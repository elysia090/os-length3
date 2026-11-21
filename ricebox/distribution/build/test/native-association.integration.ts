// Exercise AOT production with a native translator, its Wasm companion and a Linux ELF.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync} from 'node:zlib';
import {openDistribution} from '../../deployment/local.ts';
import {canonicalExecutableSource} from '../../format/executable-source.ts';

test('actual producer emits a compatible explicit binding with a supplied native translator and real ELF',
  {timeout: 30_000}, t => {
  const {SODS_NATIVE: native, SODS_TRANSLATOR_WASM: translator, RICEBOX_AOT_ELF: program} = process.env;
  assert.ok(native && translator && program, 'Set SODS_NATIVE, SODS_TRANSLATOR_WASM and RICEBOX_AOT_ELF');
  const work = mkdtempSync(join(tmpdir(), 'ricebox-native-association-')), out = join(work, 'layers');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  try {
    const tree = join(work, 'tree');
    mkdirSync(join(tree, 'root/usr/bin'), {recursive: true}); mkdirSync(join(tree, 'root/etc'));
    const bytes = readFileSync(program);
    writeFileSync(join(tree, 'root/usr/bin/program'), bytes, {mode: 0o755});
    writeFileSync(join(tree, 'root/etc/os-release'), 'NAME=fixture\nVERSION_ID=0.0.1\n');
    const archive = zstdCompressSync(execFileSync('tar', ['-C', tree, '-cf', '-', 'root'], {maxBuffer: 1 << 28}));
    const root = join(work, `fixture-0.0.1-x86_64-${hash(archive)}.tar.zst`); writeFileSync(root, archive);
    execFileSync(process.execPath, [fileURLToPath(new URL('../distribution.ts', import.meta.url)), root, out,
      '--translator', translator, '--sods', native, '--hot', '/usr/bin/program', '--cache', ''], {stdio: 'pipe', timeout: 25_000});
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
