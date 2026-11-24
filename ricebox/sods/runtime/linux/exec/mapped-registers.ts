import {REG, type RegName} from '../parts.ts';

export type MappedSyscall = (nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint) => bigint;
export interface MappedContext {
  readonly at: number;
  readonly syscall?: MappedSyscall;
  revoked?: object;
}

type RegisterExports = Partial<Record<RegName, WebAssembly.Global>> & {
  contexts: WebAssembly.Memory;
  save_context(at: number): void;
  restore_context(at: number): void;
};

// image.rs mapped_context writes the scalar registers in REG order, followed
// by MXCSR, padding and sixteen 128-bit XMM registers starting at byte 160.
const CONTEXT_BYTES = 160 + 16 * 16;
const OFFSETS = new Map(REG.map((reg, i) => [reg, i * 8]));

/** Registers in use stay in Wasm globals until a different thread enters.
 * Each suspended context has one slot in a memory private to the core. */
export class MappedRegisters {
  readonly #core: RegisterExports;
  readonly initial: MappedContext = {at: 0};
  readonly #owned = new Set<MappedContext>([this.initial]);
  #resident: MappedContext | undefined = this.initial;
  #last?: MappedContext;
  #free: number[] = [];
  #end = CONTEXT_BYTES;

  constructor(core: RegisterExports) { this.#core = core; }

  get resident(): MappedContext | undefined { return this.#resident; }
  get size(): number { return this.#owned.size; }
  contexts(): Iterable<MappedContext> { return this.#owned; }

  check(context: MappedContext): void {
    if (!this.#owned.has(context)) throw new Error('Mapped register context has no owner');
  }

  get(context: MappedContext, reg: RegName): bigint {
    if (context !== this.#last) this.check(context);
    const offset = OFFSETS.get(reg);
    if (offset === undefined) return 0n;
    if (context === this.#resident || context === this.#last) return this.#core[reg]!.value as bigint;
    return new DataView(this.#core.contexts.buffer).getBigInt64(context.at + offset, true);
  }

  set(context: MappedContext, reg: RegName, value: bigint): void {
    this.check(context);
    const offset = OFFSETS.get(reg);
    if (offset === undefined) throw new RangeError('Unknown mapped register');
    if (context === this.#resident) this.#core[reg]!.value = BigInt.asIntN(64, value);
    else new DataView(this.#core.contexts.buffer).setBigInt64(context.at + offset, value, true);
  }

  select(context: MappedContext): void {
    this.check(context);
    const previous = this.#resident;
    if (previous === context) return;
    if (previous) this.#core.save_context(previous.at);
    this.#core.restore_context(context.at);
    this.#resident = context;
  }

  fork(parent: MappedContext, syscall: MappedSyscall): MappedContext {
    if (parent !== this.#resident) throw new Error('Mapped clone requires the current context');
    const memory = this.#core.contexts;
    let at = this.#free.pop();
    if (at === undefined) {
      if (this.#end + CONTEXT_BYTES > memory.buffer.byteLength) memory.grow(1);
      at = this.#end;
      this.#end += CONTEXT_BYTES;
    }
    this.#core.save_context(parent.at);
    new Uint8Array(memory.buffer).copyWithin(at, parent.at, parent.at + CONTEXT_BYTES);
    const child = {at, syscall};
    this.#owned.add(child);
    return child;
  }

  drop(context: MappedContext): void {
    this.check(context);
    if (this.#owned.size === 1) {
      this.select(context);
      this.#last = context; // Keep final register inspection available after process exit.
    }
    this.#owned.delete(context);
    if (context === this.#resident) this.#resident = undefined;
    this.#free.push(context.at);
  }
}
