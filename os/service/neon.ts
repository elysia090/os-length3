// The Remote's database as the deploy and its verification reach it: the
// migrations, run one way by both (deploy.ts, verify.ts), and how this
// machine reaches a database with the Worker's own driver (Neon's, over a
// WebSocket): a Neon host directly, a Postgres on this machine through the
// bridge in this process (bridge.ts).

import {Pool} from '@neondatabase/serverless';
import {drizzle} from 'drizzle-orm/neon-serverless';
import {migrate} from 'drizzle-orm/neon-serverless/migrator';
import {bridge, throughBridge} from './bridge.ts';

export const MIGRATIONS = new URL('./migrations', import.meta.url).pathname;

/** The migrations, as a deploy runs them, as the database's owner: what is not applied yet, in order, each once. */
export async function migrateRemote(db: ReturnType<typeof drizzle>) {
  await migrate(db, {migrationsFolder: MIGRATIONS});
}

/** A pool on `url` and its Drizzle database (no schema: for the owner's statements). */
export function owner(url: string) {
  const pool = new Pool({connectionString: url});
  return {pool, db: drizzle(pool)};
}

/** The connection string of the Neon project's default branch, as its owner (NEON_API_KEY, NEON_PROJECT_ID); null without them. */
export async function defaultBranchUrl(): Promise<string | null> {
  const key = process.env.NEON_API_KEY, project = process.env.NEON_PROJECT_ID;
  if (!key || !project) return null;
  const q = new URLSearchParams({database_name: process.env.NEON_DATABASE ?? 'neondb', role_name: process.env.NEON_OWNER ?? 'neondb_owner', pooled: 'false'});
  const r = await fetch(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(project)}/connection_uri?${q}`,
    {headers: {authorization: `Bearer ${key}`, accept: 'application/json'}});
  if (!r.ok) throw new Error(`Neon connection_uri: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return ((await r.json()) as {uri: string}).uri;
}

/** This machine itself: a Postgres here is reached through the bridge, in plain text that never leaves it. */
export const isLocal = (host: string) => /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i.test(host) || host.endsWith('.localhost');
/** A Neon host, whose proxy speaks the driver's WebSocket itself. */
export const isNeon = (host: string) => /\.neon\.tech$/i.test(host);
/** A Neon endpoint as its id, pooled or not (ep-x-y-123 for ep-x-y-123-pooler.region.aws.neon.tech). */
export const endpointOf = (host: string) => host.toLowerCase().split('.')[0].replace(/-pooler$/, '');

/**
 * Make this process's Neon driver able to reach `url`: nothing to do for a Neon host, a bridge for one
 * on this machine (closed by what is returned). Any other host is refused: the driver would reach it
 * only through a bridge, in plain text, across a network.
 */
export async function reach(url: string): Promise<{close(): Promise<void>}> {
  const host = new URL(url).hostname;
  if (isNeon(host)) return {close: async () => {}};
  if (!isLocal(host)) throw new Error('Only a Neon host or a Postgres on this machine is reached with the Worker\'s driver');
  const b = await bridge({tcp: true});
  throughBridge(b.port);
  return b;
}
