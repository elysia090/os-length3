import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {checkAsset, storedParts} from '../check-assets.ts';

test('the common check hashes decoded data before preparing a translation', async () => {
  const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  const stored = gzipSync(wasm), sha256 = createHash('sha256').update(wasm).digest('hex');
  const result = await checkAsset(stored, true);
  assert.deepEqual(result, {bytes: wasm, sha256});
  const prepared = await checkAsset(stored, true, {shared: false});
  assert.equal(prepared.size, wasm.byteLength);
  assert.equal(prepared.sha256, sha256);
  assert.equal(WebAssembly.validate(prepared.bytes as BufferSource), true);
  await assert.rejects(checkAsset(Uint8Array.of(7), true));
});

test('cache parts are stored in order with a digest of their contents only', async () => {
  const one = Uint8Array.of(1, 2), two = Uint8Array.of(3, 4);
  assert.equal(await storedParts([one], false), one);
  const body = Uint8Array.of(1, 2, 3, 4), digest = createHash('sha256').update(body).digest();
  assert.deepEqual(await storedParts([one, two], false), body);
  assert.deepEqual(await storedParts([one, two], true), Uint8Array.from([...body, ...digest]));
});


test('the actual integrity Worker returns owned bytes on success and returns lent bytes on error', {timeout: 10_000}, async t => {
  const source = new URL('../check.worker.ts', import.meta.url).href;
  const bridge = `
import {parentPort} from 'node:worker_threads';
globalThis.addEventListener = (type, handle) => parentPort.on(type, data => handle({data}));
globalThis.postMessage = (value, {transfer = []} = {}) => parentPort.postMessage(value, transfer);
await import(${JSON.stringify(source)});
parentPort.postMessage('ready');
`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`));
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  const body = Uint8Array.of(1, 2, 3), bytes = new Uint8Array(body).buffer;
  const checked = once(worker, 'message');
  worker.postMessage({id: 1, bytes, unpack: false}, [bytes]);
  const [good] = await checked;
  assert.equal(bytes.byteLength, 0);
  assert.deepEqual(new Uint8Array(good.bytes), body);
  assert.equal(good.sha256, createHash('sha256').update(body).digest('hex'));

  const invalid = new Uint8Array(body).buffer, received = once(worker, 'message');
  worker.postMessage({id: 2, bytes: invalid, unpack: true}, [invalid]);
  const [bad] = await received;
  assert.equal(invalid.byteLength, 0);
  assert.equal(bad.id, 2);
  assert.equal(typeof bad.error, 'string');
  assert.deepEqual(new Uint8Array(bad.bytes), body);
});
