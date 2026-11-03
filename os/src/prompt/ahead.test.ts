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

const root = ['/usr/bin/busybox', '/usr/bin/git', '/usr/bin/you', '/usr/bin/grep', '/usr/bin/rg', '/usr/bin/fd', '/usr/bin/jq', '/usr/bin/make',
  '/usr/bin/curl', '/usr/bin/tar', '/usr/bin/gcc', '/usr/bin/as', '/usr/bin/ld', '/usr/bin/ld.bfd',
  '/usr/libexec/gcc/x86_64-alpine-linux-musl/16.2.0/cc1', '/usr/libexec/gcc/x86_64-alpine-linux-musl/16.2.0/collect2', '/usr/bin/lazygit'];

test('what anyone reaches for is translated ahead, in that order; nothing hot, nothing the root has not, nothing not a program', () => {
  assert.deepEqual(aheadFor(index(root)), ['/usr/bin/grep', '/usr/bin/rg', '/usr/bin/fd', '/usr/bin/jq', '/usr/bin/make', '/usr/bin/curl', '/usr/bin/tar']);
  const list = aheadFor(index(root.filter((p) => p !== '/usr/bin/fd')));
  assert.deepEqual(list, ['/usr/bin/grep', '/usr/bin/rg', '/usr/bin/jq', '/usr/bin/make', '/usr/bin/curl', '/usr/bin/tar']);
  assert.ok(!list.includes('/usr/bin/git') && !list.includes('/usr/bin/busybox') && !list.includes('/etc/gitconfig'));
});

test('what building C runs is not translated in the browser: the heavy are the release\'s to translate', () => {
  const list = aheadFor(index(root));
  for (const p of ['/usr/bin/gcc', '/usr/bin/as', '/usr/bin/ld', '/usr/bin/ld.bfd']) assert.ok(!list.includes(p), p);
  assert.ok(!list.some((p) => /\/(cc1|collect2)$/.test(p)));
});
