// Run the translator itself as wasm, so a browser can translate the
// programs it executes (a compiler's output included) without a server.

export async function loadTranslator(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const {exports: x} = await WebAssembly.instantiate(module, {});
  return function translate(elf) {
    const ptr = x.xlat_alloc(elf.length);
    new Uint8Array(x.memory.buffer, ptr, elf.length).set(elf);
    const status = x.xlat_translate(ptr, elf.length);
    x.xlat_free(ptr, elf.length);
    const out = new Uint8Array(x.memory.buffer, x.xlat_output_ptr(), x.xlat_output_len()).slice();
    if (status !== 0) throw new Error(new TextDecoder().decode(out));
    return out;
  };
}
