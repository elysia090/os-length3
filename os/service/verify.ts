// The Remote, verified against a real Postgres: the migrations as a deploy
// runs them, then the Remote's contract tests on what they made, with no
// bucket, through the Worker's own driver; then what it made goes.
//
//   DATABASE_URL='postgresql://…' npm run verify:remote [-- --production]
//
// DATABASE_URL is any Postgres this machine reaches with the Worker's driver:
// a Neon branch, pooled or direct (straight to Neon's proxy), or a Postgres
// on this machine (through a bridge in this process, bridge.ts). Its role
// must be able to make a database (Neon's owner role can; so can a local
// superuser).
//
// What it makes, and nothing else, it takes away again:
//   - a database of its own beside the one named, remote_verify_<time>_<hex>
//     (commented so), migrated by migrateRemote (neon.ts, what deploy.ts
//     runs) and dropped at the end, also when the tests fail or it is
//     stopped (Ctrl-C). The database named in the URL is only connected to.
//   - the role remote_app, only if the migrations made it (0001 makes it when
//     the server has none) and nothing else uses it then; one that was there
//     before is never touched.
// A run killed outright leaves its database, named in what it printed.
//
// It refuses a database that looks like production, unless --production:
//   - a host on this machine is never production
//   - a host whose name says prod, production or live is taken for it
//   - a Neon endpoint is production when it is the project's default
//     branch's, as Neon says (NEON_API_KEY and NEON_PROJECT_ID, what the
//     deploy uses) or as REMOTE_PRODUCTION_HOSTS says (endpoint ids or host
//     names, comma separated; not secret); with neither, it cannot tell, and
//     refuses
//   - any other host is refused anyway: the driver would reach it in plain
//     text across a network
//
// It never prints the URL, its password, or its host: what the tests print is
// passed on with each of those written as ***.

import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {defaultBranchUrl, endpointOf, isLocal, isNeon, MIGRATIONS, migrateRemote, owner, reach} from './neon.ts';

const OS = new URL('..', import.meta.url).pathname;
const say = (s: string) => console.log(`verify:remote: ${s}`);
function stop(s: string, code = 2): never { console.error(`verify:remote: ${s}`); process.exit(code); }

/** Why `url` looks like production, or null when it does not (a promise: Neon may be asked). */
export async function production(url: URL, env: NodeJS.ProcessEnv = process.env, ask = defaultBranchUrl): Promise<string | null> {
  const host = url.hostname.toLowerCase();
  if (isLocal(host)) return null;
  if (/(^|[^a-z])(prod|production|live)([^a-z]|$)/.test(host)) return 'its host is named as production';
  if (!isNeon(host)) return 'it is not a Neon host or this machine, so it is not reached with the Worker\'s driver';
  const named = (env.REMOTE_PRODUCTION_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  if (named.some((h) => endpointOf(h) === endpointOf(host))) return 'REMOTE_PRODUCTION_HOSTS names its endpoint';
  const main = await ask();
  if (main && endpointOf(new URL(main).hostname) === endpointOf(host)) return 'it is the Neon project\'s default branch';
  if (!main && !named.length) return 'it cannot tell (set REMOTE_PRODUCTION_HOSTS to the production endpoint, or NEON_API_KEY and NEON_PROJECT_ID)';
  return null;
}

/** Each of these written as *** wherever it appears. */
const hiding = (secrets: string[]) => {
  const words = [...new Set(secrets.filter((s) => s.length >= 3))].sort((a, b) => b.length - a.length);
  return (text: string) => words.reduce((t, w) => t.split(w).join('***'), text);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((f) => f !== '--production');
  if (unknown.length) stop(`not a flag: ${unknown.join(' ')} (only --production)`);
  const given = process.env.DATABASE_URL;
  if (!given) stop('DATABASE_URL is not set: the Postgres to verify against (a Neon branch, or one on this machine)');
  let url: URL;
  try { url = new URL(given); } catch { stop('DATABASE_URL is not a URL'); }
  if (!/^postgres(ql)?:$/.test(url!.protocol)) stop('DATABASE_URL is not a postgres:// URL');
  url = url!;
  const hide = hiding([given, decodeURIComponent(url.password), url.password, url.host, url.hostname, endpointOf(url.hostname)]);

  const why = await production(url).catch((e: unknown) => stop(hide(`could not ask Neon which branch is production: ${String(e)}`)));
  if (why && !flags.includes('--production')) stop(`refused: this looks like production (${why}). --production runs it anyway.`);
  if (why) say(`running against what looks like production (${why}), as --production says`);

  const driver = await reach(given).catch((e: unknown) => stop(hide(String(e instanceof Error ? e.message : e))));
  say(`the Worker's driver (@neondatabase/serverless over WebSocket), ${isNeon(url.hostname) ? 'straight to Neon' : 'through a bridge to this machine\'s Postgres'}`);

  const name = `remote_verify_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;
  const ours = /^remote_verify_\d{14}_[0-9a-f]{6}$/;
  const there = owner(given);
  let made = false, roleBefore = true, code = 1;
  const at = new URL(given);
  at.pathname = `/${name}`;
  const scratch = at.toString();

  let cleaning: Promise<void> | null = null;
  const clean = () => (cleaning ??= (async () => {
    try {
      if (made && ours.test(name)) {
        await there.db.execute(sql.raw(`drop database if exists "${name}" with (force)`));
        say(`dropped ${name}`);
      }
      if (made && !roleBefore) {
        try {
          await there.db.execute(sql.raw('drop role if exists remote_app'));
          say('dropped remote_app, which the migrations made');
        } catch { say('left remote_app, which the migrations made: something else uses it now'); }
      }
    } catch (e) {
      console.error(hide(`verify:remote: could not take ${name} away (${String(e)}); drop it by hand`));
    } finally {
      await there.pool.end().catch(() => {});
      await driver.close();
    }
  })());
  let tests: ChildProcess | null = null;
  // Stopped: the tests first, then what was made goes, as at any other end.
  process.once('SIGINT', () => { tests?.kill(); void clean().then(() => process.exit(130)); });

  try {
    const role = await there.db.execute(sql`select 1 from pg_roles where rolname = 'remote_app'`);
    roleBefore = role.rows.length > 0;
    await there.db.execute(sql.raw(`create database "${name}"`));
    made = true;
    await there.db.execute(sql.raw(`comment on database "${name}" is 'made by npm run verify:remote; dropped when it ends, safe to drop'`));
    say(`made ${name}`);

    const target = owner(scratch);
    try {
      await migrateRemote(target.db);
      const applied = await target.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      const journal = JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as {entries: {tag: string}[]};
      say(`migrations: ${(applied.rows[0] as {n: number}).n} applied, as deploy.ts applies them (${journal.entries[0].tag} … ${journal.entries.at(-1)!.tag})`);
    } finally {
      await target.pool.end();
    }

    say('the contract tests, with no bucket');
    code = await new Promise<number>((done) => {
      const p = tests = spawn(process.execPath, ['--test', 'service/contract.test.ts'], {cwd: OS, stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, DATABASE_URL: '', REMOTE_TEST_DATABASE_URL: scratch, REMOTE_TEST_BUCKET: 'none'}});
      p.stdout.on('data', (b: Buffer) => process.stdout.write(hide(b.toString())));
      p.stderr.on('data', (b: Buffer) => process.stderr.write(hide(b.toString())));
      p.on('exit', (c) => done(c ?? 1));
    });
    say(code === 0 ? 'the Remote verified against this database' : `the contract tests failed (${code})`);
  } catch (e) {
    console.error(hide(`verify:remote: ${e instanceof Error ? e.message : String(e)}`));
    code = 1;
  } finally {
    await clean();
  }
  process.exit(code);
}
