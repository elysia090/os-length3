import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Change} from '../../../repo/repos.ts';
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


// Writeback is a why repo adapter, not an implicit persistent disk in ricebox.
import {store} from '../../../repo/repos.ts';
import {WriteBack} from './repo-copy.ts';

function journal(t: import('node:test').TestContext) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const memory: Record<string, string> = {};
  Object.defineProperties(memory, {
    setItem: {value: (k: string, v: string) => { memory[k] = v; }},
    getItem: {value: (k: string) => memory[k] ?? null},
    removeItem: {value: (k: string) => { delete memory[k]; }},
  });
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: memory});
  t.after(() => { if (before) Object.defineProperty(globalThis, 'sessionStorage', before); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  return memory;
}
const changed = (bytes = new Uint8Array([1])) => ({dirs: [], files: [{path: 'same.txt', bytes, existed: true}], removed: []});

test('completed writes release the pending file allowance instead of exhausting a long session', async (t) => {
  journal(t);
  let written = 0;
  t.mock.method(store, 'put', async () => { written++; return 1; });
  const skipped: string[] = [];
  const copy = new WriteBack('notes', 'shell', (s) => skipped.push(s));
  for (let i = 0; i < 2001; i++) { copy.write(changed()); await new Promise<void>((r) => setImmediate(r)); }
  assert.equal(written, 2001);
  assert.deepEqual(skipped, []);
});

test('completed writes release the pending byte allowance', async (t) => {
  journal(t);
  let written = 0;
  t.mock.method(store, 'put', async () => { written++; return 1; });
  const copy = new WriteBack('notes', 'shell', () => {});
  const bytes = new Uint8Array(1 << 20);
  for (let i = 0; i < 33; i++) { copy.write(changed(bytes)); await new Promise<void>((r) => setImmediate(r)); }
  assert.equal(written, 33);
});

test('failed writes keep their recovery journal and later writes cannot be replayed behind them', async (t) => {
  const kept = journal(t);
  let calls = 0;
  t.mock.method(store, 'put', async () => { if (++calls === 1) throw new Error('disk temporarily unavailable'); return 1; });
  const skipped: string[] = [];
  const copy = new WriteBack('notes', 'shell', (s) => skipped.push(s));
  copy.write(changed(new Uint8Array([1])));
  await settled();
  assert.equal(Object.keys(kept).length, 1, 'the failed write must survive a reload');
  copy.write(changed(new Uint8Array([2])));
  await settled();
  assert.equal(Object.keys(kept).length, 2, 'retain later values too so replay cannot restore the older value last');
  assert.equal(skipped.length, 1);
});

test('pending writes stay bounded, and successful batches leave no journal', async (t) => {
  const kept = journal(t);
  let release!: () => void, written = 0;
  const gate = new Promise<void>((r) => { release = r; });
  t.mock.method(store, 'put', async () => { await gate; written++; return 1; });
  const skipped: string[] = [];
  const copy = new WriteBack('bounded', 'shell', (s) => skipped.push(s));
  for (let i = 0; i < 2001; i++) copy.write(changed());
  release();
  await settled();
  assert.equal(written, 2000);
  assert.equal(skipped.length, 1);
  assert.equal(Object.keys(kept).length, 0);
  copy.write(changed());
  await settled();
  assert.equal(written, 2001);
});

test('recovery ordering is shared by simultaneous shells of the same repo, not unrelated repos', async (t) => {
  const kept = journal(t);
  let fail = true;
  t.mock.method(store, 'put', async () => { if (fail) throw new Error('refused'); return 1; });
  const a = new WriteBack('shared', 'shell-a', () => {});
  const b = new WriteBack('shared', 'shell-b', () => {});
  const other = new WriteBack('unrelated', 'shell-c', () => {});
  a.write(changed());
  await settled();
  fail = false;
  b.write(changed(new Uint8Array([2])));
  other.write(changed());
  await settled();
  const journals = Object.values(kept).map((v) => JSON.parse(v));
  assert.deepEqual(journals.map((j) => j.repo), ['shared', 'shared']);
  assert.deepEqual(journals.map((j) => j.files[0].b64), ['AQ==', 'Ag==']);
});

test('two shells serialize writes to the same repo before acknowledging their journals', async (t) => {
  const kept = journal(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: number[] = [];
  t.mock.method(store, 'put', async (_repo: string, _path: string, bytes: Uint8Array) => {
    calls.push(bytes[0]);
    if (bytes[0] === 1) { await gate; throw new Error('late refusal'); }
    return 1;
  });
  const a = new WriteBack('concurrent', 'a', () => {});
  const b = new WriteBack('concurrent', 'b', () => {});
  a.write(changed(new Uint8Array([1])));
  b.write(changed(new Uint8Array([2])));
  await settled();
  assert.deepEqual(calls, [1]);
  release();
  await settled();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(Object.keys(kept).length, 2);
});

test('why excludes git metadata in both directions without imposing that policy on sods', async (t) => {
  journal(t);
  const hidden = ['.git/config', '.GIT/config', '.Git./x', '.git /x', 'git~1/hooks', '.g\u200cit/config', 'nested/.git/x'];
  const {source, tell} = told();
  const reached: string[] = [];
  const stop = mirror('policy', 'shell', (m) => reached.push(m.path), source);
  for (const path of [...hidden, '.gitignore', '.github/workflows/test.yml']) tell({repo: 'policy', path, what: 'file', text: 'x'});
  const written: string[] = [];
  t.mock.method(store, 'put', async (_r: string, path: string) => { written.push(path); return 1; });
  t.mock.method(store, 'mkdir', async (_r: string, path: string) => { written.push(path); });
  t.mock.method(store, 'remove', async (_r: string, path: string) => { written.push(path); });
  new WriteBack('policy', 'shell', () => {}).write({dirs: hidden, files: [...hidden, '.gitignore'].map((path) => ({path, bytes: new Uint8Array([1]), existed: false})), removed: hidden});
  await settled(); stop();
  assert.deepEqual(reached, ['.gitignore', '.github/workflows/test.yml']);
  assert.deepEqual(written, ['.gitignore']);
});

test('write receipt waits for a slow store and does not turn waiter timeout into consumption', async (t) => {
  journal(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(store, 'put', async () => { await gate; return 1; });
  const receipt = new WriteBack('slow-receipt', 'shell', () => {}).write(changed());
  assert.equal(await Promise.race([receipt.then(() => 'completed'), new Promise(resolve => setTimeout(() => resolve('waiting'), 5))]), 'waiting');
  release();
  assert.deepEqual(await receipt, {storeAccepted: true, excluded: 0, skipped: [], journalCreated: true});
});

test('write receipt distinguishes excluded paths, failed store paths, and notification failure', async (t) => {
  journal(t);
  const notification = new Error('diagnostic failed');
  t.mock.method(store, 'put', async () => { throw new Error('store refused'); });
  const copy = new WriteBack('receipt-failure', 'shell', () => { throw notification; });
  const result = await copy.write({dirs: ['.git'], files: [{path: '.git/config', bytes: new Uint8Array([0]), existed: false}, ...changed().files], removed: []});
  assert.equal(result.storeAccepted, false); assert.equal(result.excluded, 2);
  assert.deepEqual(result.skipped, ['same.txt']); assert.equal(result.notificationFailure, notification);
  assert.equal(result.failure, undefined);
  // A diagnostic failure is not a failed predecessor that blocks later work.
  t.mock.method(store, 'put', async () => 1);
  assert.equal((await copy.write(changed())).storeAccepted, true);
});

test('unexpected partial failure and blocked successor return outcomes without rolling back the prefix', async (t) => {
  const kept = journal(t), calls: string[] = [], failure = new Error('synchronous sink failure');
  t.mock.method(store, 'put', (_repo: string, path: string) => {
    calls.push(path);
    if (path === 'second') throw failure;
    return Promise.resolve(1);
  });
  const copy = new WriteBack('receipt-prefix', 'shell', () => {});
  const first = copy.write({dirs: [], files: ['first', 'second', 'third'].map(path => ({path, bytes: new Uint8Array([1]), existed: false})), removed: []});
  const second = copy.write(changed());
  const results = await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.ok(results.every(result => !result.storeAccepted && result.failure === failure));
  assert.equal(Object.keys(kept).length, 2);
  // The drained queue can accept a new batch, while recovery journals remain.
  assert.equal((await copy.write(changed())).storeAccepted, true);
  assert.deepEqual(calls, ['first', 'second', 'same.txt']);
});
