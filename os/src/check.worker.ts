// l3's files checked off the page's thread (userland.ts): unpacked when they are packed, and their SHA-256 taken,
// which the browser works out on the thread that asks for it (8 MB holds that thread 27 ms): here, never where the
// page draws and is written in. A buffer lent comes back with the answer, so nothing large is copied on the way.
//
// Page → worker: {id, bytes, unpack}. Worker → page: {id, bytes, sha256}, or {id, error, bytes} (what was lent, back).

addEventListener('message', async (e: MessageEvent<{id: number; bytes: ArrayBuffer; unpack: boolean}>) => {
  const {id, unpack} = e.data;
  try {
    const bytes = unpack ? await new Response(new Blob([e.data.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : e.data.bytes;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    postMessage({id, bytes, sha256: [...d].map((b) => b.toString(16).padStart(2, '0')).join('')}, {transfer: [bytes]});
  } catch (err) {
    postMessage({id, error: String(err), bytes: e.data.bytes}, {transfer: e.data.bytes.byteLength ? [e.data.bytes] : []});
  }
});
