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
  /** Code reached later: from `seeds`, past the `known` addresses, filling table slots from `base`. */
  translate.more = function more(elf, seeds, known, base) {
    const words = (list) => new Uint8Array(new BigUint64Array(list.map(BigInt)).buffer);
    const e = put(elf), s = put(words(seeds)), k = put(words(known));
    const status = x.xlat_translate_more(e, elf.length, s, seeds.length, k, known.length, base);
    x.xlat_free(e, elf.length); x.xlat_free(s, seeds.length * 8); x.xlat_free(k, known.length * 8);
    return output(status);
  };
  return translate;
}
