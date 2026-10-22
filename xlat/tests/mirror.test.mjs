import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Vfs} from '../runtime/fs.mjs';
import {isGitName, Mirror} from '../runtime/mirror.mjs';

const enc = new TextEncoder(), dec = new TextDecoder();

test('guest changes under the root come out once, outside puts do not echo', () => {
  const v = new Vfs();
  v.writeFile('/root/a/README.md', enc.encode('# a\n'));
  v.mkdirp('/root/a/issue');
  v.writeFile('/root/b/x', enc.encode('other repo'));
  const m = new Mirror(v, '/root/a');
  assert.equal(m.changes(), null);

  v.writeFile('/root/a/issue/001.md', enc.encode('Fix：x\n'));
  v.mkdirp('/root/a/src/deep');
  v.lookup('/root/a/README.md', '/').write(0, enc.encode('#'));
  const c = m.changes();
  assert.deepEqual(c.dirs.sort(), ['src', 'src/deep']);
  assert.deepEqual(c.files.map((f) => [f.path, dec.decode(f.bytes), f.existed]).sort(),
    [['README.md', '# a\n', true], ['issue/001.md', 'Fix：x\n', false]]);
  assert.deepEqual(c.removed, []);
  assert.equal(m.changes(), null);

  v.lookup('/root/a', '/').entries.delete('src');
  assert.deepEqual(m.changes(), {dirs: [], files: [], removed: ['src']});

  m.put('docs/new.md', enc.encode('from the app'));
  m.put('issue', null);
  assert.equal(m.changes(), null);
  assert.equal(dec.decode(v.readFile('/root/a/docs/new.md')), 'from the app');
});

test('a repo\'s .git, however it is spelt, is never mirrored either way', () => {
  for (const n of ['.git', '.GIT', '.Git.', '.git ', 'git~1', '.g\u200cit']) assert.ok(isGitName(n), n);
  for (const n of ['git', '.github', '.gitignore']) assert.ok(!isGitName(n), n);
  const v = new Vfs();
  v.mkdirp('/root/a');
  const m = new Mirror(v, '/root/a');
  v.writeFile('/root/a/.GIT/config', enc.encode('[core]'));
  v.writeFile('/root/a/git~1/hooks/pre-commit', enc.encode('#!/bin/sh'));
  assert.equal(m.changes(), null);
  m.put('../b/x', enc.encode('out'));
  m.put('.git/config', enc.encode('in'));
  assert.throws(() => v.readFile('/root/b/x'));
  assert.throws(() => v.readFile('/root/a/.git/config'));
});
