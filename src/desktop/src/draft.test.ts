import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp, sha256} from '../service/app.ts';
import {createAuth} from '../service/auth.ts';
import {memoryBucket} from '../service/bucket.ts';
import * as schema from '../service/schema.ts';

// A browser on one Remote, all in this process: its storage is a map, and
// every fetch goes to the service itself.
const shelf = new Map<string, string>();
Object.assign(globalThis, {localStorage: {
  getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k),
}});
const URL_ = 'http://remote.test', APP = 'http://app.test';
const db = drizzle(new PGlite(), {schema});
await migrate(db, {migrationsFolder: new URL('../service/migrations', import.meta.url).pathname});
const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: URL_, appOrigin: APP, rateLimit: false, dev: true});
const app = createApp({db, auth, bucket: memoryBucket(), origins: [APP], providers: ['dev']});
Object.assign(globalThis, {fetch: (url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('Origin', APP);
  return app.request(url, {...init, headers});
}});

const {store} = await import('./repos.ts');
const draft = await import('./draft.ts');
const history = await import('./history.ts');
const {setState, getState} = await import('./state.ts');
const enc = new TextEncoder();

/** Signing in as the browser does: the stand-in provider's page, then back. */
const signIn = async () => {
  const asked = await fetch(`${URL_}/api/auth/sign-in/social`, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/`})});
  const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const go = new URL(((await asked.json()) as {url: string}).url);
  const approve = new URL(`${URL_}/dev-oauth/approve`);
  for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
  const back = (await fetch(approve.toString())).headers.get('Location')!;
  return (await fetch(back, {headers: {Cookie: cookies}})).headers.get('set-auth-token')!;
};
const token = await signIn();
await setState('remote', JSON.stringify({url: URL_, token}));

/** Another device on the same account, speaking to the Remote directly. */
async function elsewhere(repo: string, change: Record<string, Uint8Array | string | null>) {
  const auth = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
  const now = await (await fetch(`${URL_}/v1/repos/${repo}`, {headers: auth})).json() as {version?: number};
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const [p, v] of Object.entries(change)) {
    if (v === null) { remove.push(p); continue; }
    const bytes = typeof v === 'string' ? enc.encode(v) : v;
    const sha = await sha256(bytes);
    await fetch(`${URL_}/v1/blobs/${sha}`, {method: 'PUT', headers: {Authorization: auth.Authorization}, body: bytes as BodyInit});
    set[p] = sha;
  }
  const r = await fetch(`${URL_}/v1/repos/${repo}/draft`, {method: 'PATCH', headers: auth, body: JSON.stringify({version: now.version ?? 0, set, remove})});
  assert.equal(r.status, 200, await r.clone().text());
}

const text = async (repo: string, path: string) => (await store.read(repo, path)).text;
const names = async (repo: string, dir = '') => (await store.tree(repo, dir)).map((e) => e.name);

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

test("the other device's changes come in; a file changed on both keeps this one and puts that one beside it", async () => {
  await elsewhere('notes', {'docs/plan.md': 'plan\n'});
  const took = await draft.sync('notes');
  assert.equal(took.taken, 1);
  assert.equal(await text('notes', 'docs/plan.md'), 'plan\n');
  await elsewhere('notes', {'README.md': 'theirs\n'});
  await store.write('notes', 'README.md', 'mine\n');
  const both = await draft.sync('notes');
  assert.deepEqual(both.both, ['README.md']);
  assert.equal(await text('notes', 'README.md'), 'mine\n');
  assert.equal(await text('notes', 'README (別の端末).md'), 'theirs\n');
  // And this device's is what the Remote has now, beside file and all.
  const now = await (await fetch(`${URL_}/v1/repos/notes`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal(now.draft['README.md'], await sha256(enc.encode('mine\n')));
  assert.ok('README (別の端末).md' in now.draft);
});

test('a file this browser cannot hold stays on the Remote, untouched by this copy', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]);
  await elsewhere('notes', {'logo.png': png});
  await draft.sync('notes');
  assert.ok(!(await names('notes')).includes('logo.png'));
  await store.write('notes', 'README.md', 'mine, again\n');
  await draft.sync('notes');
  const now = await (await fetch(`${URL_}/v1/repos/notes`, {headers: {Authorization: `Bearer ${token}`}})).json() as {draft: Record<string, string>};
  assert.equal(now.draft['logo.png'], await sha256(png));
});

test('a repo only on the Remote comes here when opened, with nothing of a template', async () => {
  await elsewhere('far', {'a.txt': 'a\n'});
  await draft.fetchRepo('far');
  assert.deepEqual(await names('far'), ['a.txt']);
  assert.equal(await text('far', 'a.txt'), 'a\n');
});

test('区切る makes the draft history; what is not cut is the draft against it', async () => {
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
  await assert.rejects(history.cut('notes', null, '  ', ''), /件名/);
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
});
