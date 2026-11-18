import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {canonicalExecutableSource} from '../../format/executable-source.ts';
import {openDistribution} from '../../deployment/local.ts';
import {standIn, makeWebroot} from '../../test/fixtures/distribution.ts';

// Real archive reader, packing, AOT CLI boundary, blob and manifest producer;
// stand-in ELF/translator deliberately do not claim execution correctness.
test('actual producer binds its captured hot bytes to the canonical placed entry', () => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox-association-')), out = join(work, 'layers');
  try {
    const root = standIn(work, '9.9.9'), result = makeWebroot(root, out, work);
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const web = openDistribution(out);
    try {
      const translation = web.index.translations[0], source = canonicalExecutableSource(web.index, translation);
      const file = web.index.files.find(f => f.path === translation.path)!;
      const elf = gunzipSync(readFileSync(join(out, translation.elf.path)));
      assert.equal(source.binding, 'explicit');
      assert.deepEqual(translation.association, {version: 1, origin: `${web.index.packs[file.pack].name.slice(0, -5)}_${file.at}_${file.len}`,
        sourceSha256: createHash('sha256').update(elf).digest('hex'), sourceBytes: elf.length, mode: 'whole'});
      assert.equal(source.sha256, translation.sha256);
      assert.equal(source.size, file.size);
      assert.equal(source.size, translation.elf.bytes);
      assert.equal(elf.subarray(0, 4).toString(), '\x7fELF');
      const alias = web.index.files.find(f => f.path === '/usr/bin/busybox.same')!;
      assert.deepEqual([alias.pack, alias.at, alias.len, alias.size], [file.pack, file.at, file.len, file.size]);
      assert.equal(canonicalExecutableSource(web.index, {...translation, path: alias.path}).origin, source.origin);
      const legacy = {...translation}; delete legacy.association;
      assert.equal(canonicalExecutableSource(web.index, legacy).binding, 'legacy-derived');
    } finally { web.close(); }
  } finally { rmSync(work, {recursive: true, force: true}); }
});
