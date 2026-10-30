import assert from 'node:assert/strict';
import {test} from 'node:test';
import {counts, lineOps} from './linediff.ts';

test('lines are counted as git counts them for a small edit', () => {
  assert.deepEqual(counts(lineOps('a\nb\nc\n', 'a\nB\nc\nd\n')), {added: 2, removed: 1});
  assert.deepEqual(counts(lineOps('', 'x\n')), {added: 1, removed: 0});
  assert.deepEqual(counts(lineOps('x\ny\n', '')), {added: 0, removed: 2});
  assert.deepEqual(lineOps('a\nb\n', 'a\nx\nb\n').map((o) => o.kind), ['same', 'add', 'same']);
});

test('a file too large to compare line by line is still counted for appends', () => {
  const big = Array.from({length: 3000}, (_, i) => `line ${i}`).join('\n');
  const other = Array.from({length: 3000}, (_, i) => `other ${i}`).join('\n');
  assert.deepEqual(counts(lineOps(big, other)), {added: 3000, removed: 3000});
  assert.deepEqual(counts(lineOps(`${big}\n`, `${big}\nmore\n`)), {added: 1, removed: 0});
});
