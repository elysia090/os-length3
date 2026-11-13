// why's files checked off the page's thread (userland.ts): unpacked when they are packed, and their SHA-256 taken,
// which the browser works out on the thread that asks for it (8 MB holds that thread 27 ms): here, never where the
// page draws and is written in. A buffer lent comes back with the answer, so nothing large is copied on the way.
//
// Page → worker: {id, bytes, unpack, prepare?}. Worker → page: {id, bytes, sha256}, or {id, error, bytes} (what was
// lent, back). With `prepare: {shared}` the bytes are a translation, given back as the kernel runs it (sods'
// share.ts prepare: copying a 16 MB module held the page's thread for a tenth of a second, as a Prompt was in use):
// {id, bytes, sha256, size, segments}, its digest and size those of the translation as it was.

//
// Page → worker: {id, keep: {url, cache, parts, seal}}: the parts joined, sealed (their SHA-256 after them) when
// `seal`, and put in the page's Cache Storage at `url` (whole). Worker → page: {id, size}, or {id, error}. Keeping a
// translation of tens of MB held the page's thread 20–60 ms a time (its copies, its digest, the cache's own copy).

import {prepare} from '../share.ts';

type Keep = {id: number; keep: {url: string; cache: string; parts: Uint8Array[]; seal: boolean}};
type Check = {id: number; bytes: ArrayBuffer; unpack: boolean; prepare?: {shared: boolean}};

async function keep({id, keep: k}: Keep) {
  try {
    const n = k.parts.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(n + (k.seal ? 32 : 0));
    let at = 0;
    for (const p of k.parts) { out.set(p, at); at += p.byteLength; }
    if (k.seal) out.set(new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(0, n))), n);
    const c = await caches.open(k.cache);
    await c.put(k.url, new Response(out, {headers: {'content-type': 'application/octet-stream', 'content-length': String(out.length)}}));
    postMessage({id, size: out.length});
  } catch (err) {
    postMessage({id, error: String(err)});
  }
}

addEventListener('message', async (e: MessageEvent<Check | Keep>) => {
  if ('keep' in e.data) { void keep(e.data); return; }
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
    const lent = (e.data as Check).bytes;
    postMessage({id, error: String(err), bytes: lent}, {transfer: lent.byteLength ? [lent] : []});
  }
});
