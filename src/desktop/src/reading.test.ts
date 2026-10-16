import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readingOrder} from './reading.ts';

test('a directory reads README first, then its files, then its directories', () => {
  const entries = [{name: 'src', kind: 'dir'}, {name: 'Makefile', kind: 'file'}, {name: 'docs', kind: 'dir'},
    {name: 'README.md', kind: 'file'}, {name: 'LICENSE', kind: 'file'}, {name: 'readme-old', kind: 'file'}];
  assert.deepEqual(readingOrder(entries).map((e) => e.name), ['README.md', 'LICENSE', 'Makefile', 'readme-old', 'docs', 'src']);
});
