import assert from 'node:assert/strict';
import {test} from 'node:test';
import {kindOf, lineCount, readingOrder} from './reading.ts';

test('a directory reads README first, then its files, then its directories', () => {
  const entries = [{name: 'src', kind: 'dir'}, {name: 'Makefile', kind: 'file'}, {name: 'docs', kind: 'dir'},
    {name: 'README.md', kind: 'file'}, {name: 'LICENSE', kind: 'file'}, {name: 'readme-old', kind: 'file'}];
  assert.deepEqual(readingOrder(entries).map((e) => e.name), ['README.md', 'LICENSE', 'Makefile', 'readme-old', 'docs', 'src']);
});

test('lines are counted like an editor and kinds come from the name', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\n'), 1);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('\n\n'), 2);
  assert.deepEqual(['src/main.c', 'Makefile', 'README.md', '.bashrc', 'notes', 'x.RS'].map(kindOf),
    ['C', 'Makefile', 'Markdown', 'テキスト', 'テキスト', 'Rust']);
});
