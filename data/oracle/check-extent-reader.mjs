import assert from 'node:assert/strict';
import {diagnosticExtents} from '../../src/v2/vm/check/browser/extent-reader.mjs';
const bytes = Uint8Array.from({length:100000},(_,i) => (i * 31) & 255);
const hash = async data => Buffer.from(await crypto.subtle.digest('SHA-256',data)).toString('hex');
const row = {name:'boot.kernel-object',bytes:bytes.length,chunkBytes:65536,
  chunks:[await hash(bytes.subarray(0,65536)),await hash(bytes.subarray(65536))]};
let corruption = false, mode = 206, sizeDelta = 0;
async function fetcher(url,options) {
  assert.equal(url.pathname,'/boot.kernel-object');
  const [,first,last] = options.headers.Range.match(/^bytes=(\d+)-(\d+)$/), start = Number(first), end = Number(last);
  const data = new Uint8Array(end - start + 1 + sizeDelta); data.set(bytes.subarray(start,start + data.length));
  if (corruption) data[0] ^= 1;
  return new Response(data,{status:mode,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
}
const make = () => diagnosticExtents({2:row},new URL('http://127.0.0.1/'),fetcher);
const transport = make();
assert.deepEqual(await transport.read(2,4096,4096),bytes.slice(4096,8192));
assert.deepEqual(await transport.read(2,8192,4096),bytes.slice(8192,12288));
assert.equal(transport.stats.fetches,1); assert.equal(transport.stats.cachedBytes,65536);
assert.deepEqual(await transport.read(2,65530,20),bytes.slice(65530,65550));
assert.equal(transport.stats.fetches,2); assert.equal(transport.stats.fetchedBytes,100000);
assert.equal(transport.stats.cacheHighWaterBytes,65536);
for (const args of [[2,-1,8],[2,0,4097],[2,99999,8],[3,0,8],[2,NaN,8]])
  await assert.rejects(transport.read(...args),/invalid C/);
for (const fault of ['corruption','status','short','oversize']) {
  corruption = fault === 'corruption'; mode = fault === 'status' ? 200 : 206;
  sizeDelta = fault === 'short' ? -1 : fault === 'oversize' ? 1 : 0;
  const bad = make();
  await assert.rejects(bad.read(2,4096,4096));
  assert.equal(bad.stats.cachedBytes,0); // Refused bytes never become resident cache.
  corruption = false; mode = 206; sizeDelta = 0;
  assert.deepEqual(await bad.read(2,4096,4096),bytes.slice(4096,8192));
  assert.equal(bad.stats.fetches,2);
}
console.log('bounded extent transport: green (exact Range; shared chunk; cross-chunk; corrupt/short/oversized/200 refusal; bounded cache)');
// Image-kind admission uses the same exact range/chunk owner, not a second
// filesystem reader. Switching source kind must not hit the prior chunk.
const images=diagnosticExtents({2:row,5:{...row,name:'boot.system-object'}},new URL('http://127.0.0.1/'),
  (url,options)=>{
    assert(['/boot.kernel-object','/boot.system-object'].includes(url.pathname));
    return fetcher(new URL('http://127.0.0.1/boot.kernel-object'),options);
  });
assert.deepEqual(await images.read(2,4096,4096),bytes.slice(4096,8192));
assert.deepEqual(await images.read(5,4096,4096),bytes.slice(4096,8192));
assert.equal(images.stats.fetches,2);
assert.deepEqual(await images.read(5,8192,4096),bytes.slice(8192,12288));
assert.equal(images.stats.fetches,2);
assert.deepEqual(await images.read(5,65530,20),bytes.slice(65530,65550));
assert.equal(images.stats.cacheHighWaterBytes,65536);
await assert.rejects(images.read(5,99999,2),/invalid C/);
console.log('Immutable image uses the same bounded authenticated transport: green (kind isolation, shared chunk, cross-chunk, extent refusal)');
