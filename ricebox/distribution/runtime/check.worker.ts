// Off-thread integrity checks and Cache Storage writes for the page. Returned
// bytes travel back by transfer; the page decides which assets are retained.
import {checkAsset, storedParts} from './check-assets.ts';

type Keep = {id: number; keep: {url: string; cache: string; parts: Uint8Array[]; seal: boolean}};
type Check = {id: number; bytes: ArrayBuffer; unpack: boolean; prepare?: {shared: boolean}};

async function keep({id, keep: k}: Keep) {
  try {
    const out = await storedParts(k.parts, k.seal);
    const c = await caches.open(k.cache);
    await c.put(k.url, new Response(out as BlobPart, {headers: {'content-type': 'application/octet-stream', 'content-length': String(out.length)}}));
    postMessage({id, size: out.length});
  } catch (err) {
    postMessage({id, error: String(err)});
  }
}

addEventListener('message', async (e: MessageEvent<Check | Keep>) => {
  if ('keep' in e.data) { void keep(e.data); return; }
  const {id, bytes: lent, unpack, prepare} = e.data;
  try {
    const checked = await checkAsset(new Uint8Array(lent), unpack, prepare);
    // A check starts with a transferred ArrayBuffer and returns owned bytes.
    const bytes = checked.bytes.buffer as ArrayBuffer;
    const transfer = [bytes, ...(checked.segments ?? []).map(segment => segment.bytes.buffer)];
    postMessage({id, ...checked, bytes}, {transfer});
  } catch (err) {
    postMessage({id, error: String(err), bytes: lent}, {transfer: lent.byteLength ? [lent] : []});
  }
});
