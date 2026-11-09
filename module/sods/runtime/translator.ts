// Run the translator itself as wasm, so a browser can translate the
// programs it executes (a compiler's output included) without a server.
//
// A wasm memory only grows, so what the translator held (programs it keeps
// parsed) goes back to the host only with the instance: `renew` makes a
// fresh one from the same compiled module.

/** The translator's own exports. */
interface Exports {
  memory: WebAssembly.Memory;
  xlat_budget(n: number): void;
  xlat_run(n: number): void;
  xlat_alloc(n: number): number;
  xlat_free(at: number, n: number): void;
  xlat_output_ptr(): number;
  xlat_output_len(): number;
  xlat_translate(elf: number, length: number): number;
  xlat_translate_whole(elf: number, length: number): number;
  xlat_translate_seeded(elf: number, length: number, seeds: number, count: number): number;
  xlat_open(elf: number, length: number, known: number, count: number): number;
  xlat_translate_more(handle: number, seeds: number, count: number, base: number): number;
  xlat_close(handle: number): void;
  xlat_unzstd(at: number, length: number, size: number): number;
  xlat_sha256(at: number, length: number): number;
}

/** The translator, loaded: an x86-64 program's bytes in, a WebAssembly module's out; and what else it is asked. */
export interface Translate {
  (elf: Uint8Array): Uint8Array<ArrayBuffer>;
  whole(elf: Uint8Array): Uint8Array<ArrayBuffer>;
  seeded(elf: Uint8Array, seeds: (bigint | number)[]): Uint8Array<ArrayBuffer>;
  more(elf: Uint8Array, seeds: (bigint | number)[], known: Set<bigint>, base: number): Uint8Array<ArrayBuffer>;
  close(known: Set<bigint>): void;
  unzstd(bytes: Uint8Array, size: number): Uint8Array<ArrayBuffer>;
  sha256(bytes: Uint8Array): Uint8Array<ArrayBuffer>;
  held(): number;
  spare(): number;
  renew(): boolean;
  /** The translator's compiled module: the x87 (x87.ts) is an instance of it of its own. */
  readonly module: WebAssembly.Module;
}

export async function loadTranslator(source: WebAssembly.Module | BufferSource): Promise<Translate> {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = (m: WebAssembly.Module): Exports => new WebAssembly.Instance(m, {}).exports as unknown as Exports;
  let x = instance(module);
  // XLAT_BUDGET=N (node): how much code reached later one module may hold, for measuring (0: all it reaches).
  const budget = globalThis.process?.env?.XLAT_BUDGET;
  if (budget) x.xlat_budget(Number(budget));
  // XLAT_RUN=N (node): functions cut into runs of N blocks (kernel.rs RUN), so the cut is tested on small programs.
  const run = globalThis.process?.env?.XLAT_RUN;
  if (run) x.xlat_run(Number(run));
  // What a fresh instance holds: that much never goes back.
  let base = x.memory.buffer.byteLength;
  const put = (bytes: Uint8Array): number => { const p = x.xlat_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  const output = (status: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(x.memory.buffer, x.xlat_output_ptr(), x.xlat_output_len()).slice();
    if (status !== 0) throw new Error(new TextDecoder().decode(out));
    return out;
  };
  // The ELF is the translator's once given (parsed where it lies), so it is not freed here.
  function translate(elf: Uint8Array): Uint8Array<ArrayBuffer> {
    return output(x.xlat_translate(put(elf), elf.length));
  }
  /** As translate, all of the program: as the release translates the hot ones, and a page a program ahead of its run. */
  translate.whole = (elf: Uint8Array): Uint8Array<ArrayBuffer> => output(x.xlat_translate_whole(put(elf), elf.length));
  const words = (list: (bigint | number)[]): Uint8Array<ArrayBuffer> => new Uint8Array(new BigUint64Array(list.map((w) => BigInt(w))).buffer);
  /** As translate, and from the function starts `seeds` too: the program with the code it reached later, as one module. */
  translate.seeded = function seeded(elf: Uint8Array, seeds: (bigint | number)[]): Uint8Array<ArrayBuffer> {
    const s = put(words(seeds));
    const status = x.xlat_translate_seeded(put(elf), elf.length, s, seeds.length);
    x.xlat_free(s, seeds.length * 8);
    return output(status);
  };
  // Each program's handle (by its set of starts known: one per translation of it, so a program translated again as
  // one module, and its first translation still running, are told apart), while the translator holds its ELF parsed
  // with the starts translated so far (it keeps a few, and adds each module's starts itself).
  let handles = new WeakMap<Set<bigint>, number>();
  const open = new Set<number>();
  const opened = (elf: Uint8Array, known: Set<bigint>): number => {
    const list = [...known];
    const k = put(words(list));
    const handle = x.xlat_open(put(elf), elf.length, k, list.length);
    x.xlat_free(k, list.length * 8);
    if (handle === 0) output(1);
    handles.set(known, handle);
    open.add(handle);
    return handle;
  };
  /** Code reached later: from `seeds`, past the `known` addresses (a set, read only when the ELF is opened; the program's handle), filling table slots from `base`. */
  translate.more = function more(elf: Uint8Array, seeds: (bigint | number)[], known: Set<bigint>, base: number): Uint8Array<ArrayBuffer> {
    const s = put(words(seeds));
    const go = (handle: number): number => x.xlat_translate_more(handle, s, seeds.length, base);
    const handle = handles.get(known) ?? opened(elf, known);
    let status = go(handle);
    // Let go of by the translator for others since: open it again.
    if (status !== 0 && new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.xlat_output_ptr(), x.xlat_output_len())) === 'that ELF is not open') {
      open.delete(handle);
      status = go(opened(elf, known));
    }
    x.xlat_free(s, seeds.length * 8);
    return output(status);
  };
  /** Let go of what the translator keeps for the program whose starts are `known` (it is no longer kept). */
  translate.close = (known: Set<bigint>): void => {
    const handle = handles.get(known);
    if (handle === undefined) return;
    x.xlat_close(handle);
    handles.delete(known);
    open.delete(handle);
  };
  /** A root file from a pack: its zstd frames decoded, `size` bytes (xlat_unzstd). */
  translate.unzstd = (bytes: Uint8Array, size: number): Uint8Array<ArrayBuffer> => {
    const p = put(bytes);
    const status = x.xlat_unzstd(p, bytes.length, size);
    x.xlat_free(p, bytes.length);
    return output(status);
  };
  /** The SHA-256 of `bytes`, its 32 bytes (xlat_sha256): what a pack's table holds of a file, checked at once. */
  translate.sha256 = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const p = put(bytes);
    const status = x.xlat_sha256(p, bytes.length);
    x.xlat_free(p, bytes.length);
    return output(status);
  };
  /** Bytes the translator's memory holds now. */
  translate.held = (): number => x.memory.buffer.byteLength;
  /** Of those, what a fresh instance would give back. */
  translate.spare = (): number => Math.max(0, x.memory.buffer.byteLength - base);
  /**
   * A fresh instance, so the old memory goes back: what it kept is let go,
   * and a program still running opens its ELF again on its next miss (with
   * the starts it knows, which it sends then). True: renewed.
   */
  translate.renew = (): boolean => {
    x = instance(module);
    if (budget) x.xlat_budget(Number(budget));
    if (run) x.xlat_run(Number(run));
    base = x.memory.buffer.byteLength;
    handles = new WeakMap();
    open.clear();
    return true;
  };
  translate.module = module;
  return translate;
}
