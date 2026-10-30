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
//         DATABASE_URL, as remote_worker_<when>: the login role it connects
//           as, a member of remote_app (rows, nothing else; 0001) and of
//           nothing more, its requests cut off at 15 s. Made in SQL, not in
//           Neon's console, where a role is given more than this; made new
//           each time, never changed (neon.ts workerRole), and the ones before
//           it dropped once the new Worker answers. ANEW=1 makes a new one.
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
// is shown. A deploy's secrets go together in an owner-only temporary JSON
// file, removed when wrangler finishes; `link` uses its standard input.

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {deployWorker} from './deploy-worker.ts';
import {enterEmail} from './enter.ts';
import {limitsOf, month, spent, take} from './budget.ts';
import {rows, type Db} from './request.ts';
import {mirror, type Store} from './mirror.ts';
import {defaultBranchUrl, migrateBeforeWorker, migrateRemote, owner as ownerOn, retireWorkers, workerRole} from './neon.ts';
import {pinnedDesktop, pinnedDistros, pinnedRoots} from './releases.ts';

const config = new URL('../wrangler.toml', import.meta.url).pathname;
const toml = readFileSync(config, 'utf8');

/**
 * What the Worker serves as the app is the build (dist, made by `npm run build:cloudflare`), never this tree: a page
 * served from the sources asks for /src/main.ts, which a browser will not run (a .ts file is served as video, MPEG
 * transport stream), and /boot.js is not there, so all it shows is the page's background. Refused before anything moves.
 */
function built(dir: string): string | null {
  const page = `${dir}/index.html`;
  if (!existsSync(page)) return `${page} is not there: build the app first (npm run build:cloudflare)`;
  const html = readFileSync(page, 'utf8');
  if (/src="\/src\/main\.ts"/.test(html) || !html.includes('name="length3-build"')) return `${page} is the sources' page, not a build's: build the app first (npm run build:cloudflare)`;
  if (!existsSync(`${dir}/boot.js`)) return `${dir}/boot.js is not there: the build is not whole`;
  return null;
}

const vars = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];

/** wrangler, `input` on its standard input (never on a command line); what it printed, when `heard`. */
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

/** A new login role for the Worker, with a new password (workerRole, neon.ts): its name, and the URL the Worker reaches it by. */
async function worker(db: Awaited<ReturnType<typeof owner>>['db'], url: URL): Promise<{name: string; url: string}> {
  const password = secret(30).replace(/[^A-Za-z0-9]/g, 'x');
  const name = await workerRole(db, password);
  // The pooled host: many short connections, as a Worker makes.
  const host = url.hostname.includes('-pooler.') ? url.hostname : url.hostname.replace(/^([^.]+)\./, '$1-pooler.');
  return {name, url: `postgresql://${name}:${password}@${host}${url.pathname}?sslmode=require`};
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
      const r = await fetch(`${base}/v1/health`, {signal: AbortSignal.timeout(15_000)});
      if (r.ok && ((await r.clone().json().catch(() => null)) as {ok?: boolean} | null)?.ok === true) return console.log(`${base}: answers from its database`);
      last = `${r.status} ${(await r.text()).slice(0, 300)}`;
    } catch (e) { last = String(e); }
  }
  throw new Error(`${base}/v1/health: ${last}`);
}

/** How long a release file no deploy pins any more is kept, for the clients of its release (days). */
const UNPINNED_DAYS = 90;

/** What the Remote serves of the release, put in its bucket where it lacks it (mirror.ts). */
async function releaseFiles(bucket: string) {
  const version = readFileSync(new URL('../RELEASE', import.meta.url), 'utf8').trim();
  const desktop = pinnedDesktop(version);
  if (!desktop.length) console.log(`shared/desktop-releases.json pins no desktop app for ${version}: the web offers none until it is pinned (the release's notes say what to pin)`);
  const rootRs = readFileSync(new URL('../core/src/root.rs', import.meta.url), 'utf8');
  const pins = [...pinnedRoots(rootRs), ...pinnedDistros(rootRs), ...desktop];
  // The same budget as the Worker's (wrangler.toml [vars]): asked before a file is fetched (a put of the month,
  // and the bytes R2 would hold with it in place of what it replaces); counted once it is put, with its record
  // (release_file, whose trigger counts its bytes), so a deploy that fails counts nothing.
  const limits = limitsOf(Object.fromEntries(['R2_STORED_MB', 'R2_WRITES_MONTH'].map((k) => [k, vars(k)])));
  const {pool, db} = await owner();
  const recordOf = async (q: Db, key: string) => (await rows<{sha256: string; bytes: number}>(q, sql`select sha256, bytes::float8 as bytes from release_file where key = ${key}`)).at(0);
  const store: Store = {
    async has(p) {
      const r = await recordOf(db, p.key);
      const same = r?.sha256 === p.sha256 && Number(r.bytes) === p.bytes;
      // Still pinned: its moment is now, so it is not taken for one this tree has let go of (below).
      if (same) await db.execute(sql`update release_file set at = now() where key = ${p.key}`);
      return same;
    },
    async put(p, file) {
      await must(['r2', 'object', 'put', `${bucket}/${p.key}`, '--file', file, '--content-type', p.type, '--remote']);
      await db.transaction(async (tx: Db) => {
        await take(tx, month(Date.now()), 'r2:a', 1, Number.MAX_SAFE_INTEGER);
        await tx.execute(sql`insert into release_file (key, sha256, bytes) values (${p.key}, ${p.sha256}, ${p.bytes})
          on conflict (key) do update set sha256 = excluded.sha256, bytes = excluded.bytes, at = now()`);
      });
    },
  };
  try {
    const allow = async (p: {key: string; bytes: number}) => {
      if (await spent(db, month(Date.now()), 'r2:a') + 1 > limits.writes) throw new Error(`${p.key}: R2's puts for this month are spent`);
      const had = Number((await recordOf(db, p.key))?.bytes ?? 0);
      if (await spent(db, 'all', 'r2:stored') + p.bytes - had > limits.stored) throw new Error(`${p.key}: R2 would hold more than R2_STORED_MB`);
    };
    const {kept, put} = await mirror(pins, store, {api: process.env.GITHUB_API_URL || 'https://api.github.com',
      repo: process.env.GITHUB_REPOSITORY || 'elysia090/os-length3', token: process.env.GITHUB_TOKEN}, console.log, allow);
    console.log(`release files on the Remote: ${put.length} put, ${kept.length} there already`);
    // What no deploy has pinned for UNPINNED_FOR goes (a release a client of then may still ask for stays that long):
    // before, every deploy's roots and desktop apps (150 MB) stayed for good, in the bytes R2_STORED_MB counts with
    // everyone's files, until uploads were refused. The object first, then its record (whose trigger counts it gone).
    const pinned = new Set(pins.map((p) => p.key));
    const old = (await db.execute(sql`select key from release_file where at < now() - make_interval(days => ${UNPINNED_DAYS})`)).rows as {key: string}[];
    for (const {key} of old.filter((r) => !pinned.has(r.key))) {
      if ((await wrangler(['r2', 'object', 'delete', `${bucket}/${key}`, '--remote'], {heard: true})).code !== 0) { console.log(`${key}: not let go this time`); continue; }
      await db.execute(sql`delete from release_file where key = ${key}`);
      console.log(`${key}: let go (no deploy has pinned it for ${UNPINNED_DAYS} days)`);
    }
  } finally {
    await pool.end();
  }
}

const step = process.argv[2];
// On Workers Builds, only main's build deploys (README.md, Deploy): another branch's build uploads a version to
// preview (`npx wrangler versions upload`), never this, which migrates production's database and replaces its Worker.
const branch = process.env.WORKERS_CI_BRANCH;
if (branch && branch !== 'main') {
  console.error(`deploy: this is a build of ${branch}, not main: production is deployed from main alone (a branch's deploy command is \`npx wrangler versions upload\`)`);
  process.exit(2);
}

if (!step) {
  const unbuilt = built(new URL(`../${vars('directory') ?? 'dist'}`, import.meta.url).pathname);
  if (unbuilt) { console.error(`deploy: ${unbuilt}`); process.exit(2); }
  const given = process.env.ENTER_KEY || undefined;
  if (given && !/^[A-Za-z0-9_-]{32,}$/.test(given)) { console.error('ENTER_KEY: 32 or more letters, digits, - and _'); process.exit(2); }
  const {url, pool, db} = await owner();
  const waiting = await migrateBeforeWorker(db);
  if (waiting) console.log(`migrations: ${waiting} and after wait for the new Worker`);
  console.log('migrations: done');
  // What room_free() (0014) asks how much room the database's rows let go of: without it, a database at PG_MB is
  // taken as full until VACUUM FULL. Neon has it; a database that does not, or an owner who may not, goes on without.
  await db.execute(sql`create extension if not exists pgstattuple`).then(() => console.log('pgstattuple: there'),
    (e: unknown) => console.log(`pgstattuple: not made (${e instanceof Error ? e.message : String(e)}); the database is taken as full at PG_MB until VACUUM FULL`));
  const bucket = vars('bucket_name')!;
  if ((await wrangler(['r2', 'bucket', 'info', bucket, '--json'], {heard: true})).code !== 0) await must(['r2', 'bucket', 'create', bucket]);
  const kept = await held();
  const give: Record<string, string> = {};
  // A new role for a new DATABASE_URL (the Worker has none: the first deploy, or one that stopped before giving it;
  // or ANEW=1): the role a Worker running now signs in as is left as it is until the new Worker answers (below).
  let role: string | null = null;
  if (!kept.has('DATABASE_URL') || process.env.ANEW === '1') {
    const w = await worker(db, url);
    role = w.name;
    give.DATABASE_URL = w.url;
    console.log(`DATABASE_URL: as ${role}, made now`);
  }
  await pool.end();
  if (!kept.has('BETTER_AUTH_SECRET')) give.BETTER_AUTH_SECRET = secret(48);
  const made = vars('ENTER_AS') && !given && !kept.has('ENTER_KEY');
  if (given || made) give.ENTER_KEY = given ?? secret(32);
  console.log(`secrets given: ${Object.keys(give).join(', ') || 'none'}; kept: ${[...kept].filter((k) => !(k in give)).join(', ') || 'none'}`);
  // Given with the version it deploys, so no version runs without them.
  await deployWorker(give, must);
  if (made) handOn(give.ENTER_KEY, 'This Remote has its first link.');
  await answers(vars('BASE_URL')!);
  // The Worker answers as the new role: the ones before it go (a deploy that stopped half-way left its own too).
  if (role) {
    const later = await owner();
    try {
      const {dropped, left} = await retireWorkers(later.db, role);
      console.log(`the Worker's roles before ${role}: ${dropped.length ? `${dropped.join(', ')} dropped` : 'none to drop'}${left.length ? `; ${left.join(', ')} left (said above)` : ''}`);
    } finally { await later.pool.end(); }
  }
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
