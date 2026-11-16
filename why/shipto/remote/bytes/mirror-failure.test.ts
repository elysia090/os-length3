import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {dirname} from 'node:path';
import {Writable} from 'node:stream';
import {test} from 'node:test';
import {mirror, type Pinned} from './mirror.ts';

for (const failure of ['ENOSPC', 'EIO', 'close']) {
  test(`mirror catches ${failure}, cancels the body, continues remaining pins and removes temporary files`, async () => {
    const bytes = new Uint8Array(100_000).fill(7);
    const pins: Pinned[] = ['bad', 'good'].map(file => ({key: file, path: `/${file}`, tag: 'test', file,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      type: 'application/octet-stream', url: `https://test/${file}`}));
    const original = fs.createWriteStream;
    const files: string[] = [], put: string[] = [];
    let cancelled = false;
    fs.createWriteStream = ((path, options) => {
      files.push(String(path));
      if (files.length > 1) return original(path, options);
      return new Writable({write(_chunk, _encoding, callback) {
        if (failure === 'close') this.destroy();
        else callback(Object.assign(new Error(failure), {code: failure}));
      }});
    }) as typeof fs.createWriteStream;
    syncBuiltinESMExports();
    try {
      await assert.rejects(mirror(pins, {
        async has() { return false; },
        async put(p, file) { assert.deepEqual(new Uint8Array(fs.readFileSync(file)), bytes); put.push(p.key); },
      }, {api: '', repo: '', fetch: async url => String(url).endsWith('/bad')
        ? new Response(new ReadableStream({start(c) { c.enqueue(bytes); }, cancel() { cancelled = true; }}))
        : new Response(bytes)}, () => {}), failure === 'close' ? /premature close/i : new RegExp(failure));
      assert.deepEqual(put, ['good']);
      assert.equal(cancelled, true);
      assert.equal(files.length, 2);
      assert.equal(fs.existsSync(dirname(files[0])), false);
    } finally {
      fs.createWriteStream = original;
      syncBuiltinESMExports();
    }
  });
}
