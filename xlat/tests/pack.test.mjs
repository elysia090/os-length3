import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {constants, zstdCompressSync, zstdDecompressSync} from 'node:zlib';
import {Vfs} from '../runtime/fs.mjs';
import {mountPack} from '../runtime/pack.mjs';
import {loadTranslator} from '../runtime/translator.mjs';

const enc = new TextEncoder(), dec = new TextDecoder();

const translator = new URL('../target/wasm32-unknown-unknown/release/xlat.wasm', import.meta.url);

test('the translator decodes what zstd encoded, at every level and size, as the browser reads a pack', async () => {
  const translate = await loadTranslator(readFileSync(translator));
  const texts = [enc.encode('a'), enc.encode('hello hello hello hello'), randomBytes(5000), new Uint8Array(3 << 20).map((_, i) => (i * 31) % 251)];
  for (const t of texts) for (const level of [1, 3, 19]) {
    const z = zstdCompressSync(t, {params: {[constants.ZSTD_c_compressionLevel]: level}});
    assert.deepEqual(Buffer.from(translate.unzstd(z, t.length)), Buffer.from(t));
  }
  // A size that does not match is an error, not a short file.
  assert.throws(() => translate.unzstd(zstdCompressSync(enc.encode('abc')), 4), /not 4/);
});

test('packs mount their tree at once and each file only when read; what was there stays', () => {
  const blobs = [];
  let at = 0;
  const put = (text, raw = false) => {
    const bytes = enc.encode(text), stored = raw ? bytes : zstdCompressSync(bytes);
    blobs.push(stored);
    const p = {size: bytes.length, at, len: stored.length, ...(raw ? {raw: true} : {})};
    at += stored.length;
    return p;
  };
  const one = {...put('#!/bin/sh\necho one\n'), pack: 0};
  const index = {
    dirs: [{path: '/usr', mode: 0o755}, {path: '/usr/bin', mode: 0o755}, {path: '/etc', mode: 0o755}],
    links: [{path: '/usr/bin/again', target: 'one'}, {path: '/etc/given', target: '/nowhere'}],
    files: [{path: '/usr/bin/one', mode: 0o755, ...one}, {path: '/usr/bin/hard', mode: 0o755, ...one},
      {path: '/etc/os-release', mode: 0o644, ...put('NAME=x\n', true), pack: 0}, {path: '/etc/given', mode: 0o644, ...put('from the pack'), pack: 0}],
    codec: 'zstd',
    packs: [{name: 'p.pack', owner: 'local', bytes: 0}],
  };
  const pack = Buffer.concat(blobs);
  const reads = [];
  const v = new Vfs();
  v.writeFile('/etc/given', enc.encode('given first'));
  mountPack(v, index, (name, a, n) => { assert.equal(name, 'p.pack'); reads.push(a); return new Uint8Array(pack.subarray(a, a + n)); },
    (bytes) => new Uint8Array(zstdDecompressSync(bytes)));
  assert.equal(reads.length, 0);
  assert.equal(v.lookup('/usr/bin/one', '/').size, one.size);
  assert.equal(dec.decode(v.readFile('/usr/bin/again', '/')), '#!/bin/sh\necho one\n');
  assert.equal(dec.decode(v.readFile('/usr/bin/hard', '/')), '#!/bin/sh\necho one\n');
  assert.equal(dec.decode(v.readFile('/etc/os-release', '/')), 'NAME=x\n');
  assert.equal(dec.decode(v.readFile('/etc/given', '/')), 'given first');
  assert.equal(v.lookup('/usr/bin/one', '/').mode & 0o777, 0o755);
  assert.equal(reads.length, 3);
});
