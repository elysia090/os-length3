import assert from 'node:assert/strict';
import {test} from 'node:test';
import {KeptStore, lay, MemoryStore, plainPart, renamed, TEMPLATES, templateFiles, validName, type Keep, type Kept} from './repos.ts';
import type {Message} from './tabs.ts';

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

/** A shelf as IndexedDB is one: kept apart from any page, laid over path by path, and refusing writes while `full`. */
function fakeShelf() {
  const kept = new Map<string, Kept>();
  const notes: [string, Keep][] = [];
  const shelf = {
    full: false,
    kept,
    async all() {
      for (const [n, c] of notes.splice(0)) if (c.whole || kept.has(n)) kept.set(n, lay(kept.get(n), c));
      return [...kept].map(([k, v]) => [k, structuredClone(v)] as [string, Kept]);
    },
    async get(n: string) {
      let k = kept.get(n);
      for (const [m, c] of notes) if (m === n && (c.whole || k)) k = lay(k, c);
      return k && structuredClone(k);
    },
    async merge(n: string, c: Keep) {
      if (shelf.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      kept.set(n, lay(await shelf.get(n), structuredClone(c)));
      for (let i = notes.length - 1; i >= 0; i--) if (notes[i][0] === n) notes.splice(i, 1);
    },
    note(n: string, c: Keep) { if (shelf.full) return false; notes.push([n, structuredClone(c)]); return true; },
    async drop(names: string[]) { for (const n of names) kept.delete(n); },
  };
  return shelf;
}

/** Tabs of one browser: what one posts, every other hears. */
function tabsOf() {
  const all: ((m: Message) => void)[][] = [];
  return () => {
    const mine: ((m: Message) => void)[] = [];
    all.push(mine);
    return {post(m: Message) { for (const l of all) if (l !== mine) for (const f of l) f(structuredClone(m)); }, hear(f: (m: Message) => void) { mine.push(f); }};
  };
}

test('repos kept in the browser come back in a new page, as they were left', async () => {
  const fake = fakeShelf();
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

test('two tabs keep one copy: each writes only what it changed, and takes in what the other kept', async () => {
  const fake = fakeShelf(), tab = tabsOf();
  const a = new KeptStore(fake, tab());
  await a.create('notes', 'standard');
  await a.flush();
  // B opens after: it reads the copy as kept.
  const b = new KeptStore(fake, tab());
  const heard: [string, string[] | null][] = [];
  b.heard = (repo, _key, paths) => heard.push([repo, paths]);
  assert.equal((await b.read('notes', 'README.md')).text, '# notes\n');
  // Each changes its own file; neither writes the other's over with what it read before.
  await a.write('notes', 'README.md', '# from A\n');
  await b.add('notes', '', 'b.md', 'from B');
  await a.flush();
  await b.flush();
  const next = new KeptStore(fake);
  assert.equal((await next.read('notes', 'README.md')).text, '# from A\n');
  assert.equal((await next.read('notes', 'b.md')).text, 'from B');
  // And B shows A's README now, and was told so.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await b.read('notes', 'README.md')).text, '# from A\n');
  assert.deepEqual(heard, [['notes', ['README.md']]]);
  // Before a sync, a tab takes in what the other kept; a change of its own not kept yet stays its own.
  await a.write('notes', 'b.md', 'B, as A wrote it');
  await a.flush();
  await b.write('notes', 'README.md', '# B, not kept yet\n');
  await b.reload('notes');
  assert.equal((await b.read('notes', 'b.md')).text, 'B, as A wrote it');
  assert.equal((await b.read('notes', 'README.md')).text, '# B, not kept yet\n');
  // Let go in one tab: gone from the other too, unless that one changed it and has not kept it.
  await a.letGo(['notes']);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await b.list()).length, 1);
  await b.flush();
  assert.equal((await new KeptStore(fake).read('notes', 'README.md')).text, '# B, not kept yet\n');
});

test('a change this browser cannot keep (its storage full) waits, is said, and is kept once there is room', async () => {
  const fake = fakeShelf();
  const a = new KeptStore(fake);
  let told = 0;
  a.onTrouble(() => told++);
  await a.create('notes', 'standard');
  await a.flush();
  fake.full = true;
  await a.write('notes', 'README.md', '# kept later\n');
  await assert.rejects(a.flush(), /could not keep/);
  assert.match(a.trouble ?? '', /quota/);
  assert.equal(told, 1);
  assert.ok(a.waiting('notes'));
  assert.equal(fake.kept.get('notes')?.files.find(([p]) => p === 'README.md')?.[1], '# notes\n');
  fake.full = false;
  await a.flush();
  assert.equal(a.trouble, null);
  assert.equal(told, 2);
  assert.equal(a.waiting('notes'), false);
  assert.equal((await new KeptStore(fake).read('notes', 'README.md')).text, '# kept later\n');
});

test('leaving the page keeps what waits at once, and what is written while it is left', async () => {
  const fake = fakeShelf();
  const a = new KeptStore(fake);
  await a.create('notes', 'standard');
  await a.flush();
  await a.write('notes', 'README.md', '# as the tab closed\n');
  a.leave();
  assert.equal(a.waiting('notes'), false);
  // A field that saves itself as the page goes: kept then too, with no timer to wait for.
  await a.add('notes', '', 'late.md', 'saved on the way out');
  assert.equal(a.waiting('notes'), false);
  const next = new KeptStore(fake);
  assert.equal((await next.read('notes', 'README.md')).text, '# as the tab closed\n');
  assert.equal((await next.read('notes', 'late.md')).text, 'saved on the way out');
});
