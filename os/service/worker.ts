// The Remote on Cloudflare: the service over Neon (Postgres) and R2. The
// WebSocket pool, not the HTTP driver, because Better Auth and the service
// use transactions. Without its R2 binding (BLOBS) it is the Remote all the
// same, holding no files: each route that would move bytes says so (bucket.ts).
//
// The app and its sign-in are made once an isolate, so what they keep (the
// DNS a domain's record was read from, the routes) lives as long as it does.
// A connection cannot outlive the request that opened it, so each request,
// and each day's sweep, opens its own, and the database the app was made
// with is, while that request runs, that request's.
import {AsyncLocalStorage} from 'node:async_hooks';
import {Pool} from '@neondatabase/serverless';
import {drizzle} from 'drizzle-orm/neon-serverless';
import {createApp} from './app.ts';
import {createAuth, providers} from './auth.ts';
import {enterEmail} from './enter.ts';
import {r2Bucket, type R2Bucket} from './bucket.ts';
import {limitsOf} from './budget.ts';
import {MarkObject, objectMarks, type MarkNamespace} from './mark.ts';
import type {Edge} from './files.ts';
import {planConfig, type Billing} from './plan.ts';
import {stripeRest} from './stripe.ts';
import * as schema from './schema.ts';
import {sweep} from './sweep.ts';

/** The mark's Durable Object (wrangler.toml MARK): a Worker's main module names each class it serves. */
export {MarkObject};

export interface Env {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BASE_URL: string;
  APP_ORIGIN: string;
  /** The domain Inbox addresses are on (name@DOMAIN). */
  DOMAIN?: string;
  /** Other pages that may call, space separated (the desktop app's webview). */
  APP_ORIGINS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_SECRET?: string;
  /** For research (enter.ts): the one account's name; with it, nobody signs up and the link is the way in. */
  ENTER_AS?: string;
  /** The key its link carries (a secret, long and random). */
  ENTER_KEY?: string;
  /** What one account may keep, in MB (2048 unless said). */
  QUOTA_MB?: string;
  /** The free plan (plan.ts): repos and MB a free account keeps on the Remote (3 and 100 unless said), days a failed payment stays paid (14). */
  FREE_REPOS?: string;
  FREE_MB?: string;
  GRACE_DAYS?: string;
  /** Stripe (stripe.ts), secrets both: with either missing, or no price below, billing is off and paid features cannot be bought here yet. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Each tier's price (price_…), variables: a tier without one is not sold here (plan.ts TIERS). */
  STRIPE_PRICE_GO?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MAX?: string;
  /** File contents (R2). Not bound: the Remote holds no files, and says so. */
  BLOBS?: R2Bucket;
  /**
   * '1': the stand-in provider (devoauth.ts) is offered too, for the production-like selftest on this
   * machine (selftest/prod). Taken only where BASE_URL is this machine itself, never on Cloudflare.
   */
  DEV_SIGN_IN?: string;
  /** What R2 and the database may be asked for (budget.ts): R2_STORED_MB, R2_WRITES_MONTH, R2_READS_MONTH, UPLOAD_MB_DAY, PG_MB. */
  R2_STORED_MB?: string;
  R2_WRITES_MONTH?: string;
  R2_READS_MONTH?: string;
  UPLOAD_MB_DAY?: string;
  PG_MB?: string;
  /** The mark (mark.ts, wrangler.toml MARK): looks answered without the database while nothing was written. Not bound, every look asks it. */
  MARK?: MarkNamespace;
  /** How often one session or address may ask (wrangler.toml [[ratelimits]]); not bound, none is counted. */
  LIMITER?: {limit(o: {key: string}): Promise<{success: boolean}>};
}

/** The edge's own cache, where a Worker has one (not under workers.dev, nor on this machine's workerd without it). */
const edge = (): Edge | undefined => (globalThis as {caches?: {default?: Edge}}).caches?.default;

/** Whether `url` is this machine itself (localhost, 127.x, ::1). */
const loopback = (url: string) => { try { return /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(new URL(url).hostname); } catch { return false; } };
interface Ctx { waitUntil(p: Promise<unknown>): void }
/** Hono's view of a Worker's context: waitUntil, and passThroughOnException, which the Remote never uses. */
type ExecutionCtx = Ctx & {passThroughOnException(): void; props: unknown};

/**
 * One database for what is made once, that is, within `at(d, f)`, the
 * database `d` that request opened. Outside any, it is `idle`: asked what it
 * is (its schema), never to run a query.
 */
export function scoped<T extends object>(idle: T) {
  const now = new AsyncLocalStorage<T>();
  const db = new Proxy(idle, {
    get(target, k) {
      const d = now.getStore() ?? target;
      const v = Reflect.get(d, k, d);
      return typeof v === 'function' ? v.bind(d) : v;
    },
  });
  return {db, at: <R>(d: T, f: () => R): R => now.run(d, f)};
}

/** A pool of the database's own, and the Drizzle database over it. */
export const open = (url: string) => {
  // A database that does not answer is said in ten seconds (request.ts failed: 503), not waited on until the client gives up.
  const pool = new Pool({connectionString: url, connectionTimeoutMillis: 10_000});
  return {pool, db: drizzle(pool, {schema})};
};

/**
 * `f` on a connection of this request's own, as `at` gives it the database; the pool is let go once
 * the request is answered (`after`: the Worker's waitUntil). What the Worker does with each request
 * and each sweep, and what the tests and verify.ts do the same way (testing.ts).
 */
export async function served<R>(url: string, at: <T>(d: ReturnType<typeof open>['db'], f: () => T) => T, f: () => Promise<R>,
  after: (p: Promise<unknown>) => void): Promise<R> {
  const {pool, db} = open(url);
  try {
    return await at(db, f);
  } finally {
    after(pool.end());
  }
}

let made: ReturnType<typeof make> | null = null;
function make(env: Env) {
  // Without its secret, Better Auth would sign with its public default and every key derived from it (keys.ts) would
  // be keyed with nothing: refused at once, never served that way.
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET is missing or shorter than 32 characters');
  const {db, at} = scoped(open(env.DATABASE_URL).db);
  const pair = (id?: string, secret?: string) => (id && secret ? {clientId: id, clientSecret: secret} : undefined);
  const github = pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET), google = pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    apple = pair(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET);
  const origins = (env.APP_ORIGINS ?? '').split(/\s+/).filter(Boolean);
  // For research: the one account, entered by its link; no key, no way in at all.
  const enter = env.ENTER_AS ? {as: env.ENTER_AS, key: env.ENTER_KEY && env.ENTER_KEY.length >= 32 ? env.ENTER_KEY : ''} : undefined;
  const dev = env.DEV_SIGN_IN === '1' && loopback(env.BASE_URL) && !enter;
  const domain = env.DOMAIN ?? 'length3.com';
  const auth = createAuth({db, secret: env.BETTER_AUTH_SECRET, baseURL: env.BASE_URL, appOrigin: env.APP_ORIGIN, origins, github, google, apple, dev,
    only: enter && enterEmail(enter.as), domain});
  const bucket = env.BLOBS ? r2Bucket(env.BLOBS) : null;
  const marks = env.MARK ? objectMarks(env.MARK) : undefined;
  const app = createApp({db, auth, bucket, origins: [env.APP_ORIGIN, ...origins], appOrigin: env.APP_ORIGIN, providers: providers({github, google, apple, dev}),
    domain, baseURL: env.BASE_URL, secret: env.BETTER_AUTH_SECRET, enter,
    quota: env.QUOTA_MB ? Number(env.QUOTA_MB) * 1024 ** 2 : undefined,
    limits: limitsOf(env as unknown as Record<string, string | undefined>), edge: edge(), limiter: env.LIMITER, sessionKept: 10_000,
    // The plan holds here (but on a Remote for research, one person's alone); a tier is bought only when
    // Stripe's keys and its price are given.
    plan: enter ? undefined : planConfig(env),
    billing: billingOf(env), marks});
  return {app, at, bucket, marks};
}

/** How the plan is bought here: Stripe's keys and the tiers with a price; none, when either key or every price is missing. */
export function billingOf(env: Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET' | 'STRIPE_PRICE_GO' | 'STRIPE_PRICE_PRO' | 'STRIPE_PRICE_MAX'>, f?: typeof fetch): Billing | undefined {
  const prices: Billing['prices'] = {};
  for (const [tier, id] of [['go', env.STRIPE_PRICE_GO], ['pro', env.STRIPE_PRICE_PRO], ['max', env.STRIPE_PRICE_MAX]] as const) if (id?.trim()) prices[tier] = id.trim();
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !Object.keys(prices).length) return undefined;
  return {stripe: stripeRest(env.STRIPE_SECRET_KEY, f), webhookSecret: env.STRIPE_WEBHOOK_SECRET, prices};
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx) {
    const m = made ??= make(env);
    // With its context, so what a request does once it is answered (the mark moving: mark.ts) is the Worker's waitUntil.
    return served(env.DATABASE_URL, m.at, async () => m.app.fetch(request, env, ctx as ExecutionCtx), (p) => ctx.waitUntil(p));
  },
  // Once a day (wrangler.toml's trigger): what was held long enough goes. Awaited, not handed to
  // waitUntil: a sweep that fails is said in the log and fails its run, as Cron Events shows it.
  async scheduled(_event: unknown, env: Env, ctx: Ctx) {
    const m = made ??= make(env);
    const {pool, db} = open(env.DATABASE_URL);
    try {
      const gone = await sweep(db, m.bucket);
      console.log('sweep', JSON.stringify(gone));
      // What went is no look's any more: the mark moves, and what it heard of beats a day ago goes.
      if (m.marks) await Promise.all([m.marks.move(), m.marks.forget(Date.now() - 86_400_000)]).catch((e: unknown) => console.error('sweep: the mark', e));
      // Every step ran; one or more failed (each said in the log): the run fails, as Cron Events shows it.
      if (gone.failed) throw new Error(`${gone.failed} of the sweep's steps failed`);
    } catch (e) {
      console.error('sweep failed', e);
      throw e;
    } finally {
      ctx.waitUntil(pool.end());
    }
  },
};
