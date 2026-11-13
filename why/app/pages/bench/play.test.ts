import {test} from 'node:test';
import assert from 'node:assert/strict';
import {differing} from './play.ts';

test('an edit goes over only what differs: what the old and new begin and end with alike stays', () => {
  assert.deepEqual(differing('# garden', '# garden\n\nCount the lines'), {at: 8, old: '', new: '\n\nCount the lines'});
  assert.deepEqual(differing('echo "$count lines"', 'echo "$n lines"'), {at: 7, old: 'count', new: 'n'});
  assert.deepEqual(differing('abc', 'xyz'), {at: 0, old: 'abc', new: 'xyz'});
  // A repeated letter at the seam is counted once, never twice.
  assert.deepEqual(differing('aa', 'aaa'), {at: 2, old: '', new: 'a'});
  // A character of two halves is never split.
  assert.deepEqual(differing('x😀', 'x😃'), {at: 1, old: '😀', new: '😃'});
});
