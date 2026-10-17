import assert from 'node:assert/strict';
import {test} from 'node:test';
import {findInText, nameMatches} from './search.ts';

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
