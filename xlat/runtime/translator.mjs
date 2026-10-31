// Run the translator itself as wasm, so a browser can translate the
// programs it executes (a compiler's output included) without a server.
//
// A wasm memory only grows, so what the translator held (programs it keeps
// parsed) goes back to the host only with the instance: `renew` makes a
// fresh one from the same compiled module.

export async function loadTranslator(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  let x = (await WebAssembly.instantiate(module, {})).exports;
  // XLAT_BUDGET=N (node): how much code reached later one module may hold, for measuring (0: all it reaches).
  const budget = globalThis.process?.env?.XLAT_BUDGET;
  if (budget) x.xlat_budget(Number(budget));
  // What a fresh instance holds: that much never goes back.
  let base = x.memory.buffer.byteLength;
  const put = (bytes) => { const p = x.xlat_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  const output = (status) => {
    const out = new Uint8Array(x.memory.buffer, x.xlat_output_ptr(), x.xlat_output_len()).slice();
    if (status !== 0) throw new Error(new TextDecoder().decode(out));
    return out;
  };
  // The ELF is the translator's once given (parsed where it lies), so it is not freed here.
  function translate(elf) {
    return output(x.xlat_translate(put(elf), elf.length));
  }
  const words = (list) => new Uint8Array(new BigUint64Array(list.map(BigInt)).buffer);
  /** As translate, and from the function starts `seeds` too: the program with the code it reached later, as one module. */
  translate.seeded = function seeded(elf, seeds) {
    const s = put(words(seeds));
    const status = x.xlat_translate_seeded(put(elf), elf.length, s, seeds.length);
    x.xlat_free(s, seeds.length * 8);
    return output(status);
  };
  // Each program's handle (by its set of starts known: one per translation of it, so a program translated again as
  // one module, and its first translation still running, are told apart), while the translator holds its ELF parsed
  // with the starts translated so far (it keeps a few, and adds each module's starts itself).
  let handles = new WeakMap();
  const open = new Set();
  const opened = (elf, known) => {
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
  translate.more = function more(elf, seeds, known, base) {
    const s = put(words(seeds));
    const go = (handle) => x.xlat_translate_more(handle, s, seeds.length, base);
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
  translate.close = (known) => {
    const handle = handles.get(known);
    if (handle === undefined) return;
    x.xlat_close(handle);
    handles.delete(known);
    open.delete(handle);
  };
  /** A root file from a pack: its zstd frames decoded, `size` bytes (xlat_unzstd). */
  translate.unzstd = (bytes, size) => {
    const p = put(bytes);
    const status = x.xlat_unzstd(p, bytes.length, size);
    x.xlat_free(p, bytes.length);
    return output(status);
  };
  /** Bytes the translator's memory holds now. */
  translate.held = () => x.memory.buffer.byteLength;
  /** Of those, what a fresh instance would give back. */
  translate.spare = () => Math.max(0, x.memory.buffer.byteLength - base);
  /**
   * A fresh instance, so the old memory goes back: what it kept is let go,
   * and a program still running opens its ELF again on its next miss (with
   * the starts it knows, which it sends then). True: renewed.
   */
  translate.renew = () => {
    x = new WebAssembly.Instance(module, {}).exports;
    if (budget) x.xlat_budget(Number(budget));
    base = x.memory.buffer.byteLength;
    handles = new WeakMap();
    open.clear();
    return true;
  };
  return translate;
}
