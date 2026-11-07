// A program of the root translated before its first run, while a person reads or types (os/app/prompt/ahead.ts): whole,
// as the hot programs are in the release, and prepared as a Prompt's kernel prepares what it translates (share.mjs, for
// memory shared or not as that kernel's is), handed back for the page to keep as it keeps the kernel's own, so that the run
// that wants it reads it rather than waiting on the translator. One program a worker, so all the translator held goes
// back with it; and a worker of its own, so a Prompt is never kept from its next line by it.
//
//   in:  {translator: WebAssembly.Module, url, pack, at, len, size, raw, shared, lines, line}   (where the root's
//        packs are, where the program is in one, and its line of that pack's table of `lines`, as the index says)
//   out: {wasm, segments} or {error}

import {loadTranslator} from './translator.mjs';
import {prepare} from './share.mjs';
import {LINE, checkFile, checkTable} from './table.mjs';

/** Bytes [at, at+len) of a pack: a Range of it (of the whole pack, from a server that ignores Range). */
async function range(url, pack, at, len) {
  const r = await fetch(new URL(`packs/${pack}`, url).href, {headers: {Range: `bytes=${at}-${at + len - 1}`}});
  if (r.status !== 206 && r.status !== 200) throw new Error(`root: packs/${pack} answered ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return r.status === 200 ? bytes.subarray(at, at + len) : bytes;
}

/** The program's bytes as its pack holds them, once they are what the pack's table says (table.mjs), as a Prompt's. */
async function stored({url, pack, at, len, lines, line}, sha256) {
  const [table, bytes] = await Promise.all([range(url, pack, 0, lines * LINE), range(url, pack, at, len)]);
  checkTable(table, pack, sha256);
  checkFile(bytes, table, line, pack, sha256);
  return bytes;
}

/**
 * A program as its pack holds it (`raw`, or zstd frames of `size` bytes), translated whole (as the release translates
 * the hot programs: the run then reaches nothing later, and never reads the program) and prepared as a kernel prepares
 * what it translates: {wasm, segments}, the module as that kernel runs it and its data segments (or null when they are
 * in it).
 */
export async function translatedAhead(translator, bytes, opts) {
  return whole(await loadTranslator(translator), bytes, opts);
}

function whole(translate, bytes, {raw, size, shared}) {
  const elf = raw ? bytes : translate.unzstd(bytes, size);
  if (elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) throw new Error('not a program');
  return prepare(translate.whole(elf), {shared});
}

if (typeof WorkerGlobalScope === 'function' && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({data}) => {
    try {
      const translate = await loadTranslator(data.translator);
      const out = whole(translate, await stored(data, translate.sha256), data);
      // Moved, not copied: a module of tens of MB copied here was read again on the page's thread as it came (10–22 ms
      // a time). (Shared memory is not moved; it goes as itself.)
      const buffers = [out.wasm.buffer, ...(out.segments ?? []).map((s) => s.bytes.buffer)];
      self.postMessage(out, [...new Set(buffers)].filter((b) => b instanceof ArrayBuffer));
    } catch (e) {
      self.postMessage({error: e instanceof Error ? e.message : String(e)});
    }
  };
}
