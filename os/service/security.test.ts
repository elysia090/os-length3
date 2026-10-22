// What the Remote promises against the standards it is held to, one test a
// promise (scratchpad security/conformance.md maps each to its item): the
// headers every answer carries, CORS, the cookie that cannot be used from
// another site, no GET that changes anything, a refusal for asking too often
// said one way, a key a purpose, the cookies' prefix, the security.txt, and
// what the database role the Worker connects as may not do.

import assert from 'node:assert/strict';
import {hkdfSync} from 'node:crypto';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {eq} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {SECURITY_TXT} from './about.ts';
import {createApp} from './app.ts';
import {AUTH_LIMITS, createAuth} from './auth.ts';
import {hmacHex, keyFor, same} from './keys.ts';
import {MIGRATIONS} from './neon.ts';
import {API_POLICY, throttled} from './request.ts';
import * as schema from './schema.ts';
import {APP, BASE, freshDb, named, SECRET, service} from './testing.ts';

const EVIL = 'https://evil.example';

test('every answer of the Remote is data that is never cached, sniffed, framed, embedded elsewhere or reached but by HTTPS (ASVS 14.4.1-14.4.7)', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const answers = [
    await s.call('GET', '/v1/about'),
    await s.call('GET', '/v1/repos', {token: t}),
    await s.call('GET', '/v1/repos'),
    await s.call('GET', '/v1/nothing-here', {token: t}),
    await s.call('GET', '/api/auth/get-session', {token: t}),
    await s.call('GET', '/.well-known/security.txt'),
  ];
  for (const r of answers) {
    assert.equal(r.headers.get('Content-Security-Policy'), API_POLICY);
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
    assert.equal(r.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
  assert.ok(API_POLICY.includes("default-src 'none'") && API_POLICY.includes("frame-ancestors 'none'"));
  // The stand-in provider's page (dev and tests only) says a policy of its own, as strict as its form allows.
  const page = await s.call('GET', '/dev-oauth/authorize?state=x&redirect_uri=http://remote.test/');
  assert.match(page.headers.get('Content-Security-Policy') ?? '', /default-src 'none'.*frame-ancestors 'none'/);
});

test('CORS answers only the app\'s own origins, with credentials, and caches a preflight ten minutes (ASVS 14.5.3)', async () => {
  const s = await service();
  const ok = await s.call('OPTIONS', '/v1/repos', {headers: {Origin: APP, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization'}});
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
  assert.equal(ok.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(ok.headers.get('Access-Control-Max-Age'), '600');
  const no = await s.call('OPTIONS', '/v1/repos', {headers: {Origin: EVIL, 'Access-Control-Request-Method': 'PUT'}});
  assert.equal(no.headers.get('Access-Control-Allow-Origin'), null);
  const read = await s.call('GET', '/v1/about', {headers: {Origin: EVIL}});
  assert.equal(read.headers.get('Access-Control-Allow-Origin'), null);
});

test('the session cookie alone opens nothing for another site\'s page, a read neither; a bearer token from anywhere does (CSRF: ASVS 4.2.2, 13.2.3; Fetch Metadata)', async () => {
  const s = await service();
  const t = await s.start('Ren');
  const cookie = s.sessions.get(t)!;
  assert.ok(cookie);
  // A request no page of the app made carries no Origin of the app's ('' is none to the Remote).
  const as = (headers: Record<string, string>, method = 'GET', body?: unknown) =>
    s.call(method, method === 'GET' ? '/v1/repos' : '/v1/home/profile', {headers: {Cookie: cookie, Origin: '', ...headers}, body}).then((r) => r.status);
  // From the app's own page, as the browser says it: read and write.
  assert.equal(await as({Origin: APP, 'Sec-Fetch-Site': 'same-origin'}), 200);
  assert.equal(await as({'Sec-Fetch-Site': 'same-origin'}), 200);
  // Opened by hand (typed, a bookmark): no site started it.
  assert.equal(await as({'Sec-Fetch-Site': 'none'}), 200);
  // Started by another site's page: a link, an image, a script, a fetch with credentials.
  assert.equal(await as({'Sec-Fetch-Site': 'cross-site'}), 403);
  assert.equal(await as({'Sec-Fetch-Site': 'cross-site', Origin: EVIL}), 403);
  assert.equal(await as({'Sec-Fetch-Site': 'same-site'}), 403);
  assert.equal(await as({Origin: EVIL}, 'PUT', {value: {}, version: 0}), 403);
  // A bearer token cannot be sent by another site's page without a preflight CORS refuses: taken from anywhere.
  assert.equal((await s.call('GET', '/v1/repos', {token: t, headers: {Origin: EVIL, 'Sec-Fetch-Site': 'cross-site'}})).status, 200);
});

test('no GET changes anything: signals are taken with a POST, and a GET of them takes nothing (audit I2; ASVS 13.1.x)', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await named(s, [ren, 'ren'], [mio, 'mio']);
  for (const [a, b] of [[ren, 'mio'], [mio, 'ren']] as const) await s.call('POST', '/v1/inbox/contacts', {token: a, body: {address: b, state: 'accepted'}});
  assert.equal((await s.call('POST', '/v1/inbox/signals', {token: ren, body: {to: 'mio', session: 's1', kind: 'offer', data: 'sdp'}})).status, 201);
  const cookie = s.sessions.get(mio)!;
  // What a page elsewhere could make a browser ask: refused, and nothing is taken.
  const got = await s.call('GET', '/v1/inbox/signals?from=ren', {headers: {Cookie: cookie, Origin: '', 'Sec-Fetch-Site': 'cross-site'}});
  assert.equal(got.status, 403);
  const asGet = await s.call('GET', '/v1/inbox/signals?from=ren', {token: mio});
  assert.deepEqual([asGet.status, asGet.headers.get('Allow')], [405, 'POST']);
  assert.equal((await s.db.select().from(schema.signal)).length, 1);
  const taken = await s.call('POST', '/v1/inbox/signals/take', {token: mio, body: {from: 'ren'}});
  assert.deepEqual((taken.json as unknown as {kind: string}[]).map((x) => x.kind), ['offer']);
  assert.equal((await s.db.select().from(schema.signal)).length, 0);
});

test('asking too often is 429 with Retry-After and retryAfter, wherever it is counted (RFC 6585 §4; ASVS 2.2.1, 11.1.4)', async () => {
  const s = await service();
  // Codes resolved signed out are counted by address (audit N1): thirty an hour, then refused for what is left of it.
  const from = {'CF-Connecting-IP': '198.51.100.7'};
  for (let i = 0; i < 30; i++) assert.equal((await s.call('GET', `/v1/seen/${100000 + i}/repo`, {headers: from})).status, 404);
  const no = await s.call('GET', '/v1/seen/100031/repo', {headers: from});
  assert.equal(no.status, 429);
  const wait = Number(no.headers.get('Retry-After'));
  assert.ok(wait > 3500 && wait <= 3600, String(wait));
  assert.equal(no.json.retryAfter, wait);
  // Another address is counted apart; a name, not a code, is not counted.
  assert.equal((await s.call('GET', '/v1/seen/100031/repo', {headers: {'CF-Connecting-IP': '198.51.100.8'}})).status, 404);
  assert.equal((await s.call('GET', '/v1/seen/ren/repo', {headers: from})).status, 404);

  // The helper every per-address count goes through: many at once are counted one by one.
  const db = await freshDb();
  const tries = await Promise.allSettled(Array.from({length: 8}, () => throttled(db, 'test:burst', 5, 60_000, {error: 'Too many tries from here; try again later'})));
  assert.deepEqual([tries.filter((x) => x.status === 'fulfilled').length, tries.filter((x) => x.status === 'rejected').length], [5, 3]);
});

test('Better Auth\'s own refusals for asking too often are said the same way, and its tighter limits hold on devices and passkeys (RFC 8628 §5.1-5.2)', async () => {
  const db = await freshDb();
  const auth = createAuth({db, secret: SECRET, baseURL: BASE, appOrigin: APP, dev: true});
  const app = createApp({db, auth, bucket: null, origins: [APP], appOrigin: APP, providers: ['dev'], baseURL: BASE, secret: SECRET});
  const ask = () => app.request(`${BASE}/api/auth/device/code`, {method: 'POST', headers: {'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9'},
    body: JSON.stringify({client_id: 'l3'})});
  const max = AUTH_LIMITS['/device/code'].max;
  for (let i = 0; i < max; i++) assert.equal((await ask()).status, 200);
  const r = await ask();
  assert.equal(r.status, 429);
  const wait = r.headers.get('Retry-After');
  assert.ok(wait && Number(wait) > 0 && Number(wait) <= 60, String(wait));
  assert.deepEqual(await r.json(), {error: 'Too many requests; try again later', retryAfter: Number(wait)});
  for (const p of ['/passkey/verify-authentication', '/device/approve', '/device/token']) assert.ok(AUTH_LIMITS[p].max <= 40, p);
});

test('each purpose has a key of its own, derived from the one secret with HKDF; none is the secret (audit U1, A10; ASVS 6.4.1-6.4.2)', async () => {
  const keys = (['better-auth', 'domain-proof', 'invite', 'off-code'] as const).map((p) => keyFor(SECRET, p));
  assert.equal(new Set(keys).size, 4);
  for (const k of keys) { assert.match(k, /^[0-9a-f]{64}$/); assert.notEqual(k, SECRET); }
  assert.equal(keyFor(SECRET, 'invite'), keyFor(SECRET, 'invite'));
  assert.notEqual(keyFor(SECRET, 'invite'), keyFor(SECRET, 'invite', 2));
  // HKDF-SHA256 itself, as RFC 5869 A.1 gives it (node's, not one of ours).
  const okm = Buffer.from(hkdfSync('sha256', Buffer.from('0b'.repeat(22), 'hex'), Buffer.from('000102030405060708090a0b0c', 'hex'),
    Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42)).toString('hex');
  assert.equal(okm, '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  assert.ok(same('abc', 'abc') && !same('abc', 'abd') && !same('abc', 'abcd'));

  const s = await service();
  const ren = await s.start('Ren');
  await named(s, [ren, 'ren']);
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip', board: 'plan'}});
  const bid = (made.json.boards as {id: string}[])[0].id;
  await s.call('PATCH', `/v1/boards/${bid}`, {token: ren, body: {guests: true}});
  const inv = await s.call('POST', `/v1/boards/${bid}/invites`, {token: ren});
  const [row] = await s.db.select().from(schema.invite).where(eq(schema.invite.boardId, bid));
  // What is kept of an invitation is an HMAC under the invite key: not a digest of the secret and the code, nor under the secret itself.
  assert.equal(row.digest, await hmacHex(keyFor(SECRET, 'invite'), `invite\n${inv.json.invite as string}`));
  assert.notEqual(row.digest, await hmacHex(SECRET, `invite\n${inv.json.invite as string}`));
  // The off-code likewise, under its own key.
  const {user, session} = (await s.call('GET', '/api/auth/get-session', {token: ren})).json as unknown as {user: {id: string}; session: {id: string}};
  await s.db.insert(schema.guard).values({userId: user.id, proofSession: session.id, proofAt: new Date()});
  assert.equal((await s.call('POST', '/v1/off-code', {token: ren, body: {code: 'ab12c'}})).status, 200);
  const [g] = await s.db.select().from(schema.guard).where(eq(schema.guard.userId, user.id));
  assert.equal(g.offDigest, await hmacHex(keyFor(SECRET, 'off-code'), `off-code\n${user.id}\nAB12C`));
});

test('over HTTPS every sign-in cookie is a __Host- one: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain (ASVS 3.4.1-3.4.5)', async () => {
  const db = await freshDb();
  const base = 'https://remote.example';
  const auth = createAuth({db, secret: SECRET, baseURL: base, appOrigin: 'https://app.example', dev: true, rateLimit: false});
  const r = await auth.handler(new Request(`${base}/api/auth/sign-in/social`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://app.example'},
    body: JSON.stringify({provider: 'dev', callbackURL: 'https://app.example/'})}));
  assert.equal(r.status, 200, await r.clone().text());
  const set = r.headers.getSetCookie();
  assert.ok(set.length > 0);
  for (const c of set) {
    assert.match(c, /^__Host-length3\./, c);
    assert.match(c, /;\s*Secure/i, c);
    assert.match(c, /;\s*HttpOnly/i, c);
    assert.match(c, /;\s*SameSite=Lax/i, c);
    assert.match(c, /;\s*Path=\/(;|$)/i, c);
    assert.doesNotMatch(c, /;\s*Domain=/i, c);
  }
});

test('/.well-known/security.txt says where to report, until a date less than a year and more than a month away (RFC 9116)', async () => {
  const s = await service();
  const r = await s.call('GET', '/.well-known/security.txt');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type') ?? '', /^text\/plain/);
  const fields = Object.fromEntries(r.text.trim().split('\n').map((l) => l.split(/: (.*)/s).slice(0, 2)));
  assert.equal(fields.Contact, SECURITY_TXT.contact);
  assert.equal(fields.Canonical, `${BASE}/.well-known/security.txt`);
  const until = Date.parse(fields.Expires);
  // Renewed by hand (about.ts SECURITY_TXT): this fails a month before it would be stale.
  assert.ok(until > Date.now() + 30 * 86_400_000, `security.txt Expires ${fields.Expires}: renew it`);
  assert.ok(until <= Date.now() + 366 * 86_400_000, 'RFC 9116 §2.5.5: at most a year ahead');
});

test('the role the Worker connects as reads and writes rows, and can make, change or drop nothing (ASVS 1.4.5, 14.1.x; audit D10)', async () => {
  const pg = new PGlite();
  try {
    await migrate(drizzle(pg, {schema}), {migrationsFolder: MIGRATIONS});
    // As deploy.ts makes it (worker()): a login role in remote_app and nothing more.
    await pg.exec(`CREATE ROLE remote_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD 'x'; GRANT remote_app TO remote_worker;`);
    await pg.exec('SET ROLE remote_worker');
    assert.deepEqual((await pg.query<{n: number}>('select count(*)::int as n from "user"')).rows, [{n: 0}]);
    const refused = async (q: string) => {
      await pg.exec('SAVEPOINT p');
      await assert.rejects(pg.exec(q), /permission denied|must be owner|must be superuser|must have|not allowed/i, q);
      await pg.exec('ROLLBACK TO SAVEPOINT p');
    };
    await pg.exec('BEGIN');
    for (const q of [
      'create table evil (x int)',
      'drop table "user"',
      'alter table "user" add column evil int',
      'truncate "session"',
      'create function evil() returns int language sql as $$select 1$$',
      'create index evil on "user" (name)',
      'create schema evil',
      'create role evil',
      'grant pg_read_server_files to remote_worker',
      'alter role remote_worker superuser',
      'drop extension plpgsql',
      'drop table drizzle.__drizzle_migrations',
    ]) await refused(q);
    await pg.exec('ROLLBACK');
  } finally {
    await pg.close();
  }
});

test('sign-in is the authorization code flow with state and PKCE, back only to the app, and devices are only the app and l3 (RFC 9700 §2.1, §4.1, §4.7; RFC 8628 §3.2, §5)', async () => {
  const s = await service();
  // A sign-in that would end on another site is refused before any provider is asked (no open redirect).
  const evil = await s.call('POST', '/api/auth/sign-in/social', {body: {provider: 'dev', callbackURL: `${EVIL}/`}});
  assert.equal(evil.status, 403);
  const asked = await s.call('POST', '/api/auth/sign-in/social', {body: {provider: 'dev', callbackURL: `${APP}/`}});
  const go = new URL(asked.json.url as string);
  assert.equal(go.searchParams.get('response_type'), 'code');
  assert.equal(go.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((go.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.ok((go.searchParams.get('state') ?? '').length >= 32);
  // The redirect URI is the Remote's own, one fixed path a provider (as registered with it) matches exactly.
  assert.equal(go.searchParams.get('redirect_uri'), `${BASE}/api/auth/callback/dev`);
  // A callback whose state this browser was not given makes no session.
  const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const forged = await s.app.request(`${BASE}/api/auth/callback/dev?code=x&state=forged`, {headers: {Cookie: cookies}});
  assert.equal(forged.headers.get('set-auth-token'), null);
  assert.ok(forged.status >= 300, String(forged.status));
  assert.doesNotMatch(forged.headers.get('Location') ?? '', /signed-in/);

  // Only the app and l3 ask for a device code; the code is 8 letters and digits, for ten minutes,
  // polled no faster than every 2 s; approving it takes the app's own page.
  assert.equal((await s.call('POST', '/api/auth/device/code', {body: {client_id: 'evil'}})).status, 400);
  const code = (await s.call('POST', '/api/auth/device/code', {body: {client_id: 'l3'}})).json as unknown as {user_code: string; expires_in: number; interval: number; verification_uri: string};
  assert.match(code.user_code, /^[A-Z0-9]{8}$/);
  assert.deepEqual([code.expires_in, code.interval, code.verification_uri], [600, 2, `${APP}/?device`]);
  const t = await s.start('Ren');
  const approve = (headers: Record<string, string>) => s.app.request(`${BASE}/api/auth/device/approve`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Cookie: s.sessions.get(t)!, ...headers}, body: JSON.stringify({userCode: code.user_code})});
  assert.equal((await approve({Origin: EVIL})).status, 403);
  assert.equal((await approve({})).status, 403);
});

test('a session is listed, ended from another, and ends at sign-out; a sign-in is a new one (ASVS 3.2.1, 3.3.1, 3.3.4)', async () => {
  const s = await service();
  const one = await s.start('Ren'), two = await s.start('Ren');
  assert.notEqual(one, two);
  const listed = (await s.call('GET', '/api/auth/list-sessions', {token: one})).json as unknown as {token: string}[];
  assert.equal(listed.length, 2);
  // Ended from the other device, as Remote → Devices does: by the session's own token, as listed.
  const theirs = ((await s.call('GET', '/api/auth/get-session', {token: two})).json as unknown as {session: {token: string}}).session.token;
  assert.ok(listed.some((x) => x.token === theirs));
  assert.equal((await s.call('POST', '/api/auth/revoke-session', {token: one, body: {token: theirs}})).status, 200);
  assert.equal((await s.call('GET', '/v1/repos', {token: two})).status, 401);
  assert.equal((await s.call('POST', '/api/auth/sign-out', {token: one, body: {}})).status, 200);
  assert.equal((await s.call('GET', '/v1/repos', {token: one})).status, 401);
});
