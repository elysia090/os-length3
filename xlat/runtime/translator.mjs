// Run the translator itself as wasm, so a browser can translate the
// programs it executes (a compiler's output included) without a server.

export async function loadTranslator(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const {exports: x} = await WebAssembly.instantiate(module, {});
  const put = (bytes) => { const p = x.xlat_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  const output = (status) => {
    const out = new Uint8Array(x.memory.buffer, x.xlat_output_ptr(), x.xlat_output_len()).slice();
    if (status !== 0) throw new Error(new TextDecoder().decode(out));
    return out;
  };
  function translate(elf) {
    const ptr = put(elf);
    const status = x.xlat_translate(ptr, elf.length);
    x.xlat_free(ptr, elf.length);
    return output(status);
  }
  const words = (list) => new Uint8Array(new BigUint64Array(list.map(BigInt)).buffer);
  // Each ELF's handle, while the translator holds it parsed with the starts
  // translated so far (it keeps a few, and adds each module's starts itself).
  const handles = new WeakMap();
  const open = (elf, known) => {
    const e = put(elf), k = put(words(known));
    const handle = x.xlat_open(e, elf.length, k, known.length);
    x.xlat_free(e, elf.length); x.xlat_free(k, known.length * 8);
    if (handle === 0) output(1);
    handles.set(elf, handle);
    return handle;
  };
  /** Code reached later: from `seeds`, past the `known` addresses, filling table slots from `base`. */
  translate.more = function more(elf, seeds, known, base) {
    const s = put(words(seeds));
    const go = (handle) => x.xlat_translate_more(handle, s, seeds.length, base);
    let status = go(handles.get(elf) ?? open(elf, known));
    // Let go of by the translator for others since: open it again.
    if (status !== 0 && new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.xlat_output_ptr(), x.xlat_output_len())) === 'that ELF is not open') status = go(open(elf, known));
    x.xlat_free(s, seeds.length * 8);
    return output(status);
  };
  return translate;
}
