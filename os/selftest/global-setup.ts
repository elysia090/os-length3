// One run of the selftest: the web app as a person meets it, against a
// Remote of its own. Before the first test:
//
//   1. the app is built for a Remote on its own origin (VITE_LENGTH3_REMOTE=''),
//      into selftest/.dist, unless that build is newer than every source;
//   2. a fresh Remote (service/dev.ts) starts on a free port, its data in a
//      new temporary directory: PGlite, blobs, mail.log, nothing kept;
//   3. `vite preview` serves the build on another free port and passes /api
//      and /v1 to that Remote (LENGTH3_DEV_REMOTE), as `vite` does in development.
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
// production runs it (selftest/prod/README.md): in place of 2 and 3, the
// Worker on workerd serving that build and the Remote on one origin, over a
// Postgres 16 of its own reached as remote_worker through the Neon driver.

import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
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

const SOURCES = ['src', 'shared', 'public', 'index.html', 'vite.config.ts', 'package-lock.json'];
const STAMP = join(OUT, '.built');

/** What the build carries besides the sources: the browser's Prompt, when public/ has it. */
const carries = () => JSON.stringify({prompt: existsSync(join(OS, 'public', 'userland', 'l3.json'))});

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
  let r: Awaited<ReturnType<typeof remote>> | null = null;
  const teardown = async () => {
    if (r) writeFileSync(join(LOGS, 'worker.log'), r.log());
    await r?.stop();
    await b.stop();
    pg.destroy();
    rmSync(dir, {recursive: true, force: true});
  };
  try {
    // Each person paid (the plan holds outside research; servers are paid), billing through the stand-in for Stripe.
    r = await remote(pg, {dir, assets: OUT, bridge: b.port, paid: true, plan: {billing: true}});
  } catch (e) {
    await teardown();
    throw e;
  }
  process.env.SELFTEST_APP = process.env.SELFTEST_REMOTE = r.url;
  process.env.SELFTEST_DATA = dir;
  console.log(`selftest: the app and its Remote on ${r.url}: the Worker on workerd, Postgres 16 as remote_worker`);
  return teardown;
}

export default async function globalSetup(_config: FullConfig) {
  mkdirSync(LOGS, {recursive: true});
  build();
  if (process.env.SELFTEST_REMOTE_KIND === 'worker') return worker();
  const data = mkdtempSync(join(tmpdir(), 'length3-selftest-'));
  const [remotePort, appPort] = [await freePort(), await freePort()];
  const app = `http://localhost:${appPort}`;
  const remoteURL = `http://localhost:${remotePort}`;
  const children: ChildProcess[] = [];
  const teardown = async () => {
    await Promise.all(children.map(stop));
    rmSync(data, {recursive: true, force: true});
  };
  // Stopped even when the run itself is cut short (Ctrl-C), not only by the teardown.
  const kill = () => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); };
  process.once('exit', kill);
  try {
    // The Remote's own name is localhost too, so the session it sets on sign-in is the app's.
    children.push(start('remote', ['service/dev.ts', data, String(remotePort), app], {LENGTH3_DEV_BASE: remoteURL}));
    children.push(start('preview', [join(OS, 'node_modules/vite/bin/vite.js'), 'preview', '--outDir', OUT,
      '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {LENGTH3_DEV_REMOTE: `http://127.0.0.1:${remotePort}`}));
    // Through the preview, so both are up and the one passes to the other. (Between the servers and
    // from here, the address itself: what localhost names first, ::1 or 127.0.0.1, is the system's.)
    await ready(`http://127.0.0.1:${appPort}/v1/about`, children);
  } catch (e) {
    await teardown();
    throw e;
  }
  process.env.SELFTEST_APP = app;
  process.env.SELFTEST_REMOTE = `http://127.0.0.1:${remotePort}`;
  process.env.SELFTEST_DATA = data;
  console.log(`selftest: the app on ${app}, its Remote on ${remoteURL}`);
  return async () => {
    process.off('exit', kill);
    await teardown();
  };
}
