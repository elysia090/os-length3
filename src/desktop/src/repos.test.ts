import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemoryStore, TEMPLATES, templateFiles, validName} from './repos.ts';

test('repo names match the native rule', () => {
  assert.ok(validName('my-repo_1.0'));
  for (const bad of ['', '.git', 'a/b', 'a b', 'x'.repeat(65)]) assert.ok(!validName(bad), bad);
});

test('every template keeps inbox.md and TODO.md', () => {
  for (const t of TEMPLATES) {
    const files = templateFiles('r', t.id);
    assert.ok(files.has('inbox.md') && files.has('TODO.md'), t.id);
    // The list shown to the user names exactly what is created.
    const shown = t.files.map((f) => f.replace(/\/$/, '')).sort();
    assert.deepEqual([...files.keys()].sort(), shown, t.id);
  }
});

test('the memory store lists directories first and reads files', async () => {
  const s = new MemoryStore();
  await s.create('a', 'c');
  await assert.rejects(s.create('a', 'c'));
  const root = await s.tree('a', '');
  assert.deepEqual(root.slice(0, 3).map((e) => e.name), ['docs', 'issue', 'src']);
  assert.deepEqual((await s.tree('a', 'src')).map((e) => e.name), ['main.c']);
  assert.match((await s.read('a', 'src/main.c')).text!, /puts/);
  assert.equal((await s.list())[0].name, 'a');
});
