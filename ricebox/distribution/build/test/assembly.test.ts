import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {packageCache, readArchive} from '../../test/fixtures/package-cache.ts';

function assemble(pkgs: string, out: string) {
  const result = spawnSync('sh', [fileURLToPath(new URL('../assemble.sh', import.meta.url)), pkgs, out, '0.0.1'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const archive = readdirSync(out).find((p) => p.endsWith('.tar.zst'))!;
  assert.match(archive, /^ricebox-0\.0\.1-x86_64-[0-9a-f]{64}\.tar\.zst$/);
  return {archive: join(out, archive), manifest: readFileSync(join(out, 'manifest'), 'utf8')};
}
test('ricebox assembles without a why binary, compiler, or all optional recipes', () => {
  const {at, pkgs} = packageCache();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const one = assemble(pkgs, join(at, 'one')), two = assemble(pkgs, join(at, 'two'));
    assert.equal(one.archive.split('/').at(-1), two.archive.split('/').at(-1));
    assert.match(readArchive(one.archive, 'root/etc/os-release'), /ID=ricebox/);
    assert.equal(readArchive(one.archive, 'root/usr/bin/tool'), 'a neutral tool\n');
    assert.match(one.manifest, /package.base=/);
    assert.doesNotMatch(one.manifest, /why\./);
    const list = spawnSync('tar', ['--zstd', '-tf', one.archive], {encoding: 'utf8'}).stdout;
    assert.doesNotMatch(list, /usr\/bin\/why/);
  } finally { rmSync(at, {recursive: true, force: true}); }
});
test('deployment composition adds and removes packages and preserves explicitly supplied identity', () => {
  const {at, pkgs, add} = packageCache();
  try {
    add('site', {'etc/os-release': 'NAME="Site environment"\nID=site\n', 'usr/bin/site': 'site command\n'});
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\nsite 1.0 site-source\n');
    const one = assemble(pkgs, join(at, 'one'));
    assert.match(readArchive(one.archive, 'root/etc/os-release'), /ID=site/);
    assert.match(readArchive(one.archive, 'root/etc/apk/world'), /site/);
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const two = assemble(pkgs, join(at, 'two'));
    assert.doesNotMatch(two.manifest, /package.site=/);
    assert.doesNotMatch(readArchive(two.archive, 'root/etc/apk/world'), /site/);
  } finally { rmSync(at, {recursive: true, force: true}); }
});

test('the same neutral root becomes static layers without requiring why or optional hot programs', async () => {
  const {at, pkgs} = packageCache();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const {archive} = assemble(pkgs, join(at, 'root'));
    const wasm = join(at, 'translator.wasm');
    writeFileSync(wasm, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const out = join(at, 'site'), stage = join(at, 'stage');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../distribution.ts', import.meta.url)), archive, out, '--translator', wasm, '--stage', stage], {encoding: 'utf8', timeout: 30000});
    assert.equal(r.status, 0, r.stderr);
    const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8'));
    assert.equal(about.name, 'ricebox');
    const index = JSON.parse(readFileSync(join(out, about.index.path), 'utf8'));
    assert.equal(index.translations.length, 0);
    assert.ok(index.files.some((f: {path: string}) => f.path === '/usr/bin/tool'));
    const {nativeTree, webTree} = await import('../../verification/inventory.ts');
    const web = webTree(out);
    assert.deepEqual(web.entries, (await nativeTree(archive)).entries);
    const extracted = join(at, 'extracted'); mkdirSync(extracted);
    const extraction = spawnSync('tar', ['--zstd', '--same-permissions', '-xf', archive, '-C', extracted], {encoding: 'utf8'});
    assert.equal(extraction.status, 0, extraction.stderr);
    const nativeRoot = join(extracted, 'root');
    assert.deepEqual((await nativeTree(nativeRoot)).entries, web.entries);
    // Same path, size and mode: parity must compare the actual body digest.
    writeFileSync(join(nativeRoot, 'usr/bin/tool'), 'a mutated tool\n');
    const {differences} = await import('../../format/inventory.ts');
    const changed = differences(await nativeTree(nativeRoot), web);
    assert.equal(changed.same, false);
    assert.deepEqual(changed.missing, []);
    assert.deepEqual(changed.extra, []);
    assert.deepEqual(changed.changed.map(entry => entry.path), ['/usr/bin/tool']);
    assert.deepEqual(readFileSync(join(stage, 'sods.wasm')), readFileSync(wasm));
  } finally { rmSync(at, {recursive: true, force: true}); }
});

test('layers keep identical translated artifacts when the build cache is reused', async () => {
  const at = mkdtempSync(join(tmpdir(), 'ricebox-layers-test-'));
  try {
    const {standIn, makeWebroot} = await import('../../test/fixtures/distribution.ts');
    const archive = standIn(at, '9.9.9');
    const one = join(at, 'one'), two = join(at, 'two');
    for (const out of [one, two]) { const r = makeWebroot(archive, out, at); assert.equal(r.status, 0, r.stderr); }
    const about = JSON.parse(readFileSync(join(one, 'webroot.json'), 'utf8'));
    assert.equal(about.name, 'ricebox');
    const a = readFileSync(join(one, about.index.path));
    const b = readFileSync(join(two, about.index.path));
    assert.deepEqual(a, b);
    assert.equal(JSON.parse(a.toString()).translations.length, 1);
    assert.equal(readdirSync(join(at, 'aot-cache')).length, 1);
  } finally { rmSync(at, {recursive: true, force: true}); }
});
