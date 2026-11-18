import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Vfs} from '../../runtime/linux/fs.ts';
import {Mirror} from '../../runtime/linux/mirror.ts';

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
  v.file('/root/a/README.md').write(0, enc.encode('#'));
  const c = m.changes();
  assert.ok(c);
  assert.deepEqual(c.dirs.sort(), ['src', 'src/deep']);
  assert.deepEqual(c.files.map((f) => [f.path, dec.decode(f.bytes), f.existed]).sort(),
    [['README.md', '# a\n', true], ['issue/001.md', 'Fix：x\n', false]]);
  assert.deepEqual(c.removed, []);
  assert.equal(m.changes(), null);

  v.dir('/root/a').entries.delete('src');
  assert.deepEqual(m.changes(), {dirs: [], files: [], removed: ['src']});

  m.put('docs/new.md', enc.encode('from the app'));
  m.put('issue', null);
  assert.equal(m.changes(), null);
  assert.equal(dec.decode(v.readFile('/root/a/docs/new.md')), 'from the app');
});

test('git metadata is ordinary guest data; traversal remains rejected', () => {
  const v = new Vfs(); v.mkdirp('/root/a');
  const m = new Mirror(v, '/root/a');
  v.writeFile('/root/a/.GIT/config', enc.encode('[core]'));
  assert.equal(m.changes()?.files[0].path, '.GIT/config');
  m.put('.git/config', enc.encode('outside'));
  assert.equal(dec.decode(v.readFile('/root/a/.git/config')), 'outside');
  assert.equal(m.changes(), null);
  m.put('../b/x', enc.encode('out'));
  assert.throws(() => v.readFile('/root/b/x'));
});

test('failed file capture does not acknowledge the observation', () => {
  const v = new Vfs();
  v.writeFile('/work/a', 'old');
  v.writeFile('/work/b', 'old');
  const m = new Mirror(v, '/work');
  v.file('/work/a').write(0, enc.encode('new'));
  const b = v.file('/work/b');
  b.write(0, enc.encode('new'));
  const bytes = b.bytes.bind(b);
  let fail = true;
  b.bytes = () => { if (fail) { fail = false; throw new Error('capture failed'); } return bytes(); };

  assert.throws(() => m.changes(), /capture failed/);
  assert.deepEqual(m.changes()?.files.map((f) => [f.path, dec.decode(f.bytes)]), [['a', 'new'], ['b', 'new']]);
  assert.equal(m.changes(), null);
});

test('a mutation during capture remains eligible for the next observation', () => {
  const v = new Vfs();
  const a = v.writeFile('/work/a', 'old');
  const b = v.writeFile('/work/b', 'old');
  const m = new Mirror(v, '/work');
  a.write(0, enc.encode('one'));
  b.write(0, enc.encode('two'));
  const bytes = b.bytes.bind(b);
  let mutate = true;
  b.bytes = () => { if (mutate) { mutate = false; a.write(0, enc.encode('end')); } return bytes(); };

  const first = m.changes()!;
  assert.deepEqual(first.files.map((f) => [f.path, dec.decode(f.bytes)]), [['a', 'one'], ['b', 'two']]);
  assert.deepEqual(m.changes()?.files.map((f) => [f.path, dec.decode(f.bytes)]), [['a', 'end']]);
  assert.equal(dec.decode(first.files[0].bytes), 'one');
  assert.equal(m.changes(), null);
});
