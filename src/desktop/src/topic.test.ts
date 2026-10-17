import assert from 'node:assert/strict';
import {test} from 'node:test';
import {farFrom, onTop, pageOf, type Post} from './topic.ts';

const post = (id: string): Post => ({id, address: 'ren@length3.test', name: 'Ren', body: id, at: 0, mine: false});

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
