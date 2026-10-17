// For tests: the Remote in this process (service/app.ts on PGlite), signed
// in to the way a browser is, with DNS and mail as stand-ins. Not part of
// the service; only the tests import it.
//
// A database is made once per process, migrated, and each one after that
// starts from a copy of it (a fresh Postgres and its migrations take ten
// seconds and more; a copy, one or two). Each made by `service()` or
// `freshDb()` is closed when the test that made it ends; `sharedService()`
// is one for a whole file, closed when the file is done, its tests kept
// apart by each signing in as people of their own (`person()`).

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
import * as schema from './schema.ts';

export const BASE = 'http://remote.test';
export const APP = 'http://app.test';
export const SECRET = 'test-secret-'.repeat(4);
export const enc = new TextEncoder();

let template: Promise<Blob> | null = null;
/** The migrated database every test's starts as. */
const migrated = () => (template ??= (async () => {
  const pg = new PGlite();
  await migrate(drizzle(pg, {schema}), {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
  const dump = await pg.dumpDataDir('none');
  await pg.close();
  return dump;
})());

/** Closed when the test that opened them ends. */
const open: PGlite[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((pg) => pg.close())); });

async function database(): Promise<PGlite> {
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
  return make(pg, records, o);
}

let shared: Promise<Service> | null = null;
/** One Remote for every test of a file that asks for it, closed when the file is done. */
export function sharedService(): Promise<Service> {
  if (!shared) {
    shared = database().then((pg) => make(pg, {}, {}));
    after(async () => { await (await shared!).close(); });
  }
  return shared;
}

async function make(pg: PGlite, records: Record<string, string[]>, o: Options) {
  const db = drizzle(pg, {schema});
  const auth = createAuth({db, secret: SECRET, baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true, only: o.enter && enterEmail(o.enter.as)});
  const bucket = memoryBucket();
  // DNS as a map of name → TXT records.
  const dns = new Map(Object.entries(records));
  const mails: {to: string; subject: string; text: string}[] = [];
  const app = createApp({db, auth, bucket, origins: [APP], appOrigin: APP, providers: ['dev'], domain: 'length3.test', baseURL: BASE,
    secret: SECRET, txt: async (name) => dns.get(name) ?? [], recheck: 0, mail: async (to, subject, text) => { mails.push({to, subject, text}); }, quota: o.quota,
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
  /** Signing in as a browser does: the provider's page, then back through the callback. The same name is the same account. */
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
  let people = 0;
  /** Someone no other test of this Remote is: a new account, signed in. */
  const person = (word = 'Person') => start(`${word} ${process.pid}-${++people}`);
  const publish = (name: string, value: string) => dns.set(name, [...(dns.get(name) ?? []), value]);
  const unpublish = (name: string) => dns.delete(name);
  return {db, app, call, start, person, bucket, publish, unpublish, mails, sessions, close: () => pg.close()};
}

// ---- what many tests do ----

/** The account a session is. */
export const idOf = async (s: Service, t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {user: {id: string}}).user.id;
/** The id of the session a token is. */
export const sessionOf = async (s: Service, t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {session: {id: string}}).session.id;
export const upload = async (s: Service, t: string, bytes: Uint8Array) => {
  const sha = await sha256(bytes);
  return {sha, status: (await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status};
};
export const named = async (s: Service, ...people: [string, string][]) => { for (const [t, n] of people) await s.call('POST', '/v1/inbox/addresses', {token: t, body: {name: n}}); };
export const accept = (s: Service, t: string, address: string, state = 'accepted') => s.call('POST', '/v1/inbox/contacts', {token: t, body: {address, state}});
export const count = async (s: Service, query: ReturnType<typeof sql>) => ((await s.db.execute(query)).rows as {n: number}[])[0].n;
