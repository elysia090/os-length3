// One run of the selftest: the web app as a person meets it, against a
// Remote of its own. Before the first test:
//
//   1. the app is built for a Remote on its own origin (VITE_LENGTH3_REMOTE=''),
//      into selftest/.dist, unless that build is newer than every source;
//   2. a fresh Remote (service/dev.ts) starts on a free port, its data in a
//      new temporary directory: PGlite, blobs, mail.log, nothing kept (off
//      CI, its database a copy of an empty one made once, in selftest/.pg);
//   3. `vite preview` serves the build on another free port and passes /api
//      and /v1 to that Remote (LENGTH3_DEV_REMOTE), as `vite` does in development;
//   4. beside them, the same again for a Remote with the plan (LENGTH3_PLAN=1:
//      the free allowance, the tiers, and Stripe's stand-in, devbilling.ts),
//      started at the same time, for the specs about paying (SELFTEST_PLAN_APP).
//      Every other spec meets a Remote with no plan, where everything is open.
//
// Both are reached by the name localhost (bound to 127.0.0.1): a passkey's
// relying party is a domain, never an address, so Chromium's virtual
// authenticator (fixtures.ts) works only there, and the session cookie the
// Remote sets is the app's because cookies do not tell ports apart.
//
// The function returned is the teardown: both stop and the directory goes,
// however the tests went. Nothing listens on a fixed port, so runs (and
// other work on this machine) never meet.
//
// SELFTEST_REMOTE_KIND=worker runs the same tests against the Remote as
// production runs it (selftest/prod/README.md): in place of 2 to 4, the
// Worker on workerd serving that build and the Remote on one origin, over a
// Postgres 16 of its own reached as remote_worker through the Neon driver
// (and a second, its people free until they pay, for the specs about paying).

import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {cp} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FullConfig} from '@playwright/test';
import {OS, OUT, LOGS} from './paths.ts';

/** A port nothing listens on now, chosen by the system. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const {port} = s.address() as {port: number};
      s.close(() => resolve(port));
    });
  });
}

/** The newest change under `path` (a file or a directory, walked). */
function newest(path: string): number {
  if (!existsSync(path)) return 0;
  // A link made or changed counts as a change, as what it points to does.
  const s = statSync(path);
  let n = Math.max(s.mtimeMs, lstatSync(path).mtimeMs);
  if (!s.isDirectory()) return n;
  for (const e of readdirSync(path)) n = Math.max(n, newest(join(path, e)));
  return n;
}

// The core the browser runs (core/web, built by vite.config.ts) is made from core/src.
const SOURCES = ['src', 'shared', 'public', 'index.html', 'vite.config.ts', 'package-lock.json', 'core/src', 'core/web/src', 'scripts/core-wasm.ts'];
const STAMP = join(OUT, '.built');

/** What the build carries besides the sources: the browser's Prompt, when public/ has it. */
const carries = () => JSON.stringify({prompt: existsSync(join(OS, 'public', 'l3', 'l3.json'))});

/** Build unless selftest/.dist is newer than everything it is made from, and carries the same. */
function build() {
  const made = existsSync(STAMP) ? statSync(STAMP).mtimeMs : 0;
  const changed = Math.max(...SOURCES.map((s) => newest(join(OS, s))));
  if (made > changed && readFileSync(STAMP, 'utf8') === carries()) { console.log('selftest: the build in selftest/.dist is fresh'); return; }
  console.log('selftest: building the app for a Remote on its own origin');
  const r = spawnSync(process.execPath, [join(OS, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', OUT, '--logLevel', 'warn'],
    {cwd: OS, stdio: 'inherit', env: {...process.env, VITE_LENGTH3_REMOTE: ''}});
  if (r.status !== 0) throw new Error('selftest: the build failed');
  writeFileSync(STAMP, carries());
}

/** Where an empty Remote's database is kept between runs, made once for what it is made from (`emptyDatabase`). */
const KEPT = join(OS, 'selftest', '.pg');

/** Every file under `path`, walked in order, with its contents, into `hash`. */
function hashTree(hash: ReturnType<typeof createHash>, path: string) {
  if (!statSync(path).isDirectory()) { hash.update(path.slice(OS.length)).update(readFileSync(path)); return; }
  for (const e of readdirSync(path).sort()) hashTree(hash, join(path, e));
}

/**
 * An empty Remote's database (PGlite's directory, migrated), made the first time and kept in selftest/.pg, named by
 * what makes it (PGlite's and drizzle's versions, the migrations): each Remote of a run starts from a copy of it. A
 * cluster made anew (PGlite's initdb, in WebAssembly) and migrated was two thirds of a Remote's start, the same each
 * time. What the Remote does with an empty database (the migrations it finds done, the sweep) it still does. Not on
 * CI, where nothing is kept from one run to the next: there each Remote makes its own, the two at once, as before
 * (one made first and copied would be the slower).
 */
async function emptyDatabase(): Promise<string> {
  const migrations = join(OS, 'service', 'migrations');
  const hash = createHash('sha256');
  for (const pkg of ['@electric-sql/pglite', 'drizzle-orm']) hash.update(readFileSync(join(OS, 'node_modules', pkg, 'package.json')));
  hashTree(hash, migrations);
  const name = hash.digest('hex').slice(0, 16);
  const kept = join(KEPT, name);
  if (existsSync(kept)) return kept;
  console.log('selftest: making an empty database for the Remotes to start from');
  mkdirSync(KEPT, {recursive: true});
  // Made beside where it is kept, then put there whole: a run that stops halfway leaves nothing taken for it.
  const making = mkdtempSync(join(KEPT, 'making-'));
  try {
    const [{PGlite}, {drizzle}, {migrate}] = await Promise.all([import('@electric-sql/pglite'), import('drizzle-orm/pglite'), import('drizzle-orm/pglite/migrator')]);
    const pg = new PGlite(join(making, 'pg'));
    await migrate(drizzle(pg), {migrationsFolder: migrations});
    await pg.close();
    // Another run may have kept the same meanwhile: either is the same database.
    try { renameSync(join(making, 'pg'), kept); } catch (e) { if (!existsSync(kept)) throw e; }
  } finally {
    rmSync(making, {recursive: true, force: true});
  }
  // What an earlier PGlite or migration made is not started from again.
  for (const e of readdirSync(KEPT)) if (e !== name && !e.startsWith('making-')) rmSync(join(KEPT, e), {recursive: true, force: true});
  return kept;
}

/**
 * The directory `from` copied as `to`: by the system's cp, which copies a database's thousand small files four times
 * as fast as node's copy does, or by node's where there is no cp.
 */
function copyDir(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let none = false;
    const c = spawn('cp', ['-R', from, to], {stdio: 'ignore'});
    c.once('error', () => { none = true; cp(from, to, {recursive: true}).then(resolve, reject); });
    c.once('close', (code) => { if (!none) { if (code === 0) resolve(); else reject(new Error(`selftest: cp -R ${from} ${to} ended with ${code}`)); } });
  });
}

/** Start `args` with node, its output in logs/<name>.log. */
function start(name: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const log = createWriteStream(join(LOGS, `${name}.log`));
  const child = spawn(process.execPath, args, {cwd: OS, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  return child;
}

/** Ask `url` until it answers 200, or the child dies, or a minute passes. */
async function ready(url: string, children: ChildProcess[]) {
  const until = Date.now() + 60_000;
  for (;;) {
    const dead = children.find((c) => c.exitCode !== null);
    if (dead) throw new Error(`selftest: a server exited (${dead.exitCode}) before answering; see selftest/.logs`);
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error(`selftest: ${url} did not answer within a minute; see selftest/.logs`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(hard); resolve(); });
    child.kill('SIGTERM');
  });
}

/** The production-like Remote (selftest/prod): Postgres, the bridge, the Worker on workerd serving the build. */
async function worker(): Promise<() => Promise<void>> {
  const {cluster} = await import('./prod/postgres.ts');
  const {remote, bridgeProcess} = await import('./prod/stack.ts');
  const pg = await cluster();
  const b = await bridgeProcess().catch((e) => { pg.destroy(); throw e; });
  const dir = mkdtempSync(join(tmpdir(), 'length3-selftest-worker-'));
  const made: Awaited<ReturnType<typeof remote>>[] = [];
  const teardown = async () => {
    for (const [i, x] of made.entries()) writeFileSync(join(LOGS, i ? 'worker-plan.log' : 'worker.log'), x.log());
    await Promise.all(made.map((x) => x.stop()));
    await b.stop();
    pg.destroy();
    rmSync(dir, {recursive: true, force: true});
  };
  let r: Awaited<ReturnType<typeof remote>>, plan: Awaited<ReturnType<typeof remote>>;
  try {
    // Each person paid (the plan holds outside research; servers are paid), billing through the stand-in for Stripe;
    // and, at the same time, one whose people are free until they pay there, for the specs about paying.
    const both = await Promise.allSettled([remote(pg, {dir: join(dir, 'paid'), assets: OUT, bridge: b.port, paid: true, plan: {billing: true}}),
      remote(pg, {dir: join(dir, 'plan'), assets: OUT, bridge: b.port, plan: {billing: true}})]);
    for (const x of both) if (x.status === 'fulfilled') made.push(x.value);
    const failed = both.find((x) => x.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    [r, plan] = made;
  } catch (e) {
    await teardown();
    throw e;
  }
  process.env.SELFTEST_APP = process.env.SELFTEST_REMOTE = r.url;
  process.env.SELFTEST_PLAN_APP = process.env.SELFTEST_PLAN_REMOTE = plan.url;
  process.env.SELFTEST_DATA = dir;
  console.log(`selftest: the app and its Remote on ${r.url}: the Worker on workerd, Postgres 16 as remote_worker`);
  return teardown;
}

export default async function globalSetup(_config: FullConfig) {
  mkdirSync(LOGS, {recursive: true});
  build();
  if (process.env.SELFTEST_REMOTE_KIND === 'worker') return worker();
  const empty = process.env.CI ? null : await emptyDatabase();
  const data = mkdtempSync(join(tmpdir(), 'length3-selftest-'));
  const [remotePort, appPort, planRemotePort, planAppPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const app = `http://localhost:${appPort}`, planApp = `http://localhost:${planAppPort}`;
  const remoteURL = `http://localhost:${remotePort}`;
  const children: ChildProcess[] = [];
  const teardown = async () => {
    await Promise.all(children.map(stop));
    rmSync(data, {recursive: true, force: true});
  };
  // Stopped even when the run itself is cut short (Ctrl-C), not only by the teardown.
  const kill = () => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); };
  process.once('exit', kill);
  /** A Remote (its data in `dir` under the run's; off CI, its database a copy of the empty one) and the preview that passes to it, `name` naming their logs. */
  const pair = async (name: string, dir: string, rPort: number, aPort: number, env: NodeJS.ProcessEnv = {}) => {
    if (empty) {
      mkdirSync(join(data, dir));
      await copyDir(empty, join(data, dir, 'pg'));
    }
    const at = `http://localhost:${aPort}`;
    // The Remote's own name is localhost too, so the session it sets on sign-in is the app's.
    children.push(start(`remote${name}`, ['service/dev.ts', join(data, dir), String(rPort), at], {LENGTH3_DEV_BASE: `http://localhost:${rPort}`, ...env}));
    children.push(start(`preview${name}`, [join(OS, 'node_modules/vite/bin/vite.js'), 'preview', '--outDir', OUT,
      '--host', '127.0.0.1', '--port', String(aPort), '--strictPort'], {LENGTH3_DEV_REMOTE: `http://127.0.0.1:${rPort}`}));
    // Through the preview, so both are up and the one passes to the other. (Between the servers and
    // from here, the address itself: what localhost names first, ::1 or 127.0.0.1, is the system's.)
    return ready(`http://127.0.0.1:${aPort}/v1/about`, children);
  };
  try {
    // The two at once: the Remote with the plan costs the run no time of its own.
    await Promise.all([pair('', 'open', remotePort, appPort), pair('-plan', 'plan', planRemotePort, planAppPort, {LENGTH3_PLAN: '1'})]);
  } catch (e) {
    await teardown();
    throw e;
  }
  process.env.SELFTEST_APP = app;
  process.env.SELFTEST_REMOTE = `http://127.0.0.1:${remotePort}`;
  process.env.SELFTEST_PLAN_APP = planApp;
  process.env.SELFTEST_PLAN_REMOTE = `http://127.0.0.1:${planRemotePort}`;
  process.env.SELFTEST_DATA = join(data, 'open');
  console.log(`selftest: the app on ${app}, its Remote on ${remoteURL}; with the plan, ${planApp}`);
  return async () => {
    process.off('exit', kill);
    await teardown();
  };
}
