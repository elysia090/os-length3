import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handle, memoryBucket, sha256} from '../remote/remote.ts';

// The browser's storage, as this process has none.
const kept = new Map<string, string>();
Object.assign(globalThis, {localStorage: {
  getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k),
}});
// Every fetch goes to one Remote, in memory.
const bucket = memoryBucket();
const URL_ = 'https://remote.test';
Object.assign(globalThis, {fetch: (url: string, init?: RequestInit) => handle(new Request(url, init), bucket)});

const {store} = await import('./repos.ts');
const sync = await import('./sync.ts');
const {getState, setState} = await import('./state.ts');
const enc = new TextEncoder();

/** Another device on the same account: it speaks to the Remote directly. */
async function otherPushes(token: string, repo: string, change: Record<string, string>) {
  const auth = {Authorization: `Bearer ${token}`};
  const head = await (await fetch(`${URL_}/v1/repos/${repo}`, {headers: auth})).json();
  const tree = {...head.tree};
  for (const [p, text] of Object.entries(change)) {
    const sha = await sha256(enc.encode(text));
    await fetch(`${URL_}/v1/blobs/${sha}`, {method: 'PUT', headers: auth, body: text});
    tree[p] = sha;
  }
  const r = await fetch(`${URL_}/v1/repos/${repo}/cuts`, {method: 'POST', headers: auth,
    body: JSON.stringify({parent: head.id, tree, kind: '', title: 'from elsewhere', issue: '', note: ''})});
  assert.equal(r.status, 201);
}

const stateOf = async (repo: string) => (await sync.states()).get(repo)!;
let token = '';

test('a repo is only here until 区切る pushes it; an edit makes it unpushed again', async () => {
  token = await sync.signUp(URL_);
  await store.create('notes', 'standard');
  assert.equal((await stateOf('notes')).state, 'local');
  await sync.push('notes', {kind: 'Fix', title: 'first', issue: '', note: ''});
  assert.equal((await stateOf('notes')).state, 'pushed');
  await store.write('notes', 'README.md', '# notes\nmore\n');
  assert.deepEqual(await stateOf('notes'), {state: 'unpushed', changed: 1, head: (await stateOf('notes')).head});
  assert.deepEqual(await sync.pushedRepos(), []);
  await sync.push('notes', {kind: '', title: 'second', issue: '', note: ''});
  assert.equal((await stateOf('notes')).state, 'pushed');
  assert.deepEqual(await sync.pushedRepos(), ['notes']);
});

test('when another device pushes, this one is behind until it takes it in', async () => {
  await otherPushes(token, 'notes', {'docs/plan.md': 'plan\n'});
  assert.equal((await stateOf('notes')).state, 'behind');
  // A push from the old base is refused, not merged over.
  await store.write('notes', 'README.md', '# notes\nhere\n');
  await assert.rejects(sync.push('notes', {kind: '', title: 'x', issue: '', note: ''}), /先に進んでいます/);
  // Taking in keeps what changed here and takes what changed there.
  assert.equal(await sync.pull('notes'), 'taken');
  assert.equal((await store.read('notes', 'docs/plan.md')).text, 'plan\n');
  assert.equal((await store.read('notes', 'README.md')).text, '# notes\nhere\n');
  assert.equal((await stateOf('notes')).state, 'unpushed');
  await sync.push('notes', {kind: '', title: 'on top', issue: '', note: ''});
  assert.equal((await stateOf('notes')).state, 'pushed');
});

test('a file changed on both sides is named, and nothing is taken', async () => {
  await otherPushes(token, 'notes', {'README.md': 'theirs\n', 'docs/plan.md': 'plan 2\n'});
  await store.write('notes', 'README.md', 'mine\n');
  await assert.rejects(sync.pull('notes'), (e: unknown) => e instanceof sync.Conflict && e.paths.join() === 'README.md');
  assert.equal((await store.read('notes', 'README.md')).text, 'mine\n');
  assert.equal((await store.read('notes', 'docs/plan.md')).text, 'plan\n');
});

test('a repo the Remote has comes here whole, checked against its names', async () => {
  const auth = {Authorization: `Bearer ${token}`};
  const text = 'only there\n';
  const sha = await sha256(enc.encode(text));
  await fetch(`${URL_}/v1/blobs/${sha}`, {method: 'PUT', headers: auth, body: text});
  await fetch(`${URL_}/v1/repos/far/cuts`, {method: 'POST', headers: auth,
    body: JSON.stringify({parent: null, tree: {'a/b.md': sha, empty: null}, kind: '', title: 't', issue: '', note: ''})});
  assert.equal(await sync.pull('far'), 'taken');
  assert.deepEqual((await store.tree('far', '')).map((e) => e.name), ['a', 'empty']);
  assert.equal((await store.read('far', 'a/b.md')).text, text);
  assert.equal((await stateOf('far')).state, 'pushed');
});

test('a setting changed here goes up from its version; unchanged, the Remote\'s comes down', async () => {
  await setState('todo', JSON.stringify(['a']));
  assert.equal(sync.homeState('todo'), 'local');
  assert.equal(await sync.syncHome('todo'), 'pushed');
  assert.equal(sync.homeState('todo'), 'pushed');
  // Another device changes it; nothing changed here, so it comes down.
  const auth = {Authorization: `Bearer ${token}`};
  const etag = (await fetch(`${URL_}/v1/home/todo`, {headers: auth})).headers.get('ETag')!;
  await fetch(`${URL_}/v1/home/todo`, {method: 'PUT', headers: {...auth, 'If-Match': etag}, body: JSON.stringify(['a', 'b'])});
  assert.equal(await sync.syncHome('todo'), 'pushed');
  assert.equal(getState('todo'), JSON.stringify(['a', 'b']));
  // Both change it: neither is lost, and it says so.
  const etag2 = (await fetch(`${URL_}/v1/home/todo`, {headers: auth})).headers.get('ETag')!;
  await fetch(`${URL_}/v1/home/todo`, {method: 'PUT', headers: {...auth, 'If-Match': etag2}, body: JSON.stringify(['there'])});
  await setState('todo', JSON.stringify(['here']));
  assert.equal(await sync.syncHome('todo'), 'conflict');
  assert.equal(getState('todo'), JSON.stringify(['here']));
});
