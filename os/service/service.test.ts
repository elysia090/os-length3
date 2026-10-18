import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp, sha256} from './app.ts';
import {createAuth} from './auth.ts';
import {enterEmail, type Enter} from './enter.ts';
import {memoryBucket} from './bucket.ts';
import * as schema from './schema.ts';
import {sweep} from './sweep.ts';
import homeSync from '../shared/home-sync.json' with {type: 'json'};

const BASE = 'http://remote.test';
const APP = 'http://app.test';

// Each test's database is a copy of one made and migrated once: making one
// anew (initdb) is most of a test's time, a copy a fraction of it. Each is
// closed when its test ends, so the file's tests do not hold them all at once.
let migrated: Promise<File | Blob> | undefined;
const open: PGlite[] = [];
const fresh = async () => {
  migrated ??= (async () => {
    const pg = new PGlite();
    await migrate(drizzle(pg, {schema}), {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
    const dump = await pg.dumpDataDir('none');
    await pg.close();
    return dump;
  })();
  const pg = new PGlite({loadDataDir: await migrated});
  open.push(pg);
  return drizzle(pg, {schema});
};
afterEach(() => Promise.all(open.splice(0).map((pg) => pg.close())).then(() => {}));

async function service(records: Record<string, string[]> = {}, o: {quota?: number; enter?: Enter} = {}) {
  const db = await fresh();
  const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true, only: o.enter && enterEmail(o.enter.as)});
  const bucket = memoryBucket();
  // DNS as a map of name → TXT records.
  const dns = new Map(Object.entries(records));
  const mails: {to: string; subject: string; text: string}[] = [];
  const app = createApp({db, auth, bucket, origins: [APP], appOrigin: APP, providers: ['dev'], domain: 'length3.test', baseURL: BASE,
    secret: 'test-secret-'.repeat(4), txt: async (name) => dns.get(name) ?? [], recheck: 0, mail: async (to, subject, text) => { mails.push({to, subject, text}); }, quota: o.quota,
    enter: o.enter});
  // The service asks its own stand-in provider for tokens over the network: here, itself.
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    (String(url instanceof Request ? url.url : url).startsWith(BASE) ? app.request(url as string, init) : real(url, init))) as typeof fetch;
  const call = async (method: string, path: string, opts: {token?: string; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>} = {}) => {
    const r = await app.request(BASE + path, {
      method,
      headers: {Origin: APP, ...(opts.token ? {Authorization: `Bearer ${opts.token}`} : {}), ...(opts.body !== undefined ? {'Content-Type': 'application/json'} : {}), ...opts.headers},
      body: (opts.bytes as BodyInit | undefined) ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {status: r.status, json: json as Record<string, unknown> & unknown[], headers: r.headers, text};
  };
  /** Each session's cookie, as the browser that signed in holds it. */
  const sessions = new Map<string, string>();
  /** Signing in as a browser does: the provider's page, then back through the callback. */
  const start = async (name = 'Ren') => {
    const asked = await app.request(`${BASE}/api/auth/sign-in/social`, {method: 'POST', headers: {Origin: APP, 'Content-Type': 'application/json'},
      body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/?signed-in`})});
    assert.equal(asked.status, 200, await asked.clone().text());
    const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const go = new URL(((await asked.json()) as {url: string}).url);
    const approve = new URL(`${BASE}/dev-oauth/approve`);
    for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
    approve.searchParams.set('name', name);
    const back = (await app.request(approve.toString())).headers.get('Location')!;
    const done = await app.request(back, {headers: {Cookie: cookies}});
    assert.equal(done.status, 302, await done.clone().text());
    assert.equal(done.headers.get('Location'), `${APP}/?signed-in`);
    const token = done.headers.get('set-auth-token');
    assert.ok(token);
    sessions.set(token!, done.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
    return token!;
  };
  const publish = (name: string, value: string) => dns.set(name, [...(dns.get(name) ?? []), value]);
  const unpublish = (name: string) => dns.delete(name);
  return {db, app, call, start, bucket, publish, unpublish, mails, sessions};
}

const enc = new TextEncoder();

type Service = Awaited<ReturnType<typeof service>>;
/** Who a session is, as the Remote says (the name the app's off ask shows comes from here). */
const whoIs = async (s: Service, token: string) =>
  (await s.call('GET', '/api/auth/get-session', {token})).json as unknown as {user: {id: string; name: string}; session: {id: string; token: string}};
/** A passkey sign-in `ago` ms before now made this session, as auth.ts records one (no authenticator in a test). */
async function prove(s: Service, token: string, ago = 0) {
  const {user, session} = await whoIs(s, token);
  const proof = {proofSession: session.id, proofAt: new Date(Date.now() - ago)};
  await s.db.insert(schema.guard).values({userId: user.id, ...proof}).onConflictDoUpdate({target: schema.guard.userId, set: proof});
}
/** The sessions of the account `token` is in, as Remote → Devices lists them. */
const sessionsOf = async (s: Service, token: string) =>
  (await s.call('GET', '/api/auth/list-sessions', {token})).json as unknown as {id: string; token: string}[];

test('nothing of the work is answered without a session', async () => {
  const s = await service();
  assert.equal((await s.call('GET', '/v1/repos')).status, 401);
  assert.equal((await s.call('GET', '/v1/repos', {token: 'not-a-session'})).status, 401);
  const t = await s.start();
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: t})).json, []);
});

test('an account is a provider identity: the same person signs in to the same account', async () => {
  const s = await service();
  const a = await s.start('Ren'), b = await s.start('Ren'), other = await s.start('Mio');
  const who = async (t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {user: {id: string; name: string}}).user;
  assert.equal((await who(a)).id, (await who(b)).id);
  assert.notEqual((await who(a)).id, (await who(other)).id);
  assert.equal((await who(a)).name, 'Ren');
  // The session's own token (as get-session gives it) works as the bearer too.
  const raw = ((await s.call('GET', '/api/auth/get-session', {token: a})).json as unknown as {session: {token: string}}).session.token;
  assert.equal((await s.call('GET', '/v1/repos', {token: raw})).status, 200);
  // No way in without a provider: there are no blank accounts.
  assert.notEqual((await s.call('POST', '/api/auth/sign-in/anonymous', {body: {}})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/about')).json, {passkey: true, providers: ['dev'], domain: 'length3.test', app: APP});
});

test('a device asks for a code, a signed-in browser approves it, the device gets its own session', async () => {
  const s = await service();
  const t = await s.start();
  const asked = await s.call('POST', '/api/auth/device/code', {body: {client_id: 'l3'}});
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const {device_code, user_code, verification_uri_complete} = asked.json as unknown as {device_code: string; user_code: string; verification_uri_complete: string};
  assert.ok(verification_uri_complete.startsWith(`${APP}/?device`));
  // On the origin the Remote says its app is on, by whatever name a device reaches it (core/src/remote.rs device_page_ok).
  assert.ok(verification_uri_complete.startsWith(`${(await s.call('GET', '/v1/about')).json.app}/?device`));
  const poll = () => s.call('POST', '/api/auth/device/token', {body: {grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: 'l3'}});
  assert.equal((await poll()).json.error, 'authorization_pending');
  // Unknown clients cannot ask.
  assert.notEqual((await s.call('POST', '/api/auth/device/code', {body: {client_id: 'someone-else'}})).status, 200);
  // The browser first claims the code it was shown (the page asks which device), then approves.
  const claimed = await s.call('GET', `/api/auth/device?user_code=${encodeURIComponent(user_code)}`, {token: t});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  const approved = await s.call('POST', '/api/auth/device/approve', {token: t, body: {userCode: user_code}});
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  // Polling sooner than the interval says so; after it, the token comes.
  await new Promise((r) => setTimeout(r, 2100));
  const got = await poll();
  assert.equal(got.status, 200, JSON.stringify(got.json));
  const deviceToken = got.json.access_token as string;
  assert.ok(deviceToken && deviceToken !== t);
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: deviceToken})).json, []);
  // Each is a session of its own, listed together, and ended one by one.
  const list = await s.call('GET', '/api/auth/list-sessions', {token: t});
  assert.equal((list.json as unknown[]).length, 2);
});

test('Devices: another device is signed out from any of the account\'s, and from no one else\'s', async () => {
  const s = await service();
  const laptop = await s.start('Ren'), phone = await s.start('Ren'), mio = await s.start('Mio');
  const phoneId = (await whoIs(s, phone)).session.id;
  const phoneRow = (await sessionsOf(s, laptop)).find((d) => d.id === phoneId);
  assert.ok(phoneRow, 'the other device is listed');
  // Another account cannot end it, even holding the row's token: it is not that account's session.
  await s.call('POST', '/api/auth/revoke-session', {token: mio, body: {token: phoneRow.token}});
  assert.equal((await s.call('GET', '/v1/repos', {token: phone})).status, 200);
  // The same call l3 makes (`l3 remote devices rm N`) and the row's Sign out makes: the phone is out, the laptop stays.
  assert.equal((await s.call('POST', '/api/auth/revoke-session', {token: laptop, body: {token: phoneRow.token}})).status, 200);
  assert.equal((await s.call('GET', '/v1/repos', {token: phone})).status, 401);
  assert.equal((await s.call('GET', '/v1/repos', {token: laptop})).status, 200);
  assert.deepEqual((await sessionsOf(s, laptop)).map((d) => d.id), [(await whoIs(s, laptop)).session.id]);
});

test('Turning off checks the account\'s name as the Remote says it, not one the person chose elsewhere', async () => {
  const s = await service();
  const t = await s.start('Sora Tamura');
  await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 0, set: {}, remove: []}});
  // The profile is the person's to write: it is not what is checked.
  assert.equal((await s.call('PUT', '/v1/home/profile', {token: t, body: {value: JSON.stringify({name: 'Sora', handle: 'sora', bio: ''}), version: 0}})).status, 200);
  await prove(s, t);
  await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB12C'}});
  const off = (name: string) => s.call('POST', '/v1/repos/notes/off', {token: t, body: {name, repo: 'notes', code: 'AB12C'}});
  const refused = await off('Sora');
  assert.deepEqual([refused.status, refused.json.error], [403, 'The names do not match.']);
  // The name get-session gives (what the ask says to type), in any case and with spaces around it.
  assert.equal((await whoIs(s, t)).user.name, 'Sora Tamura');
  assert.equal((await off(' sora tamura ')).status, 200);
});

test('Setting the code and turning off are confirmed by one passkey, for five minutes and no longer', async () => {
  const s = await service();
  const t = await s.start('Ren');
  for (const r of ['notes', 'trip']) await s.call('PATCH', `/v1/repos/${r}/draft`, {token: t, body: {version: 0, set: {}, remove: []}});
  const off = (repo: string) => s.call('POST', `/v1/repos/${repo}/off`, {token: t, body: {name: 'Ren', repo, code: 'AB12C'}});
  // The off ask sets the code with a passkey, then turns off without asking for another (src/pages/remote.ts PROOF, four minutes).
  await prove(s, t, 4 * 60 * 1000);
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB12C'}})).status, 200);
  assert.equal((await off('notes')).status, 200);
  // Past five minutes the passkey is asked again.
  await prove(s, t, 5 * 60 * 1000 + 1000);
  const late = await off('trip');
  assert.deepEqual([late.status, late.json.error], [403, 'Confirm with a passkey.']);
  // A proof is one session's: another device of the same account is not confirmed by it.
  await prove(s, t);
  const other = await s.start('Ren');
  assert.equal((await s.call('POST', '/v1/repos/trip/off', {token: other, body: {name: 'Ren', repo: 'trip', code: 'AB12C'}})).status, 403);
});

test('a draft changes only from the version it was read at; a cut records it', async () => {
  const s = await service();
  const t = await s.start();
  const put = async (text: string) => {
    const bytes = enc.encode(text);
    const sha = await sha256(bytes);
    assert.equal((await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status, 201);
    return sha;
  };
  const readme = await put('# notes\n');
  // A diff naming a blob not there yet says which.
  const ghost = await sha256(enc.encode('not uploaded'));
  assert.deepEqual((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 0, set: {'a.md': ghost}, remove: []}})).json, {missing: [ghost]});
  const v1 = await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 0, set: {'README.md': readme, docs: null}, remove: []}});
  assert.deepEqual(v1.json, {version: 1});
  // Two devices on version 1: one lands, the other gets the draft to merge.
  const plan = await put('plan\n');
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'docs/plan.md': plan}, remove: ['docs']}})).json.version, 2);
  const stale = await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'x.md': plan}, remove: []}});
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, {version: 2});
  // Paths that leave the repo or touch .git never get in.
  for (const p of ['../x', '.git/config', 'a//b', 'src/.GIT./hooks']) {
    assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 2, set: {[p]: null}, remove: []}})).status, 400, p);
  }
  // Commit: the draft as it is at version 2.
  const first = await s.call('POST', '/v1/repos/notes/cuts', {token: t, body: {version: 2, parent: null, kind: 'Fix', title: '最初', issue: 'issue/001.md', note: '', added: 2, removed: 0}});
  assert.equal(first.status, 201);
  const id = first.json.id as string;
  const one = await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t});
  assert.deepEqual([one.json.tree, one.json.added, one.json.title, 'userId' in one.json], [{'README.md': readme, 'docs/plan.md': plan}, 2, '最初', false]);
  // A cut from an older version, or an older parent, is refused with what is there.
  assert.deepEqual((await s.call('POST', '/v1/repos/notes/cuts', {token: t, body: {version: 1, parent: id, title: 'x'}})).json, {head: id, version: 2});
  assert.equal((await s.call('POST', '/v1/repos/notes/cuts', {token: t, body: {version: 2, parent: null, title: 'x'}})).status, 409);
  const repos = await s.call('GET', '/v1/repos', {token: t});
  assert.deepEqual((repos.json as unknown as {name: string; head: string; version: number; bytes: number}[]).map((r) => [r.name, r.head, r.version, r.bytes]), [['notes', id, 2, 13]]);
  const log = await s.call('GET', '/v1/repos/notes/log', {token: t});
  assert.deepEqual((log.json as unknown as {id: string; title: string; tree: object}[]).map((c) => [c.id, c.title]), [[id, '最初']]);
  // Turning a repo off asks for a passkey just now, the names and the code; it then answers only that it is off.
  const off = (body: unknown) => s.call('POST', '/v1/repos/notes/off', {token: t, body});
  assert.equal((await off({name: 'Ren', repo: 'notes', code: 'AB12C'})).status, 403); // no passkey yet
  const session = ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {session: {id: string}; user: {id: string}});
  await s.db.insert(schema.guard).values({userId: session.user.id, proofSession: session.session.id, proofAt: new Date()});
  assert.equal((await off({name: 'Ren', repo: 'notes', code: 'AB12C'})).status, 409); // no code set
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB-1'}})).status, 400);
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'ab12c'}})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/off-code', {token: t})).json.set, true);
  assert.equal((await off({name: 'Ren', repo: 'notes', code: 'ZZZZZ'})).status, 403);
  assert.equal((await off({name: 'Mio', repo: 'notes', code: 'AB12C'})).status, 403);
  assert.equal((await off({name: 'ren', repo: 'notes', code: 'AB12C'})).status, 200);
  assert.equal((await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t})).status, 410);
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 2, set: {}, remove: []}})).status, 410);
  const listed = (await s.call('GET', '/v1/repos', {token: t})).json as unknown as {name: string; offAt: number; until: number}[];
  assert.equal(listed[0].name, 'notes');
  assert.ok(listed[0].offAt && listed[0].until - listed[0].offAt === 30 * 24 * 3600 * 1000);
  // On: back at once, history and all.
  assert.equal((await s.call('POST', '/v1/repos/notes/on', {token: t})).status, 200);
  assert.equal((await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t})).status, 200);
  // Thirty days on, it goes for good.
  await s.db.update(schema.repo).set({offAt: new Date(Date.now() - 31 * 24 * 3600 * 1000)});
  await sweep(s.db, s.bucket);
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: t})).json, []);
  assert.equal((await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t})).status, 404);
});

test('an account sees only its own: blobs, repos, settings', async () => {
  const s = await service();
  const a = await s.start('A'), b = await s.start('B');
  const bytes = enc.encode('mine');
  const sha = await sha256(bytes);
  await s.call('PUT', `/v1/blobs/${sha}`, {token: a, bytes});
  assert.equal((await s.call('GET', `/v1/blobs/${sha}`, {token: b})).status, 404);
  assert.deepEqual((await s.call('POST', '/v1/blobs/missing', {token: b, body: [sha]})).json, [sha]);
  await s.call('PATCH', '/v1/repos/r/draft', {token: a, body: {version: 0, set: {'a.txt': sha}, remove: []}});
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: b})).json, []);
  // The same file kept by another account is not counted as this one's, nor told to it.
  await s.call('PUT', `/v1/blobs/${sha}`, {token: b, bytes});
  assert.equal(((await s.call('GET', '/v1/repos', {token: a})).json as unknown as {bytes: number}[])[0].bytes, 4);
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '[]', version: 0}})).json.version, 1);
  assert.deepEqual((await s.call('GET', '/v1/home/todo', {token: b})).json, {value: null, version: 0});
  // A setting changes only from the version it was read at.
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '["x"]', version: 1}})).json.version, 2);
  assert.deepEqual((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '["y"]', version: 1}})).json, {value: '["x"]', version: 2});
});

test('Home\'s settings answer as shared/home-sync.json records them, which the app and l3 are written against', async () => {
  const s = await service();
  const t = await s.start();
  for (const [i, x] of homeSync.exchanges.entries()) {
    const r = await s.call(x.method, x.path, {token: t, body: 'body' in x ? x.body : undefined});
    assert.deepEqual([r.status, r.json], [x.status, x.response], `exchange ${i + 1}: ${x.method} ${x.path}`);
  }
});

test('Health: anyone may ask whether the Remote answers from its database, and is told no more than that', async () => {
  const s = await service();
  assert.deepEqual((await s.call('GET', '/v1/health')).json, {ok: true});
  // A database that does not answer: 503, its error kept in the log, not in the answer.
  const down = {execute: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432 as remote_worker'); }};
  const app = createApp({db: down, auth: createAuth({db: down, secret: 'test-secret-'.repeat(4), baseURL: BASE, appOrigin: APP}), bucket: memoryBucket(),
    origins: [APP], providers: [], domain: 'length3.test', baseURL: BASE});
  const error = console.error;
  console.error = () => {};
  try {
    const r = await app.request(`${BASE}/v1/health`);
    assert.equal(r.status, 503);
    assert.doesNotMatch(await r.text(), /ECONNREFUSED|remote_worker/);
  } finally {
    console.error = error;
  }
});

test('Sign-in is held off address by address, the address Cloudflare saw, counted in the database', async () => {
  const db = await fresh();
  // Two of the same app over one database, as two isolates of the Worker are.
  const made = () => createApp({db, auth: createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: BASE, appOrigin: APP, dev: true}),
    bucket: memoryBucket(), origins: [APP], providers: ['dev'], domain: 'length3.test', baseURL: BASE});
  const [a, b] = [made(), made()];
  const signIn = async (app: ReturnType<typeof made>, ip: string) => (await app.request(`${BASE}/api/auth/sign-in/social`, {method: 'POST',
    headers: {Origin: APP, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip}, body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/`})})).status;
  // Three sign-ins in ten seconds from one address, then it waits, in either isolate; another address does not.
  const one = [];
  for (const app of [a, b, a, b]) one.push(await signIn(app, '203.0.113.1'));
  assert.deepEqual(one, [200, 200, 200, 429]);
  assert.equal(await signIn(b, '203.0.113.2'), 200);
  // The count is the database's (an isolate's memory is its own alone), kept by the service's role.
  const kept = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role remote_app`);
    return (await tx.execute(sql`update rate_limit set count = count where key like '203.0.113.%' returning key, count`)).rows;
  });
  assert.deepEqual(kept.map((r) => [String(r.key).split('|')[0], r.count]).sort(), [['203.0.113.1', 3], ['203.0.113.2', 1]]);
});

test('only the app\'s pages may call, and they can read a new session\'s token', async () => {
  const s = await service();
  const ok = await s.call('OPTIONS', '/v1/repos', {headers: {'Access-Control-Request-Method': 'GET'}});
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
  const r = await s.call('POST', '/api/auth/sign-in/social', {body: {provider: 'dev', callbackURL: `${APP}/`}});
  assert.equal(r.headers.get('Access-Control-Allow-Credentials'), 'true');
  const other = await s.call('OPTIONS', '/v1/repos', {headers: {Origin: 'http://evil.test', 'Access-Control-Request-Method': 'GET'}});
  assert.notEqual(other.headers.get('Access-Control-Allow-Origin'), 'http://evil.test');
});

test('work on an issue is its own line; submitted, reviewed by version, merged into main', async () => {
  const s = await service();
  const t = await s.start();
  const put = async (text: string) => {
    const bytes = enc.encode(text);
    const sha = await sha256(bytes);
    await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes});
    return sha;
  };
  const [readme, issue, fix, fix2, other] = await Promise.all(['# r\n', 'Fix：落ちる\n', 'fixed\n', 'fixed again\n', 'main moved\n'].map(put));
  const draft = (line: string, version: number, set: Record<string, string | null>) =>
    s.call('PATCH', `/v1/repos/r/draft?line=${line}`, {token: t, body: {version, set, remove: []}});
  const commitOn = async (line: string, title: string) => {
    const now = (await s.call('GET', `/v1/repos/r?line=${line}`, {token: t})).json as unknown as {version: number; head: string | null};
    const r = await s.call('POST', `/v1/repos/r/cuts?line=${line}`, {token: t, body: {version: now.version, parent: now.head, title}});
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.id as string;
  };
  await draft('main', 0, {'README.md': readme, 'issue/001.md': issue});
  const first = await commitOn('main', 'start');
  // Writing to a line nobody started is refused: work begins from its issue.
  assert.equal((await draft('001', 0, {'a.txt': fix})).status, 404);
  const started = await s.call('POST', '/v1/repos/r/lines', {token: t, body: {issue: 'issue/001.md'}});
  assert.equal(started.status, 201);
  assert.deepEqual([started.json.line, started.json.base, started.json.issue], ['001', first, 'issue/001.md']);
  assert.equal(started.json.startedBy, 'Ren');
  // Its draft is read where a device reads it: the line itself (the list of lines carries none).
  assert.ok(!('draft' in started.json));
  assert.deepEqual((await s.call('GET', '/v1/repos/r?line=001', {token: t})).json.draft, {'README.md': readme, 'issue/001.md': issue});
  // Committing on the line leaves main alone.
  assert.equal((await draft('001', 1, {'src/fix.c': fix})).status, 200);
  const c1 = await commitOn('001', 'Fix：落ちる');
  assert.equal(((await s.call('GET', '/v1/repos/r', {token: t})).json as unknown as {head: string}).head, first);
  // Submit change needs the commits pushed.
  assert.equal((await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '001', kind: 'Fix', title: '落ちる'}})).status, 409);
  assert.equal((await s.call('POST', '/v1/repos/r/lines/001/push', {token: t, body: {head: c1}})).status, 200);
  const submitted = await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '001', kind: 'Fix', title: '落ちる'}});
  assert.equal(submitted.status, 201);
  const id = submitted.json.id as string;
  assert.deepEqual([submitted.json.version, submitted.json.state, submitted.json.base, submitted.json.head], [1, 'open', first, c1]);
  assert.equal((await s.call('POST', `/v1/repos/r/changes/${id}/reviews`, {token: t, body: {version: 1, verdict: 'approve', marks: ['src/fix.c:2', 'src/fix.c:2', 7]}})).status, 201);
  // More work, pushed and submitted again: version 2, and the approval is of version 1.
  assert.equal((await draft('001', 2, {'src/fix.c': fix2})).status, 200);
  const c2 = await commitOn('001', 'Fix：落ちる（続き）');
  await s.call('POST', '/v1/repos/r/lines/001/push', {token: t, body: {head: c2}});
  const again = await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '001', kind: 'Fix', title: '落ちる'}});
  assert.deepEqual([again.json.id, again.json.version], [id, 2]);
  assert.deepEqual((again.json.reviews as {version: number; verdict: string; marks: string[]}[]).map((r) => [r.version, r.verdict, r.marks]), [[1, 'approve', ['src/fix.c:2']]]);
  // Merging the old version is refused; merging this one lands on main, with main's own work kept.
  assert.equal((await s.call('POST', `/v1/repos/r/changes/${id}/merge`, {token: t, body: {version: 1}})).status, 409);
  await draft('main', 1, {'notes.txt': other});
  const merged = await s.call('POST', `/v1/repos/r/changes/${id}/merge`, {token: t, body: {version: 2}});
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  assert.equal(merged.json.state, 'merged');
  const main = (await s.call('GET', '/v1/repos/r', {token: t})).json as unknown as {head: string; draft: Record<string, string>};
  assert.equal(main.head, merged.json.merged);
  assert.equal(main.draft['src/fix.c'], fix2);
  assert.equal(main.draft['notes.txt'], other);
  const log = (await s.call('GET', '/v1/repos/r/log', {token: t})).json as unknown as {id: string; merged: string | null}[];
  assert.deepEqual(log.map((c) => c.merged), [c2, null]);
});

test('a file both sides changed stops the merge; reject is the receiver\'s, reset the submitter\'s', async () => {
  const s = await service();
  const t = await s.start();
  const sha = async (text: string) => {
    const bytes = enc.encode(text);
    const d = await sha256(bytes);
    await s.call('PUT', `/v1/blobs/${d}`, {token: t, bytes});
    return d;
  };
  const [a, b, c, issue] = await Promise.all(['a\n', 'b\n', 'c\n', 'Fix：x\n'].map(sha));
  const head = async (line: string) => (await s.call('GET', `/v1/repos/r?line=${line}`, {token: t})).json as unknown as {version: number; head: string | null};
  const commitOn = async (line: string) => {
    const h = await head(line);
    return (await s.call('POST', `/v1/repos/r/cuts?line=${line}`, {token: t, body: {version: h.version, parent: h.head, title: 'x'}})).json.id as string;
  };
  await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 0, set: {'f.txt': a, 'issue/001.md': issue, 'issue/002.md': issue}, remove: []}});
  await commitOn('main');
  for (const n of ['001', '002']) await s.call('POST', '/v1/repos/r/lines', {token: t, body: {issue: `issue/${n}.md`}});
  await s.call('PATCH', '/v1/repos/r/draft?line=001', {token: t, body: {version: 1, set: {'f.txt': b}, remove: []}});
  const one = await commitOn('001');
  await s.call('POST', '/v1/repos/r/lines/001/push', {token: t, body: {head: one}});
  await s.call('PATCH', '/v1/repos/r/draft?line=002', {token: t, body: {version: 1, set: {'f.txt': c}, remove: []}});
  const two = await commitOn('002');
  await s.call('POST', '/v1/repos/r/lines/002/push', {token: t, body: {head: two}});
  const x = (await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '001', title: 'one'}})).json.id as string;
  const y = (await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '002', title: 'two'}})).json.id as string;
  assert.equal((await s.call('POST', `/v1/repos/r/changes/${x}/merge`, {token: t, body: {version: 1}})).status, 200);
  const clash = await s.call('POST', `/v1/repos/r/changes/${y}/merge`, {token: t, body: {version: 1}});
  assert.deepEqual([clash.status, clash.json.conflicts], [409, ['f.txt']]);
  assert.equal((await s.call('POST', `/v1/repos/r/changes/${y}/reject`, {token: t, body: {note: 'clashes'}})).json.state, 'rejected');
  // A rejected change is not reset; an open one is, and can be submitted again.
  assert.equal((await s.call('POST', `/v1/repos/r/changes/${y}/reset`, {token: t, body: {}})).status, 409);
  const back = await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '002', title: 'two'}});
  assert.deepEqual([back.json.state, back.json.version], ['open', 2]);
  assert.equal((await s.call('POST', `/v1/repos/r/changes/${y}/reset`, {token: t, body: {}})).json.state, 'reset');
  const list = (await s.call('GET', '/v1/repos/r/changes', {token: t})).json as unknown as {title: string; state: string}[];
  assert.deepEqual(list.map((l) => [l.title, l.state]).sort(), [['one', 'merged'], ['two', 'reset']]);
});

test('Inbox: an address is claimed or published by its domain; messages are small, and strangers are held to a few', async () => {
  const s = await service({'_length3.example.org': ['some other record'], '_length3.elsewhere.example': ['v=length3; remote=remote.elsewhere.example; proof=x']});
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  // Nobody sends before having an address.
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@length3.test', body: 'hi'}})).status, 409);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'ren'}})).status, 201);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'ren'}})).status, 409);
  // A name on another domain needs that domain's DNS to say so, with a proof made for this account.
  const unpublished = await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'mio', domain: 'example.org'}});
  const record = unpublished.json.publish as unknown as {name: string; type: string; value: string};
  assert.deepEqual([unpublished.status, record.name, record.type], [409, '_length3.example.org', 'TXT']);
  assert.match(record.value, /^v=length3; remote=remote\.test; proof=[a-z2-7]{26}$/);
  // The same domain's record for another account does not do for this one.
  const renRecord = (await s.call('GET', '/v1/inbox/domains/example.org', {token: ren})).json as unknown as {value: string; found: boolean};
  assert.notEqual(renRecord.value, record.value);
  s.publish('_length3.example.org', renRecord.value);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'mio', domain: 'example.org'}})).status, 409);
  s.publish('_length3.example.org', record.value);
  assert.equal(((await s.call('GET', '/v1/inbox/domains/example.org', {token: mio})).json as unknown as {found: boolean}).found, true);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'mio', domain: 'example.org'}})).status, 201);
  assert.deepEqual((await s.call('GET', '/v1/inbox/lookup?address=mio@example.org', {token: ren})).json, {address: 'mio@example.org', reachable: true});
  assert.equal(((await s.call('GET', '/v1/inbox/lookup?address=x@nowhere.example', {token: ren})).json).reachable, false);
  // A domain held by another Remote is found through its record, and said to be elsewhere.
  assert.match(String((await s.call('GET', '/v1/inbox/lookup?address=xy@elsewhere.example', {token: ren})).json.why), /another Remote/);
  // Ren writes: a request to Mio, of which Mio holds only a few unanswered.
  const sent = await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@example.org', type: 'review', target: {repo: 'notes', change: 'abc'}, body: 'could you look?'}});
  assert.deepEqual([sent.status, sent.json.request], [201, true]);
  for (let i = 0; i < 2; i++) await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@example.org', body: `again ${i}`}});
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@example.org', body: 'and again'}})).status, 429);
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@example.org', body: 'x'.repeat(4001)}})).status, 400);
  // Live chat needs both to have accepted: not yet.
  assert.equal((await s.call('POST', '/v1/inbox/signals', {token: ren, body: {to: 'mio@example.org', session: 's1', kind: 'offer', data: 'sdp'}})).status, 403);
  const threads = (await s.call('GET', '/v1/inbox/threads', {token: mio})).json as unknown as {address: string; state: string; unread: number; last: {type: string}}[];
  assert.deepEqual(threads.map((t) => [t.address, t.state, t.unread]), [['ren@length3.test', 'request', 3]]);
  const thread = (await s.call('GET', '/v1/inbox/threads/ren@length3.test', {token: mio})).json as unknown as {messages: {type: string; target: object}[]};
  assert.deepEqual([thread.messages[0].type, thread.messages[0].target], ['review', {repo: 'notes', change: 'abc'}]);
  // Mio accepts: now both ways, so signalling may pass, and is taken once.
  await s.call('POST', '/v1/inbox/contacts', {token: mio, body: {address: 'ren@length3.test', state: 'accepted'}});
  assert.equal((await s.call('POST', '/v1/inbox/signals', {token: ren, body: {to: 'mio@example.org', session: 's1', kind: 'offer', data: 'sdp'}})).status, 201);
  const got = (await s.call('GET', '/v1/inbox/signals?from=ren@length3.test', {token: mio})).json as unknown as {from: string; kind: string}[];
  assert.deepEqual(got.map((g) => [g.from, g.kind]), [['ren@length3.test', 'offer']]);
  assert.deepEqual((await s.call('GET', '/v1/inbox/signals?from=ren@length3.test', {token: mio})).json, []);
  // Blocked: nothing more arrives.
  await s.call('POST', '/v1/inbox/contacts', {token: mio, body: {address: 'ren@length3.test', state: 'blocked'}});
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@example.org', body: 'hello?'}})).status, 403);
  // The Remote's own domain answers for one name, never with a list.
  const wk = await s.call('GET', '/.well-known/length3?name=ren');
  assert.deepEqual(wk.json, {remote: BASE, name: 'ren'});
  assert.deepEqual((await s.call('GET', '/.well-known/length3')).json, {remote: BASE});
});

test('Servers: people who know each other, boards with talk and a TODO kept together', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio'), kai = await s.start('Kai');
  // A server is made by someone with an address, and comes with a first board.
  assert.equal((await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}})).status, 409);
  for (const [t, n] of [[ren, 'ren'], [mio, 'mio'], [kai, 'kai']] as const) await s.call('POST', '/v1/inbox/addresses', {token: t, body: {name: n}});
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip', board: 'plan'}});
  assert.equal(made.status, 201);
  const sid = made.json.id as string, bid = (made.json.boards as {id: string}[])[0].id;
  // Others are not in it, and do not see it.
  assert.equal((await s.call('GET', `/v1/boards/${bid}`, {token: mio})).status, 404);
  // Only a contact can be added: someone one knows, who knows one back.
  assert.equal((await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}})).status, 403);
  await s.call('POST', '/v1/inbox/contacts', {token: ren, body: {address: 'mio@length3.test', state: 'accepted'}});
  assert.equal((await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}})).status, 403);
  await s.call('POST', '/v1/inbox/contacts', {token: mio, body: {address: 'ren@length3.test', state: 'accepted'}});
  const added = await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}});
  assert.deepEqual((added.json as unknown as {address: string}[]).map((p) => p.address), ['ren@length3.test', 'mio@length3.test']);
  assert.deepEqual(((await s.call('GET', '/v1/servers', {token: mio})).json as unknown as {name: string}[]).map((x) => x.name), ['Trip']);

  // Its TODO, kept together item by item: a new item takes its fields; a change sends only what changed.
  const item = (t: string, id: string, body: unknown) => s.call('PUT', `/v1/boards/${bid}/todos/${id}`, {token: t, body});
  assert.equal((await item(ren, 'a1', {title: 'Book the inn', place: 1, created: 1})).status, 201);
  assert.equal((await item(mio, 'b2', {kind: 'Ask', title: 'Who drives?', place: 2, created: 2})).status, 201);
  assert.equal((await item(kai, 'c3', {title: 'not in it', place: 3})).status, 404);
  // Ren ticks the item while Mio writes its detail: both stay.
  await item(ren, 'a1', {done: true});
  await item(mio, 'a1', {detail: 'two nights, near the station'});
  // An item put between two takes a place between theirs.
  await item(ren, 'm1', {title: 'Train times', place: 1.5, created: 3});
  type Item = {id: string; kind: string | null; title: string; detail: string; done: boolean; by: string};
  const list = (await s.call('GET', `/v1/boards/${bid}/todos`, {token: mio})).json as unknown as Item[];
  assert.deepEqual(list.map((x) => [x.id, x.kind, x.title, x.detail, x.done, x.by]), [
    ['a1', null, 'Book the inn', 'two nights, near the station', true, 'ren@length3.test'],
    ['m1', null, 'Train times', '', false, 'ren@length3.test'],
    ['b2', 'Ask', 'Who drives?', '', false, 'mio@length3.test']]);
  assert.equal((await item(ren, 'a1', {kind: 'not a kind!'})).status, 400);
  assert.equal((await item(ren, 'a1', {title: 'x'.repeat(201)})).status, 400);
  assert.equal((await s.call('DELETE', `/v1/boards/${bid}/todos/m1`, {token: mio})).status, 204);
  // A second board, removed by the server's owner: held 30 days, answering nothing, back at once with its TODO.
  const other = (await s.call('POST', `/v1/servers/${sid}/boards`, {token: mio, body: {name: 'food'}})).json.id as string;
  await s.call('PUT', `/v1/boards/${other}/todos/f1`, {token: mio, body: {title: 'ramen', place: 1, created: 1}});
  assert.equal((await s.call('DELETE', `/v1/boards/${other}`, {token: mio})).status, 403);
  const removed = await s.call('DELETE', `/v1/boards/${other}`, {token: ren});
  assert.ok((removed.json.until as number) > Date.now() + 29 * 86_400_000);
  assert.equal((await s.call('GET', `/v1/boards/${other}/todos`, {token: mio})).status, 404);
  const listed = ((await s.call('GET', '/v1/servers', {token: mio})).json as unknown as {boards: {name: string; gone?: number}[]}[])[0].boards;
  assert.deepEqual(listed.map((b) => [b.name, !!b.gone]), [['plan', false], ['food', true]]);
  assert.equal((await s.call('POST', `/v1/boards/${other}/back`, {token: mio})).status, 403);
  assert.equal((await s.call('POST', `/v1/boards/${other}/back`, {token: ren})).status, 200);
  assert.equal(((await s.call('GET', `/v1/boards/${other}/todos`, {token: mio})).json as unknown as {title: string}[])[0].title, 'ramen');

  // The talk around it, newest first a page at a time.
  for (const [t, b] of [[ren, 'Kyoto first?'], [mio, 'yes'], [ren, 'booked']] as const) assert.equal((await s.call('POST', `/v1/boards/${bid}/posts`, {token: t, body: {body: b}})).status, 201);
  const page = (await s.call('GET', `/v1/boards/${bid}/posts?limit=2`, {token: mio})).json as unknown as {posts: {id: string; by: string; body: string; mine?: boolean}[]; more: boolean};
  assert.deepEqual(page.posts.map((p) => [p.by, p.body]), [['ren@length3.test', 'booked'], ['mio@length3.test', 'yes']]);
  assert.equal(page.more, true);
  // A post is taken down by its writer (or the server's owner), no one else.
  assert.equal((await s.call('DELETE', `/v1/boards/${bid}/posts/${page.posts[0].id}`, {token: mio})).status, 404);
  assert.equal((await s.call('DELETE', `/v1/boards/${bid}/posts/${page.posts[1].id}`, {token: ren})).status, 204);
  // Taken home as text: the TODO, then the talk.
  const home = await s.call('GET', `/v1/boards/${bid}/archive`, {token: mio});
  assert.equal(home.status, 200);
  assert.match(home.text, /^# Trip \/ plan\n\n## TODO\n\n- \[x\] Book the inn\n  two nights, near the station\n- \[ \] Ask：Who drives\?\n\n## Discussion\n/);
  assert.match(home.text, /ren: Kyoto first\?\n.*ren: booked\n/);
  assert.ok(!home.text.includes(': yes'));
  assert.ok(!(await s.call('GET', `/v1/boards/${bid}/archive?talk=0`, {token: mio})).text.includes('Discussion'));
  assert.ok(!(await s.call('GET', `/v1/boards/${bid}/archive?todo=0`, {token: mio})).text.includes('## TODO'));

  // Closed, nobody else reads it; opened, anyone does, signed in or not.
  assert.equal((await s.call('GET', `/v1/open/${bid}/posts`)).status, 404);
  // How far it is open is its server's owner's to say.
  assert.equal((await s.call('PATCH', `/v1/boards/${bid}`, {token: mio, body: {open: true}})).status, 403);
  assert.equal((await s.call('PATCH', `/v1/boards/${bid}`, {token: ren, body: {open: true}})).status, 200);
  assert.deepEqual(((await s.call('GET', '/v1/open')).json as unknown as {name: string}[]).map((b) => b.name), ['plan']);
  assert.equal(((await s.call('GET', `/v1/open/${bid}/posts`)).json as unknown as {posts: unknown[]}).posts.length, 2);
  assert.equal(((await s.call('GET', `/v1/open/${bid}/todos`)).json as unknown as unknown[]).length, 2);
  // A guest writes once the email is shown to be theirs, and only where guests are taken.
  assert.equal((await s.call('POST', `/v1/open/${bid}/guest`, {body: {email: 'aki@example.org'}})).status, 404);
  await s.call('PATCH', `/v1/boards/${bid}`, {token: ren, body: {guests: true}});
  assert.equal((await s.call('POST', `/v1/open/${bid}/guest`, {body: {email: 'aki@example.org'}})).status, 202);
  assert.equal((await s.call('POST', `/v1/open/${bid}/guest`, {body: {email: 'aki@example.org'}})).status, 429);
  const code = /is (\d{6})/.exec(s.mails.at(-1)!.text)![1];
  assert.equal(s.mails.at(-1)!.to, 'aki@example.org');
  assert.equal((await s.call('POST', `/v1/open/${bid}/guest/check`, {body: {email: 'aki@example.org', code: code === '000000' ? '000001' : '000000'}})).status, 403);
  const ok = await s.call('POST', `/v1/open/${bid}/guest/check`, {body: {email: 'aki@example.org', code}});
  assert.equal(ok.status, 200);
  assert.equal((await s.call('POST', `/v1/open/${bid}/posts`, {body: {body: 'can I come?'}})).status, 403);
  const g = await s.call('POST', `/v1/open/${bid}/posts`, {body: {body: 'can I come?'}, headers: {'X-Guest': ok.json.token as string}});
  assert.deepEqual([g.status, g.json.by, g.json.guest], [201, 'aki', true]);
  // A guest writes for a while: the token is a lease.
  const {eq} = await import('drizzle-orm');
  await s.db.update(schema.guest).set({tokenUntil: new Date(Date.now() - 1000)}).where(eq(schema.guest.email, 'aki@example.org'));
  assert.equal((await s.call('POST', `/v1/open/${bid}/posts`, {body: {body: 'still?'}, headers: {'X-Guest': ok.json.token as string}})).status, 403);
  // Leaving: the owner leaves, and the server is the one who came next's.
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/people/ren@length3.test`, {token: ren})).status, 204);
  // Removed, it is held: it answers nothing, its name is held for it, and its owner may bring it back.
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}`, {token: mio})).status, 200);
  assert.equal((await s.call('GET', `/v1/boards/${bid}`, {token: mio})).status, 404);
  assert.equal((await s.call('GET', `/v1/open/${bid}/posts`)).status, 404);
  assert.equal((await s.call('POST', '/v1/servers', {token: kai, body: {name: 'Trip'}})).status, 409);
  assert.deepEqual(((await s.call('GET', '/v1/servers?gone=1', {token: mio})).json as unknown as {address: string}[]).map((x) => x.address), ['trip@length3.test']);
  assert.equal((await s.call('POST', `/v1/servers/${sid}/back`, {token: kai})).status, 404);
  assert.equal((await s.call('POST', `/v1/servers/${sid}/back`, {token: mio})).status, 200);
  assert.equal((await s.call('GET', `/v1/boards/${bid}`, {token: mio})).status, 200);
});

test('Who sees a repo: its owner, the servers it is shown in, or everyone, under a name that need not be its owner\'s', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio'), kai = await s.start('Kai');
  for (const [t, n] of [[ren, 'ren'], [mio, 'mio'], [kai, 'kai']] as const) await s.call('POST', '/v1/inbox/addresses', {token: t, body: {name: n}});
  // Ren's repo, committed twice, pushed once: what others see is what was pushed.
  const put = async (t: string, text: string) => {
    const bytes = enc.encode(text);
    const sha = await sha256(bytes);
    await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes});
    return sha;
  };
  const [readme, later, secret] = await Promise.all(['# hello\n', '# hello again\n', 'not in any tree\n'].map((x) => put(ren, x)));
  const commit = async (t: string, set: Record<string, string>, title: string) => {
    const now = (await s.call('GET', '/v1/repos/hello', {token: t})).json as unknown as {version?: number; head?: string | null};
    const version = now.version ?? 0;
    await s.call('PATCH', '/v1/repos/hello/draft', {token: t, body: {version, set, remove: []}});
    return (await s.call('POST', '/v1/repos/hello/cuts', {token: t, body: {version: version + 1, parent: now.head ?? null, title}})).json.id as string;
  };
  const first = await commit(ren, {'README.md': readme}, 'start');
  assert.equal((await s.call('POST', '/v1/repos/hello/lines/main/push', {token: ren, body: {head: first}})).status, 200);
  await commit(ren, {'README.md': later}, 'not pushed');
  const see = (as: string, t?: string) => s.call('GET', `/v1/seen/${as.replace(':', '/')}`, {token: t});
  const state = async () => ((await s.call('GET', '/v1/seen', {token: ren})).json as unknown as {seen: string; servers: {name: string}[]; as: string | null}[])[0];
  const seen = (body: unknown) => s.call('PUT', '/v1/repos/hello/seen', {token: ren, body});
  // Private at first: only Ren sees it.
  assert.deepEqual([(await state()).seen, (await see('ren@length3.test:hello', ren)).status, (await see('ren@length3.test:hello', mio)).status], ['private', 200, 404]);
  // Shown in a server: its people see it, and whose it is; nobody else does.
  await s.call('POST', '/v1/inbox/contacts', {token: ren, body: {address: 'mio@length3.test', state: 'accepted'}});
  await s.call('POST', '/v1/inbox/contacts', {token: mio, body: {address: 'ren@length3.test', state: 'accepted'}});
  const sid = (await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip', address: 'trip'}})).json.id as string;
  await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}});
  assert.equal((await s.call('POST', `/v1/servers/${sid}/repos`, {token: mio, body: {repo: 'hello'}})).status, 404);
  assert.equal((await s.call('POST', `/v1/servers/${sid}/repos`, {token: ren, body: {repo: 'hello'}})).status, 201);
  assert.deepEqual([(await state()).seen, (await state()).servers.map((x) => x.name)], ['servers', ['Trip']]);
  const listed = (await s.call('GET', `/v1/servers/${sid}/repos`, {token: mio})).json as unknown as {owner: string; name: string; mine: boolean}[];
  assert.deepEqual(listed.map((r) => [r.owner, r.name, r.mine]), [['ren@length3.test', 'hello', false]]);
  const shown = await see('ren@length3.test:hello', mio);
  assert.deepEqual([shown.status, shown.json.owner, shown.json.title, shown.json.tree], [200, 'ren@length3.test', 'start', {'README.md': readme}]);
  const file = (path: string) => s.call('GET', `/v1/seen/ren@length3.test/hello/file?path=${encodeURIComponent(path)}`, {token: mio});
  // Only what is in the tree it was pushed to, by its path: not the commit after it, nor any other blob of Ren's.
  assert.equal((await file('README.md')).text, '# hello\n');
  assert.deepEqual(await Promise.all([later, secret, '../README.md', ''].map(async (p) => (await file(p)).status)), [404, 404, 404, 404]);
  assert.equal((await see('ren@length3.test:hello', kai)).status, 404);
  // Taken off the list by Ren or the server's owner; Mio may not.
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/repos/ren@length3.test/hello`, {token: mio})).status, 403);
  // From the server to everyone: it is seen as the server's, and nothing it answers names Ren.
  const pub = await seen({seen: 'everyone'});
  assert.deepEqual([pub.json.seen, pub.json.as], ['everyone', 'trip@length3.test:hello']);
  const out = await see('trip@length3.test:hello');
  assert.equal(out.status, 200);
  assert.ok(!JSON.stringify(out.json).includes('ren'), JSON.stringify(out.json));
  assert.equal((await s.call('GET', `/v1/seen/trip@length3.test/hello/file?path=README.md`)).text, '# hello\n');
  // Ren's own name does not open it to everyone: that would tie the two together.
  assert.deepEqual([(await see('ren@length3.test:hello')).status, (await see('ren@length3.test:hello', kai)).status], [404, 404]);
  // A face's names are one namespace: Mio's hello cannot also be trip:hello.
  const mine = await put(mio, '# mio\n');
  await commit(mio, {'README.md': mine}, 'mio');
  await s.call('POST', `/v1/servers/${sid}/repos`, {token: mio, body: {repo: 'hello'}});
  const clash = await s.call('PUT', '/v1/repos/hello/seen', {token: mio, body: {seen: 'everyone', as: sid}});
  assert.deepEqual([clash.status, clash.json.error], [409, 'That name is taken']);
  // Taken down, it is held for Ren a while: nobody else's repo answers to it meanwhile.
  assert.equal((await seen({seen: 'servers', servers: [sid]})).json.seen, 'servers');
  assert.equal((await see('trip@length3.test:hello')).status, 404);
  const held = await s.call('PUT', '/v1/repos/hello/seen', {token: mio, body: {seen: 'everyone', as: sid}});
  assert.deepEqual([held.status, held.json.error], [409, 'That name was let go, and is held for its owner a while']);
  assert.equal((await seen({seen: 'everyone', as: sid})).status, 200);
  // Made public by Ren as Ren: then Ren's name is its face, by choice.
  assert.equal((await seen({seen: 'everyone', as: 'me'})).json.as, 'ren@length3.test:hello');
  assert.deepEqual([(await see('ren@length3.test:hello')).status, (await see('trip@length3.test:hello')).status], [200, 404]);
  // Choices are only among servers one is in.
  assert.equal((await seen({seen: 'servers', servers: []})).status, 400);
  assert.equal((await seen({seen: 'servers', servers: ['nope']})).status, 403);
  // Private again: off every list, and its face taken down.
  assert.equal((await seen({seen: 'private'})).json.seen, 'private');
  assert.deepEqual([(await see('ren@length3.test:hello')).status, (await see('ren@length3.test:hello', mio)).status], [404, 404]);
  // A share lasts as long as its owner's place: Ren leaves, and what was public as Trip ends with it.
  await seen({seen: 'everyone', as: sid});
  assert.equal((await see('trip@length3.test:hello')).status, 200);
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/people/ren@length3.test`, {token: ren})).status, 204);
  assert.equal((await see('trip@length3.test:hello')).status, 404);
  assert.deepEqual(((await s.call('GET', `/v1/servers/${sid}/repos`, {token: mio})).json as unknown as {owner: string}[]).map((r) => r.owner), ['mio@length3.test']);
});

test('Names: people and servers share one namespace; a name let go is held for its owner; a domain that stops naming the Remote stops answering', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'ren'}});
  await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'mio'}});
  // A server's name and a person's are in one namespace.
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Book club', address: 'books'}});
  assert.equal(made.json.address, 'books@length3.test');
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'books'}})).status, 409);
  assert.equal((await s.call('POST', '/v1/servers', {token: mio, body: {name: 'Ren', address: 'ren'}})).status, 409);
  assert.equal(((await s.call('GET', '/v1/inbox/lookup?address=books@length3.test', {token: mio})).json as unknown as {reachable: boolean}).reachable, false);
  // Let go: it answers no more, nobody else may take it while it is held, and its owner may take it back.
  assert.equal((await s.call('DELETE', '/v1/inbox/addresses/ren@length3.test', {token: mio})).status, 404);
  assert.equal((await s.call('DELETE', '/v1/inbox/addresses/ren@length3.test', {token: ren})).status, 200);
  assert.equal(((await s.call('GET', '/v1/inbox/lookup?address=ren@length3.test', {token: mio})).json as unknown as {reachable: boolean}).reachable, false);
  const held = await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'ren'}});
  assert.deepEqual([held.status, held.json.error], [409, 'That name was let go, and is held for its owner a while']);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'ren'}})).status, 201);
  // Held long enough, it is anyone's.
  const {eq} = await import('drizzle-orm');
  await s.call('DELETE', '/v1/inbox/addresses/ren@length3.test', {token: ren});
  await s.db.update(schema.address).set({releasedAt: new Date(Date.now() - 31 * 86_400_000)}).where(eq(schema.address.address, 'ren@length3.test'));
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'ren'}})).status, 201);
  // A name on one's own domain answers while its DNS names this Remote for its owner.
  const rec = (await s.call('GET', '/v1/inbox/domains/ren.dev', {token: ren})).json as unknown as {name: string; value: string};
  s.publish(rec.name, rec.value);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'ren', domain: 'ren.dev'}})).status, 201);
  assert.equal(((await s.call('GET', '/v1/inbox/lookup?address=ren@ren.dev', {token: mio})).json as unknown as {reachable: boolean}).reachable, true);
  s.unpublish(rec.name);
  const gone = (await s.call('GET', '/v1/inbox/lookup?address=ren@ren.dev', {token: mio})).json as unknown as {reachable: boolean; why: string};
  assert.deepEqual([gone.reachable, gone.why], [false, 'Its domain no longer names this Remote']);
  assert.ok(((await s.call('GET', '/v1/inbox/me', {token: ren})).json.addresses as {address: string; lapsed?: boolean}[]).find((a) => a.address === 'ren@ren.dev')?.lapsed);
});

test('Names on the Remote: first come, for five years at a time, renewed by their owner; a code finds whoever has it', async () => {
  const s = await service();
  const {eq} = await import('drizzle-orm');
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  const claimed = await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'ren'}});
  await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'mio'}});
  // Five years from now; a domain of one's own has no term.
  const years = ((claimed.json.until as number) - Date.now()) / (365.25 * 86_400_000);
  assert.ok(years > 4.99 && years < 5.01, String(years));
  type Me = {code: string; addresses: {address: string; until?: number; ended?: boolean}[]};
  const me = (await s.call('GET', '/v1/inbox/me', {token: ren})).json as unknown as Me;
  assert.match(me.code, /^\d{6}$/);
  // Found by its name alone, or by its code; a code is only ever one principal's.
  const look = async (q: string) => (await s.call('GET', `/v1/inbox/lookup?address=${q}`, {token: mio})).json as unknown as {reachable: boolean; address?: string};
  assert.deepEqual(await look('ren'), {address: 'ren@length3.test', reachable: true});
  assert.deepEqual(await look(me.code), {address: 'ren@length3.test', reachable: true});
  assert.equal((await s.call('GET', '/v1/inbox/me', {token: ren})).json.code, me.code);
  assert.notEqual(((await s.call('GET', '/v1/inbox/me', {token: mio})).json as unknown as Me).code, me.code);
  // A message reaches a code as it does a name.
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: mio, body: {to: me.code, body: 'hi'}})).status, 201);
  // Past its term it answers no one, and is held for Ren a while: nobody else may claim it, Ren renews it back.
  await s.db.update(schema.address).set({until: new Date(Date.now() - 1000)}).where(eq(schema.address.address, 'ren@length3.test'));
  assert.equal((await look('ren')).reachable, false);
  assert.ok(((await s.call('GET', '/v1/inbox/me', {token: ren})).json as unknown as Me).addresses[0].ended);
  const held = await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'ren'}});
  assert.deepEqual([held.status, held.json.error], [409, 'That name was let go, and is held for its owner a while']);
  assert.equal((await s.call('POST', '/v1/inbox/addresses/mio@length3.test/renew', {token: ren})).status, 404);
  const renewed = await s.call('POST', '/v1/inbox/addresses/ren@length3.test/renew', {token: ren});
  assert.equal(renewed.status, 200);
  assert.ok((renewed.json.until as number) > Date.now() + 4.9 * 365 * 86_400_000);
  assert.equal((await look('ren')).reachable, true);
  // Not renewed, and held long enough: anyone's.
  await s.db.update(schema.address).set({until: new Date(Date.now() - 31 * 86_400_000)}).where(eq(schema.address.address, 'ren@length3.test'));
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'ren'}})).status, 201);
  // A server's name the same: for a term, renewed by its owner; it has a code too.
  const made = await s.call('POST', '/v1/servers', {token: mio, body: {name: 'Trip', address: 'trip'}});
  assert.match(made.json.code as string, /^\d{6}$/);
  assert.ok((made.json.until as number) > Date.now());
  const sid = made.json.id as string;
  assert.equal((await s.call('POST', `/v1/servers/${sid}/renew`, {token: ren})).status, 404);
  assert.equal((await s.call('POST', `/v1/servers/${sid}/renew`, {token: mio})).status, 200);
  assert.equal(((await s.call('GET', '/v1/servers', {token: mio})).json as unknown as {code: string}[])[0].code, made.json.code);
});

// ---- What the review of this service found, each kept fixed by a test ----

const idOf = async (s: Service, t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {user: {id: string}}).user.id;
const upload = async (s: Service, t: string, bytes: Uint8Array) => {
  const sha = await sha256(bytes);
  return {sha, status: (await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status};
};
const named = async (s: Service, ...people: [string, string][]) => { for (const [t, n] of people) await s.call('POST', '/v1/inbox/addresses', {token: t, body: {name: n}}); };
const accept = (s: Service, t: string, address: string, state = 'accepted') => s.call('POST', '/v1/inbox/contacts', {token: t, body: {address, state}});
const count = async (s: Service, query: ReturnType<typeof sql>) => ((await s.db.execute(query)).rows as {n: number}[])[0].n;

test('Guessing: codes that find people are looked up so many an hour, and the code to turn a repo off is tried so many times', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await named(s, [ren, 'ren'], [mio, 'mio']);
  const code = (await s.call('GET', '/v1/inbox/me', {token: ren})).json.code as string;
  const lookup = async (a: string) => (await s.call('GET', `/v1/inbox/lookup?address=${a}`, {token: mio}));
  // Someone is found by their code; everyone is not read off by trying every code.
  assert.equal((await lookup(code)).json.address, 'ren@length3.test');
  const tried = [];
  for (let i = 0; i < 30; i++) tried.push((await lookup(String(100000 + i))).status);
  assert.deepEqual([tried.filter((x) => x === 200).length, tried.at(-1)], [29, 429]);
  // As in every way a code is taken (here, accepting someone by it), and only codes: a name is still looked up.
  assert.equal((await s.call('POST', '/v1/inbox/contacts', {token: mio, body: {address: code}})).status, 429);
  assert.equal((await lookup('ren')).json.address, 'ren@length3.test');
  assert.equal((await s.call('GET', `/v1/inbox/lookup?address=${code}`, {token: ren})).status, 200);
  // The five-letter code: so many wrong in an hour, then none is taken, the right one neither.
  await s.call('PATCH', '/v1/repos/r/draft', {token: ren, body: {version: 0, set: {}, remove: []}});
  const session = ((await s.call('GET', '/api/auth/get-session', {token: ren})).json as unknown as {session: {id: string}; user: {id: string}});
  await s.db.insert(schema.guard).values({userId: session.user.id, proofSession: session.session.id, proofAt: new Date()});
  assert.equal((await s.call('POST', '/v1/off-code', {token: ren, body: {code: 'AB12C'}})).status, 200);
  const off = async (c: string) => (await s.call('POST', '/v1/repos/r/off', {token: ren, body: {name: 'Ren', repo: 'r', code: c}})).status;
  const wrong = [];
  for (let i = 0; i < 11; i++) wrong.push(await off(`ZZZ${String(i).padStart(2, '0')}`));
  assert.deepEqual([wrong.filter((x) => x === 403).length, wrong.at(-1)], [10, 429]);
  assert.equal(await off('AB12C'), 429);
  // An hour on, it is taken again.
  await s.db.execute(sql`update throttle set at = now() - interval '61 minutes' where key like 'off-code:%'`);
  assert.equal(await off('AB12C'), 200);
});

test('Consent: nobody is put in a server by someone they have not accepted, or have blocked; being put in servers never stops anyone making one', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio'), kai = await s.start('Kai');
  await named(s, [ren, 'ren'], [mio, 'mio'], [kai, 'kai']);
  const sid = (await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}})).json.id as string;
  const add = (who: string) => s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: `${who}@length3.test`}});
  // Kai blocked Ren; Ren accepting Kai on Ren's own side does not put Kai in.
  await accept(s, kai, 'ren', 'blocked');
  await accept(s, ren, 'kai');
  const refused = await add('kai');
  assert.deepEqual([refused.status, refused.json.error], [403, 'Only your contacts can be added']);
  // Nor someone who has not accepted Ren; when both sides have, they are in.
  await accept(s, ren, 'mio');
  assert.equal((await add('mio')).status, 403);
  await accept(s, mio, 'ren');
  assert.equal((await add('mio')).status, 201);
  assert.deepEqual((await s.call('GET', '/v1/servers', {token: kai})).json, []);
  // Put in fifty servers by others, Kai still makes one of their own: only what one owns, or has held, counts.
  const k = await idOf(s, kai);
  await s.db.execute(sql`insert into server (id, name) select lpad(g::text, 12, 'x'), 'S' from generate_series(1, 50) g`);
  await s.db.execute(sql`insert into server_member (server_id, user_id) select lpad(g::text, 12, 'x'), ${k} from generate_series(1, 50) g`);
  assert.equal((await s.call('POST', '/v1/servers', {token: kai, body: {name: 'Mine', address: 'kaimine'}})).status, 201);
  // Owning fifty (and one) is the end of it.
  await s.db.execute(sql`update server_member set owner = true where user_id = ${k}`);
  const full = await s.call('POST', '/v1/servers', {token: kai, body: {name: 'More', address: 'kaimore'}});
  assert.deepEqual([full.status, full.json.error], [429, 'Too many servers']);
});

test('Guests: codes go to an address a few an hour whatever the board, and from one sender so many; a board has a few waiting; the mail says only the code; tries at once are each counted', async () => {
  const s = await service();
  const ren = await s.start('Ren');
  await named(s, [ren, 'ren']);
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Prizes', board: 'CLAIM YOUR PRIZE at evil.example'}});
  const boards = [(made.json.boards as {id: string}[])[0].id];
  for (let i = 1; i < 4; i++) boards.push((await s.call('POST', `/v1/servers/${made.json.id}/boards`, {token: ren, body: {name: `Win big ${i}`}})).json.id as string);
  // Taking guests opens a board: guests write only where anyone reads.
  for (const b of boards) assert.equal((await s.call('PATCH', `/v1/boards/${b}`, {token: ren, body: {guests: true}})).json.open, true);
  const ask = (b: string, email: string, from: string) => s.call('POST', `/v1/open/${b}/guest`, {body: {email}, headers: {'CF-Connecting-IP': from}});
  // One address: three codes an hour, whichever boards ask, from wherever.
  for (let i = 0; i < 3; i++) assert.equal((await ask(boards[i], 'victim@example.org', `10.0.0.${i}`)).status, 202);
  const fourth = await ask(boards[3], 'victim@example.org', '10.0.0.9');
  assert.deepEqual([fourth.status, fourth.json.error], [429, 'Too many codes asked for; try again in an hour']);
  // Nothing anyone chose reaches the address: no board's name, in the subject or the text.
  assert.ok(s.mails.length === 3 && s.mails.every((m) => !/prize|win|evil/i.test(m.subject + m.text) && /^Your code is \d{6}\. It holds for 10 minutes\.$/.test(m.text)));
  // One sender: ten an hour.
  for (let i = 0; i < 10; i++) assert.equal((await ask(boards[1], `a${i}@example.org`, '10.9.9.9')).status, 202);
  assert.equal((await ask(boards[1], 'a10@example.org', '10.9.9.9')).status, 429);
  // One board: twenty waiting for a code at once (the victim's is one of them on this board).
  for (let i = 0; i < 19; i++) assert.equal((await ask(boards[2], `w${i}@example.org`, `10.1.0.${i}`)).status, 202);
  const crowd = await ask(boards[2], 'w19@example.org', '10.1.0.99');
  assert.deepEqual([crowd.status, crowd.json.error], [429, 'Too many people are waiting for a code here; try again soon']);
  // Ten wrong tries at once are ten tries: the code is spent after five, and the right one then does nothing.
  assert.equal((await ask(boards[3], 'tries@example.org', '10.2.0.1')).status, 202);
  const code = /is (\d{6})/.exec(s.mails.at(-1)!.text)![1];
  const check = (c: string) => s.call('POST', `/v1/open/${boards[3]}/guest/check`, {body: {email: 'tries@example.org', code: c}});
  const wrong = await Promise.all(Array.from({length: 10}, () => check(code === '000000' ? '000001' : '000000')));
  assert.ok(wrong.every((r) => r.status === 403));
  assert.equal((await check(code)).status, 403);
  // A guest without a token is refused as a guest (403), not as a session the Remote does not know (401).
  assert.equal((await s.call('POST', `/v1/open/${boards[0]}/posts`, {body: {body: 'hi'}})).status, 403);
});

test('Names: an account keeps five, those it let go among them; a few servers a day; a server its maker leaves with nobody else in it is held a day', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  for (const n of ['r1', 'r2', 'r3', 'r4', 'r5']) assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: n}})).status, 201);
  // Let go, a name is still held for Ren, and still counts: no sixth by letting go of one.
  await s.call('DELETE', '/v1/inbox/addresses/r5@length3.test', {token: ren});
  const sixth = await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'r6'}});
  assert.deepEqual([sixth.status, sixth.json.error], [409, 'Too many names']);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: ren, body: {name: 'r5'}})).status, 201);
  // Ten servers a day.
  await named(s, [mio, 'mio']);
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push((await s.call('POST', '/v1/servers', {token: mio, body: {name: `S${i}`, address: `mios${i}`}})).json.id as string);
  const eleventh = await s.call('POST', '/v1/servers', {token: mio, body: {name: 'S10', address: 'mios10'}});
  assert.deepEqual([eleventh.status, eleventh.json.error], [429, 'Too many servers made today']);
  // Made and left with nobody else in it: held a day, not thirty.
  assert.equal((await s.call('DELETE', `/v1/servers/${ids[0]}/people/mio@length3.test`, {token: mio})).status, 204);
  const held = ((await s.call('GET', '/v1/servers?gone=1', {token: mio})).json as unknown as {id: string; until: number}[]).find((x) => x.id === ids[0])!;
  assert.ok(Math.abs(held.until - Date.now() - 86_400_000) < 60_000, String(held.until - Date.now()));
  assert.equal((await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Taken', address: 'mios0'}})).status, 409);
  // A day on, its name is anyone's.
  await s.db.execute(sql`update address set released_at = released_at - interval '1 day 1 minute' where server_id = ${ids[0]}`);
  assert.equal((await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Mine now', address: 'mios0'}})).status, 201);
});

test('Storage: settings, repos, lines and reviews are capped, trees count toward the room, and uploads at once cannot pass it together', async () => {
  const quota = 100_000;
  const s = await service({}, {quota});
  const t = await s.start('Ren');
  const me = await idOf(s, t);
  // Eight settings at most.
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) assert.equal((await s.call('PUT', `/v1/home/${k}`, {token: t, body: {value: 'x', version: 0}})).status, 200);
  assert.deepEqual((await s.call('PUT', '/v1/home/i', {token: t, body: {value: 'x', version: 0}})).json.error, 'Too many settings');
  assert.equal((await s.call('PUT', '/v1/home/a', {token: t, body: {value: 'y', version: 1}})).status, 200);
  const one = await upload(s, t, enc.encode('x'));
  assert.equal((await s.call('PATCH', '/v1/repos/small/draft', {token: t, body: {version: 0, set: {'a.txt': one.sha}, remove: []}})).status, 200);
  // Two hundred repos, a hundred pieces of work on one, fifty reviews of a change.
  await s.db.execute(sql`insert into repo (user_id, name) select ${me}, 'r' || g from generate_series(1, 199) g`);
  assert.deepEqual((await s.call('PATCH', '/v1/repos/more/draft', {token: t, body: {version: 0, set: {}, remove: []}})).json.error, 'Too many repos');
  const small = sql`(select id from repo where user_id = ${me} and name = 'small')`;
  await s.db.execute(sql`insert into line (repo_id, user_id, name) select ${small}, ${me}, 'l' || g from generate_series(1, 100) g`);
  assert.deepEqual((await s.call('POST', '/v1/repos/small/lines', {token: t, body: {issue: 'issue/new.md'}})).json.error, 'This repo has too much work open');
  const [c1, c2] = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'], h = 'a'.repeat(64);
  await s.db.execute(sql`insert into cut (repo_id, id, user_id, tree, title) values (${small}, ${h}, ${me}, '{}', 'x')`);
  await s.db.execute(sql`insert into change (id, repo_id, user_id, line, title, head) values (${c1}, ${small}, ${me}, 'l1', 'x', ${h}), (${c2}, ${small}, ${me}, 'l2', 'x', ${h})`);
  const review = (id: string, marks: string[]) => s.call('POST', `/v1/repos/small/changes/${id}/reviews`, {token: t, body: {version: 1, verdict: 'comment', marks}});
  // A review marks as many lines as fit: two hundred, saying 32 KiB in all.
  const marked = await review(c1, Array.from({length: 1000}, (_, i) => `${'p'.repeat(190)}:${i}`));
  const marks = (marked.json.reviews as {marks: string[]}[])[0].marks;
  assert.ok(marked.status === 201 && marks.length > 0 && marks.length <= 200 && marks.join('').length <= 32 * 1024, String(marks.length));
  await s.db.execute(sql`insert into review (change_id, user_id, version, verdict, by) select ${c2}, ${me}, 1, 'comment', '' from generate_series(1, 50)`);
  assert.deepEqual((await review(c2, [])).json.error, 'Too many reviews on this change');
  // A tree of long paths to one small file counts as what it takes: refused when it would not fit.
  const set = Object.fromEntries(Array.from({length: 700}, (_, i) => [`${'d'.repeat(150)}/${i}.txt`, one.sha]));
  const big = await s.call('PATCH', '/v1/repos/small/draft', {token: t, body: {version: 1, set, remove: []}});
  assert.deepEqual([big.status, big.json.error], [507, 'The Remote is full for this account']);
  // Eight uploads at once into the room that is left: those that fit, and no more.
  const sent = await Promise.all(Array.from({length: 8}, (_, i) => upload(s, t, new Uint8Array(30_000).fill(i + 1))));
  const took = sent.filter((r) => r.status === 201).length;
  const blobs = await count(s, sql`select coalesce(sum(bytes), 0)::int as n from blob`);
  assert.ok(took >= 1 && took < 8 && sent.every((r) => r.status === 201 || r.status === 507) && blobs <= quota, `${took} ${blobs}`);
});

test('Requests: a write on the cookie alone is taken only from the app\'s pages, and a body is JSON only when sent as JSON', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const post = (headers: Record<string, string>) => s.app.request(`${BASE}/v1/inbox/addresses`, {method: 'POST', headers, body: JSON.stringify({name: 'ren'})});
  const cookie = s.sessions.get(t)!;
  // A page elsewhere posts a form-like body with the browser's cookie: refused.
  assert.equal((await post({Cookie: cookie, Origin: 'http://evil.test', 'Content-Type': 'text/plain'})).status, 403);
  assert.equal((await post({Cookie: cookie, 'Content-Type': 'application/json'})).status, 403);
  // From the app's own page, text is still not JSON; JSON is.
  assert.equal((await post({Cookie: cookie, Origin: APP, 'Content-Type': 'text/plain'})).status, 400);
  assert.equal((await post({Cookie: cookie, Origin: APP, 'Content-Type': 'application/json'})).status, 201);
  // The bearer token is never sent by a page elsewhere: it is enough by itself.
  assert.equal((await s.app.request(`${BASE}/v1/repos`, {headers: {Authorization: `Bearer ${t}`}})).status, 200);
});

test('Requests: a body is read no further than its route takes, however it is sent, before anyone is asked who they are', async () => {
  const key = 'k'.repeat(40);
  const s = await service({}, {enter: {as: 'banana000000', key}});
  const streamed = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({start(c) { c.enqueue(bytes); c.close(); }});
  const send = (method: string, path: string, bytes: Uint8Array, headers: Record<string, string> = {}) =>
    s.app.request(`${BASE}${path}`, {method, headers: {Origin: APP, 'Content-Type': 'application/json', ...headers}, body: streamed(bytes), duplex: 'half'} as RequestInit);
  // Anyone's: a key of megabytes is refused unread, said to be that long or sent without saying, and no try is counted for it.
  const big = enc.encode(JSON.stringify({key: 'k'.repeat(2 << 20)}));
  assert.equal((await send('POST', '/v1/enter', big, {'Content-Length': String(big.length)})).status, 413);
  assert.equal((await send('POST', '/v1/enter', big)).status, 413);
  assert.equal(await count(s, sql`select count(*)::int as n from throttle`), 0);
  const t = (await s.call('POST', '/v1/enter', {body: {key}})).json.token as string;
  // A file is as large as a file may be, and no larger; a draft's diff larger than any other body is still read.
  const auth = {Authorization: `Bearer ${t}`};
  assert.equal((await send('PUT', `/v1/blobs/${'0'.repeat(64)}`, new Uint8Array((16 << 20) + 1), {...auth, 'Content-Type': 'application/octet-stream'})).status, 413);
  const one = await upload(s, t, enc.encode('x'));
  const set = Object.fromEntries(Array.from({length: 1500}, (_, i) => [`${'d'.repeat(900)}/${i}.txt`, one.sha]));
  const diff = enc.encode(JSON.stringify({version: 0, set, remove: []}));
  assert.ok(diff.length > 1 << 20);
  assert.equal((await send('PATCH', '/v1/repos/r/draft', diff, auth)).status, 200);
  assert.equal((await send('POST', '/v1/inbox/messages', diff, auth)).status, 413);
});

test('A repo named on answers only that it is off; a range that ends before it starts is refused; what moved is one small read', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const moved = async () => (await s.call('GET', '/v1/moved', {token: t})).json as unknown as {repos: string; home: Record<string, number>};
  const first = await moved();
  assert.deepEqual([first.home, (await moved()).repos], [{}, first.repos]);
  for (const n of ['on', 'other']) await s.call('PATCH', `/v1/repos/${n}/draft`, {token: t, body: {version: 0, set: {'a.txt': null}, remove: []}});
  const two = await moved();
  assert.notEqual(two.repos, first.repos);
  await s.call('PUT', '/v1/home/todo', {token: t, body: {value: '[]', version: 0}});
  assert.deepEqual([(await moved()).repos, (await moved()).home], [two.repos, {todo: 1}]);
  // Off: every path of the repo says so, whatever its name; on again, it answers.
  await s.db.update(schema.repo).set({offAt: new Date()});
  assert.notEqual((await moved()).repos, two.repos);
  for (const n of ['on', 'other']) assert.equal((await s.call('GET', `/v1/repos/${n}`, {token: t})).status, 410, n);
  assert.equal((await s.call('GET', '/v1/repos/on/log', {token: t})).status, 410);
  assert.equal((await s.call('POST', '/v1/repos/on/on', {token: t})).status, 200);
  assert.equal((await s.call('GET', '/v1/repos/on', {token: t})).status, 200);
  // A refused commit leaves no commit behind.
  const before = await count(s, sql`select count(*)::int as n from cut`);
  assert.equal((await s.call('POST', '/v1/repos/on/cuts', {token: t, body: {version: 1, parent: 'f'.repeat(64), title: 'x'}})).status, 409);
  assert.equal(await count(s, sql`select count(*)::int as n from cut`), before);
  // A release bundle: a range that ends before it starts asks for nothing there is.
  const sha = 'a'.repeat(64);
  await s.bucket.put(`os/${sha}`, new Uint8Array(100).map((_, i) => i));
  const backwards = await s.call('GET', `/v1/os/${sha}`, {headers: {Range: 'bytes=50-10'}});
  assert.deepEqual([backwards.status, backwards.headers.get('Content-Range')], [416, 'bytes */100']);
  const part = await s.app.request(`${BASE}/v1/os/${sha}`, {headers: {Range: 'bytes=10-19'}});
  assert.deepEqual([part.status, part.headers.get('Content-Range'), [...new Uint8Array(await part.arrayBuffer())]], [206, 'bytes 10-19/100', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]]);
  const head = await s.app.request(`${BASE}/v1/os/${sha}`, {method: 'HEAD'});
  assert.deepEqual([head.status, head.headers.get('Content-Length')], [200, '100']);
});

test('Discard: an off repo goes for good now, asked as off is; its name is remembered, so a copy that was in step cannot bring it back, and one made anew can', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const me = await idOf(s, t);
  await named(s, [t, 'ren']);
  const readme = (await upload(s, t, enc.encode('# r\n'))).sha, issue = (await upload(s, t, enc.encode('Fix：x\n'))).sha, fix = (await upload(s, t, enc.encode('fixed\n'))).sha;
  // A repo with all a repo has: commits, a line of work with its change, a share in a server and a public name.
  await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 0, set: {'README.md': readme, 'issue/001.md': issue}, remove: []}});
  await s.call('POST', '/v1/repos/r/cuts', {token: t, body: {version: 1, parent: null, title: 'start'}});
  await s.call('POST', '/v1/repos/r/lines', {token: t, body: {issue: 'issue/001.md'}});
  await s.call('PATCH', '/v1/repos/r/draft?line=001', {token: t, body: {version: 1, set: {'fix.c': fix}, remove: []}});
  const work = (await s.call('POST', '/v1/repos/r/cuts?line=001', {token: t, body: {version: 2, parent: (await s.call('GET', '/v1/repos/r?line=001', {token: t})).json.head, title: 'fix'}})).json.id as string;
  await s.call('POST', '/v1/repos/r/lines/001/push', {token: t, body: {head: work}});
  assert.equal((await s.call('POST', '/v1/repos/r/changes', {token: t, body: {line: '001', title: 'fix'}})).status, 201);
  const sid = (await s.call('POST', '/v1/servers', {token: t, body: {name: 'Trip'}})).json.id as string;
  assert.equal((await s.call('POST', `/v1/servers/${sid}/repos`, {token: t, body: {repo: 'r'}})).status, 201);
  assert.equal((await s.call('PUT', '/v1/repos/r/seen', {token: t, body: {seen: 'everyone', as: 'me'}})).status, 200);
  await s.call('PATCH', '/v1/repos/keep/draft', {token: t, body: {version: 0, set: {'README.md': readme}, remove: []}});
  const of = async (table: string) => count(s, table === 'repo' || table === 'repo_gone'
    ? sql`select count(*)::int as n from ${sql.identifier(table)} where user_id = ${me} and name = 'r'`
    : sql`select count(*)::int as n from ${sql.identifier(table)} x join repo r on r.id = x.repo_id where r.user_id = ${me} and r.name = 'r'`);
  const tables = ['repo', 'line', 'cut', 'change', 'repo_share', 'repo_public'];
  assert.deepEqual(await Promise.all(tables.map(of)), [1, 2, 2, 1, 1, 1]);

  // Asked as off is: a passkey just now, the names and the code; and only of a repo that is off.
  const discard = (body: unknown = {name: 'Ren', repo: 'r', code: 'AB12C'}, name = 'r') => s.call('POST', `/v1/repos/${name}/discard`, {token: t, body});
  assert.deepEqual([(await discard()).status, (await discard()).json.error], [403, 'Confirm with a passkey.']);
  const session = ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {session: {id: string}}).session.id;
  await s.db.insert(schema.guard).values({userId: me, proofSession: session, proofAt: new Date()});
  assert.equal((await discard()).status, 409); // no code set
  await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB12C'}});
  assert.deepEqual([(await discard({name: 'Ren', repo: 'r', code: 'ZZZZZ'})).status, (await discard({name: 'Ren', repo: 'r', code: 'ZZZZZ'})).json.error], [403, 'That is not the code.']);
  assert.equal((await discard({name: 'Ren', repo: 'keep', code: 'AB12C'})).status, 403);
  assert.equal((await discard({name: 'Mio', repo: 'r', code: 'AB12C'})).status, 403);
  const onStill = await discard();
  assert.deepEqual([onStill.status, onStill.json.error], [409, 'Turn it off first.']);
  assert.deepEqual(await Promise.all(tables.map(of)), [1, 2, 2, 1, 1, 1]);
  assert.equal((await discard({name: 'Ren', repo: 'nope', code: 'AB12C'}, 'nope')).status, 404);

  // Off, then discarded: all of it goes in one step, and its name is remembered as gone.
  assert.equal((await s.call('POST', '/v1/repos/r/off', {token: t, body: {name: 'Ren', repo: 'r', code: 'AB12C'}})).status, 200);
  const moved = async () => (await s.call('GET', '/v1/moved', {token: t})).json.repos as string;
  const before = await moved();
  const done = await discard();
  assert.deepEqual([done.status, done.json], [200, {name: 'r', discarded: true}]);
  assert.deepEqual(await Promise.all(tables.map(of)), [0, 0, 0, 0, 0, 0]);
  assert.equal(await of('repo_gone'), 1);
  const gone = (await s.call('GET', '/v1/repos/gone', {token: t})).json as unknown as {name: string; at: number}[];
  assert.ok(gone.length === 1 && gone[0].name === 'r' && Math.abs(gone[0].at - Date.now()) < 60_000, JSON.stringify(gone));
  assert.notEqual(await moved(), before);
  assert.deepEqual(((await s.call('GET', '/v1/repos', {token: t})).json as unknown as {name: string}[]).map((r) => r.name), ['keep']);
  assert.equal((await s.call('GET', '/v1/seen/ren@length3.test/r')).status, 404);
  // Asked again: it is not there to discard.
  assert.equal((await discard()).status, 404);

  // A copy that was in step with it is told it went, whatever it sends, on any line.
  const read = await s.call('GET', '/v1/repos/r', {token: t});
  assert.deepEqual([read.status, read.json.gone], [404, gone[0].at]);
  const resent = await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 0, set: {'README.md': readme}, remove: []}});
  assert.deepEqual([resent.status, resent.json], [410, {error: 'This repo was discarded on the Remote.', gone: gone[0].at}]);
  assert.equal((await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 2, set: {}, remove: []}})).status, 410);
  assert.equal((await s.call('PATCH', '/v1/repos/r/draft?line=001&anew=1', {token: t, body: {version: 1, set: {}, remove: []}})).status, 410);
  assert.deepEqual(((await s.call('GET', '/v1/repos', {token: t})).json as unknown as unknown[]).length, 1);
  // One that never was is made anew under the name, and the name is no longer gone.
  const stamp = await moved();
  const anew = await s.call('PATCH', '/v1/repos/r/draft?anew=1', {token: t, body: {version: 0, set: {'README.md': readme}, remove: []}});
  assert.deepEqual([anew.status, anew.json], [200, {version: 1}]);
  assert.deepEqual([(await s.call('GET', '/v1/repos/gone', {token: t})).json, await of('repo_gone')], [[], 0]);
  assert.notEqual(await moved(), stamp);
  assert.deepEqual(((await s.call('GET', '/v1/repos/r', {token: t})).json as unknown as {draft: object}).draft, {'README.md': readme});
  // `gone` is the Remote's own word: no repo is made under it.
  const word = await s.call('PATCH', '/v1/repos/gone/draft', {token: t, body: {version: 0, set: {}, remove: []}});
  assert.deepEqual([word.status, word.json.error], [400, 'A repo cannot be called gone']);
});

test('The sweep remembers a repo it let go as gone, for 90 days', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const draft = (query = '') => s.call('PATCH', `/v1/repos/old/draft${query}`, {token: t, body: {version: 0, set: {'a.txt': null}, remove: []}});
  assert.equal((await draft()).status, 200);
  await s.db.update(schema.repo).set({offAt: new Date(Date.now() - 31 * 86_400_000)});
  const went = await sweep(s.db, s.bucket);
  assert.equal(went.repo, 1);
  const gone = (await s.call('GET', '/v1/repos/gone', {token: t})).json as unknown as {name: string; at: number}[];
  assert.deepEqual(gone.map((g) => g.name), ['old']);
  assert.equal((await draft()).status, 410);
  // Ninety days on, it is forgotten: read as not gone at once, swept the next day.
  await s.db.execute(sql`update repo_gone set at = now() - interval '91 days'`);
  assert.deepEqual((await s.call('GET', '/v1/repos/gone', {token: t})).json, []);
  assert.equal((await sweep(s.db, s.bucket)).remembered, 1);
  assert.equal(await count(s, sql`select count(*)::int as n from repo_gone`), 0);
  assert.equal((await draft()).status, 200);
});

test('A board item taken off is not brought back by a late change; closing a board ends its guests', async () => {
  const s = await service();
  const ren = await s.start('Ren');
  await named(s, [ren, 'ren']);
  const bid = ((await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}})).json.boards as {id: string}[])[0].id;
  const item = (body: unknown) => s.call('PUT', `/v1/boards/${bid}/todos/a1`, {token: ren, body});
  assert.equal((await item({title: 'Ship it', place: 5, created: 1})).status, 201);
  assert.equal((await s.call('DELETE', `/v1/boards/${bid}/todos/a1`, {token: ren})).status, 204);
  const late = await item({done: true});
  assert.deepEqual([late.status, late.json.error], [404, 'That item was taken off']);
  assert.deepEqual((await s.call('GET', `/v1/boards/${bid}/todos`, {token: ren})).json, []);
  // A whole item (a title and a place) is a new one.
  assert.equal((await item({title: 'Ship it again', place: 1})).status, 201);
  const set = (body: unknown) => s.call('PATCH', `/v1/boards/${bid}`, {token: ren, body}).then((r) => [r.json.open, r.json.guests]);
  assert.deepEqual(await set({guests: true}), [true, true]);
  assert.deepEqual(await set({open: false}), [false, false]);
  assert.equal((await s.call('POST', `/v1/open/${bid}/guest`, {body: {email: 'a@example.org'}})).status, 404);
});

test('Letting an address go takes down what went public under it; a face its owner no longer has holds nothing for them', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await named(s, [ren, 'ren']);
  await s.call('PATCH', '/v1/repos/hello/draft', {token: ren, body: {version: 0, set: {a: null}, remove: []}});
  assert.equal((await s.call('PUT', '/v1/repos/hello/seen', {token: ren, body: {seen: 'everyone', as: 'me'}})).json.as, 'ren@length3.test:hello');
  await s.call('DELETE', '/v1/inbox/addresses/ren@length3.test', {token: ren});
  assert.equal(((await s.call('GET', '/v1/seen', {token: ren})).json as unknown as {seen: string}[])[0].seen, 'private');
  // Held long enough, the name is Mio's, and so is ren:hello when she makes hers public.
  await s.db.execute(sql`update address set released_at = now() - interval '31 days' where address = 'ren@length3.test'`);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'ren'}})).status, 201);
  await s.call('PATCH', '/v1/repos/hello/draft', {token: mio, body: {version: 0, set: {b: null}, remove: []}});
  const mine = await s.call('PUT', '/v1/repos/hello/seen', {token: mio, body: {seen: 'everyone', as: 'me'}});
  assert.deepEqual([mine.status, mine.json.as], [200, 'ren@length3.test:hello']);
});

test('Live chat: a device takes only what came from the one it talks with, in its own session', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio'), kai = await s.start('Kai');
  await named(s, [ren, 'ren'], [mio, 'mio'], [kai, 'kai']);
  for (const [a, b] of [[ren, 'mio'], [mio, 'ren'], [ren, 'kai'], [kai, 'ren']] as const) await accept(s, a, b);
  const send = (t: string, session: string, kind: string) => s.call('POST', '/v1/inbox/signals', {token: t, body: {to: 'ren', session, kind, data: kind}});
  const take = (query: string) => s.call('GET', `/v1/inbox/signals?${query}`, {token: ren}).then((r) => (r.json as unknown as {from: string; session: string; kind: string}[]).map((x) => `${x.from} ${x.session} ${x.kind}`));
  await send(mio, 'm1', 'offer');
  await send(kai, 'k1', 'offer');
  // Two chats open: each takes its own peer's offer, and leaves the other's.
  assert.deepEqual(await take('from=mio'), ['mio@length3.test m1 offer']);
  assert.deepEqual(await take('from=kai'), ['kai@length3.test k1 offer']);
  // Two devices talking with Mio, in two sessions: each takes its own.
  await send(mio, 'a', 'answer');
  await send(mio, 'b', 'candidate');
  assert.deepEqual(await take('from=mio&session=a'), ['mio@length3.test a answer']);
  assert.deepEqual(await take('from=mio&session=b'), ['mio@length3.test b candidate']);
  assert.deepEqual(await take('from=mio&session=a'), []);
});

test('The sweep lets go of sessions, devices\' codes and verifications that ran out, and of none that still holds', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const me = await idOf(s, t);
  assert.equal((await s.call('POST', '/api/auth/device/code', {body: {client_id: 'l3'}})).status, 200);
  // Written as Better Auth writes them (UTC, without a zone): one run out a minute ago of each.
  const ago = new Date(Date.now() - 60_000);
  await s.db.insert(schema.session).values({id: 'gone-session', token: 'gone-token', userId: me, expiresAt: ago, updatedAt: ago});
  await s.db.insert(schema.deviceCode).values({id: 'gone-code', deviceCode: 'gone-device', userCode: 'GONE0000', expiresAt: ago, status: 'pending'});
  await s.db.insert(schema.verification).values({id: 'gone-verification', identifier: 'x', value: 'y', expiresAt: ago});
  await s.db.insert(schema.verification).values({id: 'kept-verification', identifier: 'x', value: 'y', expiresAt: new Date(Date.now() + 60_000)});
  const gone = await sweep(s.db, s.bucket);
  assert.deepEqual([gone.session, gone.device_code, gone.verification], [1, 1, 1]);
  assert.deepEqual([await count(s, sql`select count(*)::int as n from session`), await count(s, sql`select count(*)::int as n from device_code`),
    await count(s, sql`select count(*)::int as n from verification where id = 'kept-verification'`)], [1, 1, 1]);
  assert.equal((await s.call('GET', '/v1/repos', {token: t})).status, 200);
});

test('The sweep: what was held long enough goes in one place, blobs no tree names among it, and nothing else', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  const me = await idOf(s, ren), her = await idOf(s, mio);
  await named(s, [ren, 'ren'], [mio, 'mio']);
  const kept = await upload(s, ren, enc.encode('kept')), dropped = await upload(s, ren, enc.encode('dropped')), committed = await upload(s, ren, enc.encode('committed'));
  const draft = (version: number, set: Record<string, string | null>, remove: string[] = []) => s.call('PATCH', '/v1/repos/r/draft', {token: ren, body: {version, set, remove}});
  await draft(0, {'c.txt': committed.sha});
  assert.equal((await s.call('POST', '/v1/repos/r/cuts', {token: ren, body: {version: 1, parent: null, title: 'with c'}})).status, 201);
  await draft(1, {'d.txt': dropped.sha});
  await draft(2, {'k.txt': kept.sha}, ['c.txt', 'd.txt']);
  // A blob is not taken for unnamed the day it came: a diff names it after it is sent.
  assert.equal((await sweep(s.db, s.bucket)).blob, undefined);
  await s.db.execute(sql`update blob set created_at = now() - interval '2 days'`);
  await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio', body: 'old and read'}});
  await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio', body: 'old and unread'}});
  await s.db.execute(sql`update message set created_at = now() - interval '91 days', read_at = case when body = 'old and read' then now() end`);
  const gone = await sweep(s.db, s.bucket);
  assert.equal(gone.blob, 1);
  const has = async (sha: string) => (await s.db.execute(sql`select 1 from blob where user_id = ${me} and sha256 = ${sha}`)).rows.length > 0;
  assert.deepEqual([await has(kept.sha), await has(committed.sha), await has(dropped.sha)], [true, true, false]);
  assert.ok(!s.bucket.keys().includes(`u/${me}/${dropped.sha}`) && s.bucket.keys().includes(`u/${me}/${kept.sha}`));
  assert.deepEqual(((await s.db.execute(sql`select body from message`)).rows as {body: string}[]).map((m) => m.body), ['old and unread']);
  // Held thirty days and more: a server (its name with it) and a board; a signal and a proof minutes old; what was asked a day ago.
  await s.db.execute(sql`insert into server (id, name, gone_at) values ('oldoldoldold', 'Old', now() - interval '31 days'), ('newnewnewnew', 'New', now() - interval '29 days')`);
  await s.db.execute(sql`insert into address (address, server_id, name, domain, until, released_at) values ('old@length3.test', 'oldoldoldold', 'old', 'length3.test', now() + interval '1 year', now() - interval '1 day')`);
  await s.db.execute(sql`insert into board (id, server_id, name, gone_at) values ('boldboldbold', 'newnewnewnew', 'x', now() - interval '31 days'), ('bnewbnewbnew', 'newnewnewnew', 'y', null)`);
  await s.db.execute(sql`insert into signal (to_user, from_user, session, kind, data, created_at) values (${me}, ${her}, 's', 'offer', '', now() - interval '3 minutes')`);
  await s.db.execute(sql`insert into guard (user_id, proof_session, proof_at) values (${her}, 'x', now() - interval '6 minutes')`);
  await s.db.execute(sql`insert into throttle (key, at) values ('k', now() - interval '2 days')`);
  const later = await sweep(s.db, s.bucket);
  assert.deepEqual([later.server, later.board, later.signal, later.guard, later.throttle], [1, 1, 1, 1, 1]);
  assert.deepEqual([await count(s, sql`select count(*)::int as n from server`), await count(s, sql`select count(*)::int as n from board`),
    await count(s, sql`select count(*)::int as n from address`)], [1, 1, 2]);
  // Nothing else went: the repo, its draft and its history are as they were.
  assert.deepEqual(((await s.call('GET', '/v1/repos/r', {token: ren})).json as unknown as {draft: object}).draft, {'k.txt': kept.sha});
  assert.equal(((await s.call('GET', '/v1/repos/r/log', {token: ren})).json as unknown[]).length, 1);
});

test('On Workers the app is made once, and each request uses the database it opened', async () => {
  const {scoped} = await import('./worker.ts');
  const [one, two] = [await fresh(), await fresh()];
  const {db, at} = scoped(one);
  const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true});
  const app = createApp({db, auth, bucket: memoryBucket(), origins: [APP], providers: ['dev'], domain: 'length3.test', baseURL: BASE});
  let on = one;
  const ask = (url: string, init: RequestInit = {}) => at(on, () => app.request(url, {...init, headers: {Origin: APP, ...(init.headers as Record<string, string>)}}));
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch;
  const asked = await ask(`${BASE}/api/auth/sign-in/social`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/`})});
  const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const go = new URL(((await asked.json()) as {url: string}).url);
  const approve = new URL(`${BASE}/dev-oauth/approve`);
  for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
  const back = (await ask(approve.toString())).headers.get('Location')!;
  const token = (await ask(back, {headers: {Cookie: cookies}})).headers.get('set-auth-token')!;
  const repos = async () => (await ask(`${BASE}/v1/repos`, {headers: {Authorization: `Bearer ${token}`}})).status;
  // The session is in the database its sign-in's requests opened, and only there.
  assert.equal(await repos(), 200);
  on = two;
  assert.equal(await repos(), 401);
  on = one;
  assert.equal(await repos(), 200);
});

test('On Workers a sweep that fails fails its run, and says so', async () => {
  const worker = (await import('./worker.ts')).default;
  // A database nobody answers for: the sweep's first step fails.
  const env = {DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1/none?sslmode=require', BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    BASE_URL: BASE, APP_ORIGIN: APP, BLOBS: {get: async () => null, put: async () => undefined, delete: async () => undefined}};
  const later: Promise<unknown>[] = [], said: unknown[][] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { said.push(a); };
  try {
    await assert.rejects(worker.scheduled({}, env, {waitUntil: (p) => { later.push(p); }}));
  } finally {
    console.error = error;
  }
  assert.equal(said[0]?.[0], 'sweep failed');
  // The connection is let go however the sweep went.
  assert.deepEqual((await Promise.allSettled(later)).map((r) => r.status), ['fulfilled']);
});

test('The room is counted as things come and go, and agrees with counting it all again; its stamp moves with the repo list', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const me = await idOf(s, t);
  const room = async () => (await s.db.execute(sql`select used, stamp from room where user_id = ${me}`)).rows[0] as {used: number; stamp: number};
  const recount = () => count(s, sql`select ((select coalesce(sum(bytes), 0) from blob where user_id = ${me}) + (select coalesce(sum(bytes), 0) from line where user_id = ${me})
    + (select coalesce(sum(bytes), 0) from cut where user_id = ${me}) + (select coalesce(sum(bytes), 0) from review where user_id = ${me}))::int as n`);
  const moved = async () => (await s.call('GET', '/v1/moved', {token: t})).json.repos as string;
  const a = (await upload(s, t, enc.encode('a'.repeat(500)))).sha, b = (await upload(s, t, enc.encode('b'))).sha, issue = (await upload(s, t, enc.encode('Fix：x\n'))).sha;
  const stamps = [await moved()];
  await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 0, set: {'a.txt': a, 'issue/001.md': issue}, remove: []}});
  stamps.push(await moved());
  await s.call('POST', '/v1/repos/r/cuts', {token: t, body: {version: 1, parent: null, title: 'one'}});
  stamps.push(await moved());
  await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 1, set: {'b.txt': b}, remove: ['a.txt']}});
  await s.call('POST', '/v1/repos/r/lines', {token: t, body: {issue: 'issue/001.md'}});
  assert.equal(new Set(stamps).size, stamps.length, stamps.join(' '));
  assert.equal((await room()).used, await recount());
  // What its draft's files take is read when the draft is written: b alone now, each blob once.
  const listed = (await s.call('GET', '/v1/repos', {token: t})).json as unknown as {name: string; bytes: number}[];
  assert.deepEqual(listed.map((r) => [r.name, r.bytes]), [['r', 1 + enc.encode('Fix：x\n').length]]);
  // A repo discarded takes all that hangs from it, and its room says so.
  await s.db.update(schema.repo).set({offAt: new Date(Date.now() - 31 * 86_400_000)});
  const before = await moved();
  await sweep(s.db, s.bucket);
  assert.notEqual(await moved(), before);
  const blobs = await count(s, sql`select coalesce(sum(bytes), 0)::int as n from blob where user_id = ${me}`);
  assert.deepEqual([(await room()).used, await recount()], [blobs, blobs]);
});

test('The service\'s role reads and writes rows, and nothing else', async () => {
  const s = await service();
  const as = async (q: ReturnType<typeof sql>) => {
    try { await s.db.transaction(async (tx) => { await tx.execute(sql`set local role remote_app`); await tx.execute(q); }); return 'done'; } catch { return 'refused'; }
  };
  assert.deepEqual(await Promise.all([
    as(sql`select count(*) from repo`), as(sql`insert into throttle (key) values ('k')`),
    as(sql`create table mine (x int)`), as(sql`drop table throttle`), as(sql`alter table repo drop constraint repo_name`), as(sql`truncate throttle`),
  ]), ['done', 'done', 'refused', 'refused', 'refused', 'refused']);
});

test('For research: nobody signs up, the link enters the one account, and nothing is shown to everyone', async () => {
  const key = 'k'.repeat(40);
  const s = await service({}, {enter: {as: 'banana000000', key}});
  assert.deepEqual((await s.call('GET', '/v1/about')).json, {passkey: false, providers: [], domain: 'length3.test', app: APP, enter: true});
  // A provider admits nobody, not even one this Remote could offer.
  const asked = await s.app.request(`${BASE}/api/auth/sign-in/social`, {method: 'POST', headers: {Origin: APP, 'Content-Type': 'application/json'},
    body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/`})});
  const go = new URL(((await asked.json()) as {url: string}).url);
  const approve = new URL(`${BASE}/dev-oauth/approve`);
  for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
  const back = (await s.app.request(approve.toString())).headers.get('Location')!;
  const done = await s.app.request(back, {headers: {Cookie: asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')}});
  assert.ok(!done.headers.get('set-auth-token') && !(done.headers.get('Location') ?? '').includes('signed-in'), done.headers.get('Location') ?? '');
  assert.equal(await count(s, sql`select count(*)::int as n from "user"`), 0);
  // The link: a wrong key opens nothing; the key enters the one account, the same one each time.
  const enter = (k: unknown) => s.call('POST', '/v1/enter', {body: {key: k}});
  assert.deepEqual(await Promise.all(['', 'k'.repeat(39), 'k'.repeat(41), 42].map(async (k) => (await enter(k)).status)), [403, 403, 403, 403]);
  const a = await enter(key), b = await enter(key);
  assert.deepEqual([a.status, a.json.name, b.status], [200, 'banana000000', 200]);
  // The latest entry is the one that proves the person is here.
  const t = b.json.token as string;
  const who = async (token: string) => ((await s.call('GET', '/api/auth/get-session', {token})).json as unknown as {user: {id: string}} | null)?.user.id;
  assert.ok((await who(t)) && (await who(t)) === (await who(a.json.token as string)));
  assert.equal(await count(s, sql`select count(*)::int as n from "user"`), 1);
  // A session made by the link ends a day after it was made, and using it does not draw it out.
  await s.call('GET', '/v1/repos', {token: t});
  assert.ok(await count(s, sql`select count(*)::int as n from session where extract(epoch from expires_at - created_at) between 86000 and 86500`) >= 2);
  // It works as any account does, and entering just now is proof enough to set the code a repo is turned off with.
  assert.equal((await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version: 0, set: {}, remove: []}})).status, 200);
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB12C'}})).status, 200);
  // No passkey is added (one would let a link's holder back in after the key changed), and nothing goes to everyone.
  assert.equal((await s.call('POST', '/api/auth/passkey/generate-register-options', {token: t, body: {}})).status, 403);
  await s.call('POST', '/v1/inbox/addresses', {token: t, body: {name: 'banana'}});
  assert.equal((await s.call('PUT', '/v1/repos/r/seen', {token: t, body: {seen: 'everyone', as: 'me'}})).status, 403);
  const sid = (await s.call('POST', '/v1/servers', {token: t, body: {name: 'Lab', address: 'lab'}})).json as unknown as {boards: {id: string}[]};
  assert.equal((await s.call('PATCH', `/v1/boards/${sid.boards[0].id}`, {token: t, body: {open: true}})).status, 403);
  // Guessing is held off: an address that keeps trying is told to wait, even with the key.
  for (let i = 0; i < 20; i++) await enter('nope');
  assert.equal((await enter(key)).status, 429);
});

test('News: what came in that one has not seen, one\'s own only; a board read so far only goes forward', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio'), kai = await s.start('Kai');
  await named(s, [ren, 'ren'], [mio, 'mio'], [kai, 'kai']);
  const news = async (t: string) => (await s.call('GET', '/v1/news', {token: t})).json as unknown as {inbox: number; boards: {id: string; server: string; post: string}[]};
  assert.equal((await s.call('GET', '/v1/news')).status, 401);
  assert.deepEqual(await news(ren), {inbox: 0, boards: []});
  // A message not read yet is counted, request or not; opening the conversation reads it.
  await s.call('POST', '/v1/inbox/messages', {token: mio, body: {to: 'ren', body: 'hello'}});
  await s.call('POST', '/v1/inbox/messages', {token: kai, body: {to: 'ren', body: 'hi'}});
  assert.equal((await news(ren)).inbox, 2);
  // Someone blocked is not news.
  await accept(s, ren, 'kai', 'blocked');
  assert.equal((await news(ren)).inbox, 1);
  await s.call('POST', '/v1/inbox/threads/mio/read', {token: ren});
  assert.equal((await news(ren)).inbox, 0);
  assert.equal((await news(mio)).inbox, 0);

  // A board: a post by another is new to its people, never one's own, and never to someone not in it.
  await accept(s, ren, 'mio');
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip', board: 'plan'}});
  const sid = made.json.id as string, bid = (made.json.boards as {id: string}[])[0].id;
  assert.equal((await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}})).status, 201);
  const mine = await s.call('POST', `/v1/boards/${bid}/posts`, {token: ren, body: {body: 'mine'}});
  assert.deepEqual((await news(ren)).boards, []);
  assert.deepEqual((await news(mio)).boards, [{id: bid, server: sid, post: mine.json.id}]);
  assert.deepEqual((await news(kai)).boards, []);
  // Read so far: by its people only, a post's id, and forward only.
  const seen = (t: string, post: unknown) => s.call('POST', `/v1/boards/${bid}/seen`, {token: t, body: {post}});
  assert.equal((await seen(kai, mine.json.id)).status, 404);
  assert.equal((await seen(mio, 'not a post')).status, 400);
  assert.equal((await seen(mio, mine.json.id)).status, 204);
  assert.deepEqual((await news(mio)).boards, []);
  const next = await s.call('POST', `/v1/boards/${bid}/posts`, {token: ren, body: {body: 'and then'}});
  assert.deepEqual((await news(mio)).boards, [{id: bid, server: sid, post: next.json.id}]);
  assert.equal((await seen(mio, next.json.id)).status, 204);
  // Another device that read less, later, takes nothing back.
  assert.equal((await seen(mio, mine.json.id)).status, 204);
  assert.deepEqual((await news(mio)).boards, []);
  // A board removed is not news.
  await s.call('POST', `/v1/boards/${bid}/posts`, {token: ren, body: {body: 'once more'}});
  assert.equal((await news(mio)).boards.length, 1);
  await s.call('DELETE', `/v1/boards/${bid}`, {token: ren});
  assert.deepEqual((await news(mio)).boards, []);
});

test('Asked into a server from the Inbox: in once they accept the one who asked, while that one is still in it', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio'), kai = await s.start('Kai'), ana = await s.start('Ana');
  await named(s, [ren, 'ren'], [mio, 'mio'], [kai, 'kai'], [ana, 'ana']);
  const sid = (await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}})).json.id as string;
  const people = async () => ((await s.call('GET', `/v1/servers/${sid}/people`, {token: ren})).json as unknown as {address: string}[]).map((p) => p.address);
  const ask = (from: string, to: string) => s.call('POST', '/v1/inbox/messages', {token: from, body: {to, body: 'Come into Trip', target: {server: sid}}});
  // Ren asks Mio: a request; Mio is not in it until Mio accepts Ren.
  assert.equal((await ask(ren, 'mio')).json.request, true);
  assert.deepEqual(await people(), ['ren@length3.test']);
  await accept(s, mio, 'ren');
  assert.deepEqual(await people(), ['ren@length3.test', 'mio@length3.test']);
  // Kai, not in it, cannot ask anyone into it: Ana accepting Kai puts Ana in nothing.
  await ask(kai, 'ana');
  await accept(s, ana, 'kai');
  assert.deepEqual(await people(), ['ren@length3.test', 'mio@length3.test']);
  // Mio asks Kai, then leaves before Kai answers: Kai answering by writing back (which accepts) comes into nothing.
  await ask(mio, 'kai');
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/people/mio@length3.test`, {token: mio})).status, 204);
  await s.call('POST', '/v1/inbox/messages', {token: kai, body: {to: 'mio', body: 'sure'}});
  assert.deepEqual(await people(), ['ren@length3.test']);
  // Blocking the one who asked puts no one in.
  await ask(ren, 'ana');
  await accept(s, ana, 'ren', 'blocked');
  assert.deepEqual(await people(), ['ren@length3.test']);
  // Writing back to the one who asked is accepting them, and comes in the same way.
  await ask(ren, 'kai');
  await s.call('POST', '/v1/inbox/messages', {token: kai, body: {to: 'ren', body: 'ok'}});
  assert.deepEqual(await people(), ['ren@length3.test', 'kai@length3.test']);
});
