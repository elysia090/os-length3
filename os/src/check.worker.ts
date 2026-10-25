// l3's files checked off the page's thread (userland.ts): unpacked when they are packed, and their SHA-256 taken,
// which the browser works out on the thread that asks for it (8 MB holds that thread 27 ms): here, never where the
// page draws and is written in. A buffer lent comes back with the answer, so nothing large is copied on the way.
//
// Page → worker: {id, bytes, unpack, prepare?}. Worker → page: {id, bytes, sha256}, or {id, error, bytes} (what was
// lent, back). With `prepare: {shared}` the bytes are a translation, given back as the kernel runs it (xlat's
// share.mjs prepare: copying a 16 MB module held the page's thread for a tenth of a second, as a Prompt was in use):
// {id, bytes, sha256, size, segments}, its digest and size those of the translation as it was.

import {prepare} from '../../xlat/runtime/share.mjs';

addEventListener('message', async (e: MessageEvent<{id: number; bytes: ArrayBuffer; unpack: boolean; prepare?: {shared: boolean}}>) => {
  const {id, unpack} = e.data;
  try {
    const bytes = unpack ? await new Response(new Blob([e.data.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : e.data.bytes;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (e.data.prepare) {
      const p = prepare(new Uint8Array(bytes), e.data.prepare);
      postMessage({id, bytes: p.wasm.buffer, sha256, size: bytes.byteLength, segments: p.segments},
        {transfer: [p.wasm.buffer, ...(p.segments ?? []).map((s) => s.bytes.buffer)]});
      return;
    }
    postMessage({id, bytes, sha256}, {transfer: [bytes]});
  } catch (err) {
    postMessage({id, error: String(err), bytes: e.data.bytes}, {transfer: e.data.bytes.byteLength ? [e.data.bytes] : []});
  }
});
