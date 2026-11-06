import assert from 'node:assert/strict';
import {test} from 'node:test';
import {findInText, nameFirst, nameMatches, stillAt} from './search.ts';

test('lines are found without regard to case, with where the match sits', () => {
  const hits = findInText('#include <stdio.h>\n\nint main(void) {\n    PUTS("hello");\n}\n', 'puts');
  assert.deepEqual(hits, [{line: 4, text: '    PUTS("hello");', from: 4, to: 8}]);
  assert.deepEqual(findInText('a\na\na', 'a', 2).map((h) => h.line), [1, 2]);
  assert.deepEqual(findInText('abc', ''), []);
});

test('a long line is cut to a window around the match', () => {
  const line = 'x'.repeat(500) + 'needle' + 'y'.repeat(500);
  const [hit] = findInText(line, 'needle');
  assert.equal(hit.text.slice(hit.from, hit.to), 'needle');
  assert.ok(hit.text.length <= 160);
});

test('names match on any part of the path', () => {
  assert.ok(nameMatches('src/main.c', 'MAIN'));
  assert.ok(!nameMatches('src/main.c', ''));
});

test('a file whose name holds the query comes before those that only say it', () => {
  const groups = [{path: 'Makefile'}, {path: 'README.md'}, {path: 'src/main.c'}];
  assert.deepEqual(nameFirst(groups, 'main.c').map((g) => g.path), ['src/main.c', 'Makefile', 'README.md']);
  assert.deepEqual(nameFirst(groups, 'zzz').map((g) => g.path), ['Makefile', 'README.md', 'src/main.c']);
});

test('a line found before is looked for again in the text as saved: there, moved, or gone', () => {
  assert.equal(stillAt('a\nWritten\nc', 'written', 2), 2);
  // Lines added above it: the same words, further down.
  assert.equal(stillAt('a\none\ntwo\nWritten\nc', 'written', 2), 4);
  // The nearest of several, when it moved.
  assert.equal(stillAt('Written\nx\nx\nx\nx\nx\nWritten', 'written', 5), 7);
  // The word changed or deleted: nowhere to go.
  assert.equal(stillAt('a\nWrote\nc', 'written', 2), null);
});
