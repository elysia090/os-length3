// The Remote on Cloudflare: the service over Neon (Postgres) and R2. The
// WebSocket pool, not the HTTP driver, because Better Auth uses transactions.
import {Pool} from '@neondatabase/serverless';
import {drizzle} from 'drizzle-orm/neon-serverless';
import {createApp} from './app.ts';
import {createAuth, providers} from './auth.ts';
import {r2Bucket, type R2Bucket} from './bucket.ts';
import * as schema from './schema.ts';

interface Env {
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
  BLOBS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env, ctx: {waitUntil(p: Promise<unknown>): void}) {
    const pool = new Pool({connectionString: env.DATABASE_URL});
    const db = drizzle(pool, {schema});
    const pair = (id?: string, secret?: string) => (id && secret ? {clientId: id, clientSecret: secret} : undefined);
    const github = pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET), google = pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
      apple = pair(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET);
    const origins = (env.APP_ORIGINS ?? '').split(/\s+/).filter(Boolean);
    const auth = createAuth({db, secret: env.BETTER_AUTH_SECRET, baseURL: env.BASE_URL, appOrigin: env.APP_ORIGIN, origins, github, google, apple});
    const app = createApp({db, auth, bucket: r2Bucket(env.BLOBS), origins: [env.APP_ORIGIN, ...origins], providers: providers({github, google, apple}),
      domain: env.DOMAIN ?? 'length3.com', baseURL: env.BASE_URL, secret: env.BETTER_AUTH_SECRET});
    const response = await app.fetch(request);
    ctx.waitUntil(pool.end());
    return response;
  },
};
