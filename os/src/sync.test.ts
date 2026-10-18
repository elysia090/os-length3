import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserOnRemote} from './testing-remote.ts';

// A browser's copy kept in step with the Remote (draft.ts), where the two
// sides changed the same path in different ways: whatever is in whose way,
// nothing either side wrote is lost, the sync goes through, and the Remote
// ends holding the same as this copy. Each test has a repo of its own.

const b = await browserOnRemote();
const {store, draft} = b;

/** A repo made here and on the Remote, holding `files`. */
async function made(repo: string, files: Record<string, string>) {
  await store.create(repo, '');
  for (const [p, text] of Object.entries(files)) await store.put(repo, p, text);
  await draft.sync(repo);
}

test('a folder made here where the Remote has a new file: the sync goes through, the Remote\'s beside it', async () => {
  await made('s-folder', {'keep.txt': 'k\n'});
  await b.elsewhere('s-folder', {notes: 'theirs\n'});
  await store.mkdir('s-folder', 'notes');
  const done = await draft.sync('s-folder');
  assert.deepEqual(done.both, ['notes']);
  assert.equal(await b.text('s-folder', 'notes (other device)'), 'theirs\n');
  assert.deepEqual((await store.tree('s-folder', 'notes')), []);
  assert.deepEqual(await b.remoteFiles('s-folder'), {'keep.txt': 'k\n', notes: null, 'notes (other device)': 'theirs\n'});
});

test('a file here where the Remote made it a folder: this device\'s stays, the Remote\'s goes beside the whole way', async () => {
  await made('s-way', {a: 'one\n'});
  await b.elsewhere('s-way', {a: null, 'a/b': 'theirs\n'});
  await store.write('s-way', 'a', 'mine\n');
  const done = await draft.sync('s-way');
  assert.deepEqual(done.both, ['a/b']);
  assert.deepEqual(await b.files('s-way'), {a: 'mine\n', 'a (other device)/b': 'theirs\n'});
  assert.deepEqual(await b.remoteFiles('s-way'), {a: 'mine\n', 'a (other device)/b': 'theirs\n'});
});

test('removed here and changed on the Remote: the change comes back', async () => {
  await made('s-back', {'a.txt': 'one\n', 'b.txt': 'b\n'});
  await b.elsewhere('s-back', {'a.txt': 'two\n'});
  await store.remove('s-back', 'a.txt');
  await draft.sync('s-back');
  assert.deepEqual(await b.files('s-back'), {'a.txt': 'two\n', 'b.txt': 'b\n'});
  assert.deepEqual(await b.remoteFiles('s-back'), {'a.txt': 'two\n', 'b.txt': 'b\n'});
});

test('removed on the Remote and changed here: this device\'s stays, and goes to the Remote again', async () => {
  await made('s-stay', {'a.txt': 'one\n'});
  await b.elsewhere('s-stay', {'a.txt': null});
  await store.write('s-stay', 'a.txt', 'mine\n');
  await draft.sync('s-stay');
  assert.deepEqual(await b.files('s-stay'), {'a.txt': 'mine\n'});
  assert.deepEqual(await b.remoteFiles('s-stay'), {'a.txt': 'mine\n'});
});

test('removed on the Remote and untouched here: it goes from here too', async () => {
  await made('s-gone', {'a.txt': 'one\n', 'b.txt': 'b\n'});
  await b.elsewhere('s-gone', {'a.txt': null});
  await draft.sync('s-gone');
  assert.deepEqual(await b.files('s-gone'), {'b.txt': 'b\n'});
});

test('changed on both sides twice: each of this device\'s versions is kept, under the next free name', async () => {
  await made('s-twice', {'a.md': 'one\n'});
  for (const n of [1, 2]) {
    await b.elsewhere('s-twice', {'a.md': `theirs ${n}\n`});
    await store.write('s-twice', 'a.md', `mine ${n}\n`);
    await draft.sync('s-twice');
  }
  const tag = draft.deviceTag();
  assert.deepEqual(await b.files('s-twice'), {'a.md': 'theirs 2\n', [`a (${tag}).md`]: 'mine 1\n', [`a (${tag} 2).md`]: 'mine 2\n'});
});

test('a name and text beyond ASCII, with CRLF line ends, reach the Remote and come back byte for byte', async () => {
  const files = {'ノート/メモ 1.md': '一行目\r\n二行目\r\n', 'emoji 😀.txt': '😀\n', 'no-newline': 'x'};
  await made('s-text', files);
  assert.deepEqual(await b.remoteFiles('s-text'), files);
  await b.elsewhere('s-text', {'ノート/メモ 1.md': '一行目\r\n変えた\r\n'});
  await draft.sync('s-text');
  assert.equal(await b.text('s-text', 'ノート/メモ 1.md'), '一行目\r\n変えた\r\n');
});

// ---- Home's settings: each test its own setting ----

test('the profile changed on both: the Remote\'s is taken, agreed, and the next change here goes to the Remote', async () => {
  const {getState, setState} = b.state;
  await setState('profile', JSON.stringify({name: 'Here', handle: 'ren', bio: ''}));
  await draft.syncHome('profile');
  await b.elsewhereHome('profile', JSON.stringify({name: 'There', handle: 'ren', bio: ''}));
  await setState('profile', JSON.stringify({name: 'Here again', handle: 'ren', bio: ''}));
  await draft.syncHome('profile');
  assert.equal(JSON.parse(getState('profile')!).name, 'There');
  const remote = await b.remoteHome('profile');
  assert.equal(draft.homeMoved('profile', remote.version), false);
  // A change made after that is this device's, and is sent, not taken back.
  await setState('profile', JSON.stringify({name: 'Later', handle: 'ren', bio: ''}));
  await draft.syncHome('profile');
  assert.equal(JSON.parse(getState('profile')!).name, 'Later');
  assert.equal(JSON.parse((await b.remoteHome('profile')).value!).name, 'Later');
});

test('TODO changed on two devices at once: the other\'s edit and this one\'s new item are both kept', async () => {
  const {getState, setState} = b.state;
  const item = (id: string, title: string, done = false) => ({id, kind: null, title, detail: '', done, repo: null, created: 1});
  await setState('todo', JSON.stringify([item('a', 'a'), item('b', 'b')]));
  await draft.syncHome('todo');
  // Elsewhere: a is done, b is removed. Here, meanwhile: c is added.
  await b.elsewhereHome('todo', JSON.stringify([item('a', 'a', true)]));
  await setState('todo', JSON.stringify([item('a', 'a'), item('b', 'b'), item('c', 'c')]));
  await draft.syncHome('todo');
  const now = (v: string | null) => (JSON.parse(v!) as {id: string; done: boolean}[]).map((t) => `${t.id}${t.done ? '✓' : ''}`);
  assert.deepEqual(now(getState('todo')), ['a✓', 'c']);
  assert.deepEqual(now((await b.remoteHome('todo')).value), ['a✓', 'c']);
});

test('more files than one diff carries reach the Remote over several rounds, and are agreed', async () => {
  const many = Object.fromEntries(Array.from({length: 2300}, (_, i) => [`f/${String(i).padStart(4, '0')}.txt`, `${i}\n`]));
  await store.create('s-many', '');
  for (const [p, text] of Object.entries(many)) await store.put('s-many', p, text);
  const done = await draft.sync('s-many');
  assert.equal(done.sent, 2300);
  assert.equal(Object.keys(await b.remoteFiles('s-many')).length, 2300);
  assert.deepEqual((await draft.status()).find((s) => s.name === 's-many')?.changed, 0);
});
