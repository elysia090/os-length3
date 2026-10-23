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
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, afterEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp, sha256} from './app.ts';
import {createAuth} from './auth.ts';
import {memoryBucket} from './bucket.ts';
import type {Limits} from './budget.ts';
import type {Edge} from './files.ts';
import {enterEmail, type Enter} from './enter.ts';
import {MIGRATIONS, reach} from './neon.ts';
import type {Billing, PlanConfig} from './plan.ts';
import * as schema from './schema.ts';
import {sign, type StripeApi} from './stripe.ts';
import {open as openPool, scoped, served} from './worker.ts';

/** Whether this process's Remotes keep files (contract.nobucket.test.ts says not). */
export const WITHOUT_BUCKET = process.env.REMOTE_TEST_BUCKET === 'none';
/** A real database for sharedService() (verify.ts); '' for PGlite. Never printed. */
const AGAINST = process.env.REMOTE_TEST_DATABASE_URL ?? '';

export const BASE = 'http://remote.test';
export const APP = 'http://app.test';
export const SECRET = 'test-secret-'.repeat(4);
export const enc = new TextEncoder();

/** fetch as the process had it, before any Remote here was laid over it. */
const realFetch = globalThis.fetch;

let template: Promise<Blob> | null = null;
/**
 * The migrated database every test's starts as: made once on this machine, and kept in its temporary directory
 * under what it was made from (the migrations and PGlite's version), so the test files after the first, each a
 * process of its own, load it in a fraction of the 3 s a new Postgres and its migrations take.
 */
const migrated = () => (template ??= (async () => {
  const pglite = (JSON.parse(readFileSync(new URL('../node_modules/@electric-sql/pglite/package.json', import.meta.url), 'utf8')) as {version: string}).version;
  const hash = createHash('sha256').update(pglite);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) hash.update(f).update(readFileSync(join(MIGRATIONS, f)));
  const kept = join(tmpdir(), `length3-pglite-${hash.digest('hex').slice(0, 16)}.tar`);
  if (existsSync(kept)) return new Blob([readFileSync(kept)]);
  const pg = new PGlite();
  await migrate(drizzle(pg, {schema}), {migrationsFolder: MIGRATIONS});
  const dump = await pg.dumpDataDir('none');
  await pg.close();
  // Written aside, then named: a process reading it never meets half of it.
  const aside = `${kept}.${process.pid}`;
  writeFileSync(aside, new Uint8Array(await dump.arrayBuffer()));
  renameSync(aside, kept);
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
  // In UTC, as Neon is. PGlite takes this machine's zone, and the template keeps the zone of the machine that made it:
  // made in Tokyo, now() as a moment without a zone was nine hours ahead of what Better Auth reads its columns as (UTC).
  await pg.exec(`set timezone to 'UTC'`);
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
export interface Options {
  quota?: number; enter?: Enter; plan?: PlanConfig; billing?: Billing; now?: () => number;
  /** What R2 and the database may be asked for (budget.ts), the edge's cache and the rate (app.ts Deps). */
  limits?: Limits; edge?: Edge; limiter?: {limit(o: {key: string}): Promise<{success: boolean}>}; sessionKept?: number;
}

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

/** A Remote of its own for a whole file, made as `o` says, closed when the file is done. */
export async function fileService(records: Record<string, string[]> = {}, o: Options = {}): Promise<Service> {
  const made = await make(onPglite(await database()), records, o);
  after(() => made.close());
  return made;
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
    enter: o.enter, plan: o.plan, billing: o.billing, now: o.now, limits: o.limits, edge: o.edge, limiter: o.limiter, sessionKept: o.sessionKept});
  /** A request to the Remote, served as its database is (each its own connection, on a real one). */
  const request = (url: string, init?: RequestInit) => store.serve(async () => app.request(url, init));
  // The service asks its own stand-in provider for tokens over the network: here, itself. Laid over the real
  // fetch, never over the last Remote's (which kept every Remote of a file alive, 44 deep).
  const real = realFetch;
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

// ---- Stripe, never reached: a stand-in that says what it was asked, and events signed as Stripe signs them ----

export const WEBHOOK_SECRET = 'whsec_test_' + 'x'.repeat(24);

/** Each tier's price as the stand-ins have them: its id, and what it costs (US cents, a month). */
export const PRICES = {go: 'price_test_go', pro: 'price_test_pro', max: 'price_test_max'} as const;
const COSTS: Record<string, number> = {price_test_go: 700, price_test_pro: 1400, price_test_max: 1900};

/** A StripeApi that answers at once and keeps what it was asked; `prices`, the tiers it sells. */
export function fakeStripe(prices: Billing['prices'] = PRICES) {
  const asked: {call: string; [k: string]: unknown}[] = [];
  let n = 0;
  const api: StripeApi = {
    async customer(p) { asked.push({call: 'customer', ...p}); return `cus_test${p.user.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`; },
    async checkout(p) { asked.push({call: 'checkout', ...p}); return `https://checkout.stripe.test/c/${++n}`; },
    async portal(p) { asked.push({call: 'portal', ...p}); return `https://billing.stripe.test/p/${++n}`; },
    async price(id) {
      asked.push({call: 'price', id});
      if (!(id in COSTS)) throw new Error('Stripe 404');
      return {amount: COSTS[id], currency: 'usd', interval: 'month', every: 1};
    },
  };
  return {api, asked, billing: {stripe: api, webhookSecret: WEBHOOK_SECRET, prices} as Billing};
}

let events = 0;
/** An event as Stripe sends it: its id, type, when it was made (seconds), and the object it is about. */
export const stripeEvent = (type: string, object: Record<string, unknown>, o: {id?: string; created?: number} = {}) =>
  JSON.stringify({id: o.id ?? `evt_test${process.pid}x${++events}`, object: 'event', type, created: o.created ?? Math.floor(Date.now() / 1000), data: {object}});

/** Post `payload` to the webhook, signed with `secret` at `t` (seconds), as Stripe does. */
export async function sendEvent(s: Service, payload: string, o: {secret?: string; t?: number; signature?: string} = {}) {
  const signature = o.signature ?? await sign(payload, o.secret ?? WEBHOOK_SECRET, o.t);
  return s.call('POST', '/v1/stripe/webhook', {bytes: enc.encode(payload), headers: {'Stripe-Signature': signature, 'Content-Type': 'application/json'}});
}

/**
 * A subscription object for `user` (as Checkout makes one: the account in its metadata), to the tier `tier`
 * as its one item's price says it (Go unless said).
 */
export const subscription = (user: string, o: Record<string, unknown> = {}, tier: keyof typeof PRICES = 'go') => {
  const id = user.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  return {id: `sub_test${id}`, object: 'subscription',
    customer: `cus_test${id}`, status: 'active', cancel_at_period_end: false, cancel_at: null,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400, metadata: {user},
    items: {object: 'list', data: [{id: `si_test${id}`, object: 'subscription_item', price: {id: PRICES[tier], object: 'price'}}]}, ...o};
};
