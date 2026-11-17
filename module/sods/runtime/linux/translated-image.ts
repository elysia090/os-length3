/** Private, fixed-memory, single-runner admission. This is not a general Wasm
 * sandbox, translator provenance check, or the growable Node runtime profile.
 * The host must keep the resulting instance and its Memory private, instantiate
 * under image-change admission, and allow no guest reentry during a short copy.
 */
const Module = WebAssembly.Module;
const importsOf = WebAssembly.Module.imports;
const Bytes = Uint8Array;
const functions = new Set(['syscall', 'trap', 'div128', 'clock', 'fpu', 'trace', 'miss', 'time']);

export function fixedTranslatedModule(input: Uint8Array): WebAssembly.Module {
  // Own the exact bytes inspected and compiled; callers cannot change a section
  // after the engine has validated it. Shared input is not an atomic snapshot.
  const bytes = new Bytes(input);
  const module = new Module(bytes);
  let at = 8;
  const size = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (at >= bytes.length) throw new Error('Truncated Wasm section');
      const byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error('Invalid Wasm section size');
  };
  // Standard validation above handles instruction/type validity. This framing
  // check is deliberately not an opcode decoder. Internal memory.grow is not
  // claimed absent: the physical Memory must have initial === maximum.
  while (at < bytes.length) {
    const section = bytes[at++], length = size();
    if (section === 8) throw new Error('Translated image must not have a start function');
    if (section === 5) throw new Error('Translated image must not define memory');
    if (length > bytes.length - at) throw new Error('Truncated Wasm section');
    at += length;
  }
  const seen = new Set<string>();
  for (const entry of importsOf(module)) {
    if (entry.module !== 'env' || seen.has(entry.name) ||
        (entry.name === 'memory' ? entry.kind !== 'memory' :
          entry.kind !== 'function' || !functions.has(entry.name))) {
      throw new Error('Unsupported translated image import');
    }
    seen.add(entry.name);
  }
  if (!seen.has('memory') || seen.size !== functions.size + 1) {
    throw new Error('Incomplete translated image imports');
  }
  // Names/kinds only: JS functions adapt to the module-declared signatures.
  // Expected translator signatures remain a trusted-artifact precondition;
  // instantiation checks physical memory type/limits, not that precondition.
  // No export or function is called here. Active data is applied only later,
  // inside the exclusive initialization of a fresh private Memory.
  return module;
}
