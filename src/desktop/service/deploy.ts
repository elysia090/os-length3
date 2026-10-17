// Readies the Remote on Cloudflare and Neon, one step at a time, from a
// machine that reaches both (Node 22, `npx wrangler login` done once):
//
//   OWNER_URL='postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require' node service/deploy.ts database
//       the migrations, as the database's owner; then remote_worker, the login
//       role the Worker connects as: a member of remote_app (rows, nothing
//       else; 0001) and of nothing more, its requests cut off at 15 s. Made in
//       SQL, not in Neon's console, where a role is given more than this. Its
//       new password goes straight into the Worker's DATABASE_URL secret.
//   node service/deploy.ts secret
//       BETTER_AUTH_SECRET, once (a new one signs everyone out).
//   OWNER_URL=… node service/deploy.ts link
//       a new ENTER_KEY for a Remote for research (enter.ts): the old link
//       stops opening it, and every session the one account has ends now.
//       The new link is printed once, to be handed on.
//
// No secret is printed but the link, and none is written to a file: each goes
// to `wrangler secret put` on its standard input.

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Pool} from '@neondatabase/serverless';
import {sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/neon-serverless';
import {migrate} from 'drizzle-orm/neon-serverless/migrator';
import {enterEmail} from './enter.ts';

const config = new URL('./wrangler.toml', import.meta.url).pathname;
const toml = (await import('node:fs')).readFileSync(config, 'utf8');
const vars = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];

/** A secret handed to the Worker on standard input: never on a command line, never in a file. */
function put(name: string, value: string): Promise<void> {
  return new Promise((done, failed) => {
    const p = spawn('npx', ['wrangler', 'secret', 'put', name, '-c', config], {stdio: ['pipe', 'inherit', 'inherit']});
    p.on('error', failed);
    p.on('exit', (code) => (code === 0 ? done() : failed(new Error(`wrangler secret put ${name}: ${code}`))));
    p.stdin.end(value);
  });
}
const secret = (bytes: number) => randomBytes(bytes).toString('base64url');

function owner() {
  const url = process.env.OWNER_URL;
  if (!url) { console.error('OWNER_URL: the database owner\'s connection string (Neon: Connect, the owner role)'); process.exit(2); }
  const pool = new Pool({connectionString: url});
  return {url: new URL(url), pool, db: drizzle(pool)};
}

const step = process.argv[2];
if (step === 'database') {
  const {url, pool, db} = owner();
  await migrate(db, {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
  console.log('migrations: done');
  // A password of letters and digits only, so it is written into the statement as it is.
  const password = secret(30).replace(/[^A-Za-z0-9]/g, 'x');
  const [had] = (await db.execute(sql`select 1 from pg_roles where rolname = 'remote_worker'`)).rows;
  await db.execute(sql.raw(`${had ? 'ALTER' : 'CREATE'} ROLE remote_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${password}'`));
  await db.execute(sql`grant remote_app to remote_worker`);
  for (const s of ["statement_timeout = '15s'", "idle_in_transaction_session_timeout = '15s'", "lock_timeout = '5s'"]) await db.execute(sql.raw(`alter role remote_worker set ${s}`));
  await pool.end();
  // The pooled host: many short connections, as a Worker makes.
  const host = url.hostname.includes('-pooler.') ? url.hostname : url.hostname.replace(/^([^.]+)\./, '$1-pooler.');
  await put('DATABASE_URL', `postgresql://remote_worker:${password}@${host}${url.pathname}?sslmode=require`);
  console.log('DATABASE_URL: set (remote_worker)');
} else if (step === 'secret') {
  await put('BETTER_AUTH_SECRET', secret(48));
  console.log('BETTER_AUTH_SECRET: set');
} else if (step === 'link') {
  const as = vars('ENTER_AS'), app = vars('APP_ORIGIN');
  if (!as || !app) { console.error('wrangler.toml has no ENTER_AS: this Remote is not one for research'); process.exit(2); }
  const key = secret(32);
  await put('ENTER_KEY', key);
  const {pool, db} = owner();
  const ended = (await db.execute(sql`delete from session where user_id = (select id from "user" where email = ${enterEmail(as)}) returning 1`)).rows.length;
  await pool.end();
  console.log(`ENTER_KEY: set; ${ended} session(s) of ${as} ended.\nThe link (hand it only to whoever should come in):\n\n  ${app}/#enter=${key}\n`);
} else {
  console.error('node service/deploy.ts database | secret | link   (see the top of this file)');
  process.exit(2);
}
