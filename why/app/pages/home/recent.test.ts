import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recentScope, RecentSnapshot} from './recent.ts';

const a = {url: 'https://one.invalid', user: 'a', session: 'one'};
const b = {...a, user: 'b', session: 'two'};
const A = recentScope(a), B = recentScope(b);

test('Recent holds a single account and Remote, not any account at the same address', () => {
  const recent = new RecentSnapshot<string[]>();
  recent.keep(A, recent.begin(A), ['first account']);
  assert.deepEqual(recent.read(recentScope({...a, session: 'renewed'})), ['first account']);
  assert.equal(recent.read(B), undefined);
  recent.keep(A, recent.begin(A), ['first Remote']);
  assert.equal(recent.read(recentScope({...a, url: 'https://two.invalid'})), undefined);
  assert.equal(recent.read(A), undefined);
});

test('an unknown account shares Recent with no other session or named account', () => {
  const unknown = {...a, user: undefined};
  const anonymous = recentScope(unknown);
  assert.notEqual(anonymous, recentScope({...unknown, session: 'two'}));
  assert.notEqual(anonymous, recentScope({...a, user: unknown.session}));
  assert.notEqual(anonymous, null);
});

test('logout drops the snapshot and cannot resurrect an earlier read, even when the same account returns', () => {
  const recent = new RecentSnapshot<string[]>();
  const before = recent.begin(A);
  assert.ok(recent.keep(A, before, ['old account']));
  const late = recent.begin(A);
  assert.equal(recent.read(null), undefined);
  assert.equal(recent.read(A), undefined);
  assert.equal(recent.current(A, late), false);
  assert.equal(recent.keep(A, late, ['late account']), false);
  assert.equal(recent.read(A), undefined);
});

test("an answer from the previous account cannot replace the current account's snapshot", async () => {
  const recent = new RecentSnapshot<string[]>();
  const earlier = recent.begin(A);
  let answer!: () => void;
  const pending = new Promise<void>((done) => { answer = done; }).then(() => recent.keep(B, earlier, ['other account']));
  assert.ok(recent.keep(B, recent.begin(B), ['current account']));
  answer();
  assert.equal(await pending, false);
  assert.deepEqual(recent.read(B), ['current account']);
});

test('only the latest read can replace even a same-account Recent snapshot', async () => {
  const recent = new RecentSnapshot<string[]>();
  recent.keep(A, recent.begin(A), ['visible until replaced']);
  const earlier = recent.begin(A);
  let answer!: () => void;
  const pending = new Promise<void>((done) => { answer = done; }).then(() => recent.keep(A, earlier, ['old answer']));
  const later = recent.begin(A);
  assert.deepEqual(recent.read(A), ['visible until replaced']);
  assert.ok(recent.keep(A, later, ['latest answer']));
  answer();
  assert.equal(await pending, false);
  assert.deepEqual(recent.read(A), ['latest answer']);
});
