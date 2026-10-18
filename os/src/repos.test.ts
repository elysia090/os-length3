import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemoryStore, plainPart, renamed, TEMPLATES, templateFiles, validName} from './repos.ts';

test('repo names match the native rule', () => {
  assert.ok(validName('my-repo_1.0'));
  for (const bad of ['', '.git', 'a/b', 'a b', 'x'.repeat(65)]) assert.ok(!validName(bad), bad);
});

test('a new or renamed file or folder is one plain part, as core\'s add takes it', () => {
  for (const ok of ['a.md', 'Makefile', 'my notes.txt', 'ノート.md']) assert.ok(plainPart(ok), ok);
  for (const bad of ['', '.env', '..', 'a/b', 'a\\b', '.git', 'GIT~1', '.git. ']) assert.ok(!plainPart(bad), bad);
  assert.equal(renamed('src/main.c', 'hello.c'), 'src/hello.c');
  assert.equal(renamed('README.md', 'READ.md'), 'READ.md');
});

test('templates hold the repo\'s own files, never inbox or TODO', () => {
  for (const t of TEMPLATES) {
    const files = templateFiles('r', t.id);
    assert.ok(files.has('README.md') && !files.has('inbox.md') && !files.has('TODO.md'), t.id);
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

test('the memory store adds, makes directories and removes like the native side', async () => {
  const s = new MemoryStore();
  await s.create('a', 'standard');
  await s.add('a', '', 'note.txt', 'hello\n');
  await s.add('a', 'issue', '001.md', 'Fix：x\n');
  await assert.rejects(s.add('a', 'issue', '001.md', 'again'));
  await assert.rejects(s.add('a', 'missing', 'x', ''));
  await s.mkdir('a', 'src/deep');
  assert.deepEqual((await s.tree('a', 'src')).map((e) => e.name), ['deep']);
  await s.remove('a', 'src');
  await assert.rejects(s.tree('a', 'src'));
  await assert.rejects(s.remove('a', '.git'));
  assert.equal((await s.read('a', 'note.txt')).text, 'hello\n');
});

test('the memory store renames a file or a folder in its place, never over another, as the native side', async () => {
  const s = new MemoryStore();
  await s.create('a', 'c');
  await s.rename('a', 'src/main.c', 'hello.c');
  assert.deepEqual((await s.tree('a', 'src')).map((e) => e.name), ['hello.c']);
  assert.match((await s.read('a', 'src/hello.c')).text!, /puts/);
  await assert.rejects(s.read('a', 'src/main.c'));
  await s.mkdir('a', 'src/empty');
  await s.rename('a', 'src', 'lib');
  assert.deepEqual((await s.tree('a', 'lib')).map((e) => [e.name, e.kind]), [['empty', 'dir'], ['hello.c', 'file']]);
  await assert.rejects(s.tree('a', 'src'));
  // Never over what is there, never out of its folder, never .git or a hidden name.
  await assert.rejects(s.rename('a', 'lib/hello.c', 'empty'));
  await assert.rejects(s.rename('a', 'lib', 'docs'));
  for (const bad of ['', 'x/y', '.hidden', '.git', 'GIT~1']) await assert.rejects(s.rename('a', 'lib/hello.c', bad), bad);
  await assert.rejects(s.rename('a', '', 'b'));
  await assert.rejects(s.rename('a', 'missing', 'b'));
  await s.rename('a', 'lib/hello.c', 'hello.c');
  assert.match((await s.read('a', 'lib/hello.c')).text!, /puts/);
});

test('repos kept in the browser come back in a new page, as they were left', async () => {
  const {KeptStore} = await import('./repos.ts');
  const shelf = new Map<string, import('./repos.ts').Kept>();
  const fake = {
    async all() { return [...shelf].map(([k, v]) => [k, structuredClone(v)] as [string, import('./repos.ts').Kept]); },
    async put(n: string, r: import('./repos.ts').Kept) { shelf.set(n, structuredClone(r)); },
    async drop(names: string[]) { for (const n of names) shelf.delete(n); },
  };
  const a = new KeptStore(fake);
  await a.create('notes', 'standard');
  await a.add('notes', '', 'todo.md', 'one');
  await a.mkdir('notes', 'src/deep');
  await a.write('notes', 'todo.md', 'two');
  await a.flush();
  // A new page: what was saved is there; nothing else is.
  const b = new KeptStore(fake);
  assert.deepEqual((await b.list()).map((r) => r.name), ['notes']);
  assert.equal((await b.read('notes', 'todo.md')).text, 'two');
  assert.deepEqual((await b.tree('notes', 'src')).map((e) => [e.name, e.kind]), [['deep', 'dir']]);
  await b.remove('notes', 'todo.md');
  await b.rename('notes', 'src', 'lib');
  await b.flush();
  const c = new KeptStore(fake);
  // Asked at once, before it has read the shelf: it waits, then answers.
  assert.equal((await c.tree('notes', '')).some((e) => e.name === 'todo.md'), false);
  assert.deepEqual((await c.tree('notes', 'lib')).map((e) => [e.name, e.kind]), [['deep', 'dir']]);
  assert.equal((await new KeptStore(fake).read('notes', 'README.md')).text?.startsWith('# notes'), true);
  // Let go: gone here and from the shelf.
  await c.letGo(['notes']);
  assert.deepEqual(await c.list(), []);
  assert.deepEqual(await new KeptStore(fake).list(), []);
});

test('a change this browser cannot keep (its storage full) waits, is said, and is kept once there is room', async () => {
  const {KeptStore} = await import('./repos.ts');
  const shelf = new Map<string, import('./repos.ts').Kept>();
  const fake = {
    full: false,
    async all() { return [...shelf].map(([k, v]) => [k, structuredClone(v)] as [string, import('./repos.ts').Kept]); },
    async put(n: string, r: import('./repos.ts').Kept) {
      if (fake.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      shelf.set(n, structuredClone(r));
    },
    async drop(names: string[]) { for (const n of names) shelf.delete(n); },
  };
  const a = new KeptStore(fake);
  let told = 0;
  a.onTrouble(() => told++);
  await a.create('notes', 'standard');
  await a.flush();
  fake.full = true;
  await a.write('notes', 'README.md', '# kept later\n');
  // Not kept: it rejects (so nothing is agreed on top of it), says why, and the change still waits here.
  await assert.rejects(a.flush(), /could not keep/);
  assert.match(a.trouble ?? '', /quota/);
  assert.equal(told, 1);
  assert.ok(a.waiting('notes'));
  assert.equal(shelf.get('notes')?.files.find(([p]) => p === 'README.md')?.[1], '# notes\n');
  fake.full = false;
  await a.flush();
  assert.equal(a.trouble, null);
  assert.equal(told, 2);
  assert.equal(a.waiting('notes'), false);
  assert.equal((await new KeptStore(fake).read('notes', 'README.md')).text, '# kept later\n');
});
