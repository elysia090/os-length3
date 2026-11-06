import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {constants, zstdCompressSync, zstdDecompressSync} from 'node:zlib';
import {Vfs} from '../runtime/fs.mjs';
import {mountPack, provide} from '../runtime/pack.mjs';
import {checkPacks, packOf} from '../runtime/table.mjs';
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

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const unzstd = (bytes) => new Uint8Array(zstdDecompressSync(bytes));

/** A pack of these files ({text, raw?}), as os/scripts/l3.ts makes one: {pack, name, places} (each file's {size, at, len, raw?}). */
function made(files) {
  const stored = files.map(({text, raw}) => (raw ? enc.encode(text) : new Uint8Array(zstdCompressSync(enc.encode(text)))));
  const {bytes, name, at} = packOf(stored, sha256);
  return {pack: bytes, name, places: files.map(({text, raw}, k) => ({size: enc.encode(text).length, at: at[k], len: stored[k].length, ...(raw ? {raw: true} : {})}))};
}

test('the translator gives the SHA-256 node does, as a pack is checked', async () => {
  const translate = await loadTranslator(readFileSync(translator));
  for (const n of [0, 1, 55, 56, 64, 100_000]) {
    const b = randomBytes(n);
    assert.deepEqual(translate.sha256(b), sha256(b));
  }
});

test('packs mount their tree at once and each file only when read; what was there stays', () => {
  const {pack, name, places: [one, release, given]} = made([{text: '#!/bin/sh\necho one\n'}, {text: 'NAME=x\n', raw: true}, {text: 'from the pack'}]);
  const index = {
    dirs: [{path: '/usr', mode: 0o755}, {path: '/usr/bin', mode: 0o755}, {path: '/etc', mode: 0o755}],
    links: [{path: '/usr/bin/again', target: 'one'}, {path: '/etc/given', target: '/nowhere'}],
    files: [{path: '/usr/bin/one', mode: 0o755, ...one, pack: 0}, {path: '/usr/bin/hard', mode: 0o755, ...one, pack: 0},
      {path: '/etc/os-release', mode: 0o644, ...release, pack: 0}, {path: '/etc/given', mode: 0o644, ...given, pack: 0}],
    codec: 'zstd',
    packs: [{name, owner: 'local', bytes: pack.length}],
  };
  const reads = [];
  const v = new Vfs();
  v.writeFile('/etc/given', enc.encode('given first'));
  mountPack(v, index, {range: (n, a, len) => { assert.equal(n, name); reads.push(a); return pack.slice(a, a + len); }, decode: unzstd, sha256});
  assert.equal(reads.length, 0);
  assert.equal(v.lookup('/usr/bin/one', '/').size, one.size);
  assert.equal(dec.decode(v.readFile('/usr/bin/again', '/')), '#!/bin/sh\necho one\n');
  assert.equal(dec.decode(v.readFile('/usr/bin/hard', '/')), '#!/bin/sh\necho one\n');
  assert.equal(dec.decode(v.readFile('/etc/os-release', '/')), 'NAME=x\n');
  assert.equal(dec.decode(v.readFile('/etc/given', '/')), 'given first');
  assert.equal(v.lookup('/usr/bin/one', '/').mode & 0o777, 0o755);
  // A hard link is the file it names: one node, read once, two links.
  assert.equal(v.lookup('/usr/bin/hard', '/'), v.lookup('/usr/bin/one', '/'));
  assert.equal(v.lookup('/usr/bin/one', '/').nlink, 2);
  // Two files read, and the pack's table once, first or after.
  assert.deepEqual(reads.sort((x, y) => x - y), [0, one.at, release.at]);
  checkPacks(index, (n, a, len) => pack.subarray(a, a + len), () => pack.length, sha256);
});

test('nothing read from a pack is used unless it is what its table says, and the table what the pack is named by', () => {
  const {pack, name, places: [one, two]} = made([{text: '#!/bin/sh\necho one\n'}, {text: 'two\n', raw: true}]);
  const index = {dirs: [{path: '/bin', mode: 0o755}], links: [], codec: 'zstd', packs: [{name, owner: 'local', bytes: pack.length}],
    files: [{path: '/bin/one', mode: 0o755, ...one, pack: 0}, {path: '/bin/two', mode: 0o644, ...two, pack: 0}]};
  const mounted = (bytes) => { const v = new Vfs(); mountPack(v, index, {range: (n, a, len) => bytes.slice(a, a + len), decode: unzstd, sha256}); return v; };
  // What was wrong is said (once, as the kernel's console does), and the read fails as a disk's bad block does (EIO).
  const said = [];
  const warn = console.warn;
  console.warn = (m) => said.push(m);
  try {
    // A byte of a file changed (a server, a cache, a mirror that gives something else): that file is not read.
    const file = pack.slice(); file[two.at] ^= 1;
    assert.throws(() => mounted(file).readFile('/bin/two', '/'), (e) => e.errno === 5);
    assert.match(said.pop(), /not the file its table names/);
    assert.equal(dec.decode(mounted(file).readFile('/bin/one', '/')), '#!/bin/sh\necho one\n');
    // The table changed to say the changed file: the pack is not the one named.
    const table = file.slice(); table.set(sha256(file.subarray(two.at, two.at + two.len)), 32);
    assert.throws(() => mounted(table).readFile('/bin/two', '/'), (e) => e.errno === 5);
    assert.match(said.pop(), /does not begin with the table it is named by/);
  } finally { console.warn = warn; }
  // Read whole (a release taken in): a byte after its last file is refused too, whatever the index says of its length.
  const longer = Buffer.concat([pack, Buffer.from([0])]);
  const read = (n, a, len) => longer.subarray(a, a + len);
  assert.throws(() => checkPacks(index, read, () => longer.length, sha256), /is \d+ bytes, its index says/);
  assert.throws(() => checkPacks({...index, packs: [{name, owner: 'local', bytes: longer.length}]}, read, () => longer.length, sha256), /holds bytes no file of its index is/);
});

test("a file of the root given with its bytes goes in the root's node, which each of its names shares", () => {
  const bytes = enc.encode('#!/bin/sh\necho one\n');
  const {pack, name, places: [f]} = made([{text: '#!/bin/sh\necho one\n'}]);
  const index = {dirs: [{path: '/bin', mode: 0o755}], links: [], files: [{path: '/bin/a', mode: 0o755, ...f, pack: 0}, {path: '/bin/b', mode: 0o755, ...f, pack: 0}],
    codec: 'zstd', packs: [{name, owner: 'local', bytes: pack.length}]};
  let reads = 0;
  const v = new Vfs();
  mountPack(v, index, {range: (n, a, len) => { reads++; return pack.slice(a, a + len); }, decode: unzstd, sha256});
  const node = provide(v, {path: '/bin/a', bytes, mode: 0o755, root: true});
  assert.equal(node, v.lookup('/bin/b', '/'));
  assert.equal(dec.decode(v.readFile('/bin/b', '/')), '#!/bin/sh\necho one\n');
  assert.equal(reads, 0, 'its bytes are not read from the pack');
  // Not said to be the root's own (a file of one's own over the root): written over that name alone.
  const mine = provide(v, {path: '/bin/b', bytes: enc.encode('mine'), mode: 0o644});
  assert.notEqual(mine, node);
  assert.equal(dec.decode(v.readFile('/bin/a', '/')), '#!/bin/sh\necho one\n');
});
