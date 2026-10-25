// For tests: the Remote in this process (service/app.ts on PGlite), signed
// in to the way a browser is, with DNS as a stand-in. Not part of
// the service; only the tests import it.
//
// A database is migrated once on this machine and kept as Postgres left it
// shut down; each one after that starts from its files (a fresh Postgres and
// its migrations take seconds; one from those files, under half a second),
// and is asked as testing-pglite.ts asks it. One lent by `service()` or
// `freshDb()` is the test's, and one lent by `fileService()`, `fileDb()` or
// `sharedService()` the file's: when the test or the file is done it is
// emptied, back to what its migrations left (their rows, where each sequence
// stood, a session with nothing set), and lent to whatever asks next in the
// process. Emptying takes a few milliseconds, a new one a hundred times that.
// npm test runs the files a process a core, one after another in each
// (testing-together.ts), so a process makes a database or a few and lends
// them from file to file.
// `sharedService()` is one Remote for a whole file, its tests kept apart by
// each signing in as people of their own (`person()`).
//
// Two things the environment can change, read as a Remote is made:
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
import {DataDirFS, packed, QuickPGlite, unpacked, type DataDir} from './testing-pglite.ts';
import {open as openPool, scoped, served} from './worker.ts';

/**
 * Whether a Remote made now keeps no files (contract.nobucket.test.ts says so while its file loads): read
 * each time, as the files of a process come one after another, and only one of them says it.
 */
const withoutBucket = () => process.env.REMOTE_TEST_BUCKET === 'none';
/** A real database for sharedService() (verify.ts); '' for PGlite. Never printed. */
const AGAINST = process.env.REMOTE_TEST_DATABASE_URL ?? '';

export const BASE = 'http://remote.test';
export const APP = 'http://app.test';
export const SECRET = 'test-secret-'.repeat(4);
export const enc = new TextEncoder();

/** fetch as the process had it, before any Remote here was laid over it. */
const realFetch = globalThis.fetch;

/**
 * A database's files made once on this machine by `make`, as Postgres left them shut down, and kept in its
 * temporary directory as `name` (named by all it was made from), for the test processes after the first.
 */
async function keptAs(name: string, make: () => Promise<DataDir>): Promise<DataDir> {
  const kept = join(tmpdir(), name);
  if (existsSync(kept)) return unpacked(readFileSync(kept));
  const made = await make();
  // Written aside, then named: a process reading it never meets half of it.
  const aside = `${kept}.${process.pid}`;
  writeFileSync(aside, packed(made));
  renameSync(aside, kept);
  return made;
}
/** A database's files, as PGlite left them when the database it made over `from` (none: initdb's) was closed after `f`. */
async function closedAfter(from: DataDir | undefined, f: (pg: PGlite) => Promise<unknown>): Promise<DataDir> {
  const fs = new DataDirFS(from, {keep: true});
  const pg = new PGlite({fs});
  await pg.waitReady;
  await f(pg);
  await pg.close();
  return fs.left!;
}
const PGLITE = (JSON.parse(readFileSync(new URL('../node_modules/@electric-sql/pglite/package.json', import.meta.url), 'utf8')) as {version: string}).version;
/** A hash as a kept file is named by it. */
const short = (h: ReturnType<typeof createHash>) => h.digest('hex').slice(0, 16);

let initialized: Promise<DataDir> | null = null;
/** A Postgres as initdb leaves it: three seconds each time PGlite runs initdb. */
const initdb = () => (initialized ??= keptAs(`length3-pglite-${short(createHash('sha256').update(PGLITE))}-initdb.data`,
  () => closedAfter(undefined, async () => {})));

let template: Promise<DataDir> | null = null;
/**
 * The migrated database every test's starts as: made once on this machine, under what it was made from (the
 * migrations and PGlite's version), so the test processes after the first start one in a fraction of the 3 s a
 * new Postgres and its migrations take.
 */
const migrated = () => (template ??= (async () => {
  const hash = createHash('sha256').update(PGLITE);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) hash.update(f).update(readFileSync(join(MIGRATIONS, f)));
  return keptAs(`length3-pglite-${short(hash)}.data`, async () => closedAfter(await initdb(), (pg) => migrate(drizzle(pg, {schema}), {migrationsFolder: MIGRATIONS})));
})());
/**
 * How Postgres is started for a test: as PGlite starts it, with shared buffers of 16 MB, not 128 (a test's
 * database is a few MB; Postgres clears every buffer as it starts, a fifth of the time it took to start).
 */
const START = [...PGlite.defaultStartParams, '-c', 'shared_buffers=16MB'];

/**
 * How a database is made as its migrations left it again, in what Postgres is told after DISCARD:
 * `again`, every row deleted, the migrations' put back, each sequence where they left it, and then whether
 * any of its tables or indexes has grown to `GROWN` pages; `anew`, the same by truncating every table.
 */
type Fresh = {again: string; anew: string};
let fresh: Promise<Fresh> | null = null;
/**
 * How big a table or index of a database emptied by deleting may grow before it is truncated instead: under
 * ten pages, where Postgres plans for one it has never vacuumed as it does for a new one (ten pages, at least).
 */
const GROWN = 8;
/** Read off a database no test has used yet, once a process. */
const freshOf = (pg: PGlite) => (fresh ??= (async () => {
  const tables = (await pg.query<{t: string}>(`select quote_ident(tablename) as t from pg_tables where schemaname = 'public'`)).rows.map((r) => r.t);
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const put: string[] = [];
  for (const t of tables) {
    const [{j}] = (await pg.query<{j: string | null}>(`select json_agg(x)::text as j from ${t} x`)).rows;
    if (j) put.push(`insert into ${t} select * from json_populate_recordset(null::${t}, ${literal(j)});`);
  }
  for (const {s, v, c} of (await pg.query<{s: string; v: string; c: boolean}>(`select quote_ident(sequencename) as s,
    coalesce(last_value, start_value)::text as v, last_value is not null as c from pg_sequences where schemaname = 'public'`)).rows) {
    put.push(`select setval(${literal(s)}, ${v}, ${c});`);
  }
  const back = `${put.join(' ')} set session_replication_role = origin; set timezone to 'UTC';`;
  return {
    again: `set session_replication_role = replica; ${tables.map((t) => `delete from ${t};`).join(' ')} ${back}
      select exists (select from pg_class where relnamespace = 'public'::regnamespace and pg_relation_size(oid) >= ${GROWN} * 8192) as grown`,
    anew: `set session_replication_role = replica; truncate ${tables.join(', ')}; ${back}`,
  };
})());

/**
 * A database as its migrations left it again: no row a test wrote, no sequence moved on, nothing set on its
 * session. Its rows are deleted, in a few milliseconds where truncating every table took a hundred; and once
 * deleted rows have grown a table or an index past a few pages, its tables are truncated, so that every test
 * meets tables as small as a new database's, and Postgres plans for them as it would there.
 */
async function empty(pg: PGlite) {
  const f = await fresh!;
  // Refused inside a transaction, as `discard all` is.
  if (pg.isInTransaction()) throw new Error('A transaction was left open');
  const [{grown}] = (await pg.exec(`${DISCARD} ${f.again}`)).at(-1)!.rows as {grown: boolean}[];
  if (grown) await pg.exec(f.anew);
}
/**
 * `discard all`, step by step as Postgres documents it, but for letting go of the statements the database keeps
 * parsed (testing-pglite.ts) and their plans: no test sees them, and the next test asks most of them again.
 */
const DISCARD = 'close all; set session authorization default; reset all; unlisten *; select pg_advisory_unlock_all(); discard temp; discard sequences;';

/**
 * Lent to the test running now, lent to the file (fileService, fileDb, sharedService), and emptied and waiting
 * for whatever asks next. A test's go back when it ends; a file's when the file is done, which
 * testing-together.ts says between the files it runs, or with the process.
 */
const lent: PGlite[] = [], forFile: PGlite[] = [], idle: PGlite[] = [];
/** Emptied, and kept for the next; one that cannot be is closed. */
async function giveBack(pg: PGlite) {
  if (pg.closed) return;
  try { await empty(pg); idle.push(pg); } catch { await pg.close().catch(() => {}); }
}
afterEach(async () => { for (const pg of lent.splice(0)) await giveBack(pg); });

/** Whether testing-together.ts closes what the process holds itself, after its last file. */
let held = false;
/** Every Remote and database this process holds, closed: an open PGlite keeps its process up. */
async function closeAll() {
  const s = shared;
  shared = null;
  if (s) await (await s).close();
  await Promise.all([...lent.splice(0), ...forFile.splice(0), ...idle.splice(0)].map((pg) => pg.close()));
}
// Loaded first at the root of a process's tests (by its file, or by testing-together.ts before the files it runs).
after(async () => { if (!held) await closeAll(); });

/**
 * For testing-together.ts, which runs a process's files one after another: what a file took for itself goes
 * back when it says the file is done, and the rest is closed when it says the last is. Not on node:test's
 * root hooks, which run whenever its tests have all run, between two files too.
 */
export function fileByFile() {
  held = true;
  return {
    fileDone: async () => {
      const s = shared;
      shared = null;
      if (s) await (await s).close();
      for (const pg of forFile.splice(0)) await giveBack(pg);
    },
    lastDone: async () => { held = false; await closeAll(); },
  };
}

/** A database as its migrations leave it: one kept from before, or a new one. */
async function take(): Promise<PGlite> {
  const pg = idle.pop() ?? await database();
  await freshOf(pg);
  return pg;
}
/** One for the test running now. */
const lend = async () => { const pg = await take(); lent.push(pg); return pg; };
/** One for the file, whenever in it it is asked for. */
const lendForFile = async () => { const pg = await take(); forFile.push(pg); return pg; };

/** A PGlite migrated as every test's is, for a test that runs a Remote its own way (worker.test.ts). */
export async function database(): Promise<PGlite> {
  if (AGAINST) throw new Error('Only sharedService() runs against a real database');
  const pg = new QuickPGlite({fs: new DataDirFS(await migrated()), startParams: START});
  await pg.waitReady;
  // In UTC, as Neon is. PGlite takes this machine's zone, and the template keeps the zone of the machine that made it:
  // made in Tokyo, now() as a moment without a zone was nine hours ahead of what Better Auth reads its columns as (UTC).
  await pg.exec(`set timezone to 'UTC'`);
  return pg;
}

/** A Postgres as initdb leaves it, nothing migrated, of its own (stages.test.ts migrates one step by step). */
export async function initdbDatabase(): Promise<PGlite> {
  const pg = new QuickPGlite({fs: new DataDirFS(await initdb()), startParams: START});
  await pg.waitReady;
  return pg;
}

/** A migrated database of its own, for as long as the test lasts. */
export async function freshDb() {
  return drizzle(await lend(), {schema});
}

/** A migrated database for a whole file, for as long as the file lasts. */
export async function fileDb() {
  return drizzle(await lendForFile(), {schema});
}

export type Service = Awaited<ReturnType<typeof make>>;
export interface Options {
  quota?: number; enter?: Enter; plan?: PlanConfig; billing?: Billing; now?: () => number;
  /** What R2 and the database may be asked for (budget.ts), the edge's cache and the rate (app.ts Deps). */
  limits?: Limits; edge?: Edge; limiter?: {limit(o: {key: string}): Promise<{success: boolean}>}; sessionKept?: number;
}

/** A Remote of its own for one test: `records` is DNS, a name → its TXT records. */
export async function service(records: Record<string, string[]> = {}, o: Options = {}): Promise<Service> {
  return make(kept(await lend()), records, o);
}

let shared: Promise<Service> | null = null;
/** One Remote for every test of a file that asks for it, closed when the file is done; the next file has its own. */
export function sharedService(): Promise<Service> {
  return shared ??= AGAINST ? onReal(AGAINST).then((store) => make(store, {}, {})) : lendForFile().then((pg) => make(kept(pg), {}, {}));
}

/** A Remote of its own for a whole file, made as `o` says, for as long as the file lasts. */
export async function fileService(records: Record<string, string[]> = {}, o: Options = {}): Promise<Service> {
  return make(kept(await lendForFile()), records, o);
}

type Database = ReturnType<typeof drizzle<typeof schema>>;
/** Where a Remote of the tests keeps its rows: the database the tests read (`db`), the one the app is given, how a request is served. */
interface Store { db: Database; app: Database; serve: (f: () => Promise<Response>) => Promise<Response>; close(): Promise<void> }

/** On a PGlite the pool lent: closing the Remote leaves it to the pool, which empties it and lends it again. */
const kept = (pg: PGlite): Store => {
  const db = drizzle(pg, {schema});
  return {db, app: db, serve: (f) => f(), close: async () => {}};
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
  /** What the app keeps files in: none when this Remote is made without a bucket. */
  const files = withoutBucket() ? null : bucket;
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
