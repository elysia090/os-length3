import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dayOf, farFrom, onTop, pageOf, RUN_MS, sameRun, type Post} from './servers.ts';

const post = (id: string): Post => ({id, by: 'ren@length3.test', body: id, at: 0});

test('a page is the range of ids it was read as, newest first', () => {
  assert.equal(pageOf([]), null);
  assert.deepEqual(pageOf(['c', 'b', 'a'].map(post)), {newest: 'c', oldest: 'a', posts: ['c', 'b', 'a'].map(post)});
});

test('what came after, oldest first, goes on top as pages, newest page first and each newest first', () => {
  const came = ['d', 'e', 'f', 'g', 'h'].map(post);
  const pages = onTop(came, 2);
  assert.deepEqual(pages.map((p) => [p.newest, p.oldest]), [['h', 'h'], ['g', 'f'], ['e', 'd']]);
  assert.deepEqual(pages.flatMap((p) => p.posts!.map((q) => q.id)), ['h', 'g', 'f', 'e', 'd']);
});

test('only pages far from every one in view let go of their posts', () => {
  assert.deepEqual(farFrom(20, [], 2), []);
  assert.deepEqual(farFrom(10, [4, 5], 2), [0, 1, 8, 9]);
  assert.deepEqual(farFrom(5, [0], 8), []);
});

test('one address\'s posts close together are one run; a day starts anew', () => {
  const at = (id: string, by: string, ms: number): Post => ({...post(id), by, at: ms});
  const a = at('a', 'ren@x', 0);
  assert.equal(sameRun(undefined, a), false);
  assert.equal(sameRun(a, at('b', 'ren@x', 60_000)), true);
  assert.equal(sameRun(a, at('c', 'aoi@x', 60_000)), false);
  assert.equal(sameRun(a, at('d', 'ren@x', RUN_MS)), false);
  const noon = new Date(2026, 9, 17, 12).getTime();
  assert.equal(dayOf(noon), dayOf(noon + 3600_000));
  assert.notEqual(dayOf(noon), dayOf(noon + 13 * 3600_000));
});
