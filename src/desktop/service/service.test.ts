import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp, sha256} from './app.ts';
import {createAuth} from './auth.ts';
import {memoryBucket} from './bucket.ts';
import * as schema from './schema.ts';

const BASE = 'http://remote.test';
const APP = 'http://app.test';

async function service(records: Record<string, string[]> = {}) {
  const db = drizzle(new PGlite(), {schema});
  await migrate(db, {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
  const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true});
  const bucket = memoryBucket();
  // DNS as a map of name → TXT records.
  const dns = new Map(Object.entries(records));
  const mails: {to: string; text: string}[] = [];
  const app = createApp({db, auth, bucket, origins: [APP], providers: ['dev'], domain: 'length3.test', baseURL: BASE,
    secret: 'test-secret-'.repeat(4), txt: async (name) => dns.get(name) ?? [], recheck: 0, mail: async (to, _subject, text) => { mails.push({to, text}); }});
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
    return token!;
  };
  const publish = (name: string, value: string) => dns.set(name, [...(dns.get(name) ?? []), value]);
  const unpublish = (name: string) => dns.delete(name);
  return {db, call, start, bucket, publish, unpublish, mails};
}

const enc = new TextEncoder();

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
  assert.deepEqual((await s.call('GET', '/v1/about')).json, {passkey: true, providers: ['dev'], domain: 'length3.test'});
});

test('a device asks for a code, a signed-in browser approves it, the device gets its own session', async () => {
  const s = await service();
  const t = await s.start();
  const asked = await s.call('POST', '/api/auth/device/code', {body: {client_id: 'l3'}});
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const {device_code, user_code, verification_uri_complete} = asked.json as unknown as {device_code: string; user_code: string; verification_uri_complete: string};
  assert.ok(verification_uri_complete.startsWith(`${APP}/?device`));
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
  assert.deepEqual(v1.json, {version: 1, bytes: 8});
  // Two devices on version 1: one lands, the other gets the draft to merge.
  const plan = await put('plan\n');
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'docs/plan.md': plan}, remove: ['docs']}})).json.version, 2);
  const stale = await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'x.md': plan}, remove: []}});
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, {version: 2, draft: {'README.md': readme, 'docs/plan.md': plan}});
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
  await s.db.insert(schema.passkeyProof).values({sessionId: session.session.id, userId: session.user.id});
  assert.equal((await off({name: 'Ren', repo: 'notes', code: 'AB12C'})).status, 409); // no code set
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB-1'}})).status, 400);
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'ab12c'}})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/off-code', {token: t})).json.set, true);
  assert.equal((await off({name: 'Ren', repo: 'notes', code: 'ZZZZZ'})).status, 403);
  assert.equal((await off({name: 'Mio', repo: 'notes', code: 'AB12C'})).status, 403);
  assert.equal((await off({name: 'ren', repo: 'notes', code: 'AB12C'})).status, 200);
  assert.equal((await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t})).status, 410);
  assert.equal((await s.call('PATCH', '/v1/repos/notes', {token: t, body: {version: 2, changes: {}}})).status, 410);
  const listed = (await s.call('GET', '/v1/repos', {token: t})).json as unknown as {name: string; offAt: number; until: number}[];
  assert.equal(listed[0].name, 'notes');
  assert.ok(listed[0].offAt && listed[0].until - listed[0].offAt === 30 * 24 * 3600 * 1000);
  // On: back at once, history and all.
  assert.equal((await s.call('POST', '/v1/repos/notes/on', {token: t})).status, 200);
  assert.equal((await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t})).status, 200);
  // Thirty days on, it goes for good.
  await s.db.update(schema.repo).set({offAt: new Date(Date.now() - 31 * 24 * 3600 * 1000)});
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
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '[]', version: 0}})).json.version, 1);
  assert.deepEqual((await s.call('GET', '/v1/home/todo', {token: b})).json, {value: null, version: 0});
  // A setting changes only from the version it was read at.
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '["x"]', version: 1}})).json.version, 2);
  assert.deepEqual((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '["y"]', version: 1}})).json, {value: '["x"]', version: 2});
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
  assert.deepEqual(started.json.draft, {'README.md': readme, 'issue/001.md': issue});
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
  const got = (await s.call('GET', '/v1/inbox/signals', {token: mio})).json as unknown as {from: string; kind: string}[];
  assert.deepEqual(got.map((g) => [g.from, g.kind]), [['ren@length3.test', 'offer']]);
  assert.deepEqual((await s.call('GET', '/v1/inbox/signals', {token: mio})).json, []);
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
  // Only a contact can be added: someone one knows.
  assert.equal((await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}})).status, 403);
  await s.call('POST', '/v1/inbox/contacts', {token: ren, body: {address: 'mio@length3.test', state: 'accepted'}});
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
  assert.equal((await s.call('POST', `/v1/open/${bid}/posts`, {body: {body: 'can I come?'}})).status, 401);
  const g = await s.call('POST', `/v1/open/${bid}/posts`, {body: {body: 'can I come?'}, headers: {'X-Guest': ok.json.token as string}});
  assert.deepEqual([g.status, g.json.by, g.json.guest], [201, 'aki', true]);
  // A guest writes for a while: the token is a lease.
  const {eq} = await import('drizzle-orm');
  await s.db.update(schema.guest).set({tokenUntil: new Date(Date.now() - 1000)}).where(eq(schema.guest.email, 'aki@example.org'));
  assert.equal((await s.call('POST', `/v1/open/${bid}/posts`, {body: {body: 'still?'}, headers: {'X-Guest': ok.json.token as string}})).status, 401);
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
  const sid = (await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip', address: 'trip'}})).json.id as string;
  await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}});
  assert.equal((await s.call('POST', `/v1/servers/${sid}/repos`, {token: mio, body: {repo: 'hello'}})).status, 404);
  assert.equal((await s.call('POST', `/v1/servers/${sid}/repos`, {token: ren, body: {repo: 'hello'}})).status, 201);
  assert.deepEqual([(await state()).seen, (await state()).servers.map((x) => x.name)], ['servers', ['Trip']]);
  const listed = (await s.call('GET', `/v1/servers/${sid}/repos`, {token: mio})).json as unknown as {owner: string; name: string; mine: boolean}[];
  assert.deepEqual(listed.map((r) => [r.owner, r.name, r.mine]), [['ren@length3.test', 'hello', false]]);
  const shown = await see('ren@length3.test:hello', mio);
  assert.deepEqual([shown.status, shown.json.owner, shown.json.title, shown.json.tree], [200, 'ren@length3.test', 'start', {'README.md': readme}]);
  assert.equal((await s.call('GET', `/v1/seen/ren@length3.test/hello/blobs/${readme}`, {token: mio})).text, '# hello\n');
  // Only what is in the tree it was pushed to: not the commit after it, nor any other blob of Ren's.
  assert.equal((await s.call('GET', `/v1/seen/ren@length3.test/hello/blobs/${later}`, {token: mio})).status, 404);
  assert.equal((await s.call('GET', `/v1/seen/ren@length3.test/hello/blobs/${secret}`, {token: mio})).status, 404);
  assert.equal((await see('ren@length3.test:hello', kai)).status, 404);
  // Taken off the list by Ren or the server's owner; Mio may not.
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/repos/ren@length3.test/hello`, {token: mio})).status, 403);
  // From the server to everyone: it is seen as the server's, and nothing it answers names Ren.
  const pub = await seen({seen: 'everyone'});
  assert.deepEqual([pub.json.seen, pub.json.as], ['everyone', 'trip@length3.test:hello']);
  const out = await see('trip@length3.test:hello');
  assert.equal(out.status, 200);
  assert.ok(!JSON.stringify(out.json).includes('ren'), JSON.stringify(out.json));
  assert.equal((await s.call('GET', `/v1/seen/trip@length3.test/hello/blobs/${readme}`)).text, '# hello\n');
  // Ren's own name does not open it to everyone: that would tie the two together.
  assert.deepEqual([(await see('ren@length3.test:hello')).status, (await see('ren@length3.test:hello', kai)).status], [404, 404]);
  // A face's names are one namespace: Mio's hello cannot also be trip:hello.
  const mine = await put(mio, '# mio\n');
  await commit(mio, {'README.md': mine}, 'mio');
  await s.call('POST', `/v1/servers/${sid}/repos`, {token: mio, body: {repo: 'hello'}});
  const clash = await s.call('PUT', '/v1/repos/hello/seen', {token: mio, body: {seen: 'everyone', as: sid}});
  assert.deepEqual([clash.status, clash.json.error], [409, 'taken']);
  // Taken down, it is held for Ren a while: nobody else's repo answers to it meanwhile.
  assert.equal((await seen({seen: 'servers', servers: [sid]})).json.seen, 'servers');
  assert.equal((await see('trip@length3.test:hello')).status, 404);
  const held = await s.call('PUT', '/v1/repos/hello/seen', {token: mio, body: {seen: 'everyone', as: sid}});
  assert.deepEqual([held.status, held.json.error], [409, 'held']);
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
  assert.deepEqual([held.status, held.json.error], [409, 'held']);
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
  assert.deepEqual([gone.reachable, gone.why], [false, 'its domain no longer names this Remote']);
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
  assert.deepEqual([held.status, held.json.error], [409, 'held']);
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
