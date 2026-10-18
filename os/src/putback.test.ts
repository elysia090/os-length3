import assert from 'node:assert/strict';
import {test} from 'node:test';
import {restore} from './putback.ts';
import {memoryRepo} from './testing.ts';

// Put back: the copy here made to hold what the last commit held.

test('a changed file gets its committed text again', async () => {
  const s = memoryRepo({'README.md': '# a\nchanged\n'});
  await restore(s as never, 'a', 'README.md', '# a\n');
  assert.deepEqual(s.files, {'README.md': '# a\n'});
});

test('a file added since the commit goes', async () => {
  const s = memoryRepo({'README.md': '# a\n', 'docs': null, 'docs/new.md': 'x\n'});
  await restore(s as never, 'a', 'docs/new.md', null);
  assert.deepEqual(s.files, {'README.md': '# a\n', 'docs': null});
  // Gone already (another device, a Prompt): nothing more to do.
  await restore(s as never, 'a', 'docs/new.md', null);
});

test('a file removed since comes back, its folders made first', async () => {
  const s = memoryRepo({'README.md': '# a\n'});
  await restore(s as never, 'a', 'src/net/http.c', 'int x;\n');
  await restore(s as never, 'a', 'TOP.md', 'top\n');
  assert.deepEqual(s.files, {'README.md': '# a\n', 'src': null, 'src/net': null, 'src/net/http.c': 'int x;\n', 'TOP.md': 'top\n'});
});
