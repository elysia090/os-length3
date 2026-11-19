import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {packageCache, readArchive} from '../../ricebox/distribution/test/fixtures/package-cache.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

test('why composes its CLI, identity and shell extension without putting them in ricebox', () => {
  const {at, pkgs} = packageCache();
  try {
    writeFileSync(join(pkgs, 'record'), 'base 1.0 base-source\n');
    const root = join(at, 'source');
    for (const path of ['why/VERSION', 'why/build/guest-root.sh', 'why/build/profile.sh', 'ricebox/distribution/build/assemble.sh', 'ricebox/distribution/build/package-database.ts', 'ricebox/distribution/build/script-interpreters.ts', 'ricebox/distribution/etc/os-release', 'ricebox/distribution/pins/sources.env']) {
      mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), readFileSync(join(repo, path)));
    }
    const bin = join(at, 'bin'); mkdirSync(bin);
    // Substitute compilation only. The real product composition and distributor assemble the archive.
    writeFileSync(join(bin, 'cargo'), '#!/bin/sh\nmkdir -p target/x86_64-unknown-linux-musl/prompt\nprintf product-command > target/x86_64-unknown-linux-musl/prompt/why\n', {mode: 0o755});
    const out = join(at, 'out');
    const r = spawnSync('sh', [join(root, 'why/build/guest-root.sh'), pkgs, out, '0.6.5'], {encoding: 'utf8', env: {...process.env, PATH: bin + ':' + process.env.PATH}});
    assert.equal(r.status, 0, r.stderr);
    const name = readdirSync(out).find((p) => p.endsWith('.tar.zst'))!;
    assert.match(name, /^os-length3-linux-0\.6\.5-x86_64-/);
    const archive = join(out, name);
    assert.equal(readArchive(archive, 'root/usr/bin/why'), 'product-command');
    const identity = readArchive(archive, 'root/etc/os-release');
    assert.match(identity, /^NAME="ricebox"$/m);
    assert.match(identity, /^ID=ricebox$/m);
    assert.match(identity, /^VERSION_ID=0\.6\.5$/m);
    assert.match(identity, /^PRETTY_NAME="ricebox 0\.6\.5"$/m);
    assert.match(readArchive(archive, 'root/etc/profile.d/why.sh'), /Remote/);
    const manifest = readArchive(archive, 'manifest');
    assert.match(manifest, /^version=0\.6\.5$/m);
    assert.match(manifest, /^package\.why=0\.0\.1 /m);
    assert.match(manifest, /^why\.sha256=/m);
    assert.match(readArchive(archive, 'root/etc/apk/world'), /why/);
  } finally { rmSync(at, {recursive: true, force: true}); }
});
