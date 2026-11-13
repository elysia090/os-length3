// A program of the root translated before its first run, while a person reads or types (why/app/prompt/ahead.ts, in a
// worker of its own: ahead.worker.ts): whole, as the hot programs are in the release, and prepared as a Prompt's
// kernel prepares what it translates (share.ts, for memory shared or not as that kernel's is), handed back for the
// page to keep as it keeps the kernel's own, so that the run that wants it reads it rather than waiting on the
// translator.

import {loadTranslator, type Translate} from './translator.ts';
import {prepare, type Segment} from './share.ts';

/** How the program's bytes are held and how its kernel keeps memory. */
export interface Held { raw?: boolean; size: number; shared?: boolean }
/** The translated program, prepared. */
export interface Ahead { wasm: Uint8Array<ArrayBuffer>; segments: Segment[] | null }

/**
 * A program as its pack holds it (`raw`, or zstd frames of `size` bytes), translated whole (as the release translates
 * the hot programs: the run then reaches nothing later, and never reads the program) and prepared as a kernel prepares
 * what it translates: {wasm, segments}, the module as that kernel runs it and its data segments (or null when they are
 * in it).
 */
export function aheadOf(translate: Translate, bytes: Uint8Array, {raw, size, shared}: Held): Ahead {
  const elf = raw ? bytes : translate.unzstd(bytes, size);
  if (elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) throw new Error('not a program');
  return prepare(translate.whole(elf), {shared});
}

/** aheadOf, with the translator's module or bytes. */
export async function translatedAhead(translator: WebAssembly.Module | BufferSource, bytes: Uint8Array, held: Held): Promise<Ahead> {
  return aheadOf(await loadTranslator(translator), bytes, held);
}
