// The x87 coprocessor for translated programs, exact to its 64-bit mantissa: the translator's own Rust (src/x87.rs), in
// an instance of the translator's module that does nothing else, so translating (and the translator's instance made
// afresh: translator.ts renew) never touches it. Translated code calls it wasm to wasm, its `fpu` import this
// instance's sods_fpu, with the handle of its thread's registers (the instance's `x87` global, which the kernel sets).
// The mapped dispatcher keeps that handle private and brokers the architectural FXSR image.
// One per agent (the page's kernel, each Worker of threads): a thread's registers are in the agent that runs it, and go
// to another as bytes (`saved`, `restore`).

export type MappedX87Operands = [op: number, size: number, a: number, b: number,
  lo: bigint, hi: number, pc: bigint, opcode: number];

interface Exports {
  memory: WebAssembly.Memory;
  sods_fpu: (fpu: number, op: number, size: number, a: number, b: number, lo: bigint, hi: number) => bigint;
  sods_mapped_fpu?(fpu: number, ...operands: MappedX87Operands): bigint;
  sods_fxsave?(fpu: number, wide: number): number;
  sods_fnstenv?(fpu: number): number;
  sods_fxrestore?(fpu: number, wide: number, at: number, length: number): number;
  sods_x87_new(from: number): number;
  sods_x87_reset(fpu: number): void;
  sods_x87_free(fpu: number): void;
  sods_x87_save(fpu: number): number;
  sods_x87_load(at: number, length: number): number;
  sods_x87_names(): number;
  sods_alloc(n: number): number;
  sods_output_ptr(): number;
  sods_output_len(): number;
}

export const FX87_BYTES = 160;
export const X87_ENV_BYTES = 28;

/** A thread's x87 registers as bytes: what a thread started in another Worker starts from. */
export type Saved = number[];

export class X87 {
  declare readonly x: Exports;
  /** The operations by the index translated code calls them by (comma-separated): a translation's sods.fpu must say the same. */
  declare readonly names: string;
  constructor(module: WebAssembly.Module) {
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    this.x.sods_x87_names();
    this.names = new TextDecoder().decode(this.output());
  }

  /** What translated code imports as `fpu`. */
  get fpu(): Exports['sods_fpu'] { return this.x.sods_fpu; }
  mappedInstruction(fpu: number, ...operands: MappedX87Operands): bigint {
    const run = this.x.sods_mapped_fpu;
    if (!run) throw new Error('The coprocessor has no mapped x87 support');
    return run(fpu, ...operands);
  }
  fxsave(fpu: number, wide: boolean): Uint8Array<ArrayBuffer> {
    const save = this.x.sods_fxsave;
    if (!save || save(fpu, Number(wide))) throw new Error('Cannot save mapped x87 state');
    const area = this.output();
    if (area.length !== FX87_BYTES) throw new Error('Invalid x87 state image size');
    return area;
  }
  fnstenv(fpu: number): Uint8Array<ArrayBuffer> {
    const save = this.x.sods_fnstenv;
    if (!save || save(fpu)) throw new Error('Cannot save mapped x87 environment');
    const area = this.output();
    if (area.length !== X87_ENV_BYTES) throw new Error('Invalid x87 environment image size');
    return area;
  }
  fxrestore(fpu: number, wide: boolean, area: Uint8Array): void {
    const restore = this.x.sods_fxrestore;
    if (!restore || area.length !== FX87_BYTES) throw new Error('Invalid mapped x87 restore');
    const at = this.x.sods_alloc(area.length);
    new Uint8Array(this.x.memory.buffer, at, area.length).set(area);
    if (restore(fpu, Number(wide), at, area.length)) throw new Error('Cannot restore mapped x87 state');
  }
  /** A thread's registers: as they start, or a copy of `from`'s (a new thread or process). */
  make(from = 0): number { return this.x.sods_x87_new(from); }
  /** Its registers as they start again (an exec). */
  reset(fpu: number): void { this.x.sods_x87_reset(fpu); }
  /** Let go of them (their thread ended). */
  free(fpu: number): void { this.x.sods_x87_free(fpu); }
  saved(fpu: number): Saved {
    this.x.sods_x87_save(fpu);
    return Array.from(this.output());
  }
  /** Registers from `saved`'s bytes; fresh ones where there are none. */
  restore(saved: Saved | null): number {
    if (!saved?.length) return this.make();
    const at = this.x.sods_alloc(saved.length);
    new Uint8Array(this.x.memory.buffer, at, saved.length).set(saved);
    return this.x.sods_x87_load(at, saved.length) || this.make();
  }

  /** That a translation calls the operations by the index this coprocessor numbers them by. */
  check(names: string): void {
    if (names !== this.names) throw new Error('a translation by another build of the translator than the x87 it would run on');
  }

  output(): Uint8Array<ArrayBuffer> { return new Uint8Array(this.x.memory.buffer, this.x.sods_output_ptr(), this.x.sods_output_len()).slice(); }
}

const named = new WeakMap<WebAssembly.Module, string>();
/** The x87 operations a translated `module` calls by index (its sods.fpu section), read once. */
export const namesIn = (module: WebAssembly.Module): string => {
  let n = named.get(module);
  if (n === undefined) named.set(module, n = new TextDecoder().decode(WebAssembly.Module.customSections(module, 'sods.fpu')[0] ?? new ArrayBuffer(0)));
  return n;
};

const made = new WeakMap<WebAssembly.Module, X87>();
/** The agent's coprocessor from the translator's `module`: one, however often asked. */
export const x87Of = (module: WebAssembly.Module): X87 => {
  let x = made.get(module);
  if (!x) made.set(module, x = new X87(module));
  return x;
};
