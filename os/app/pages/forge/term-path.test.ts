import assert from 'node:assert/strict';
import {test} from 'node:test';
import {asPath} from './term-path.ts';

test('a word of a terminal names a file of the repo, with the line said after it', () => {
  assert.deepEqual(asPath('count.c', 'garden'), {path: 'count.c', line: 0});
  // The compiler's and grep's: where, after it.
  assert.deepEqual(asPath('count.c:7:24:', 'garden'), {path: 'count.c', line: 7});
  assert.deepEqual(asPath('src/main.c:12:', 'garden'), {path: 'src/main.c', line: 12});
  // Said from the root, or from here.
  assert.deepEqual(asPath('/root/garden/README.md', 'garden'), {path: 'README.md', line: 0});
  assert.deepEqual(asPath('./count', 'garden'), {path: 'count', line: 0});
  // Quoted, or ending a sentence.
  assert.deepEqual(asPath("'count.c'", 'garden'), {path: 'count.c', line: 0});
  assert.deepEqual(asPath('README.md,', 'garden'), {path: 'README.md', line: 0});
  // Never out of the repo.
  assert.equal(asPath('/etc/passwd', 'garden'), null);
  assert.equal(asPath('../other/x.c', 'garden'), null);
  assert.equal(asPath('/root/other/x.c', 'garden'), null);
});
