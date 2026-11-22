import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {packageCache, readArchive} from '../../test/fixtures/package-cache.ts';
import {openDistribution} from '../../deployment/local.ts';

function runAssembly(pkgs: string, out: string, topology?: string) {
  const args = [fileURLToPath(new URL('../assemble.sh', import.meta.url)), pkgs, out];
  if (topology !== undefined) args.push('0.0.1', 'ricebox', topology);
  return spawnSync('sh', args, {encoding: 'utf8'});
}

function assemble(pkgs: string, out: string, topology?: string) {
  const result = runAssembly(pkgs, out, topology);
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
    assert.match(readArchive(one.archive, 'root/etc/os-release'), /^VERSION_ID=0\.0\.1$/m);
    assert.equal(readArchive(one.archive, 'root/usr/bin/tool'), 'a neutral tool\n');
    assert.match(one.manifest, /package.base=/);
    assert.match(one.manifest, /^version=0\.0\.1$/m);
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

const amd64Topology = 'amd64-glibc-lib64-v1';
function glibcLayout() {
  const {at, pkgs, add} = packageCache();
  const loader = 'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
  add('glibc', {[loader]: ''});
  const tree = join(pkgs, 'glibc', 'tree');
  mkdirSync(join(tree, 'usr/lib64'));
  symlinkSync('../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', join(tree, 'usr/lib64/ld-linux-x86-64.so.2'));
  for (const d of ['usr', 'usr/lib', 'usr/lib64', 'usr/lib/x86_64-linux-gnu', loader]) chmodSync(join(tree, d), 0o755);
  chmodSync(join(pkgs, 'base/tree/usr'), 0o755);
  // Header metadata only: this fixture is never an executable or interpreter.
  const header = Buffer.alloc(64);
  header.set([0x7f, 69, 76, 70, 2, 1, 1]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(62, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(header.length, 52);
  writeFileSync(join(tree, loader), header);
  writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\nglibc 1.0 glibc-source\n');
  return {at, pkgs, tree, loader, header};
}

test('only the fixed producer opt-in adds the amd64 interpreter alias', async () => {
  const {at, pkgs} = glibcLayout();
  try {
    const ordinary = assemble(pkgs, join(at, 'ordinary'));
    writeFileSync(join(pkgs, 'manifest'), 'fixture.source=headers'); // No trailing newline.
    const opted = assemble(pkgs, join(at, 'opted'), amd64Topology);
    const {nativeTree} = await import('../../verification/inventory.ts');
    const normal = await nativeTree(ordinary.archive), withAlias = await nativeTree(opted.archive);
    assert.equal(normal.entries.some(e => e.path === '/lib64'), false);
    assert.deepEqual(withAlias.entries.find(e => e.path === '/lib64'),
      {path: '/lib64', type: 'link', mode: 0o777, target: 'usr/lib64'});
    assert.deepEqual(withAlias.entries.filter(e => e.path !== '/lib64'), normal.entries);
    assert.doesNotMatch(ordinary.manifest, /^root\.topology=/m);
    assert.match(opted.manifest, /^fixture\.source=headers\nroot\.topology=amd64-glibc-lib64-v1$/m);
    writeFileSync(join(pkgs, 'manifest'), 'root.topology=amd64-glibc-lib64-v1\n');
    const labelOnly = join(at, 'label-only');
    assert.match(runAssembly(pkgs, labelOnly).stderr, /root\.topology is reserved for the assembler/);
    assert.equal(existsSync(labelOnly), false);
  } finally { rmSync(at, {recursive: true, force: true}); }
});

test('the generated alias does not accept another architecture or package ownership', () => {
  const {at, pkgs, tree, loader, header} = glibcLayout();
  try {
    const wrong = join(at, 'wrong-architecture');
    header.writeUInt16LE(183, 18); // AArch64 metadata, not executed.
    writeFileSync(join(tree, loader), header);
    assert.match(runAssembly(pkgs, wrong, amd64Topology).stderr, /needs an ELF64 little-endian x86-64 loader/);
    assert.equal(existsSync(wrong), false);

    symlinkSync('usr/lib64', join(tree, 'lib64'));
    const owned = join(at, 'package-alias'), ordinary = join(at, 'ordinary-package-alias');
    assert.match(runAssembly(pkgs, owned, amd64Topology).stderr, /glibc claims the generated \/lib64 path/);
    assert.match(runAssembly(pkgs, ordinary).stderr, /root-db: glibc puts lib64 at the root's top/);
    assert.equal(existsSync(owned) || existsSync(ordinary), false);
  } finally { rmSync(at, {recursive: true, force: true}); }
});

test('the same neutral root becomes static layers without requiring why or optional hot programs', async () => {
  const {at, pkgs} = packageCache();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const {archive} = assemble(pkgs, join(at, 'root'));
    const wasm = join(at, 'translator.wasm');
    writeFileSync(wasm, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const out = join(at, 'site');
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../distribution.ts', import.meta.url)), archive, out, '--translator', wasm], {encoding: 'utf8', timeout: 30000});
    assert.equal(r.status, 0, r.stderr);
    const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8'));
    assert.equal(about.name, 'ricebox');
    const index = JSON.parse(readFileSync(join(out, about.index.path), 'utf8'));
    assert.equal(about.version, '0.0.1');
    assert.equal(about.file, archive.split('/').at(-1));
    assert.equal(about.sha256, /([0-9a-f]{64})\.tar\.zst$/.exec(archive)?.[1]);
    assert.equal(index.version, about.version);
    assert.equal(index.sha256, about.sha256);
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
    const release = openDistribution(out);
    try { assert.deepEqual(release.blob(release.index.translator), readFileSync(wasm)); }
    finally { release.close(); }
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
