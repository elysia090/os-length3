// Ships the Remote and the web app, one Worker on Cloudflare over Neon. It is
// the deploy command of Cloudflare's Workers Builds, which runs it on each
// push to main once `npm run build:cloudflare` has built the app, with its
// own token for Cloudflare; by hand it runs from any machine that reaches
// both (Node 22; `npx wrangler login` once), after a build:
//
//   node service/deploy.ts
//       the migrations, as the database's owner, on the project's default
//       branch (production: no branch is made for a deploy), up to the first
//       contract step not applied yet (stages.ts: one that drops what the
//       Worker running now still reads, which waits for the new Worker and
//       runs once it answers); the bucket, if
//       there is none; then the Worker, given what it lacks of what it needs,
//       and asked whether it answers from its database:
//         DATABASE_URL, as remote_worker: the login role it connects as, a
//           member of remote_app (rows, nothing else; 0001) and of nothing
//           more, its requests cut off at 15 s. Made in SQL, not in Neon's
//           console, where a role is given more than this. ANEW=1 makes its
//           password again.
//         BETTER_AUTH_SECRET, once (a new one would sign everyone out).
//         ENTER_KEY, for a Remote for research (enter.ts): the one given, or
//           else, the first time, a new one, whose link is handed on.
//       Then the release's files the Remote serves to anyone (mirror.ts):
//       every root core/src/root.rs pins and the desktop app of the version
//       RELEASE names (shared/desktop-releases.json), each one the bucket
//       lacks taken from the GitHub release with GITHUB_TOKEN (read-only;
//       GITHUB_REPOSITORY names the repository when it is not this one),
//       checked against its pin, and put with wrangler.
//   node service/deploy.ts link
//       a new ENTER_KEY: the old link stops opening the Remote, and every
//       session the one account has ends now. The new link is handed on.
//
// The owner is reached by OWNER_URL, or else by asking Neon with an API key
// for the project (NEON_API_KEY, NEON_PROJECT_ID: the build's secret and
// variable). A link is handed on once: printed in the log of the build or run
// that made it (seen by whoever can see the Worker's builds). No other secret
// is shown, and none is written to a file: each goes to wrangler on its
// standard input.

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {enterEmail} from './enter.ts';
import {mirror, remoteStore} from './mirror.ts';
import {defaultBranchUrl, migrateBeforeWorker, migrateRemote, owner as ownerOn} from './neon.ts';
import {pinnedDesktop, pinnedRoots} from './releases.ts';

const config = new URL('../wrangler.toml', import.meta.url).pathname;
const toml = readFileSync(config, 'utf8');
const vars = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];

/** wrangler, `input` on its standard input (never on a command line, never in a file); what it printed, when `heard`. */
function wrangler(args: string[], o: {input?: string; heard?: boolean} = {}): Promise<{code: number; out: string; err: string}> {
  return new Promise((done, failed) => {
    const p = spawn('npx', ['wrangler', ...args, '-c', config], {stdio: ['pipe', o.heard ? 'pipe' : 'inherit', o.heard ? 'pipe' : 'inherit']});
    let out = '', err = '';
    p.stdout?.on('data', (b) => (out += b));
    p.stderr?.on('data', (b) => (err += b));
    p.on('error', failed);
    p.on('exit', (code) => done({code: code ?? 1, out, err}));
    p.stdin!.end(o.input ?? '');
  });
}
async function must(args: string[], input?: string) {
  const {code} = await wrangler(args, {input});
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(' ')}: ${code}`);
}
const secret = (bytes: number) => randomBytes(bytes).toString('base64url');

/** The owner's connection string, on the project's default branch. */
async function ownerUrl(): Promise<string> {
  if (process.env.OWNER_URL) return process.env.OWNER_URL;
  const url = await defaultBranchUrl();
  if (!url) { console.error('OWNER_URL, or NEON_API_KEY and NEON_PROJECT_ID (Neon\'s GitHub integration sets both)'); process.exit(2); }
  return url;
}
async function owner() {
  const url = await ownerUrl();
  return {url: new URL(url), ...ownerOn(url)};
}

/** The names of the secrets the Worker has; none when there is no Worker yet. */
async function held(): Promise<Set<string>> {
  const {code, out, err} = await wrangler(['secret', 'list', '--format', 'json'], {heard: true});
  // 10007: no Worker by this name yet.
  if (code !== 0) { if (/\b10007\b/.test(out + err)) return new Set(); throw new Error(`wrangler secret list: ${code}\n${err}`); }
  return new Set((JSON.parse(out) as {name: string}[]).map((s) => s.name));
}

/** remote_worker with a new password (letters and digits only, so it is written into the statement as it is); the URL the Worker reaches it by. */
async function worker(db: Awaited<ReturnType<typeof owner>>['db'], url: URL): Promise<string> {
  const password = secret(30).replace(/[^A-Za-z0-9]/g, 'x');
  const [had] = (await db.execute(sql`select 1 from pg_roles where rolname = 'remote_worker'`)).rows;
  await db.execute(sql.raw(`${had ? 'ALTER' : 'CREATE'} ROLE remote_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${password}'`));
  await db.execute(sql`grant remote_app to remote_worker`);
  for (const s of ["statement_timeout = '15s'", "idle_in_transaction_session_timeout = '15s'", "lock_timeout = '5s'"]) await db.execute(sql.raw(`alter role remote_worker set ${s}`));
  // The pooled host: many short connections, as a Worker makes.
  const host = url.hostname.includes('-pooler.') ? url.hostname : url.hostname.replace(/^([^.]+)\./, '$1-pooler.');
  return `postgresql://remote_worker:${password}@${host}${url.pathname}?sslmode=require`;
}

/** Hands a new link on, once. */
function handOn(key: string, news: string) {
  console.log(`${news} Hand it only to whoever should come in:\n\n  ${vars('APP_ORIGIN')}/#enter=${key}\n`);
}

/** Waits until the Remote answers from its database (GET /v1/health: one read; a Remote for research or not). */
async function answers(base: string) {
  let last = '';
  // A new custom domain is reachable once its certificate is issued: a minute, or a few.
  for (let i = 0; i < 30; i++) {
    if (i) await new Promise((r) => setTimeout(r, 10_000));
    try {
      const r = await fetch(`${base}/v1/health`);
      if (r.ok && ((await r.clone().json().catch(() => null)) as {ok?: boolean} | null)?.ok === true) return console.log(`${base}: answers from its database`);
      last = `${r.status} ${(await r.text()).slice(0, 300)}`;
    } catch (e) { last = String(e); }
  }
  throw new Error(`${base}/v1/health: ${last}`);
}

/** What the Remote serves of the release, put in its bucket where it lacks it (mirror.ts). */
async function releaseFiles(bucket: string) {
  const version = readFileSync(new URL('../RELEASE', import.meta.url), 'utf8').trim();
  const desktop = pinnedDesktop(version);
  if (!desktop.length) console.log(`shared/desktop-releases.json pins no desktop app for ${version}: the web offers none until it is pinned (the release's notes say what to pin)`);
  const pins = [...pinnedRoots(readFileSync(new URL('../core/src/root.rs', import.meta.url), 'utf8')), ...desktop];
  const store = remoteStore(vars('BASE_URL')!, async (p, file) => must(['r2', 'object', 'put', `${bucket}/${p.key}`, '--file', file, '--content-type', p.type, '--remote']));
  const {kept, put} = await mirror(pins, store, {api: process.env.GITHUB_API_URL || 'https://api.github.com',
    repo: process.env.GITHUB_REPOSITORY || 'elysia090/os-length3', token: process.env.GITHUB_TOKEN});
  console.log(`release files on the Remote: ${put.length} put, ${kept.length} there already`);
}

const step = process.argv[2];
if (!step) {
  const given = process.env.ENTER_KEY || undefined;
  if (given && !/^[A-Za-z0-9_-]{32,}$/.test(given)) { console.error('ENTER_KEY: 32 or more letters, digits, - and _'); process.exit(2); }
  const {url, pool, db} = await owner();
  const waiting = await migrateBeforeWorker(db);
  if (waiting) console.log(`migrations: ${waiting} and after wait for the new Worker`);
  console.log('migrations: done');
  const bucket = vars('bucket_name')!;
  if ((await wrangler(['r2', 'bucket', 'info', bucket, '--json'], {heard: true})).code !== 0) await must(['r2', 'bucket', 'create', bucket]);
  const kept = await held();
  const give: Record<string, string> = {};
  if (!kept.has('DATABASE_URL') || process.env.ANEW === '1') give.DATABASE_URL = await worker(db, url);
  await pool.end();
  if (!kept.has('BETTER_AUTH_SECRET')) give.BETTER_AUTH_SECRET = secret(48);
  const made = vars('ENTER_AS') && !given && !kept.has('ENTER_KEY');
  if (given || made) give.ENTER_KEY = given ?? secret(32);
  console.log(`secrets given: ${Object.keys(give).join(', ') || 'none'}; kept: ${[...kept].filter((k) => !(k in give)).join(', ') || 'none'}`);
  // Given with the version it deploys, so no version runs without them.
  await must(['deploy', ...(Object.keys(give).length ? ['--secrets-file', '/dev/stdin'] : [])], JSON.stringify(give));
  if (made) handOn(give.ENTER_KEY, 'This Remote has its first link.');
  await answers(vars('BASE_URL')!);
  if (waiting) {
    // The Worker that read what the contract step drops is gone now.
    const later = await owner();
    await migrateRemote(later.db);
    await later.pool.end();
    console.log('migrations: the contract step is done');
  }
  await releaseFiles(bucket);
} else if (step === 'link') {
  const as = vars('ENTER_AS');
  if (!as) { console.error('wrangler.toml has no ENTER_AS: this Remote is not one for research'); process.exit(2); }
  const key = secret(32);
  await must(['secret', 'put', 'ENTER_KEY'], key);
  const {pool, db} = await owner();
  const ended = (await db.execute(sql`delete from session where user_id = (select id from "user" where email = ${enterEmail(as)}) returning 1`)).rows.length;
  await pool.end();
  handOn(key, `A new link: the old one opens nothing now, and ${ended} session(s) of ${as} ended.`);
} else {
  console.error('node service/deploy.ts [link]   (see the top of this file)');
  process.exit(2);
}
