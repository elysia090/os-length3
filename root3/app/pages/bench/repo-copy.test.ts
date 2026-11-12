import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Change} from '../../repos/repos.ts';
import {mirror} from './repo-copy.ts';
import type {Source} from './repo-copy.ts';

/** A repo's changes told by hand, and its files' bytes as the test says they are (a path not there cannot be read). */
function told(files: Record<string, Uint8Array | Promise<Uint8Array>> = {}) {
  const heard = new Set<(c: Change) => void>();
  const source: Source = {
    onChange: (listen) => { heard.add(listen); return () => heard.delete(listen); },
    bytes: async (_repo, path) => { if (!(path in files)) throw new Error(`There is no ${path}`); return files[path]; },
  };
  return {source, tell: (c: Change) => { for (const f of heard) f(c); }};
}
const dec = new TextDecoder();
/** What was put, a line each: a file's bytes as text, a folder, or gone. */
const line = (m: {path: string; what: Uint8Array | 'dir' | null}) =>
  `${m.path} ${m.what === null ? 'gone' : m.what === 'dir' ? 'dir' : JSON.stringify(dec.decode(m.what))}`;
const settled = () => new Promise<void>((done) => setTimeout(done, 20));

test('what is saved elsewhere reaches the shell\'s copy: a file as its text, a folder, a removal; the shell\'s own and the repo as a whole do not', async () => {
  const {source, tell} = told();
  const put: string[] = [];
  const stop = mirror('notes', 'shell-1', (m) => put.push(line(m)), source);
  tell({repo: 'notes', path: 'a.md', what: 'file', text: 'a\n'});
  tell({repo: 'notes', path: 'docs', what: 'dir'});
  tell({repo: 'notes', path: 'old.md', what: 'removed'});
  tell({repo: 'notes', path: 'mine.md', what: 'file', text: 'mine\n', by: 'shell-1'});
  tell({repo: 'trip', path: 'b.md', what: 'file', text: 'b\n'});
  tell({repo: 'notes', path: '', what: 'repo'});
  await settled();
  stop();
  assert.deepEqual(put, ['a.md "a\\n"', 'docs dir', 'old.md gone']);
});

test('a file told unread is read again and put as its bytes, never as an empty file; an empty file is put empty', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]);
  const {source, tell} = told({'mark.png': png});
  const put: {path: string; what: Uint8Array | 'dir' | null}[] = [];
  const stop = mirror('notes', 'shell-1', (m) => put.push(m), source);
  tell({repo: 'notes', path: 'mark.png', what: 'unread'});
  tell({repo: 'notes', path: 'empty.txt', what: 'file', text: ''});
  // Not to be read (too large for the copy, or gone again): the copy keeps what it has, nothing is put.
  tell({repo: 'notes', path: 'huge.bin', what: 'unread'});
  await settled();
  stop();
  assert.deepEqual(put.map((m) => m.path), ['mark.png', 'empty.txt']);
  assert.deepEqual(put[0].what, png);
  assert.deepEqual(put[1].what, new Uint8Array());
});

test('what was saved after a file being read again does not reach the copy before it; nothing is put once stopped', async () => {
  let ready!: (bytes: Uint8Array) => void;
  const slow = new Promise<Uint8Array>((done) => { ready = done; });
  const {source, tell} = told({'big.bin': slow});
  const put: string[] = [];
  const stop = mirror('notes', 'shell-1', (m) => put.push(line(m)), source);
  tell({repo: 'notes', path: 'big.bin', what: 'unread'});
  tell({repo: 'notes', path: 'big.bin', what: 'removed'});
  tell({repo: 'notes', path: 'after.md', what: 'file', text: 'after\n'});
  await settled();
  assert.deepEqual(put, []);
  ready(new TextEncoder().encode('bytes'));
  await settled();
  assert.deepEqual(put, ['big.bin "bytes"', 'big.bin gone', 'after.md "after\\n"']);
  // A move is the old path gone and what is at the new one, in that order.
  tell({repo: 'notes', path: 'after.md', what: 'removed', to: 'later.md'});
  tell({repo: 'notes', path: 'later.md', what: 'file', text: 'after\n', from: 'after.md'});
  await settled();
  assert.deepEqual(put.slice(3), ['after.md gone', 'later.md "after\\n"']);
  stop();
  tell({repo: 'notes', path: 'late.md', what: 'file', text: 'late\n'});
  await settled();
  assert.equal(put.length, 5);
});
