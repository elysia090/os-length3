import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {constants, zstdCompressSync, zstdDecompressSync} from 'node:zlib';

test('the Worker transfers exact compressed bytes, or selects the original input', async () => {
  const worker = new Worker(new URL('../compress.worker.ts', import.meta.url));
  try {
    const mixed = new Uint8Array(32768);
    let seed = 1;
    for (let i = 0; i < mixed.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      mixed[i] = seed >>> 24;
    }
    const inputs = [new Uint8Array(), new Uint8Array([1, 2, 3]), mixed, new Uint8Array(32768)];
    for (const [id, bytes] of inputs.entries()) {
      const response = once(worker, 'message');
      worker.postMessage({id, bytes});
      const [result] = await response;
      const expected = zstdCompressSync(bytes, {params: {
        [constants.ZSTD_c_compressionLevel]: 19, [constants.ZSTD_c_checksumFlag]: 0,
      }});
      assert.equal(result.id, id);
      assert.equal(result.raw, expected.length >= bytes.length);
      if (result.raw) assert.equal(result.bytes, null);
      else {
        assert.equal(result.bytes.byteOffset, 0);
        assert.equal(result.bytes.buffer.byteLength, expected.length);
        assert.deepEqual(Buffer.from(result.bytes), expected);
        assert.deepEqual(zstdDecompressSync(result.bytes), Buffer.from(bytes));
      }
    }
  } finally { await worker.terminate(); }
});
