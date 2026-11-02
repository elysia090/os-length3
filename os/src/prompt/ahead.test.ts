import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aheadFor} from './ahead.ts';
import type {Index} from './userland.ts';

/** An index of these programs (each executable), the hot ones translated in the release. */
function index(programs: string[], hot: string[] = ['/usr/bin/busybox', '/usr/bin/git']): Index {
  return {
    name: 'l3', version: '0', sha256: '', codec: 'zstd', packs: [{name: 'p.pack', owner: 'p', bytes: 0}], dirs: [], links: [],
    files: [...programs, '/etc/gitconfig'].map((path, k) => ({path, mode: path.startsWith('/etc') ? 0o644 : 0o755, size: 1, pack: 0, at: k, len: 1})),
    translator: {path: '', sha256: '', size: 0, bytes: 0, name: 'xlat', version: '0', wasm: ''},
    translations: hot.map((path) => ({path, sha256: '', elf: {path: '', sha256: '', size: 0, bytes: 0}, wasm: {path: '', sha256: '', size: 0, bytes: 0}})),
  };
}

const root = ['/usr/bin/busybox', '/usr/bin/git', '/usr/bin/grep', '/usr/bin/rg', '/usr/bin/fd', '/usr/bin/jq', '/usr/bin/make',
  '/usr/bin/curl', '/usr/bin/tar', '/usr/bin/gcc', '/usr/bin/as', '/usr/bin/ld', '/usr/bin/ld.bfd',
  '/usr/libexec/gcc/x86_64-alpine-linux-musl/16.2.0/cc1', '/usr/libexec/gcc/x86_64-alpine-linux-musl/16.2.0/collect2', '/usr/bin/lazygit'];

test('a repo with C has what building it runs translated ahead first, cc1 among them, then what anyone reaches for', () => {
  const list = aheadFor(index(root), ['/root/web/src/main.c', '/root/web/README.md']);
  assert.deepEqual(list.slice(0, 6), ['/usr/bin/gcc', '/usr/libexec/gcc/x86_64-alpine-linux-musl/16.2.0/cc1',
    '/usr/libexec/gcc/x86_64-alpine-linux-musl/16.2.0/collect2', '/usr/bin/as', '/usr/bin/ld', '/usr/bin/ld.bfd']);
  assert.deepEqual(list.slice(6), ['/usr/bin/grep', '/usr/bin/rg', '/usr/bin/fd', '/usr/bin/jq', '/usr/bin/make', '/usr/bin/curl', '/usr/bin/tar']);
  // A Makefile alone says C as well.
  assert.ok(aheadFor(index(root), ['/root/web/Makefile']).includes('/usr/bin/gcc'));
});

test('a repo without C has only what anyone reaches for; nothing hot, nothing the root has not, nothing not a program', () => {
  const list = aheadFor(index(root.filter((p) => p !== '/usr/bin/fd')), ['/root/site/index.html', '/root/site/notes.md']);
  assert.deepEqual(list, ['/usr/bin/grep', '/usr/bin/rg', '/usr/bin/jq', '/usr/bin/make', '/usr/bin/curl', '/usr/bin/tar']);
  assert.ok(!list.includes('/usr/bin/git') && !list.includes('/usr/bin/busybox') && !list.includes('/etc/gitconfig'));
});
