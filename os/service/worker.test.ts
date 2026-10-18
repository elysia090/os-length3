import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {bridge, throughBridge} from './bridge.ts';
import {NO_FILES} from './bucket.ts';
import {sha256} from './request.ts';
import {database, enc} from './testing.ts';
import worker, {type Env} from './worker.ts';

// The Worker itself (worker.ts: its fetch and its scheduled sweep, each on a
// connection of its own), as production runs it: a Remote for research
// (ENTER_AS), and here with no R2 bound. Its database is reached by its own
// driver, Neon's, over a WebSocket, which a bridge in this process hands to
// a PGlite migrated as the tests' are.

const pg = await database();
const b = await bridge({pglite: pg});
throughBridge(b.port);
after(async () => { await b.close(); await pg.close(); });

const env: Env = {
  DATABASE_URL: 'postgresql://remote_worker:unused@pglite.invalid:5432/postgres',
  BETTER_AUTH_SECRET: 'worker-test-secret-'.repeat(3),
  BASE_URL: 'http://remote.test', APP_ORIGIN: 'http://app.test', DOMAIN: 'length3.test',
  ENTER_AS: 'tester', ENTER_KEY: 'k'.repeat(40),
};
/** What the Worker hands to waitUntil: each request's pool, let go after it answers. */
const waiting: Promise<unknown>[] = [];
const ctx = {waitUntil: (p: Promise<unknown>) => { waiting.push(p); }};
const ask = async (method: string, path: string, o: {token?: string; body?: unknown; bytes?: Uint8Array} = {}) => {
  const r = await worker.fetch(new Request(`${env.BASE_URL}${path}`, {method,
    headers: {...(o.token ? {Authorization: `Bearer ${o.token}`} : {}), ...(o.body !== undefined ? {'Content-Type': 'application/json'} : {})},
    body: o.bytes as BodyInit | undefined ?? (o.body === undefined ? undefined : JSON.stringify(o.body))}), env, ctx);
  const text = await r.text();
  await Promise.all(waiting.splice(0));
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return {status: r.status, json: json as Record<string, unknown>};
};

test('the Worker with no bucket starts, answers from its database, and refuses only what would move bytes', async () => {
  assert.deepEqual(await ask('GET', '/v1/health'), {status: 200, json: {ok: true}});
  assert.equal((await ask('GET', '/v1/about')).json.enter, true);
  const entered = await ask('POST', '/v1/enter', {body: {key: env.ENTER_KEY}});
  assert.equal(entered.status, 200);
  const token = entered.json.token as string;
  const sha = await sha256(enc.encode('# notes\n'));
  // Rows: which files it lacks, a draft, a commit, Home, the list of repos.
  assert.deepEqual((await ask('POST', '/v1/blobs/missing', {token, body: [sha]})).json, [sha]);
  assert.deepEqual(await ask('PATCH', '/v1/repos/notes/draft', {token, body: {version: 0, set: {docs: null}, remove: []}}), {status: 200, json: {version: 1}});
  assert.equal((await ask('POST', '/v1/repos/notes/cuts', {token, body: {version: 1, parent: null, title: 'Start'}})).status, 201);
  assert.deepEqual(await ask('PUT', '/v1/home/todo', {token, body: {value: '[]', version: 0}}), {status: 200, json: {version: 1}});
  assert.deepEqual(((await ask('GET', '/v1/repos', {token})).json as unknown as {name: string}[]).map((r) => r.name), ['notes']);
  // Bytes: one answer, wherever they would move.
  for (const [m, p, o] of [['PUT', `/v1/blobs/${sha}`, {token, bytes: enc.encode('# notes\n')}], ['GET', `/v1/blobs/${sha}`, {token}], ['GET', `/v1/os/${sha}`, {}], ['GET', '/v1/desktop/length3.deb', {}]] as const) {
    assert.deepEqual(await ask(m, p, o), {status: 503, json: {...NO_FILES}}, `${m} ${p}`);
  }
});

test('the Worker\'s daily sweep runs with no bucket', async () => {
  await worker.scheduled(null, env, ctx);
  await Promise.all(waiting.splice(0));
});
