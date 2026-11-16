import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo = fileURLToPath(new URL('..', import.meta.url));

function fixture() {
  const at = mkdtempSync(join(tmpdir(), 'ricebox-root-test-')), pkgs = join(at, 'packages');
  mkdirSync(pkgs);
  const add = (name: string, files: Record<string, string>) => {
    const dir = join(pkgs, name); mkdirSync(dir);
    for (const [path, value] of Object.entries(files)) {
      const to = join(dir, 'tree', path); mkdirSync(join(to, '..'), {recursive: true}); writeFileSync(to, value);
    }
    for (const [file, value] of [['version', '1.0'], ['source', name + '-source'], ['key', name + '-key']]) writeFileSync(join(dir, file), value);
  };
  add('base', {'usr/bin/tool': 'a neutral tool\n'});
  return {at, pkgs, add};
}
function assemble(pkgs: string, out: string) {
  const result = spawnSync('sh', [join(repo, 'module/ricebox/make/assemble.sh'), pkgs, out, '0.0.1'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const archive = readdirSync(out).find((p) => p.endsWith('.tar.zst'))!;
  assert.match(archive, /^ricebox-0\.0\.1-x86_64-[0-9a-f]{64}\.tar\.zst$/);
  return {archive: join(out, archive), manifest: readFileSync(join(out, 'manifest'), 'utf8')};
}
function read(archive: string, path: string) {
  const r = spawnSync('tar', ['--zstd', '-xOf', archive, path], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr); return r.stdout;
}
test('ricebox assembles without a why binary, compiler, or all optional recipes', () => {
  const {at, pkgs} = fixture();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const one = assemble(pkgs, join(at, 'one')), two = assemble(pkgs, join(at, 'two'));
    assert.equal(one.archive.split('/').at(-1), two.archive.split('/').at(-1));
    assert.match(read(one.archive, 'root/etc/os-release'), /ID=ricebox/);
    assert.equal(read(one.archive, 'root/usr/bin/tool'), 'a neutral tool\n');
    assert.match(one.manifest, /package.base=/);
    assert.doesNotMatch(one.manifest, /why\./);
    const list = spawnSync('tar', ['--zstd', '-tf', one.archive], {encoding: 'utf8'}).stdout;
    assert.doesNotMatch(list, /usr\/bin\/why/);
  } finally { rmSync(at, {recursive: true, force: true}); }
});
test('deployment composition adds and removes packages and preserves explicitly supplied identity', () => {
  const {at, pkgs, add} = fixture();
  try {
    add('site', {'etc/os-release': 'NAME="Site environment"\nID=site\n', 'usr/bin/site': 'site command\n'});
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\nsite 1.0 site-source\n');
    const one = assemble(pkgs, join(at, 'one'));
    assert.match(read(one.archive, 'root/etc/os-release'), /ID=site/);
    assert.match(read(one.archive, 'root/etc/apk/world'), /site/);
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const two = assemble(pkgs, join(at, 'two'));
    assert.doesNotMatch(two.manifest, /package.site=/);
    assert.doesNotMatch(read(two.archive, 'root/etc/apk/world'), /site/);
  } finally { rmSync(at, {recursive: true, force: true}); }
});

test('why composes its CLI, identity and shell extension without putting them in ricebox', () => {
  const {at, pkgs} = fixture();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const root = join(at, 'source');
    for (const path of ['why/make/root.sh', 'why/make/shell.sh', 'module/ricebox/make/assemble.sh', 'module/ricebox/make/db.ts', 'module/ricebox/make/scripts.ts', 'module/ricebox/etc/os-release', 'module/ricebox/pins/sources.env']) {
      mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), readFileSync(join(repo, path)));
    }
    const bin = join(at, 'bin'); mkdirSync(bin);
    // Substitute compilation only. The real product composition and distributor assemble the archive.
    writeFileSync(join(bin, 'cargo'), '#!/bin/sh\nmkdir -p target/x86_64-unknown-linux-musl/prompt\nprintf product-command > target/x86_64-unknown-linux-musl/prompt/why\n', {mode: 0o755});
    const out = join(at, 'out');
    const r = spawnSync('sh', [join(root, 'why/make/root.sh'), pkgs, out, '0.6.5'], {encoding: 'utf8', env: {...process.env, PATH: bin + ':' + process.env.PATH}});
    assert.equal(r.status, 0, r.stderr);
    const name = readdirSync(out).find((p) => p.endsWith('.tar.zst'))!;
    assert.match(name, /^os-length3-linux-0\.6\.5-x86_64-/);
    const archive = join(out, name);
    assert.equal(read(archive, 'root/usr/bin/why'), 'product-command');
    assert.match(read(archive, 'root/etc/os-release'), /ID=length3/);
    assert.match(read(archive, 'root/etc/profile.d/why.sh'), /Remote/);
    assert.match(read(archive, 'manifest'), /why.sha256=/);
    assert.match(read(archive, 'root/etc/apk/world'), /why/);
  } finally { rmSync(at, {recursive: true, force: true}); }
});

test('the same neutral root becomes static layers without requiring why or optional hot programs', async () => {
  const {at, pkgs} = fixture();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const {archive} = assemble(pkgs, join(at, 'root'));
    const wasm = join(at, 'translator.wasm');
    writeFileSync(wasm, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const out = join(at, 'site'), stage = join(at, 'stage');
    const r = spawnSync(process.execPath, [join(repo, 'module/ricebox/make/layers.ts'), archive, out, '--translator', wasm, '--stage', stage], {encoding: 'utf8', timeout: 30000});
    assert.equal(r.status, 0, r.stderr);
    const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8'));
    assert.equal(about.name, 'ricebox');
    const index = JSON.parse(readFileSync(join(out, about.index.path), 'utf8'));
    assert.equal(index.translations.length, 0);
    assert.ok(index.files.some((f: {path: string}) => f.path === '/usr/bin/tool'));
    const {nativeTree, webTree} = await import('../module/ricebox/make/tree.ts');
    assert.deepEqual((await webTree(out)).entries, (await nativeTree(archive)).entries);
    assert.deepEqual(readFileSync(join(stage, 'sods.wasm')), readFileSync(wasm));
  } finally { rmSync(at, {recursive: true, force: true}); }
});
