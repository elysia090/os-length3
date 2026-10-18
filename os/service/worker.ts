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
import * as schema from './schema.ts';
import {sweep} from './sweep.ts';

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
  /** File contents (R2). Not bound: the Remote holds no files, and says so. */
  BLOBS?: R2Bucket;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

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
  const {db, at} = scoped(open(env.DATABASE_URL).db);
  const pair = (id?: string, secret?: string) => (id && secret ? {clientId: id, clientSecret: secret} : undefined);
  const github = pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET), google = pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    apple = pair(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET);
  const origins = (env.APP_ORIGINS ?? '').split(/\s+/).filter(Boolean);
  // For research: the one account, entered by its link; no key, no way in at all.
  const enter = env.ENTER_AS ? {as: env.ENTER_AS, key: env.ENTER_KEY && env.ENTER_KEY.length >= 32 ? env.ENTER_KEY : ''} : undefined;
  const auth = createAuth({db, secret: env.BETTER_AUTH_SECRET, baseURL: env.BASE_URL, appOrigin: env.APP_ORIGIN, origins, github, google, apple,
    only: enter && enterEmail(enter.as)});
  const bucket = env.BLOBS ? r2Bucket(env.BLOBS) : null;
  const app = createApp({db, auth, bucket, origins: [env.APP_ORIGIN, ...origins], appOrigin: env.APP_ORIGIN, providers: providers({github, google, apple}),
    domain: env.DOMAIN ?? 'length3.com', baseURL: env.BASE_URL, secret: env.BETTER_AUTH_SECRET, enter,
    quota: env.QUOTA_MB ? Number(env.QUOTA_MB) * 1024 ** 2 : undefined});
  return {app, at, bucket};
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx) {
    const m = made ??= make(env);
    return served(env.DATABASE_URL, m.at, async () => m.app.fetch(request), (p) => ctx.waitUntil(p));
  },
  // Once a day (wrangler.toml's trigger): what was held long enough goes. Awaited, not handed to
  // waitUntil: a sweep that fails is said in the log and fails its run, as Cron Events shows it.
  async scheduled(_event: unknown, env: Env, ctx: Ctx) {
    const m = made ??= make(env);
    const {pool, db} = open(env.DATABASE_URL);
    try {
      console.log('sweep', JSON.stringify(await sweep(db, m.bucket)));
    } catch (e) {
      console.error('sweep failed', e);
      throw e;
    } finally {
      ctx.waitUntil(pool.end());
    }
  },
};
