// A stand-in release root, a few files of each kind a root has, and l3 for
// the browser made from it with a stand-in translator: for tests
// (scripts/l3.test.mjs, src/prompt/userland.test.ts), so they need neither the real
// root nor Rust.
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync} from 'node:zlib';

const os = fileURLToPath(new URL('..', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A release root of a few files: a program and its links (one a hard link), set-id and sticky bits, an empty file, the package db. */
export function standIn(dir, version) {
  const tree = join(dir, 'tree'), root = join(tree, 'root');
  for (const d of ['usr/bin', 'usr/lib/apk/db', 'etc/length3', 'tmp', 'root', 'var/empty']) mkdirSync(join(root, d), {recursive: true});
  writeFileSync(join(root, 'usr/bin/busybox'), Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(4096, 7)]));
  chmodSync(join(root, 'usr/bin/busybox'), 0o755);
  symlinkSync('usr/bin', join(root, 'bin'));
  symlinkSync('busybox', join(root, 'usr/bin/sh'));
  linkSync(join(root, 'usr/bin/busybox'), join(root, 'usr/bin/busybox.same'));
  writeFileSync(join(root, 'usr/bin/su'), 'set-id\n');
  chmodSync(join(root, 'usr/bin/su'), 0o4755);
  chmodSync(join(root, 'tmp'), 0o1777);
  chmodSync(join(root, 'root'), 0o700);
  writeFileSync(join(root, 'etc/empty'), '');
  writeFileSync(join(root, 'etc/length3/shrc'), 'PS1="$ "\n'.repeat(50));
  writeFileSync(join(root, 'etc/os-release'), `NAME="OS Length3 Linux"\nID=length3\nVERSION_ID=${version}\n`);
  writeFileSync(join(root, 'usr/lib/apk/db/installed'), 'P:busybox\nV:1\nF:usr/bin\nR:busybox\nR:sh\n\n');
  writeFileSync(join(tree, 'manifest'), `version=${version}\nbase.profile=development-standard-v1\n`);
  const tar = execFileSync('tar', ['-C', tree, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=pax',
    '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime', '-cf', '-', 'manifest', 'root'], {maxBuffer: 1 << 28});
  const z = zstdCompressSync(tar);
  const file = join(dir, `os-length3-linux-${version}-x86_64-${sha(z)}.tar.zst`);
  writeFileSync(file, z);
  rmSync(tree, {recursive: true, force: true});
  return file;
}

/** l3.mjs into `dir` with a stand-in translator (kept in `work`): a wasm module with nothing in it, and a "translation" that is the same. */
export function makeL3(root, dir, work) {
  const wasm = join(work, 'xlat.wasm');
  writeFileSync(wasm, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  const xlat = join(work, 'xlat');
  writeFileSync(xlat, `#!${process.execPath}\nrequire('fs').copyFileSync(${JSON.stringify(wasm)}, process.argv[3]);\n`);
  chmodSync(xlat, 0o755);
  return spawnSync(process.execPath, [join(os, 'scripts/l3.mjs'), root, dir, '--translator', wasm, '--xlat', xlat, '--hot', '/usr/bin/busybox'], {encoding: 'utf8'});
}

