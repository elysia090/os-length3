import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync, zstdCompressSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalExecutableSource} from '../../distribution/executable-source.ts';
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

const native = process.env.SODS_NATIVE, translator = process.env.SODS_TRANSLATOR_WASM, program = process.env.RICEBOX_AOT_ELF;
test('actual producer emits a compatible explicit binding with a supplied native translator and real ELF',
  {skip: !native || !translator || !program, timeout: 30_000}, t => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox-native-association-')), out = join(work, 'layers');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  try {
    const tree = join(work, 'tree');
    mkdirSync(join(tree, 'root/usr/bin'), {recursive: true}); mkdirSync(join(tree, 'root/etc'));
    const bytes = readFileSync(program!);
    writeFileSync(join(tree, 'root/usr/bin/program'), bytes, {mode: 0o755});
    writeFileSync(join(tree, 'root/etc/os-release'), 'NAME=fixture\nVERSION_ID=0.0.1\n');
    const archive = zstdCompressSync(execFileSync('tar', ['-C', tree, '-cf', '-', 'root'], {maxBuffer: 1 << 28}));
    const root = join(work, `fixture-0.0.1-x86_64-${hash(archive)}.tar.zst`); writeFileSync(root, archive);
    execFileSync(process.execPath, [fileURLToPath(new URL('../distribution.ts', import.meta.url)), root, out,
      '--translator', translator!, '--sods', native!, '--hot', '/usr/bin/program', '--cache', ''], {stdio: 'pipe', timeout: 25_000});
    const web = openDistribution(out);
    try {
      web.checkAll();
      const translation = web.index.translations[0], source = canonicalExecutableSource(web.index, translation);
      const file = web.index.files.find(f => f.path === source.path)!;
      assert.equal(source.binding, 'explicit');
      assert.equal(source.sha256, hash(bytes));
      assert.equal(source.size, bytes.length);
      assert.deepEqual(web.read(file), bytes);
      assert.deepEqual(web.blob(translation.elf), bytes);
      const wasm = web.blob(translation.wasm);
      assert.equal(WebAssembly.validate(wasm), true);
      t.diagnostic(JSON.stringify({source, wasmBytes: wasm.length}));
    } finally { web.close(); }
  } finally { rmSync(work, {recursive: true, force: true}); }
});
