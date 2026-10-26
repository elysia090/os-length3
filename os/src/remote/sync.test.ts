import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from '../../service/app.ts';
import {browserOnRemote} from '../testing/remote.ts';
import {purge} from '../../service/sweep.ts';
import {sql} from 'drizzle-orm';

// A browser on one Remote, all in this process (testing.ts). The tests below
// follow one repo, `notes`, through its life, each from where the one
// before left it.
const b = await browserOnRemote();
const {store, draft, history, asked, elsewhere, text, names, token, URL: URL_, db, signIn} = b;
const {setState, getState} = b.state;
const enc = new TextEncoder();

test('a repo made here is on the Remote after one sync; the next sync sends only what changed', async () => {
  await store.create('notes', 'standard');
  const first = await draft.sync('notes');
  assert.ok(first.sent > 0 && first.version > 0);
  const remote = await draft.remoteRepos();
  assert.deepEqual(remote.map((r) => r.name), ['notes']);
  await store.write('notes', 'README.md', '# notes\nmore\n');
  const second = await draft.sync('notes');
  assert.deepEqual([second.sent, second.taken, second.version], [1, 0, first.version + 1]);
  assert.deepEqual((await draft.status()).map((s) => [s.name, s.changed]), [['notes', 0]]);
});

test("the other device's changes come in; a file changed on both keeps the Remote's and puts this one's beside it, by this device's name", async () => {
  await elsewhere('notes', {'docs/plan.md': 'plan\n'});
  const took = await draft.sync('notes');
  assert.equal(took.taken, 1);
  assert.equal(await text('notes', 'docs/plan.md'), 'plan\n');
  await elsewhere('notes', {'README.md': 'theirs\n'});
  await store.write('notes', 'README.md', 'mine\n');
  const both = await draft.sync('notes');
  assert.deepEqual(both.both, ['README.md']);
  const mine = 'README (Chrome Linux).md';
  assert.equal(await text('notes', 'README.md'), 'theirs\n');
  assert.equal(await text('notes', mine), 'mine\n');
  // And the Remote has both now, under the same names as here: the name says whose it is everywhere.
  const now = await (await fetch(`${URL_}/v1/repos/notes`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal(now.draft['README.md'], await sha256(enc.encode('theirs\n')));
  assert.equal(now.draft[mine], await sha256(enc.encode('mine\n')));
});

test('a file that is not text comes here as its bytes, and stays on the Remote as it was', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]);
  await elsewhere('notes', {'logo.png': png});
  await draft.sync('notes');
  assert.ok((await names('notes')).includes('logo.png'));
  await store.write('notes', 'README.md', 'mine, again\n');
  await draft.sync('notes');
  const now = await (await fetch(`${URL_}/v1/repos/notes`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal(now.draft['logo.png'], await sha256(png));
});

test('a file or folder renamed here reaches the Remote as any change: gone at its old name, there at its new', async () => {
  const {onChange} = await import('../repos/repos.ts');
  const told: string[] = [];
  const stop = onChange((c) => told.push(`${c.what} ${c.path}${c.text !== undefined ? ` ${JSON.stringify(c.text)}` : ''}`));
  await store.rename('notes', 'docs/plan.md', 'later.md');
  await store.rename('notes', 'docs', 'notes');
  stop();
  // Told as the old gone and the new made, so a copy kept elsewhere (the shell's) follows it.
  assert.deepEqual(told.slice(0, 2), ['removed docs/plan.md', 'file docs/later.md "plan\\n"']);
  assert.deepEqual(told.slice(2, 4), ['removed docs', 'dir notes']);
  assert.ok(told.includes('file notes/later.md "plan\\n"'));
  const sent = await draft.sync('notes');
  assert.ok(sent.sent >= 2);
  const now = await (await fetch(`${URL_}/v1/repos/notes`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal(now.draft['notes/later.md'], await sha256(enc.encode('plan\n')));
  assert.ok(!Object.keys(now.draft).some((p) => p.startsWith('docs/')));
});

test('a repo only on the Remote comes here when opened, with nothing of a template', async () => {
  await elsewhere('far', {'a.txt': 'a\n'});
  await draft.fetchRepo('far');
  assert.deepEqual(await names('far'), ['a.txt']);
  assert.equal(await text('far', 'a.txt'), 'a\n');
});

test('a commit makes the draft history; what is not committed is the draft against it', async () => {
  const before = await history.changes('notes');
  assert.ok(before.connected && before.files > 0);
  const c = await history.cut('notes', null, 'Fix：最初の区切り', 'メモ');
  assert.deepEqual([c.kind, c.title], ['Fix', '最初の区切り']);
  assert.equal((await history.changes('notes')).files, 0);
  await store.write('notes', 'README.md', 'mine, again\nand a line\n');
  const after = await history.changes('notes');
  assert.deepEqual([after.files, after.added, after.removed], [1, 1, 0]);
  const d = await history.diff('notes');
  assert.ok(d[0].lines.some((l) => l.kind === 'add' && l.text === 'and a line'));
  await assert.rejects(history.cut('notes', null, '  ', ''), /title/);
  const log = await history.log('notes');
  assert.deepEqual(log.map((x) => x.title), ['最初の区切り']);
  assert.ok(log[0].files >= 3, `${log[0].files}`);
});

test("TODO from two devices is joined; the profile is the Remote's when both changed it", async () => {
  await setState('todo', JSON.stringify([{id: 'a', title: 'here'}]));
  await draft.syncHome('todo');
  // Elsewhere, from the version this one sent.
  const r = await fetch(`${URL_}/v1/home/todo`, {headers: {Authorization: `Bearer ${token}`}});
  const there = await r.json() as {version: number};
  await fetch(`${URL_}/v1/home/todo`, {method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({value: JSON.stringify([{id: 'a', title: 'here'}, {id: 'b', title: 'there'}]), version: there.version})});
  await setState('todo', JSON.stringify([{id: 'a', title: 'here'}, {id: 'c', title: 'mine'}]));
  await draft.syncHome('todo');
  const ids = (JSON.parse(getState('todo')!) as {id: string}[]).map((t) => t.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);

  await setState('profile', JSON.stringify({name: 'Ren'}));
  await draft.syncHome('profile');
  const p = await (await fetch(`${URL_}/v1/home/profile`, {headers: {Authorization: `Bearer ${token}`}})).json() as {version: number};
  await fetch(`${URL_}/v1/home/profile`, {method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({value: JSON.stringify({name: 'Ren T.'}), version: p.version})});
  await setState('profile', JSON.stringify({name: 'れん'}));
  asked.length = 0;
  await draft.syncHome('profile');
  assert.equal(getState('profile'), JSON.stringify({name: 'Ren T.'}));
  // Agreed then and there (bug: taken but never agreed, so each look took it again, three reads at a time).
  assert.deepEqual(asked, ['/v1/home/profile']);
  assert.equal(draft.homeMoved('profile', p.version + 1), false);
});

test('a copy in step is never taken apart by a Remote that does not have it: discarded there, or another account\'s', async () => {
  await store.create('kept', 'standard');
  await store.write('kept', 'README.md', '# kept\n');
  await draft.sync('kept');
  const files = async () => (await store.tree('kept', '')).map((e) => e.name).sort();
  const before = await files();
  // Discarded on another device (turned off, then for good): nothing here is taken for removed, nor called in step.
  await db.execute(sql`update repo set off_at = now() where name = 'kept'`);
  await purge(db, sql`r.name = 'kept'`);
  await assert.rejects(draft.sync('kept'), /discarded on the Remote/);
  assert.deepEqual(await files(), before);
  assert.equal(await text('kept', 'README.md'), '# kept\n');
  // Someone else signed in on this browser: not theirs to take apart either.
  const other = await signIn('Mio Other');
  await setState('remote', JSON.stringify({url: URL_, token: other}));
  await assert.rejects(draft.sync('kept'), /another account/);
  assert.deepEqual(await files(), before);
  await setState('remote', JSON.stringify({url: URL_, token}));
});

test('a copy, or a setting, agreed with one account is not sent to another that signs in on this browser', async () => {
  await store.create('mine', 'standard');
  await store.write('mine', 'README.md', '# Sora\'s\n');
  await draft.sync('mine');
  const files = async () => (await store.tree('mine', '')).map((e) => e.name).sort();
  const before = await files();
  // Another person, whose Remote has a repo of the same name.
  const other = await signIn('Mio Other');
  const auth = {Authorization: `Bearer ${other}`, 'Content-Type': 'application/json'};
  const sha = await sha256(enc.encode('Mio\'s\n'));
  await fetch(`${URL_}/v1/blobs/${sha}`, {method: 'PUT', headers: {Authorization: `Bearer ${other}`}, body: 'Mio\'s\n'});
  await fetch(`${URL_}/v1/repos/mine/draft`, {method: 'PATCH', headers: auth, body: JSON.stringify({version: 0, set: {'mio.md': sha}, remove: []})});
  // Sora's TODO, changed here and not sent yet.
  await draft.syncHome('todo');
  await setState('todo', JSON.stringify([{id: 'sora', title: 'Sora\'s, not sent yet'}]));
  await setState('remote', JSON.stringify({url: URL_, token: other}));
  // Signed in as Mio: Sora's copy is neither sent into Mio's repo nor joined with it, and Sora's TODO stays Sora's.
  await assert.rejects(draft.sync('mine'), /another account/);
  assert.deepEqual(await files(), before);
  const mio = await (await fetch(`${URL_}/v1/repos/mine`, {headers: auth})).json() as {draft: Record<string, string>};
  assert.deepEqual(Object.keys(mio.draft), ['mio.md']);
  await draft.syncHome('todo');
  const mioTodo = await (await fetch(`${URL_}/v1/home/todo`, {headers: auth})).json() as {value: string | null};
  assert.equal((mioTodo.value ?? '').includes('Sora'), false);
  assert.match(getState('todo') ?? '', /not sent yet/);
  // Sora again: all of it goes to Sora's.
  await setState('remote', JSON.stringify({url: URL_, token}));
  assert.equal((await draft.sync('mine')).sent, 0);
  await draft.syncHome('todo');
  const soraTodo = await (await fetch(`${URL_}/v1/home/todo`, {headers: {Authorization: `Bearer ${token}`}})).json() as {value: string};
  assert.match(soraTodo.value, /not sent yet/);
});

test('a file larger than the Remote takes stays here, named, and the rest of the repo is sent all the same', async () => {
  await store.create('big', 'standard');
  await b.put('big', 'big.log', 'x'.repeat((16 << 20) + 1));
  await store.write('big', 'README.md', '# sent\n');
  const s = await draft.sync('big');
  assert.deepEqual(s.unsynced.map(([p]) => p), ['big.log']);
  const remote = await (await fetch(`${URL_}/v1/repos/big`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal('big.log' in remote.draft, false);
  assert.equal(await (await fetch(`${URL_}/v1/blobs/${remote.draft['README.md']}`, {headers: {Authorization: `Bearer ${token}`}})).text(), '# sent\n');
  // Said apart, and not a change waiting to go (so it is not sent again and again, nor shown as sending).
  const st = (await draft.status()).find((x) => x.name === 'big');
  assert.deepEqual([st?.unsynced.map(([p]) => p), st?.changed], [['big.log'], 0]);
  await store.remove('big', 'big.log');
});

test('a repo made here under a name the Remote remembers as discarded is sent as a new repo', async () => {
  // Made on another device, then discarded there.
  await elsewhere('again', {'README.md': '# first\n'});
  await db.execute(sql`update repo set off_at = now() where name = 'again'`);
  await purge(db, sql`r.name = 'again'`);
  // Made here anew: never in step, so it is a new repo, not the discarded one back.
  await store.create('again', 'standard');
  await store.write('again', 'README.md', '# made again\n');
  const s = await draft.sync('again');
  assert.ok(s.sent > 0);
  const there = await (await fetch(`${URL_}/v1/repos/again`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal(await (await fetch(`${URL_}/v1/blobs/${there.draft['README.md']}`, {headers: {Authorization: `Bearer ${token}`}})).text(), '# made again\n');
});

test('a change that cannot get in, round after round, is said so and not taken for in step', async () => {
  await store.create('busy', 'standard');
  await draft.sync('busy');
  await store.write('busy', 'README.md', '# waits\n');
  await setState('todo', JSON.stringify([{id: 'busy', title: 'waits'}]));
  // Another device moves each first, every time (the Remote answers every write: moved).
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const p = new URL(url).pathname;
    if ((init?.method === 'PATCH' && p.endsWith('/draft')) || (init?.method === 'PUT' && p === '/v1/home/todo')) {
      return Promise.resolve(new Response(JSON.stringify({error: 'moved', version: 999, value: '[]'}), {status: 409, headers: {'Content-Type': 'application/json'}}));
    }
    return real(url, init);
  }) as typeof fetch;
  try {
    await assert.rejects(draft.sync('busy'), /kept moving/);
    await assert.rejects(draft.syncHome('todo'), /kept changing/);
  } finally { globalThis.fetch = real; }
  assert.equal((await draft.status()).find((x) => x.name === 'busy')?.changed, 1);
  // Once it can, it goes.
  assert.equal((await draft.sync('busy')).sent, 1);
  await draft.syncHome('todo');
  assert.equal(draft.homeMoved('todo', (await (await fetch(`${URL_}/v1/home/todo`, {headers: {Authorization: `Bearer ${token}`}})).json() as {version: number}).version), false);
});

test('an issue is worked on in its own copy; pushed, submitted, reviewed and merged into main', async () => {
  await store.add('notes', 'issue', '001.md', 'Fix：落ちる\n');
  await draft.sync('notes');
  await history.cut('notes', null, 'Patch：issue', '');
  await history.startWork('notes', '001.md');
  // The repo shows the work's copy: what main has, as of its last commit.
  assert.equal((await history.work('notes')).line, '001');
  assert.equal(await text('notes', 'issue/001.md'), 'Fix：落ちる\n');
  await store.add('notes', '', 'fix.txt', 'fixed\n');
  const c = await history.cut('notes', null, '', 'first');
  assert.deepEqual([c.kind, c.title, c.issue], ['Fix', '落ちる', 'issue/001.md']);
  let w = await history.work('notes');
  assert.deepEqual([w.line, w.commits, w.unpushed, w.change], ['001', 1, 1, null]);
  await assert.rejects(history.submit('notes'), /Push first/);
  await history.push('notes');
  const ch = await history.submit('notes');
  assert.deepEqual([ch.version, ch.state, ch.folders, ch.files], [1, 'open', [''], 1]);
  w = await history.work('notes');
  assert.deepEqual([w.unpushed, w.change?.version], [0, 1]);
  const reviewed = await history.review('notes', ch, 'approve', 'good');
  assert.equal(reviewed.reviews[0].verdict, 'approve');
  const d = await history.changeDiff('notes', ch);
  assert.deepEqual(d.map((f) => [f.path, f.status]), [['fix.txt', 'added']]);
  // main does not have it until it is merged.
  await history.switchWork('notes', 'main');
  assert.ok(!(await names('notes')).includes('fix.txt'));
  const merged = await history.merge('notes', (await history.changesOf('notes'))[0]);
  assert.equal(merged.state, 'merged');
  await draft.sync('notes');
  assert.equal(await text('notes', 'fix.txt'), 'fixed\n');
});

test('a page asks the Remote only what moved, and reads again only that', async () => {
  const lifecycle = await import('./lifecycle.ts');
  const settle = lifecycle.settled;
  await lifecycle.look();
  await settle();
  // Nothing moved: each look is one small request.
  asked.length = 0;
  await lifecycle.look();
  await settle();
  assert.deepEqual(asked, ['/v1/moved']);
  // Another device changes a repo and the TODO: the list and the TODO are read again, the other settings are not.
  await elsewhere('notes', {'later.txt': 'from the other device\n'});
  const auth = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
  const todo = await (await fetch(`${URL_}/v1/home/todo`, {headers: auth})).json() as {value: string; version: number};
  await fetch(`${URL_}/v1/home/todo`, {method: 'PUT', headers: auth, body: JSON.stringify({value: todo.value.replace(']', ',{"id":"z","title":"elsewhere"}]'), version: todo.version})});
  asked.length = 0;
  await lifecycle.look();
  await settle();
  assert.equal(asked[0], '/v1/moved');
  assert.ok(asked.includes('/v1/repos') && asked.includes('/v1/home/todo'), asked.join(' '));
  assert.ok(!asked.includes('/v1/home/profile') && !asked.includes('/v1/home/dotfiles'), asked.join(' '));
  assert.ok((JSON.parse(getState('todo')!) as {id: string}[]).some((x) => x.id === 'z'));
  assert.equal(await text('notes', 'later.txt'), 'from the other device\n');
  lifecycle.end();
});

