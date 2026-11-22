// The experimental one-thread dispatcher for authorized executable mappings.
// It owns code slots, not memory mappings, Linux syscalls or task scheduling.
import type {MappedTranslate} from '../../translation/mapped.ts';
import {MappedDataFault, type MappedRunView} from '../mapped-vm.ts';
export {MappedDataFault} from '../mapped-vm.ts';
import type {RegName} from '../parts.ts';
import {MappedCodeChanged, type BoundText} from './mapped-code-space.ts';

const MAX_SLOTS = 65536, MAX_BYTES = 64 << 20;
type Core = WebAssembly.Exports & {
  run(pc: bigint): void;
  table: WebAssembly.Table;
  budget: WebAssembly.Global;
  depth: WebAssembly.Global;
} & Partial<Record<RegName, WebAssembly.Global>>;

/** Only a syscall import that already returned may create this continuation. */
class SyscallReturn {
  constructor(pc: bigint, value: bigint, fs?: bigint) { this.pc = pc; this.value = value; this.fs = fs; }
  readonly pc: bigint;
  readonly value: bigint;
  readonly fs?: bigint;
}

function words(module: WebAssembly.Module, name: string, stride: number): BigUint64Array {
  const sections = WebAssembly.Module.customSections(module, name);
  if (sections.length !== 1 || sections[0].byteLength % stride) throw new Error('Invalid mapped code metadata');
  return new BigUint64Array(sections[0]);
}

/** One register context/table for all objects in a generation. It does not
 * share active Wasm frames across workers or return after a revoked frame. */
export class MappedDispatcher {
  #space: MappedRunView;
  #compile: MappedTranslate;
  #core: Core;
  #env: WebAssembly.ModuleImports;
  #epoch?: object;
  #active?: object;
  #syscallPc?: bigint;
  #closed = false;
  #revoked?: object;
  #uncertain?: {error: Error; handles: readonly Set<bigint>[]};
  #known = new Map<BoundText, Set<bigint>>();
  #entries = new Map<bigint, bigint>();
  #slots = 0;
  #bytes = 0;

  constructor(space: MappedRunView, compiler: MappedTranslate, host: WebAssembly.ModuleImports) {
    if (typeof space.permits !== 'function' || typeof space.string !== 'function' ||
        Object.hasOwn(host, 'mapped_access') || Object.hasOwn(host, 'mapped_string'))
      throw new TypeError('Mapped data checks require their own VM authority');
    this.#space = space;
    this.#compile = compiler;
    const module = new WebAssembly.Module(compiler.core());
    if (WebAssembly.Module.customSections(module, 'sods.mapped-core-v4').length !== 1)
      throw new Error('Mapped code requires its checked dispatcher');
    const env: WebAssembly.ModuleImports = {};
    for (const [name, fn] of Object.entries(host)) {
      if (typeof fn !== 'function') throw new TypeError('Mapped code host imports must be callbacks');
      env[name] = (...args: unknown[]) => {
        const generation = this.#requireLive();
        const next = name === 'syscall' && typeof args[7] === 'bigint' ? args[7] : undefined;
        if (next !== undefined) {
          if (this.#syscallPc !== undefined) throw new Error('Mapped syscall cannot nest');
          this.#syscallPc = next;
        }
        let value: unknown;
        try { value = Reflect.apply(fn, undefined, args); }
        finally { if (next !== undefined) this.#syscallPc = undefined; }
        if (this.#revoked) throw this.#revoked;
        // A host callback may have revoked a mapping even if the next guest
        // instruction is a direct edge inside the old Wasm function.
        if (generation !== this.#space.generation) {
          if (next !== undefined && typeof value === 'bigint')
            throw new SyscallReturn(next, value);
          throw new MappedCodeChanged();
        }
        return value;
      };
    }
    this.#env = {...env, memory: space.memory, miss: (pc: bigint) => this.#resolve(pc),
      mapped_access: (base: bigint, displacement: bigint, length: number, write: number): number => {
        this.#requireLive();
        if (displacement < 0n || (length !== 1 && length !== 2 && length !== 4 && length !== 8 && length !== 16) ||
            (write !== 0 && write !== 1))
          throw new Error('Invalid mapped data operation');
        const address = BigInt.asUintN(64, base) + displacement, mode = write ? 'write' : 'read', count = BigInt(length);
        if (address + count > 0x1_0000_0000n || !space.permits(address, count, mode))
          throw new MappedDataFault(address, length, mode);
        return Number(address); // The VM approved this whole span before address narrowing.
      },
      mapped_string: (...args: Parameters<MappedRunView['string']>): bigint => {
        this.#requireLive();
        const transferred = space.string(...args);
        this.#requireLive();
        return transferred;
      },
    };
    this.#core = new WebAssembly.Instance(module, {env: this.#env}).exports as Core;
  }

  reg(name: RegName): bigint { return this.#core[name]?.value ?? 0n; }
  setReg(name: RegName, value: bigint): void {
    this.#idle();
    const register = this.#core[name];
    if (!register) throw new RangeError('Unknown mapped register');
    register.value = BigInt.asIntN(64, value);
  }

  /** Revoke now without clearing a table that still has a Wasm frame. */
  revoke(reason: object): void { this.#revoked ??= reason; }

  /** The kernel completed a waiting call with no Wasm frames left. */
  completeSyscall(pc: bigint, value: bigint): void {
    this.#idle();
    this.#syscallResult(pc, value);
  }

  /** A successful ARCH_SET_FS may only return through its own import. The
   * old frame must unwind before its saved register context can change. */
  completeFsSyscall(pc: bigint, base: bigint): never {
    if (this.#revoked) throw this.#revoked;
    if (!this.syscallAt(pc)) throw new Error('FS completion has no mapped syscall owner');
    throw new SyscallReturn(pc, 0n, base);
  }

  syscallAt(pc: bigint): boolean { return !!this.#active && this.#syscallPc === pc; }

  run(pc: bigint, budget?: number): void {
    this.#idle();
    if (budget !== undefined) {
      if (!Number.isInteger(budget) || budget < 1 || budget > 0x7fff_ffff) throw new RangeError('Invalid mapped slice');
      this.#core.budget.value = budget;
      this.#core.depth.value = 0;
    }
    for (;;) {
      const generation = this.#space.generation;
      this.#active = generation; // Includes reentry during retirement or attachment.
      try {
        if (this.#epoch !== generation) { this.#forget(); this.#epoch = generation; }
        this.#requireLive();
        this.#core.run(BigInt.asUintN(64, pc));
        return;
      } catch (error) {
        if (!(error instanceof SyscallReturn)) throw error;
        // SYSCALL saved general, vector and flag state before calling out.
        // The normal post-import Wasm cannot restore RAX/RCX in this case.
        // Use the same architectural result and resume after, not at, the
        // completed syscall. Keep the remaining budget and discard depth.
        this.#syscallResult(error.pc, error.value, error.fs);
        pc = error.pc;
      } finally { this.#active = undefined; }
    }
  }

  close(): void {
    if (this.#active) throw new Error('Mapped code still has an active frame');
    if (this.#uncertain) throw this.#uncertain.error;
    if (this.#closed) return;
    this.#closed = true;
    this.#forget();
  }

  #requireLive(): object {
    if (this.#revoked) throw this.#revoked;
    if (!this.#active || this.#space.generation !== this.#active) throw new MappedCodeChanged();
    return this.#active;
  }

  #idle(): void {
    if (this.#revoked) throw this.#revoked;
    if (this.#closed || this.#active) throw new Error('Mapped dispatcher is not idle');
  }

  #syscallResult(pc: bigint, value: bigint, fs?: bigint): void {
    if (fs !== undefined) this.#core.fs!.value = fs;
    this.#core.r0!.value = BigInt.asIntN(64, value);
    this.#core.r1!.value = BigInt.asIntN(64, pc);
    this.#core.depth.value = 0;
  }

  #forget(): void {
    const previous = [...this.#known.values()];
    for (let i = 0; i < this.#slots; i++) this.#core.table.set(i, null);
    this.#known.clear();
    this.#entries.clear();
    this.#slots = this.#bytes = 0;
    const failures: unknown[] = [], handles: Set<bigint>[] = [];
    for (const known of previous) try { this.#compile.close(known); } catch (error) { failures.push(error); handles.push(known); }
    if (failures.length) this.#retain(new AggregateError(failures, 'Mapped artifact retirement failed'), handles);
  }

  #retain(error: Error, handles: readonly Set<bigint>[]): never {
    this.#closed = true;
    this.#uncertain = {error, handles};
    throw error;
  }

  #resolve(pc: bigint): bigint {
    const generation = this.#requireLive();
    const source = this.#space.find(pc, generation);
    if (!source) return -1n;
    const cached = this.#entries.get(pc);
    if (cached !== undefined) return cached;
    let known = this.#known.get(source);
    if (!known) this.#known.set(source, known = new Set());
    const base = this.#slots;
    try {
      const code = source.compile(generation, this.#compile, pc, known, base);
      if (this.#bytes + code.length > MAX_BYTES) throw new RangeError('Mapped translation budget exhausted');
      const module = new WebAssembly.Module(code), starts = words(module, 'sods.starts', 8), rows = words(module, 'sods.entries', 16);
      const imports = WebAssembly.Module.imports(module);
      if (WebAssembly.Module.customSections(module, 'sods.mapped-piece-v4').length !== 1 ||
          !['mapped_access', 'mapped_string'].every(name => imports.some(i => i.kind === 'function' && i.module === 'env' && i.name === name)))
        throw new Error('Mapped code fragment lacks the checked data ABI');
      const count = starts.length, end = base + count;
      const within = (at: bigint): boolean => at >= BigInt(source.text.address) &&
        at < BigInt(source.text.address + source.text.length);
      if (end > MAX_SLOTS || starts.some(at => !within(at))) throw new Error('Mapped translation leaves its executable extent');
      const entries = new Map<bigint, bigint>();
      for (let i = 0; i < rows.length; i += 2) {
        const at = rows[i], encoded = rows[i + 1], slot = Number(encoded >> 32n);
        if (!within(at) || slot < base || slot >= end) throw new Error('Mapped translation has an invalid entry');
        entries.set(at, encoded);
      }
      if (!entries.has(pc)) {
        if (count || entries.size) throw new Error('Mapped translation did not describe the requested PC');
        return -1n;
      }
      const own = new WebAssembly.Instance(module, {env: this.#env, main: this.#core}).exports.table;
      if (!(own instanceof WebAssembly.Table) || own.length !== count) throw new Error('Mapped translation has an invalid table');
      this.#requireLive();
      const table = this.#core.table;
      if (table.length < end) table.grow(Math.min(MAX_SLOTS, Math.max(end, table.length * 2, 16)) - table.length);
      for (let i = 0; i < count; i++) table.set(base + i, own.get(i));
      this.#slots = end;
      this.#bytes += code.length;
      for (const start of starts) known.add(start);
      for (const [at, entry] of entries) this.#entries.set(at, entry);
      return entries.get(pc)!;
    } catch (cause) {
      // The translator may already have updated its unseen starts. Detach
      // its parsed handle so it cannot label an incomplete attachment known.
      try { this.#compile.close(known); }
      catch (cleanup) { this.#retain(new AggregateError([cause, cleanup], 'Mapped attachment failed'), [known]); }
      this.#known.delete(source);
      throw cause;
    }
  }
}
