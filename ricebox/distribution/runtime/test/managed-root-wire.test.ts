import assert from 'node:assert/strict';
import {test} from 'node:test';
import {managedRootWire} from '../managed-root-wire.ts';
import type {Index, Translation} from '../../format/manifest.ts';

const generation = 'ab'.repeat(32), packDigest = '12'.repeat(32), otherPack = '34'.repeat(32);
const sourceDigest = '56'.repeat(32), artifactDigest = '78'.repeat(32), translatorDigest = '9a'.repeat(32);
const MAX_WIRE = 16 * 1024 * 1024;
const text = (value: string) => Buffer.from(value, 'utf8');
const hash = (value: string) => Buffer.from(value, 'hex');
function u32(value: number): Buffer { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function u64(value: number): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; }
const join = (...bytes: Uint8Array[]) => Buffer.concat(bytes);
function fixture(): Index {
  const translation = (path: string): Translation => ({path, sha256: sourceDigest,
    elf: {path: 'source.elf.gz', sha256: 'cd'.repeat(32), size: 7, bytes: 3},
    wasm: {path: 'program.wasm.gz', sha256: artifactDigest, size: 4, bytes: 8},
    association: {version: 1, origin: `${packDigest}_32_3`, sourceSha256: sourceDigest, sourceBytes: 3, mode: 'whole'}});
  return {name: 'test', version: '1', sha256: 'ef'.repeat(32), codec: 'gzip',
    packs: [{name: `${packDigest}.pack`, owner: 'one', bytes: 100}, {name: `${otherPack}.pack`, owner: 'two', bytes: 0}],
    dirs: [{path: '/z', mode: 0o1777}, {path: '/bin', mode: 0o755}],
    links: [{path: '/entry', target: 'bin/tool'}],
    files: [{path: '/bin/tool', mode: 0o755, size: 3, pack: 0, at: 32, len: 3, raw: true},
      {path: '/bin/alias', mode: 0o755, size: 3, pack: 0, at: 32, len: 3, raw: true},
      {path: '/empty', mode: 0o640, size: 0, pack: 1, at: 0, len: 0}],
    translator: {name: 'translator', version: '1', path: 'translator.wasm.gz', sha256: translatorDigest, size: 4, bytes: 8, wasm: 'translator.wasm'},
    translations: [translation('/bin/tool'), translation('/bin/alias')]};
}
function empty(): Index {
  return {...fixture(), packs: [], dirs: [], links: [], files: [], translations: []};
}
function expected(shared: boolean): Buffer {
  const file = (path: string, mode: number, size: number, pack: number, raw: boolean, at: number, stored: number) =>
    join(u32(text(path).length), u32(mode), u64(size), u32(pack), u32(Number(raw)), u64(at), u64(stored), text(path));
  const aot = (path: string) => join(u32(text(path).length), u32(Number(shared)), hash(sourceDigest), hash(artifactDigest), hash(translatorDigest), text(path));
  return join(text('SODSROOT'), u32(1), u32(0), hash(generation), u32(2), u32(2), u32(1), u32(3), u32(2), u32(0),
    hash(packDigest), u64(100), hash(otherPack), u64(0),
    u32(2), u32(0o1777), text('/z'), u32(4), u32(0o755), text('/bin'),
    u32(6), u32(8), text('/entry'), text('bin/tool'),
    file('/bin/tool', 0o755, 3, 0, true, 32, 3), file('/bin/alias', 0o755, 3, 0, true, 32, 3), file('/empty', 0o640, 0, 1, false, 0, 0),
    aot('/bin/tool'), aot('/bin/alias'));
}

test('SODSROOT v1 has exact 72-byte LE header and ordered pack, dir, link, file and AOT fields', () => {
  const result = managedRootWire(fixture(), generation);
  assert.equal(result.wire.byteOffset, 0);
  assert.ok(result.wire.buffer instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(result.wire), expected(true));
  assert.deepEqual(Buffer.from(result.wire.subarray(0, 72)), join(text('SODSROOT'), u32(1), u32(0), hash(generation), u32(2), u32(2), u32(1), u32(3), u32(2), u32(0)));
  // Both hardlink-like names are encoded. Only Rust may decide their identity.
  assert.deepEqual(result.limits, {inodes: 7, entries: 6, fileBytes: 3});
  assert.deepEqual(Buffer.from(managedRootWire(fixture(), generation, false).wire), expected(false));
});

test('generation is the caller-supplied authenticated index JSON digest, not index.sha256', () => {
  const index = fixture(), before = structuredClone(index);
  const result = managedRootWire(index, generation);
  assert.notEqual(index.sha256, generation);
  assert.deepEqual(Buffer.from(result.wire.subarray(16, 48)), hash(generation));
  assert.deepEqual(index, before);
});

test('adapter does not load payloads, invoke callbacks, instantiate code or mutate metadata', t => {
  const index = fixture(), unused = () => { throw new Error('payload access is forbidden'); };
  t.mock.method(globalThis, 'fetch', unused);
  t.mock.method(WebAssembly, 'compile', unused);
  t.mock.method(WebAssembly, 'instantiate', unused);
  const hidden = (record: object, keys: string[]) => {
    for (const key of keys) Object.defineProperty(record, key, {get: unused, configurable: true});
  };
  hidden(index, ['reading', 'readPayload', 'fileStore']);
  hidden(index.translator, ['path', 'wasm', 'size', 'bytes']);
  for (const pack of index.packs) hidden(pack, ['owner']);
  for (const translation of index.translations) {
    hidden(translation.wasm, ['path', 'size', 'bytes']);
    hidden(translation.elf, ['path', 'sha256', 'size']);
    Object.freeze(translation.elf); Object.freeze(translation.wasm); Object.freeze(translation.association); Object.freeze(translation);
  }
  for (const records of [index.packs, index.dirs, index.links, index.files, index.translations]) {
    for (const record of records) Object.freeze(record);
    Object.freeze(records);
  }
  Object.freeze(index.translator); Object.freeze(index);
  assert.deepEqual(Buffer.from(managedRootWire(index, generation).wire), expected(true));
});

test('empty inventory has no payload work and only the implicit root logical limit', () => {
  const result = managedRootWire(empty(), generation);
  assert.equal(result.wire.length, 72);
  assert.deepEqual(result.limits, {inodes: 1, entries: 0, fileBytes: 0});
});

test('stored names are byte-preserving UTF-8, not resolved, normalized or identity-deduplicated', () => {
  const index = empty(), path = '\ufeffrelative//../e\u0301/😀\0', target = '../é//./😀';
  index.dirs = [{path, mode: 0o7777}, {path, mode: 0}];
  index.links = [{path: '/', target}, {path: '', target: ''}];
  // Intentionally invalid namespace paths are Rust's decision, not an adapter's.
  const result = managedRootWire(index, generation), body = result.wire.subarray(72);
  assert.deepEqual(Buffer.from(body), join(u32(text(path).length), u32(0o7777), text(path), u32(text(path).length), u32(0), text(path),
    u32(1), u32(text(target).length), text('/'), text(target), u32(0), u32(0)));
  assert.deepEqual(result.limits, {inodes: 5, entries: 4, fileBytes: 0});
});

test('u64 metadata retains safe integers above u32 and max file bytes is a declared-size limit', () => {
  const index = empty(), large = Number.MAX_SAFE_INTEGER;
  index.packs = [{name: `${packDigest}.pack`, owner: 'unused', bytes: large}];
  index.files = [{path: '/large', mode: 0, size: large, pack: 0, at: large - 10, len: 10},
    {path: '/small', mode: 0o644, size: 7, pack: 0, at: 32, len: 2}];
  const result = managedRootWire(index, generation), view = new DataView(result.wire.buffer);
  assert.equal(view.getBigUint64(72 + 32, true), BigInt(large));
  assert.equal(view.getBigUint64(72 + 40 + 8, true), BigInt(large));
  assert.equal(view.getBigUint64(72 + 40 + 24, true), BigInt(large - 10));
  assert.equal(view.getBigUint64(72 + 40 + 32, true), 10n);
  assert.deepEqual(result.limits, {inodes: 3, entries: 2, fileBytes: large});
});

test('legacy source associations map identically but contradictory or conflicting AOT facts fail', () => {
  const legacy = fixture();
  for (const translation of legacy.translations) delete translation.association;
  assert.deepEqual(Buffer.from(managedRootWire(legacy, generation).wire), expected(true));
  const contradictory = fixture(); contradictory.translations[0].association!.sourceSha256 = otherPack;
  assert.throws(() => managedRootWire(contradictory, generation), /source digest disagrees/);
  const conflicting = fixture(); conflicting.translations[1].wasm.sha256 = otherPack;
  assert.throws(() => managedRootWire(conflicting, generation), /Conflicting prepared artifacts/);
  const missing = fixture(); missing.translations[0].path = '/missing';
  assert.throws(() => managedRootWire(missing, generation), /exactly one canonical file/);
});

test('malformed wire-relevant types, digests and integer fields are rejected', async t => {
  const cases: [string, (index: Index) => void][] = [
    ['non-array packs', index => { (index as any).packs = {}; }],
    ['non-array dirs', index => { (index as any).dirs = null; }],
    ['non-array links', index => { (index as any).links = ''; }],
    ['non-array files', index => { (index as any).files = 3; }],
    ['non-array translations', index => { (index as any).translations = false; }],
    ['missing pack record', index => { delete (index.packs as any)[0]; }],
    ['invalid pack digest', index => { index.packs[0].name = `${'X'.repeat(64)}.pack`; }],
    ['pack digest suffix', index => { index.packs[0].name = packDigest; }],
    ['pack digest trailing newline', index => { index.packs[0].name += '\n'; }],
    ['negative pack bytes', index => { index.packs[0].bytes = -1; }],
    ['unsafe pack bytes', index => { index.packs[0].bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['wrong dir record', index => { (index.dirs as any)[0] = []; }],
    ['non-string dir path', index => { (index.dirs[0] as any).path = 1; }],
    ['dir file-type bits', index => { index.dirs[0].mode = 0o40755; }],
    ['fractional dir mode', index => { index.dirs[0].mode = 1.5; }],
    ['non-string link path', index => { (index.links[0] as any).path = null; }],
    ['non-string link target', index => { (index.links[0] as any).target = {}; }],
    ['wrong file record', index => { (index.files as any)[0] = null; }],
    ['non-string file path', index => { (index.files[0] as any).path = []; }],
    ['file mode outside permissions', index => { index.files[0].mode = 0o10000; }],
    ['negative file size', index => { index.files[0].size = -1; }],
    ['infinite file size', index => { index.files[0].size = Infinity; }],
    ['unsafe file size', index => { index.files[0].size = Number.MAX_SAFE_INTEGER + 1; }],
    ['file pack beyond u32', index => { index.files[0].pack = 0x100000000; }],
    ['string file pack', index => { (index.files[0] as any).pack = '0'; }],
    ['NaN offset', index => { index.files[0].at = NaN; }],
    ['fractional stored length', index => { index.files[0].len = 0.5; }],
    ['unsafe offset', index => { index.files[0].at = Number.MAX_SAFE_INTEGER + 1; }],
    ['unsafe stored length', index => { index.files[0].len = Number.MAX_SAFE_INTEGER + 1; }],
    ['non-boolean raw', index => { (index.files[0] as any).raw = 1; }],
    ['null translator', index => { (index as any).translator = null; }],
    ['invalid translator digest', index => { index.translator.sha256 = translatorDigest.toUpperCase(); }],
    ['translator digest trailing newline', index => { index.translator.sha256 += '\n'; }],
    ['wrong translation record', index => { (index.translations as any)[0] = null; }],
    ['non-string AOT path', index => { (index.translations[0] as any).path = false; }],
    ['missing wasm descriptor', index => { delete (index.translations[0] as any).wasm; }],
    ['invalid artifact digest', index => { index.translations[0].wasm.sha256 = '00'; }],
    ['artifact digest trailing newline', index => { index.translations[0].wasm.sha256 += '\n'; }],
    ['invalid source digest', index => { index.translations[0].sha256 = ''; }],
    ['source digest trailing newline', index => { index.translations[0].sha256 += '\n'; delete index.translations[0].association; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, () => {
    const index = fixture(); mutate(index);
    assert.throws(() => managedRootWire(index, generation), /invalid managed root wire|invalid executable source/);
  });
  assert.throws(() => managedRootWire(null as any, generation), /index must be an object/);
  for (const invalid of ['', 'a'.repeat(63), 'AB'.repeat(32), generation + '\n', null, 1]) {
    assert.throws(() => managedRootWire(fixture(), invalid as any), /generation.*SHA-256/);
  }
  for (const invalid of [0, 1, null, 'true']) assert.throws(() => managedRootWire(fixture(), generation, invalid as any), /shared must be a boolean/);
});

test('lossy UTF-16 names are rejected in every encoded name position', () => {
  for (const invalid of ['\ud800', '\udfff', 'x\ud800y', '\ud800\ud800', '\udfff\ud800']) {
    for (const field of ['dir', 'link', 'target', 'file', 'aot']) {
      const index = fixture();
      if (field === 'dir') index.dirs[0].path = invalid;
      else if (field === 'link') index.links[0].path = invalid;
      else if (field === 'target') index.links[0].target = invalid;
      else if (field === 'file') index.files[0].path = invalid;
      else index.translations[0].path = invalid;
      assert.throws(() => managedRootWire(index, generation), /cannot roundtrip through UTF-8/, field);
    }
  }
});

test('16 MiB bound is exact, accounts for UTF-8 bytes, and rejects huge counts before reading records', () => {
  const exact = empty(); exact.links = [{path: 'x'.repeat(MAX_WIRE - 80), target: ''}];
  assert.equal(managedRootWire(exact, generation).wire.length, MAX_WIRE);
  const tooLong = empty(); tooLong.links = [{path: 'x'.repeat(MAX_WIRE - 79), target: ''}];
  assert.throws(() => managedRootWire(tooLong, generation), /exceeds 16 MiB/);
  const multibyte = empty(); multibyte.links = [{path: 'é'.repeat(MAX_WIRE / 2), target: ''}];
  assert.throws(() => managedRootWire(multibyte, generation), /exceeds 16 MiB/);
  const hugeCount = empty(); hugeCount.files = new Array(Math.floor(MAX_WIRE / 40) + 1);
  Object.defineProperty(hugeCount.files, 0, {get() { throw new Error('records must not be read before count rejection'); }});
  assert.throws(() => managedRootWire(hugeCount, generation), /exceeds 16 MiB/);
});
