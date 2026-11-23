// Executes authorized code for one address space, with one resident CPU context.
import type {MappedTranslate} from '../../translation/mapped.ts';
import {FX87_BYTES, X87_ENV_BYTES, type MappedX87Operands, type X87} from '../../translation/x87.ts';
import {MappedDataFault, type DataAccess, type MappedRunView} from '../mapped-vm.ts';
export {MappedDataFault} from '../mapped-vm.ts';
import type {RegName} from '../parts.ts';
import {MappedCodeChanged, type BoundText} from './mapped-code-space.ts';
import {MAPPED_ABI_VERSION, MappedArtifactRetirementError, MappedCodeTable} from './mapped-code-table.ts';
import {MappedEntries} from './mapped-entries.ts';
import {MappedRegisters, type MappedContext, type MappedSyscall} from './mapped-registers.ts';

const FX_IMAGE_BYTES = 512, MXCSR_OFFSET = 24, MXCSR_MASK = 0xffbf, FX_LOAD_MXCSR = 4;
const FX_SAVE_X87_ENV = 5;
const OWNED_IMPORTS = ['mapped_access', 'mapped_string', 'mapped_fx_state', 'access_pages'];
type X87State = {owner: X87; handle: number};
type Core = WebAssembly.Exports & {
  run(pc: bigint): void;
  table: WebAssembly.Table;
  budget: WebAssembly.Global;
  depth: WebAssembly.Global;
  mxcsr: WebAssembly.Global;
  contexts: WebAssembly.Memory;
  save_context(at: number): void;
  restore_context(at: number): void;
} & Partial<Record<RegName, WebAssembly.Global>>;

/** Only a syscall import that already returned may create this continuation. */
class SyscallReturn {
  constructor(pc: bigint, value: bigint, fs?: bigint) { this.pc = pc; this.value = value; this.fs = fs; }
  readonly pc: bigint;
  readonly value: bigint;
  readonly fs?: bigint;
}

/** One register context and dispatcher for the owning VM. Wasm frames
 * unwind at generation boundaries before the table is reconciled. */
export class MappedDispatcher {
  #space: MappedRunView;
  #core: Core;
  #code: MappedCodeTable;
  #registers: MappedRegisters;
  #openX87?: () => X87;
  #x87 = new Map<MappedContext, X87State>();
  #epoch?: object;
  #active?: object;
  #syscallPc?: bigint;
  #closed = false;
  #revoked?: object;
  #uncertain?: {error: Error; handles: readonly Set<bigint>[]; x87?: X87State};
  constructor(space: MappedRunView, compiler: MappedTranslate, host: WebAssembly.ModuleImports, openX87?: () => X87,
      codeBytes?: number) {
    if (typeof space.permits !== 'function' || typeof space.beginRead !== 'function' ||
        typeof space.beginWrite !== 'function' || typeof space.string !== 'function' ||
        !(space.accessPages instanceof WebAssembly.Memory) ||
        OWNED_IMPORTS.some(name => Object.hasOwn(host, name)) ||
        (openX87 && Object.hasOwn(host, 'fpu')))
      throw new TypeError('Mapped data checks require their own VM authority');
    this.#space = space;
    this.#openX87 = openX87;
    const module = new WebAssembly.Module(compiler.core());
    if (WebAssembly.Module.customSections(module, `sods.mapped-core-v${MAPPED_ABI_VERSION}`).length !== 1)
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
        const callback = next === undefined ? fn : this.#registers.resident?.syscall ?? fn;
        try { value = Reflect.apply(callback, undefined, args); }
        finally { if (next !== undefined) this.#syscallPc = undefined; }
        if (this.#revoked) throw this.#revoked;
        const revoked = this.#registers.resident?.revoked;
        if (revoked) throw revoked;
        // A host callback may have revoked a mapping even if the next guest
        // instruction is a direct edge inside the old Wasm function.
        if (generation !== this.#space.generation) {
          if (next !== undefined && typeof value === 'bigint')
            throw new SyscallReturn(next, value);
          throw new MappedCodeChanged();
        }
        this.#checkDataOwner();
        return value;
      };
    }
    if (openX87) env.fpu = (...operands: MappedX87Operands) => {
      this.#requireLive();
      const {owner, handle} = this.#x87State();
      const value = owner.mappedInstruction(handle, ...operands);
      this.#requireLive();
      return value;
    };
    const imports = {...env, memory: space.memory, miss: (pc: bigint) => this.#resolve(pc),
      mapped_string: (...args: Parameters<MappedRunView['string']>): bigint => {
        this.#requireLive();
        const transferred = space.string(...args);
        this.#requireLive();
        return transferred;
      },
      mapped_fx_state: (address: bigint, operation: number): number => {
        const value = this.#fxState(address, operation);
        this.#requireLive();
        return value;
      },
    };
    const entries = new MappedEntries();
    this.#core = new WebAssembly.Instance(module, {
      dispatcher: {entries: entries.memory, access_pages: space.accessPages},
      env: {...imports, mapped_access: (wide: bigint, access: number): number => {
        this.#requireLive();
        // Width and rights occupy the low six bits. Updates are negative.
        const rights = access & 3, length = ((access & 63) >>> 2) + 1;
        const update = access < 0, write = rights === 2;
        if (access < -64 || access > 63 || rights < 2 || (update && !write) ||
            (length !== 1 && length !== 2 && length !== 4 && length !== 8 && length !== 16))
          throw new Error('Invalid mapped data operation');
        const address = BigInt.asUintN(64, wide), size = BigInt(length);
        if (update && !space.permits(address, size, 'read')) throw new MappedDataFault(address, length, 'read');
        const allowed = write ? space.beginWrite(address, size) : space.beginRead(address, size);
        if (allowed) {
          this.#requireLive();
          return Number(address);
        }
        throw new MappedDataFault(address, length, write ? 'write' : 'read');
      }},
    }).exports as Core;
    this.#registers = new MappedRegisters(this.#core);
    this.#code = new MappedCodeTable(this.#core, imports, compiler, entries, codeBytes);
  }

  get initial(): MappedContext { return this.#registers.initial; }
  get threads(): number { return this.#registers.size; }
  reg(name: RegName, context = this.initial): bigint { return this.#registers.get(context, name); }
  setReg(name: RegName, value: bigint, context = this.initial): void {
    this.#idle(context);
    this.#registers.set(context, name, value);
  }

  fork(parent: MappedContext, syscall: MappedSyscall, next: bigint, stack: bigint, fs: bigint | null): MappedContext {
    if (!this.syscallAt(next, parent)) throw new Error('Mapped clone has no active syscall owner');
    const child = this.#registers.fork(parent, syscall);
    try {
      this.#syscallResult(child, next, 0n, fs ?? undefined);
      if (stack) this.#registers.set(child, 'r4', stack);
      const fpu = this.#x87.get(parent);
      if (fpu) this.#x87.set(child, {owner: fpu.owner, handle: fpu.owner.make(fpu.handle)});
      return child;
    } catch (error) {
      this.#registers.drop(child);
      throw error;
    }
  }

  /** Revoke now without clearing a table that still has a Wasm frame. */
  revoke(reason: object): void { this.#revoked ??= reason; }

  /** The kernel completed a waiting call with no Wasm frames left. */
  completeSyscall(pc: bigint, value: bigint, context = this.initial): void {
    this.#idle(context);
    this.#syscallResult(context, pc, value);
  }

  /** A successful ARCH_SET_FS may only return through its own import. The
   * old frame must unwind before its saved register context can change. */
  completeFsSyscall(pc: bigint, base: bigint, context = this.initial): never {
    if (this.#revoked) throw this.#revoked;
    if (!this.syscallAt(pc, context)) throw new Error('FS completion has no mapped syscall owner');
    throw new SyscallReturn(pc, 0n, base);
  }

  syscallAt(pc: bigint, context = this.initial): boolean {
    return !!this.#active && this.#registers.resident === context && this.#syscallPc === pc;
  }

  run(pc: bigint, budget?: number, context = this.initial): void {
    this.#idle(context);
    this.#registers.select(context);
    if (budget !== undefined) {
      if (!Number.isInteger(budget) || budget < 1 || budget > 0x7fff_ffff) throw new RangeError('Invalid mapped slice');
      this.#core.budget.value = budget;
      this.#core.depth.value = 0;
    }
    for (;;) {
      const generation = this.#space.generation;
      this.#active = generation; // Includes reentry during retirement or attachment.
      try {
        if (this.#epoch !== generation) {
          this.#retainCode(source => this.#space.find(BigInt(source.text.address), generation) === source);
          this.#epoch = generation;
        }
        this.#requireLive();
        this.#core.run(BigInt.asUintN(64, pc));
        return;
      } catch (error) {
        if (!(error instanceof SyscallReturn)) throw error;
        // SYSCALL saved general, vector and flag state before calling out.
        // The normal post-import Wasm cannot restore RAX/RCX in this case.
        // Use the same architectural result and resume after, not at, the
        // completed syscall. Keep the remaining budget and discard depth.
        this.#syscallResult(context, error.pc, error.value, error.fs);
        this.#core.depth.value = 0;
        pc = error.pc;
      } finally { this.#active = undefined; }
    }
  }

  close(): void {
    if (this.#active) throw new Error('Mapped code still has an active frame');
    try {
      if (this.#uncertain) throw this.#uncertain.error;
      if (this.#closed) return;
      this.#closed = true;
      this.#retainCode(() => false);
    } finally {
      for (const context of this.#registers.contexts()) this.#dropContext(context);
    }
  }

  retire(context: MappedContext): void {
    if (this.#active && this.#registers.resident === context) throw new Error('Mapped code still has an active frame');
    this.#registers.check(context);
    if (this.#registers.size === 1) this.close();
    else this.#dropContext(context);
  }

  #dropContext(context: MappedContext): void {
    this.#registers.drop(context);
    const x87 = this.#x87.get(context);
    if (!x87) return;
    // Unwound fragments hold no handle, so a code-retirement failure
    // does not delay returning this independent resource.
    this.#x87.delete(context);
    try { x87.owner.free(x87.handle); }
    catch (cause) {
      const failure = new Error('Mapped x87 retirement failed', {cause});
      const older = this.#uncertain;
      this.#retain(older ? new AggregateError([older.error, failure], 'Mapped CPU retirement failed') : failure,
        older?.handles ?? [], x87);
    }
  }

  #dataAddress(address: bigint, length: number, access: DataAccess): number {
    const count = BigInt(length);
    const allowed = access === 'write' ? this.#space.beginWrite(address, count) : this.#space.beginRead(address, count);
    if (!allowed)
      throw new MappedDataFault(address, length, access);
    return Number(address); // Narrow only after checking the whole span.
  }

  #x87State(): X87State {
    const context = this.#registers.resident!;
    const existing = this.#x87.get(context);
    if (existing) return existing;
    const owner = this.#openX87?.();
    if (!owner) throw new Error('Mapped FXSR requires the owning coprocessor');
    const made = {owner, handle: owner.make()};
    this.#x87.set(context, made);
    this.#requireLive();
    return made;
  }

  #fxState(address: bigint, operation: number): number {
    this.#requireLive();
    const base = BigInt.asUintN(64, address), memory = this.#space.memory;
    const readMxcsr = (at: number): number => {
      const value = new DataView(memory.buffer, at, 4).getUint32(0, true);
      if (value & ~MXCSR_MASK) throw new Error('Reserved MXCSR bits in mapped state');
      return value;
    };
    if (operation === FX_LOAD_MXCSR) return readMxcsr(this.#dataAddress(base, 4, 'read'));
    if (operation === FX_SAVE_X87_ENV) {
      const at = this.#dataAddress(base, X87_ENV_BYTES, 'write');
      const {owner, handle} = this.#x87State();
      new Uint8Array(memory.buffer, at, X87_ENV_BYTES).set(owner.fnstenv(handle));
      return at;
    }
    if (operation < 0 || operation > 3) throw new Error('Invalid mapped FXSR operation');
    if (base & 15n) throw new Error('Unaligned mapped FXSR image');
    // Bit 0 encodes REX.W and bit 1 distinguishes restore from save.
    const restore = (operation & 2) !== 0, wide = (operation & 1) !== 0;
    const at = this.#dataAddress(base, FX_IMAGE_BYTES, restore ? 'read' : 'write');
    const mxcsr = restore ? readMxcsr(at + MXCSR_OFFSET) : Number(this.#core.mxcsr.value);
    const {owner, handle} = this.#x87State();
    const area = new Uint8Array(memory.buffer, at, FX87_BYTES);
    if (restore) {
      owner.fxrestore(handle, wide, area);
      this.#core.mxcsr.value = mxcsr;
    } else {
      const state = owner.fxsave(handle, wide);
      const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
      view.setUint32(MXCSR_OFFSET, mxcsr, true);
      view.setUint32(MXCSR_OFFSET + 4, MXCSR_MASK, true);
      area.set(state);
    }
    return at; // The same frame completes the XMM transfer without another host call.
  }

  #requireLive(): object {
    if (this.#revoked) throw this.#revoked;
    const revoked = this.#registers.resident?.revoked;
    if (revoked) throw revoked;
    if (!this.#active || this.#space.generation !== this.#active) throw new MappedCodeChanged();
    this.#checkDataOwner();
    return this.#active;
  }

  #checkDataOwner(): void {
    if (!this.#space.permits(0n, 0n, 'read')) throw new MappedCodeChanged();
  }

  #idle(context: MappedContext): void {
    if (this.#revoked) throw this.#revoked;
    if (this.#closed || this.#active) throw new Error('Mapped dispatcher is not idle');
    if (context.revoked) throw context.revoked;
    this.#registers.check(context);
  }

  #syscallResult(context: MappedContext, pc: bigint, value: bigint, fs?: bigint): void {
    if (fs !== undefined) this.#registers.set(context, 'fs', fs);
    this.#registers.set(context, 'r0', value);
    this.#registers.set(context, 'r1', pc);
  }

  #retainCode(live: (source: BoundText) => boolean): void {
    try { this.#code.retain(live); }
    catch (error) {
      if (error instanceof MappedArtifactRetirementError) this.#retain(error, error.handles);
      throw error;
    }
  }

  #retain(error: Error, handles: readonly Set<bigint>[], x87?: X87State): never {
    this.#closed = true;
    this.#uncertain = {error, handles, x87};
    throw error;
  }

  #resolve(pc: bigint): bigint {
    const generation = this.#requireLive();
    const source = this.#space.find(pc, generation);
    if (!source) return -1n;
    try { return this.#code.compile(source, generation, pc, () => this.#requireLive()); }
    catch (error) {
      if (error instanceof MappedArtifactRetirementError) this.#retain(error, error.handles);
      throw error;
    }
  }
}
