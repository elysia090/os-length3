import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {sha256} from '../../host/node/hash.ts';
import {readCapturedResultRelease} from '../capture-result.ts';

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const stored = gzipSync(wasm);
const sha = sha256(stored);
const descriptor = {
  kind: 'sods-linux-capture-result-v6', host: 'linux-x64-node22-24',
  path: `blobs/${sha}.bin`, sha256: sha, size: stored.length, bytes: wasm.length, wasm: sha256(wasm),
};
const index = (captureResult: unknown) => new TextEncoder().encode(JSON.stringify({captureResult}));
const current = (bytes: Uint8Array) => ({sha256: sha256(bytes), size: bytes.length});
const read = (blob: Uint8Array) => async (path: string, size: number) => {
  assert.equal(path, descriptor.path);
  assert.equal(size, blob.length);
  return blob;
};

test('capture release derives the expanded pin only from the independently selected index', async () => {
  const bytes = index(descriptor), pinned = current(bytes);
  const selected = await readCapturedResultRelease(pinned, bytes, read(stored));
  assert.deepEqual(selected.pin, {kind: descriptor.kind, byteLength: wasm.length, sha256: descriptor.wasm});
  assert.deepEqual([...selected.bytes], [...wasm]);
  assert.ok(selected.bytes.buffer !== stored.buffer, 'decoded output must not share a Node slab');
  assert.equal(selected.bytes.buffer.byteLength, wasm.length);
  assert.equal(selected.indexSha256, pinned.sha256);
  assert.ok(Object.isFrozen(selected.pin));
});

test('stale index, missing and competing roles fail before any artifact read', async () => {
  const bytes = index(descriptor), pinned = current(bytes);
  let reads = 0;
  const never = async () => { reads++; return stored; };
  const stale = bytes.slice();
  stale[1] = 32; // Same length; the current digest, not just shape/length, matters.
  await assert.rejects(readCapturedResultRelease(pinned, stale, never), /index content mismatch/);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
  shared.set(bytes);
  await assert.rejects(readCapturedResultRelease(pinned, shared, never), /ordinary ArrayBuffer/);
  for (const value of [undefined, null, [descriptor, descriptor], {...descriptor, host: 'workerd'},
    {...descriptor, kind: 'sods-linux-capture-candidate-v1'}, {...descriptor, path: '../artifact.wasm'},
    {...descriptor, bytes: 1}, {...descriptor, size: Number.MAX_SAFE_INTEGER}]) {
    const forged = index(value);
    await assert.rejects(readCapturedResultRelease(current(forged), forged, never), /capture result descriptor/i);
  }
  assert.equal(reads, 0);
});

test('capture release independently checks stored length/digest and expanded budget', async () => {
  const bytes = index(descriptor), pinned = current(bytes);
  const corrupt = Buffer.from(stored);
  corrupt[0] ^= 1;
  await assert.rejects(readCapturedResultRelease(pinned, bytes, read(corrupt)), /stored blob content mismatch/);
  await assert.rejects(readCapturedResultRelease(pinned, bytes, async () => stored.subarray(1)), /stored blob content mismatch/);
  const shared = new Uint8Array(new SharedArrayBuffer(stored.length));
  shared.set(stored);
  await assert.rejects(readCapturedResultRelease(pinned, bytes, read(shared)), /ordinary ArrayBuffer/);
  const expandedBad = index({...descriptor, wasm: '0'.repeat(64)});
  assert.equal((await readCapturedResultRelease(current(expandedBad), expandedBad, read(stored))).pin.sha256, '0'.repeat(64),
    'transport preserves the index pin, it never substitutes a digest of bytes it read');
  const tooLarge = gzipSync(new Uint8Array(65_536));
  const sha256Stored = sha256(tooLarge), path = `blobs/${sha256Stored}.bin`;
  const short = index({...descriptor, path, size: tooLarge.length, sha256: sha256Stored});
  await assert.rejects(readCapturedResultRelease(current(short), short, async () => tooLarge), /expansion exceeded verified bounds/);
});

test('selection is snapshotted before asynchronous stored acquisition', async () => {
  const bytes = index(descriptor), pinned = current(bytes);
  let release!: (bytes: Uint8Array) => void;
  const pending = readCapturedResultRelease(pinned, bytes, () => new Promise(resolve => { release = resolve; }));
  pinned.sha256 = '0'.repeat(64);
  bytes.fill(0);
  release(stored);
  assert.equal((await pending).pin.sha256, descriptor.wasm);
});
