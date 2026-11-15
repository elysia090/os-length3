// One program of the root translated ahead of its first run (ahead.ts): its bytes fetched from its pack and checked
// against the pack's table (table.ts), then translated whole and prepared (sods). One program a worker, so all the
// translator held goes back with it; and a worker of its own, so a Prompt is never kept from its next line by it.
//
//   in:  {translator: WebAssembly.Module, url, pack, at, len, size, raw, shared, lines, line}   (where the root's
//        packs are, where the program is in one, and its line of that pack's table of `lines`, as the index says)
//   out: {wasm, segments} or {error}

import {range} from '../../sods/runtime/host.ts';
import {aheadOf, loadTranslator, type Held} from '../../sods/runtime/translate.ts';
import {fetchStored, type Stored} from './pack.ts';

self.onmessage = async ({data}: MessageEvent<Stored & Held & {translator: WebAssembly.Module}>) => {
  try {
    const translate = await loadTranslator(data.translator);
    const out = aheadOf(translate, await fetchStored(data, translate.sha256, range), data);
    // Moved, not copied: a module of tens of MB copied here was read again on the page's thread as it came (10–22 ms
    // a time). (Shared memory is not moved; it goes as itself.)
    const buffers = [out.wasm.buffer, ...(out.segments ?? []).map((s) => s.bytes.buffer)];
    self.postMessage(out, {transfer: [...new Set(buffers)].filter((b) => b instanceof ArrayBuffer)});
  } catch (e) {
    self.postMessage({error: e instanceof Error ? e.message : String(e)});
  }
};
