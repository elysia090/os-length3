import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalExecutableSource} from '../format/executable-source.ts';
import type {Index, Translation} from '../format/manifest.ts';

const name = 'a'.repeat(64), sourceSha256 = 'b'.repeat(64), origin = `${name}_64_16`;
function fixture(explicit = true) {
  const index: Pick<Index, 'files' | 'packs'> = {
    packs: [{name: `${name}.pack`, owner: 'fixture', bytes: 88}],
    files: [
      {path: '/usr/bin/p', mode: 0o755, size: 64, pack: 0, at: 64, len: 16},
      {path: '/usr/bin/other', mode: 0o755, size: 32, pack: 0, at: 80, len: 8},
    ],
  };
  const translation: Translation = {
    path: '/usr/bin/p', sha256: sourceSha256,
    elf: {path: 'blobs/elf.bin', sha256: 'c'.repeat(64), size: 48, bytes: 64},
    wasm: {path: 'blobs/wasm.bin', sha256: 'd'.repeat(64), size: 24, bytes: 80},
    ...(explicit ? {association: {version: 1 as const, origin, sourceSha256, sourceBytes: 64, mode: 'whole' as const}} : {}),
  };
  return {index, translation};
}

test('explicit and legacy associations normalize to the same canonical source without mutation or I/O', () => {
  for (const explicit of [true, false]) {
    const {index, translation} = fixture(explicit), before = JSON.stringify({index, translation});
    Object.freeze(translation.elf); Object.freeze(translation); Object.freeze(index.files[0]);
    const source = canonicalExecutableSource(index, translation);
    assert.deepEqual(source, {path: '/usr/bin/p', origin, sha256: sourceSha256, size: 64, binding: explicit ? 'explicit' : 'legacy-derived'});
    assert.equal(JSON.stringify({index, translation}), before);
    // The source digest is a trusted producer claim, not the compressed ELF blob
    // digest or a value independently derived by this data-only helper.
    assert.notEqual(source.sha256, translation.elf.sha256);
  }
});

test('raw canonical source lengths remain compatible with explicit and legacy producers', () => {
  for (const explicit of [true, false]) {
    const {index, translation} = fixture(explicit);
    index.files = [{...index.files[0], at: 32, len: 64, raw: true}]; index.packs[0].bytes = 96;
    if (translation.association) translation.association.origin = `${name}_32_64`;
    assert.equal(canonicalExecutableSource(index, translation).origin, `${name}_32_64`);
    Object.assign(index.files[0], {raw: 'true'});
    assert.throws(() => canonicalExecutableSource(index, translation), /storage mode/);
  }
});

test('selection requires one exact canonical path, not a symlink name or path normalization', () => {
  for (const path of ['/usr/bin/missing', '/bin/p', '/usr/bin/other', '/usr/bin/../bin/p', '/usr//bin/p', '/usr/bin/p/', 'usr/bin/p', '/', '/usr/bin/p\0']) {
    const {index, translation} = fixture(); translation.path = path;
    assert.throws(() => canonicalExecutableSource(index, translation), /invalid executable source/, path);
  }
  for (const conflicting of [false, true]) {
    const {index, translation} = fixture();
    index.files.push({...index.files[0], ...(conflicting ? {at: 80, len: 8} : {})});
    assert.throws(() => canonicalExecutableSource(index, translation), /exactly one canonical file/);
  }
});

test('hardlink records can share an origin while preserving each exact canonical path', () => {
  const {index, translation} = fixture();
  index.files.push({...index.files[0], path: '/usr/bin/p.same'});
  const first = canonicalExecutableSource(index, translation);
  translation.path = '/usr/bin/p.same';
  const alias = canonicalExecutableSource(index, translation);
  assert.equal(alias.origin, first.origin);
  assert.equal(alias.path, '/usr/bin/p.same');
  assert.notEqual(alias.path, first.path);
});

test('present source metadata never falls back when malformed, unsupported or contradictory', () => {
  const bad: unknown[] = [undefined, null, false, [], '', 1, {},
    {version: 2}, {mode: 'partial'}, {version: 1, mode: 'whole'},
    {...fixture().translation.association, version: '1'},
    {...fixture().translation.association, mode: 'partial'},
    {...fixture().translation.association, origin: `${'e'.repeat(64)}_64_16`},
    {...fixture().translation.association, origin: `${name}_80_8`},
    {...fixture().translation.association, origin: `${name}.pack_64_16`},
    {...fixture().translation.association, sourceBytes: 63},
    {...fixture().translation.association, sourceSha256: 'e'.repeat(64)},
  ];
  for (const association of bad) {
    const {index, translation} = fixture();
    Object.assign(translation, {association});
    assert.throws(() => canonicalExecutableSource(index, translation), /invalid executable source/);
  }
});

test('source, canonical and ELF lengths must agree for explicit and legacy associations', () => {
  for (const explicit of [true, false]) {
    for (const change of ['file', 'elf', 'raw'] as const) {
      const {index, translation} = fixture(explicit);
      if (change === 'file') index.files[0].size++;
      if (change === 'elf') translation.elf.bytes++;
      if (change === 'raw') index.files[0].raw = true;
      assert.throws(() => canonicalExecutableSource(index, translation), /invalid executable source/);
    }
  }
});

test('unknown packs, malformed names and out-of-pack selections are rejected', () => {
  for (const pack of [1, 99]) {
    const {index, translation} = fixture(); index.files[0].pack = pack;
    assert.throws(() => canonicalExecutableSource(index, translation), /pack/);
  }
  for (const packName of ['', `${name}.bin`, `${name.toUpperCase()}.pack`, `${'g'.repeat(64)}.pack`, `${name}.pack/else`]) {
    const {index, translation} = fixture(); index.packs[0].name = packName;
    assert.throws(() => canonicalExecutableSource(index, translation), /pack/);
  }
  for (const [at, len] of [[89, 1], [80, 9], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [0, 16], [31, 16], [0, 0]]) {
    const {index, translation} = fixture(); Object.assign(index.files[0], {at, len});
    assert.throws(() => canonicalExecutableSource(index, translation), /invalid executable source/);
  }
});

test('all selected source coordinates and lengths must be nonnegative safe integers', () => {
  const bad: unknown[] = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '64', null, undefined];
  for (const value of bad) {
    for (const field of ['pack', 'at', 'len', 'size']) {
      const {index, translation} = fixture(); Object.assign(index.files[0], {[field]: value});
      assert.throws(() => canonicalExecutableSource(index, translation), /invalid executable source/, field);
    }
    for (const field of ['packBytes', 'elfBytes', 'sourceBytes']) {
      const {index, translation} = fixture();
      if (field === 'packBytes') Object.assign(index.packs[0], {bytes: value});
      if (field === 'elfBytes') Object.assign(translation.elf, {bytes: value});
      if (field === 'sourceBytes') Object.assign(translation.association!, {sourceBytes: value});
      assert.throws(() => canonicalExecutableSource(index, translation), /invalid executable source/, field);
    }
  }
});

test('source digests use the exact lowercase SHA-256 encoding of stored descriptors', () => {
  for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), null, 1]) {
    for (const explicit of [true, false]) {
      const {index, translation} = fixture(explicit); Object.assign(translation, {sha256: value});
      assert.throws(() => canonicalExecutableSource(index, translation), /digest/);
    }
    const {index, translation} = fixture(); Object.assign(translation.association!, {sourceSha256: value});
    assert.throws(() => canonicalExecutableSource(index, translation), /digest/);
  }
});
