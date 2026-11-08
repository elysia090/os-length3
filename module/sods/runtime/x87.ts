// The x87 coprocessor for translated programs, exact to its 64-bit mantissa: the translator's own Rust (src/x87.rs), in
// an instance of the translator's module that does nothing else, so translating (and the translator's instance made
// afresh: translator.ts renew) never touches it. Translated code calls it wasm to wasm, its `fpu` import this
// instance's xlat_fpu, with the handle of its thread's registers (the instance's `x87` global, which the kernel sets).
// One per agent (the page's kernel, each Worker of threads): a thread's registers are in the agent that runs it, and go
// to another as bytes (`saved`, `restore`).

interface Exports {
  memory: WebAssembly.Memory;
  xlat_fpu: (fpu: number, op: number, size: number, a: number, b: number, lo: bigint, hi: number) => bigint;
  xlat_x87_new(from: number): number;
  xlat_x87_reset(fpu: number): void;
  xlat_x87_free(fpu: number): void;
  xlat_x87_save(fpu: number): number;
  xlat_x87_load(at: number, length: number): number;
  xlat_x87_names(): number;
  xlat_alloc(n: number): number;
  xlat_output_ptr(): number;
  xlat_output_len(): number;
}

/** A thread's x87 registers as bytes: what a thread started in another Worker starts from. */
export type Saved = number[];

export class X87 {
  declare readonly x: Exports;
  /** The operations by the index translated code calls them by (comma-separated): a translation's xlat.fpu must say the same. */
  declare readonly names: string;
  constructor(module: WebAssembly.Module) {
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    this.x.xlat_x87_names();
    this.names = new TextDecoder().decode(this.output());
  }

  /** What translated code imports as `fpu`. */
  get fpu(): Exports['xlat_fpu'] { return this.x.xlat_fpu; }
  /** A thread's registers: as they start, or a copy of `from`'s (a new thread or process). */
  make(from = 0): number { return this.x.xlat_x87_new(from); }
  /** Its registers as they start again (an exec). */
  reset(fpu: number): void { this.x.xlat_x87_reset(fpu); }
  /** Let go of them (their thread ended). */
  free(fpu: number): void { this.x.xlat_x87_free(fpu); }
  saved(fpu: number): Saved {
    this.x.xlat_x87_save(fpu);
    return Array.from(this.output());
  }
  /** Registers from `saved`'s bytes; fresh ones where there are none. */
  restore(saved: Saved | null): number {
    if (!saved?.length) return this.make();
    const at = this.x.xlat_alloc(saved.length);
    new Uint8Array(this.x.memory.buffer, at, saved.length).set(saved);
    return this.x.xlat_x87_load(at, saved.length) || this.make();
  }

  /** That a translation calls the operations by the index this coprocessor numbers them by. */
  check(names: string): void {
    if (names !== this.names) throw new Error('a translation by another build of the translator than the x87 it would run on');
  }

  output(): Uint8Array { return new Uint8Array(this.x.memory.buffer, this.x.xlat_output_ptr(), this.x.xlat_output_len()).slice(); }
}

const named = new WeakMap<WebAssembly.Module, string>();
/** The x87 operations a translated `module` calls by index (its xlat.fpu section), read once. */
export const namesIn = (module: WebAssembly.Module): string => {
  let n = named.get(module);
  if (n === undefined) named.set(module, n = new TextDecoder().decode(WebAssembly.Module.customSections(module, 'xlat.fpu')[0] ?? new ArrayBuffer(0)));
  return n;
};

const made = new WeakMap<WebAssembly.Module, X87>();
/** The agent's coprocessor from the translator's `module`: one, however often asked. */
export const x87Of = (module: WebAssembly.Module): X87 => {
  let x = made.get(module);
  if (!x) made.set(module, x = new X87(module));
  return x;
};
