// The experimental one-thread dispatcher for authorized executable mappings.
// It owns code slots, not memory mappings, Linux syscalls or task scheduling.
import type {MappedTranslate} from '../../translation/mapped.ts';
import type {RegName} from '../parts.ts';
import {MappedCodeChanged, type BoundText, type MappedCodeView} from './mapped-code-space.ts';

const MAX_SLOTS = 65536, MAX_BYTES = 64 << 20;
type Core = WebAssembly.Exports & {
  run(pc: bigint): void;
  table: WebAssembly.Table;
  depth: WebAssembly.Global;
} & Partial<Record<RegName, WebAssembly.Global>>;

/** Only a syscall import that already returned may create this continuation. */
class SyscallReturn {
  constructor(pc: bigint, value: bigint) { this.pc = pc; this.value = value; }
  readonly pc: bigint;
  readonly value: bigint;
}

function words(module: WebAssembly.Module, name: string, stride: number): BigUint64Array {
  const sections = WebAssembly.Module.customSections(module, name);
  if (sections.length !== 1 || sections[0].byteLength % stride) throw new Error('Invalid mapped code metadata');
  return new BigUint64Array(sections[0]);
}

/** One register context/table for all objects in a generation. It does not
 * share active Wasm frames across workers or return after a revoked frame. */
export class MappedDispatcher {
  #space: MappedCodeView;
  #compile: MappedTranslate;
  #core: Core;
  #env: WebAssembly.ModuleImports;
  #epoch?: object;
  #active?: object;
  #closed = false;
  #known = new Map<BoundText, Set<bigint>>();
  #entries = new Map<bigint, bigint>();
  #slots = 0;
  #bytes = 0;

  constructor(space: MappedCodeView & {readonly memory: WebAssembly.Memory}, compiler: MappedTranslate, host: WebAssembly.ModuleImports) {
    this.#space = space;
    this.#compile = compiler;
    const module = new WebAssembly.Module(compiler.core());
    if (WebAssembly.Module.customSections(module, 'sods.mapped-core-v2').length !== 1)
      throw new Error('Mapped code requires its generation-aware dispatcher');
    const env: WebAssembly.ModuleImports = {};
    for (const [name, fn] of Object.entries(host)) {
      if (typeof fn !== 'function') throw new TypeError('Mapped code host imports must be callbacks');
      env[name] = (...args: unknown[]) => {
        const generation = this.#requireLive();
        const value: unknown = Reflect.apply(fn, undefined, args);
        // A host callback may have revoked a mapping even if the next guest
        // instruction is a direct edge inside the old Wasm function.
        if (generation !== this.#space.generation) {
          const next = args[7];
          if (name === 'syscall' && typeof next === 'bigint' && typeof value === 'bigint')
            throw new SyscallReturn(next, value);
          throw new MappedCodeChanged();
        }
        return value;
      };
    }
    this.#env = {...env, memory: space.memory, miss: (pc: bigint) => this.#resolve(pc)};
    this.#core = new WebAssembly.Instance(module, {env: this.#env}).exports as Core;
  }

  reg(name: RegName): bigint { return this.#core[name]?.value ?? 0n; }
  setReg(name: RegName, value: bigint): void {
    if (this.#closed || this.#active) throw new Error('A running or closed mapped dispatcher cannot take a context');
    const register = this.#core[name];
    if (!register) throw new RangeError('Unknown mapped register');
    register.value = BigInt.asIntN(64, value);
  }

  run(pc: bigint): void {
    if (this.#closed || this.#active) throw new Error('Mapped dispatcher cannot reenter');
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
        this.#core.r0!.value = BigInt.asIntN(64, error.value);
        this.#core.r1!.value = BigInt.asIntN(64, error.pc);
        this.#core.depth.value = 0;
        pc = error.pc;
      } finally { this.#active = undefined; }
    }
  }

  close(): void {
    if (this.#active) throw new Error('Mapped code still has an active frame');
    if (this.#closed) return;
    this.#closed = true;
    this.#forget();
  }

  #requireLive(): object {
    if (!this.#active || this.#space.generation !== this.#active) throw new MappedCodeChanged();
    return this.#active;
  }

  #forget(): void {
    const previous = [...this.#known.values()];
    for (let i = 0; i < this.#slots; i++) this.#core.table.set(i, null);
    this.#known.clear();
    this.#entries.clear();
    this.#slots = this.#bytes = 0;
    const failures: unknown[] = [];
    for (const known of previous) try { this.#compile.close(known); } catch (error) { failures.push(error); }
    if (failures.length) { this.#closed = true; throw new AggregateError(failures, 'Mapped artifact retirement failed'); }
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
      catch (cleanup) { this.#closed = true; throw new AggregateError([cause, cleanup], 'Mapped attachment failed'); }
      throw cause;
    }
  }
}
