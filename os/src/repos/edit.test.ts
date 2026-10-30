import assert from 'node:assert/strict';
import {test} from 'node:test';
import {indentOf, leading, lineEnd, lineOf, lineStarts} from './edit.ts';

test('a file\'s lines: where each starts and ends, and which one an offset is on', () => {
  const text = 'one\ntwo\n\nfour';
  const starts = lineStarts(text);
  assert.deepEqual(starts, [0, 4, 8, 9]);
  assert.deepEqual(starts.map((_, i) => lineEnd(text, starts, i)), [3, 7, 8, 13]);
  assert.equal(lineOf(starts, 0), 0);
  assert.equal(lineOf(starts, 3), 0, 'the end of a line is on it');
  assert.equal(lineOf(starts, 4), 1);
  assert.equal(lineOf(starts, 8), 2, 'an empty line');
  assert.equal(lineOf(starts, 13), 3);
  assert.deepEqual(lineStarts(''), [0]);
});

test('the indent a line starts with, and the file\'s own', () => {
  assert.equal(leading('    return 0;'), '    ');
  assert.equal(leading('\t\tx'), '\t\t');
  assert.equal(leading('x'), '');
  assert.equal(indentOf('a\n  b\n    c\n'), '  ');
  assert.equal(indentOf('a\n\tb\n'), '\t');
  assert.equal(indentOf('plain'), '\t');
});
