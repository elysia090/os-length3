import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
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
