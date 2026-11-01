// The Remote's database as the deploy and its verification reach it: the
// migrations, run one way by both (deploy.ts, verify.ts), and how this
// machine reaches a database with the Worker's own driver (Neon's, over a
// WebSocket): a Neon host directly, a Postgres on this machine through the
// bridge in this process (bridge.ts).

import {rmSync} from 'node:fs';
import {Pool} from '@neondatabase/serverless';
import {sql, type SQL} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/neon-serverless';
import {migrate} from 'drizzle-orm/neon-serverless/migrator';
import {bridge, throughBridge} from './bridge.ts';
import {beforeWorker, firstOf, journalOf} from './stages.ts';

export const MIGRATIONS = new URL('./migrations', import.meta.url).pathname;

/** The migrations, as a deploy runs them, as the database's owner: what is not applied yet, in order, each once. */
export async function migrateRemote(db: ReturnType<typeof drizzle>) {
  await migrate(db, {migrationsFolder: MIGRATIONS});
}

/**
 * What a statement about the Worker's role failed with, as it may be said: the step, its SQLSTATE, and Postgres's own
 * words only where they are about a permission (what an operator needs to act on). Never the statement, its
 * parameters, or the error it came in, which carry the password (issue #41): Neon takes a password only as plain text.
 */
export class RoleFailed extends Error {
  readonly code: string;
  constructor(step: string, e: unknown) {
    let code = '', words = '';
    for (let x = e as {code?: unknown; message?: unknown; detail?: unknown; cause?: unknown} | undefined, i = 0; x && i < 4; x = x.cause as typeof x, i++) {
      if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) {
        code = x.code;
        // insufficient_privilege: Postgres says which permission (no statement text is in it).
        if (code === '42501') words = [x.message, x.detail].filter((w) => typeof w === 'string' && w).join(' ');
        break;
      }
    }
    super(`${step}: refused (SQLSTATE ${code || 'none'})${words ? `: ${words}` : ''}`);
    this.name = 'RoleFailed';
    this.code = code;
  }
}

/** `f`, whose failure is said as a RoleFailed alone: the error it threw goes nowhere, not even as a cause. */
async function quietly<T>(step: string, f: () => Promise<T>): Promise<T> {
  let failed: RoleFailed | null = null;
  try { return await f(); } catch (e) { failed = new RoleFailed(step, e); }
  throw failed;
}

/** The Worker's login roles: remote_worker (the one name before), and remote_worker_<UTC yyyymmddhhmmss> since. */
export const WORKER_ROLE = /^remote_worker(_[0-9]{14})?$/;
/** A new name for the Worker's login role, by when it is made. */
export const workerName = (at = new Date()) => `remote_worker_${at.toISOString().replace(/\D/g, '').slice(0, 14)}`;

/**
 * A new login role for the Worker, made as the owner: a member of remote_app (rows, nothing else; 0001) and of
 * nothing more, its statements cut off at 15 s; its name back (deploy.ts gives the Worker its URL as it).
 *
 * Always a new role, never one changed (issue #40): ALTER ROLE asks more of an owner that is not a superuser, as
 * Neon's is not, than CREATE does (naming NOSUPERUSER at all is refused, and a role another made cannot be changed),
 * and a password changed in place leaves a Worker that has the old one unable to sign in until it has the new.
 * The Worker's roles before it go once the Worker made with it answers (retireWorkers). `password` is letters and
 * digits only, so it is written into the statement as it is (Neon takes no other way); a statement that fails is
 * said without it (RoleFailed).
 */
export async function workerRole(db: ReturnType<typeof drizzle>, password: string, name = workerName()): Promise<string> {
  if (!/^[A-Za-z0-9]+$/.test(password)) throw new Error('the Worker\'s role: a password of letters and digits');
  if (!WORKER_ROLE.test(name)) throw new Error(`the Worker's role: ${name} is not one of its names`);
  const run = (step: string, q: SQL) => quietly(`${name}: ${step}`, () => db.execute(q));
  const [had] = (await run('read', sql`select 1 from pg_roles where rolname = ${name}`)).rows;
  if (had) throw new Error(`${name}: there already; the Worker's role is made new each time, never changed`);
  await run('create', sql.raw(`CREATE ROLE ${name} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${password}'`));
  await run('grant remote_app', sql.raw(`GRANT remote_app TO ${name}`));
  // No JIT: the Remote asks small things often, and a statement Postgres thinks large (a guess, from functions it cannot
  // see into) was compiled before it ran, 1.5 s of LLVM for 80 ms of work.
  for (const s of ["statement_timeout = '15s'", "idle_in_transaction_session_timeout = '15s'", "lock_timeout = '5s'", 'jit = off']) await run('settings', sql.raw(`ALTER ROLE ${name} SET ${s}`));
  return name;
}

/**
 * Every login role of the Worker but `keep` dropped, once the Worker made with `keep` answers from its database:
 * the one it had before, and any a deploy that stopped half-way made. One the owner may not drop (made by another
 * role) is left, and said with how to drop it; nothing else is asked of it.
 */
export async function retireWorkers(db: ReturnType<typeof drizzle>, keep: string): Promise<{dropped: string[]; left: string[]}> {
  const names = ((await quietly('the Worker\'s roles: read', () => db.execute(sql`select rolname from pg_roles where rolname ~ '^remote_worker(_[0-9]{14})?$' order by rolname`))).rows as {rolname: string}[])
    .map((r) => r.rolname).filter((n) => n !== keep && WORKER_ROLE.test(n));
  const dropped: string[] = [], left: string[] = [];
  for (const n of names) {
    try { await quietly(`${n}: drop`, () => db.execute(sql.raw(`DROP ROLE ${n}`))); dropped.push(n); } catch (e) {
      left.push(n);
      console.log(`${(e as Error).message}\n  ${n} is no longer the Worker's; drop it as a role that may (one with CREATEROLE and ADMIN OPTION on it): DROP ROLE ${n};`);
    }
  }
  return {dropped, left};
}

/** When the newest migration applied to `db` was made (its journal `when`); 0 when none was. */
async function applied(db: ReturnType<typeof drizzle>): Promise<number> {
  const [had] = (await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') as t`)).rows as {t: string | null}[];
  if (!had?.t) return 0;
  const [last] = (await db.execute(sql`select max(created_at) as at from drizzle.__drizzle_migrations`)).rows as {at: string | number | null}[];
  return Number(last?.at ?? 0);
}

/**
 * The migrations the Worker running now can meet, before a deploy ships the new one (stages.ts): every one before
 * the first contract step not applied yet. That step's tag when it waits for the new Worker (then migrateRemote,
 * once the new one answers), or null when nothing waits.
 */
export async function migrateBeforeWorker(db: ReturnType<typeof drizzle>): Promise<string | null> {
  const j = journalOf(MIGRATIONS);
  const n = beforeWorker(j, await applied(db));
  if (n === j.entries.length) { await migrateRemote(db); return null; }
  const first = firstOf(MIGRATIONS, n);
  try { await migrate(db, {migrationsFolder: first}); } finally { rmSync(first, {recursive: true}); }
  return j.entries[n].tag;
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
