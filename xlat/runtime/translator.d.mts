// Types for translator.mjs, as os/scripts reads them (l3-runnable.ts).
/** The translator, loaded: an x86-64 program's bytes in, a WebAssembly module out. */
export type Translate = (...args: never[]) => unknown;
export function loadTranslator(source: WebAssembly.Module | BufferSource): Promise<Translate>;
