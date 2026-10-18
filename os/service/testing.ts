// For tests: the Remote in this process (service/app.ts on PGlite), signed
// in to the way a browser is, with DNS as a stand-in. Not part of
// the service; only the tests import it.
//
// A database is made once per process, migrated, and each one after that
// starts from a copy of it (a fresh Postgres and its migrations take ten
// seconds and more; a copy, one or two). Each made by `service()` or
// `freshDb()` is closed when the test that made it ends; `sharedService()`
// is one for a whole file, closed when the file is done, its tests kept
// apart by each signing in as people of their own (`person()`).
//
// Two things the environment can change, for a whole process:
//   REMOTE_TEST_BUCKET=none          the Remote has no bucket (bucket.ts): files
//                                    are not kept, and `upload` records a blob as
//                                    kept already (its row), so the rest is tested
//   REMOTE_TEST_DATABASE_URL=…       sharedService() runs on that Postgres, through
//                                    the Worker's own driver, a connection a
//                                    request (worker.ts served); verify.ts sets it

import assert from 'node:assert/strict';
import {after, afterEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp, sha256} from './app.ts';
import {createAuth} from './auth.ts';
import {memoryBucket} from './bucket.ts';
import {enterEmail, type Enter} from './enter.ts';
import {MIGRATIONS, reach} from './neon.ts';
import * as schema from './schema.ts';
import {open as openPool, scoped, served} from './worker.ts';

/** Whether this process's Remotes keep files (contract.nobucket.test.ts says not). */
export const WITHOUT_BUCKET = process.env.REMOTE_TEST_BUCKET === 'none';
/** A real database for sharedService() (verify.ts); '' for PGlite. Never printed. */
const AGAINST = process.env.REMOTE_TEST_DATABASE_URL ?? '';

export const BASE = 'http://remote.test';
export const APP = 'http://app.test';
export const SECRET = 'test-secret-'.repeat(4);
export const enc = new TextEncoder();

let template: Promise<Blob> | null = null;
/** The migrated database every test's starts as. */
const migrated = () => (template ??= (async () => {
  const pg = new PGlite();
  await migrate(drizzle(pg, {schema}), {migrationsFolder: MIGRATIONS});
  const dump = await pg.dumpDataDir('none');
  await pg.close();
  return dump;
})());

/** Closed when the test that opened them ends. */
const open: PGlite[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((pg) => pg.close())); });

/** A PGlite migrated as every test's is, for a test that runs a Remote its own way (worker.test.ts). */
export async function database(): Promise<PGlite> {
  if (AGAINST) throw new Error('Only sharedService() runs against a real database');
  const pg = new PGlite({loadDataDir: await migrated()});
  await pg.waitReady;
  return pg;
}

/** A migrated database of its own, closed when the test ends. */
export async function freshDb() {
  const pg = await database();
  open.push(pg);
  return drizzle(pg, {schema});
}

/** A migrated database for a whole file, closed when the file is done. */
export async function fileDb() {
  const pg = await database();
  after(() => pg.close());
  return drizzle(pg, {schema});
}

export type Service = Awaited<ReturnType<typeof make>>;
export interface Options { quota?: number; enter?: Enter }

/** A Remote of its own for one test: `records` is DNS, a name → its TXT records. */
export async function service(records: Record<string, string[]> = {}, o: Options = {}): Promise<Service> {
  const pg = await database();
  open.push(pg);
  return make(onPglite(pg), records, o);
}

let shared: Promise<Service> | null = null;
/** One Remote for every test of a file that asks for it, closed when the file is done. */
export function sharedService(): Promise<Service> {
  if (!shared) {
    shared = (AGAINST ? onReal(AGAINST) : database().then(onPglite)).then((store) => make(store, {}, {}));
    after(async () => { await (await shared!).close(); });
  }
  return shared;
}

type Database = ReturnType<typeof drizzle<typeof schema>>;
/** Where a Remote of the tests keeps its rows: the database the tests read (`db`), the one the app is given, how a request is served. */
interface Store { db: Database; app: Database; serve: (f: () => Promise<Response>) => Promise<Response>; close(): Promise<void> }

const onPglite = (pg: PGlite): Store => {
  const db = drizzle(pg, {schema});
  return {db, app: db, serve: (f) => f(), close: () => pg.close()};
};

/**
 * A real Postgres as the Worker reaches one: its driver (a bridge for one on this machine), the app made
 * once over a database that is, while a request is served, that request's own connection, let go after.
 * The tests' own reads and writes go over a pool of their own. Both drivers' databases answer the same
 * calls the tests make (select, insert, execute's rows), so it is typed as the one the tests know.
 */
async function onReal(url: string): Promise<Store> {
  const driver = await reach(url);
  const idle = openPool(url);
  const {db, at} = scoped(idle.db);
  const ending = new Set<Promise<unknown>>();
  return {
    db: idle.db as unknown as Database, app: db as unknown as Database,
    serve: (f) => served(url, at, f, (p) => { ending.add(p); void p.finally(() => ending.delete(p)); }),
    close: async () => { await Promise.allSettled([...ending]); await idle.pool.end(); await driver.close(); },
  };
}

async function make(store: Store, records: Record<string, string[]>, o: Options) {
  const db = store.db;
  const auth = createAuth({db: store.app, secret: SECRET, baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true, only: o.enter && enterEmail(o.enter.as)});
  const bucket = memoryBucket();
  /** What the app keeps files in: none when this process runs without a bucket. */
  const files = WITHOUT_BUCKET ? null : bucket;
  // DNS as a map of name → TXT records.
  const dns = new Map(Object.entries(records));
  const app = createApp({db: store.app, auth, bucket: files, origins: [APP], appOrigin: APP, providers: ['dev'], domain: 'length3.test', baseURL: BASE,
    secret: SECRET, txt: async (name) => dns.get(name) ?? [], recheck: 0, quota: o.quota,
    enter: o.enter});
  /** A request to the Remote, served as its database is (each its own connection, on a real one). */
  const request = (url: string, init?: RequestInit) => store.serve(async () => app.request(url, init));
  // The service asks its own stand-in provider for tokens over the network: here, itself.
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    (String(url instanceof Request ? url.url : url).startsWith(BASE) ? request(url as string, init) : real(url, init))) as typeof fetch;
  const call = async (method: string, path: string, opts: {token?: string; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>} = {}) => {
    const r = await request(BASE + path, {
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
  /** Signing in as a browser does: the provider's page, then back through the callback. The same name is the same account. */
  const start = async (name = 'Ren') => {
    const asked = await request(`${BASE}/api/auth/sign-in/social`, {method: 'POST', headers: {Origin: APP, 'Content-Type': 'application/json'},
      body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/?signed-in`})});
    assert.equal(asked.status, 200, await asked.clone().text());
    const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const go = new URL(((await asked.json()) as {url: string}).url);
    const approve = new URL(`${BASE}/dev-oauth/approve`);
    for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
    approve.searchParams.set('name', name);
    const back = (await request(approve.toString())).headers.get('Location')!;
    const done = await request(back, {headers: {Cookie: cookies}});
    assert.equal(done.status, 302, await done.clone().text());
    assert.equal(done.headers.get('Location'), `${APP}/?signed-in`);
    const token = done.headers.get('set-auth-token');
    assert.ok(token);
    sessions.set(token!, done.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
    return token!;
  };
  let people = 0;
  /** Someone no other test of this Remote is: a new account, signed in. */
  const person = (word = 'Person') => start(`${word} ${process.pid}-${++people}`);
  const publish = (name: string, value: string) => dns.set(name, [...(dns.get(name) ?? []), value]);
  const unpublish = (name: string) => dns.delete(name);
  return {db, app, call, start, person, bucket, files, publish, unpublish, sessions, close: () => store.close()};
}

// ---- what many tests do ----

/** The account a session is. */
export const idOf = async (s: Service, t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {user: {id: string}}).user.id;
/** The id of the session a token is. */
export const sessionOf = async (s: Service, t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {session: {id: string}}).session.id;
/**
 * Send a file as a client does. With no bucket the Remote refuses it (its status says so), and the
 * file is recorded as kept already, as one sent while there was a bucket is: what a tree may name.
 */
export const upload = async (s: Service, t: string, bytes: Uint8Array) => {
  const sha = await sha256(bytes);
  const status = (await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status;
  if (!s.files) await s.db.insert(schema.blob).values({userId: await idOf(s, t), sha256: sha, bytes: bytes.length}).onConflictDoNothing();
  return {sha, status};
};
export const named = async (s: Service, ...people: [string, string][]) => { for (const [t, n] of people) await s.call('POST', '/v1/inbox/addresses', {token: t, body: {name: n}}); };
export const accept = (s: Service, t: string, address: string, state = 'accepted') => s.call('POST', '/v1/inbox/contacts', {token: t, body: {address, state}});
export const count = async (s: Service, query: ReturnType<typeof sql>) => ((await s.db.execute(query)).rows as {n: number}[])[0].n;
