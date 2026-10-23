// The production-like Remote, one at a time: a database of its own in the
// selftest's Postgres (postgres.ts), migrated and given remote_worker as
// deploy.ts does it (neon.ts migrateBeforeWorker, workerRole, then once the
// Worker answers migrateRemote for a contract step that waited; through the
// Worker's own driver), and the Worker on workerd (`wrangler dev --local`)
// from a configuration made from wrangler.toml, serving the built app as
// Workers Assets do and the Remote on the same origin, with local R2.
//
// What differs from wrangler.toml, and why (nothing else does):
//   main             selftest/prod/worker.ts: service/worker.ts with the driver pointed at the bridge
//   assets           the build given (the app built for its own origin, as build:cloudflare builds it)
//   run_worker_first also /dev-oauth/*, /dev-billing/* (the stand-ins' pages) and /__scheduled (the cron, fired)
//   [vars]           BASE_URL and APP_ORIGIN are http://localhost:PORT (one origin, as os.length3.com is);
//                    ENTER_AS only for a Remote for research; LOCAL_WS_PROXY, DEV_SIGN_IN, LOCAL_STRIPE
//   routes           none (custom domains are Cloudflare's)
//   r2_buckets       left out for a Remote without a bucket
// Secrets are in a .dev.vars beside that configuration, throwaway values
// made for this run, in a directory of its own that goes at the end.

import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {DEV_PRICES} from '../../service/devbilling.ts';
import {migrateBeforeWorker, migrateRemote, owner, reach, workerRole} from '../../service/neon.ts';
import {freePort, type Cluster} from './postgres.ts';

export const OS = fileURLToPath(new URL('../..', import.meta.url));
const WRANGLER = join(OS, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export interface RemoteOptions {
  /** Where its configuration, secrets, R2 and log are kept (made if need be). */
  dir: string;
  /** The built app to serve. */
  assets: string;
  /** The bridge (wsbridge.ts) the Worker's driver reaches Postgres through. */
  bridge: number;
  /** A Remote for research: the one account and its key. */
  enter?: {as: string; key: string};
  /** The plan (as on a Remote that is not for research), FREE_REPOS and FREE_MB as given; billing through the stand-in for Stripe. */
  plan?: {freeRepos?: string; freeMb?: string; billing?: boolean};
  /**
   * Every account made is paid (a year), as if each had subscribed: the plan holds on a Remote that is
   * not for research, and the app's selftest makes servers, which the plan gives only to paid accounts.
   * A trigger in this database alone, made by the owner; the Worker and its configuration are as ever.
   */
  paid?: boolean;
  /** No R2 bound: the Remote holds no files. */
  noBucket?: boolean;
  /** The port (a free one when not given). */
  port?: number;
  /** The name it is reached by: localhost (passkeys need a name, not an address), or 127.0.0.1. */
  host?: 'localhost' | '127.0.0.1';
}

export interface Remote {
  url: string;
  port: number;
  db: string;
  /** remote_worker's connection string (what the Worker has as DATABASE_URL). */
  databaseUrl: string;
  /** What the Worker is given: its vars and its secrets. */
  env: Record<string, string>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The daily sweep, now (the Cron Trigger, as wrangler dev's /__scheduled fires it). */
  sweep(): Promise<number>;
  log(): string;
}

/** wrangler.toml's own settings, read as the deploy reads it. */
function production() {
  const toml = readFileSync(join(OS, 'wrangler.toml'), 'utf8');
  const one = (k: string) => new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm').exec(toml)?.[1].trim();
  const section = (name: string) => {
    const at = toml.indexOf(`\n${name}\n`);
    if (at < 0) return '';
    const rest = toml.slice(at + name.length + 2);
    return rest.slice(0, rest.search(/\n\[/) < 0 ? undefined : rest.search(/\n\[/));
  };
  const vars: Record<string, string> = {};
  for (const m of section('[vars]').matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)) vars[m[1]] = m[2];
  return {
    compatibilityDate: one('compatibility_date')!, compatibilityFlags: one('compatibility_flags')!,
    notFound: one('not_found_handling')!, runWorkerFirst: JSON.parse(one('run_worker_first')!) as string[],
    crons: one('crons')!, binding: one('binding')!, bucket: one('bucket_name')!, vars,
  };
}

const q = (s: string) => JSON.stringify(s);

/** Without proxies: the Worker on this machine reaches nothing but this machine. */
function localEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, WRANGLER_SEND_METRICS: 'false', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1'};
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) delete env[k];
  return env;
}

/**
 * The app built for a Remote on its own origin, as build:cloudflare builds it (public/ with it, its
 * _headers too; without the Prompt's files unless public/ has them): PROD_ASSETS when the run built it
 * already (run.ts), else a build of its own in a new directory.
 */
export function appBuild(): string {
  const given = process.env.PROD_ASSETS;
  if (given && existsSync(join(given, 'index.html'))) return given;
  const out = mkdtempSync(join(tmpdir(), 'length3-prod-app-'));
  // Its own build goes when this process does.
  process.once('exit', () => rmSync(out, {recursive: true, force: true}));
  const r = spawnSync(process.execPath, [join(OS, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', out, '--logLevel', 'error'],
    {cwd: OS, stdio: 'inherit', env: {...process.env, VITE_LENGTH3_REMOTE: ''}});
  if (r.status !== 0) throw new Error('the app did not build');
  return out;
}

let made = 0;
/** A production-like Remote on `pg`, started. */
/** Worker roles made on this machine so far (their names, by the moment and this count, never meet). */
let roles = 0;

export async function remote(pg: Cluster, o: RemoteOptions): Promise<Remote> {
  mkdirSync(o.dir, {recursive: true});
  const port = o.port ?? await freePort();
  const url = `http://${o.host ?? 'localhost'}:${port}`;
  const db = `remote_${process.pid}_${++made}_${randomBytes(2).toString('hex')}`;
  pg.createdb(db);

  // As deploy.ts: the migrations the running Worker can meet as the owner (a contract step waits for the
  // new Worker: stages.ts), then remote_worker, through the Worker's driver.
  const reached = await reach(pg.ownerUrl(db));
  const own = owner(pg.ownerUrl(db));
  const password = randomBytes(18).toString('hex');
  let waiting: string | null = null, role = '';
  try {
    waiting = await migrateBeforeWorker(own.db);
    // A role of its own for each Remote on this cluster (roles are the cluster's), named as deploy.ts names them.
    role = await workerRole(own.db, password, `remote_worker_${String(Date.now() * 10 + (++roles % 10)).padStart(14, '0').slice(-14)}`);
    // It connects to this database (Neon's role may connect to its own; here, said so).
    await own.db.execute(sql.raw(`grant connect on database "${db}" to ${role}`));
    if (o.paid) await own.db.execute(sql.raw(`create function selftest_paid() returns trigger language plpgsql as $$ begin
        insert into plan (user_id, customer, subscription, status, period_end) values (new.id, 'cus_selftest' || md5(new.id), 'sub_selftest' || md5(new.id), 'active', now() + interval '365 days');
        return new; end $$`));
    if (o.paid) await own.db.execute(sql.raw('create trigger selftest_paid after insert on "user" for each row execute function selftest_paid()'));
  } finally {
    await own.pool.end();
    await reached.close();
  }
  const databaseUrl = `postgresql://${role}:${password}@127.0.0.1:${pg.port}/${db}`;

  const p = production();
  const vars: Record<string, string> = {...p.vars, BASE_URL: url, APP_ORIGIN: url, DOMAIN: 'length3.test',
    LOCAL_WS_PROXY: `127.0.0.1:${o.bridge}`, DEV_SIGN_IN: o.enter ? '0' : '1'};
  delete vars.ENTER_AS;
  if (o.enter) vars.ENTER_AS = o.enter.as;
  if (o.plan?.freeRepos) vars.FREE_REPOS = o.plan.freeRepos;
  if (o.plan?.freeMb) vars.FREE_MB = o.plan.freeMb;
  // Each tier's price as the stand-in for Stripe has it (devbilling.ts DEV_PRICES).
  if (o.plan?.billing) { Object.assign(vars, {STRIPE_PRICE_GO: DEV_PRICES.go, STRIPE_PRICE_PRO: DEV_PRICES.pro, STRIPE_PRICE_MAX: DEV_PRICES.max}); vars.LOCAL_STRIPE = '1'; }
  const config = [
    `name = "os-length3-prodlike"`,
    `main = ${q(join(OS, 'selftest', 'prod', 'worker.ts'))}`,
    `compatibility_date = ${p.compatibilityDate}`,
    `compatibility_flags = ${p.compatibilityFlags}`,
    '', '[assets]', `directory = ${q(o.assets)}`, `not_found_handling = ${p.notFound}`,
    `run_worker_first = ${JSON.stringify([...p.runWorkerFirst, '/dev-oauth/*', '/dev-billing/*', '/__scheduled'])}`,
    '', '[vars]', ...Object.entries(vars).map(([k, v]) => `${k} = ${q(v)}`),
    '', '[triggers]', `crons = ${p.crons}`,
    ...(o.noBucket ? [] : ['', '[[r2_buckets]]', `binding = ${p.binding}`, `bucket_name = ${p.bucket}`]),
  ].join('\n') + '\n';
  writeFileSync(join(o.dir, 'wrangler.toml'), config);
  const secrets: Record<string, string> = {DATABASE_URL: databaseUrl, BETTER_AUTH_SECRET: randomBytes(36).toString('base64url')};
  if (o.enter) secrets.ENTER_KEY = o.enter.key;
  if (o.plan?.billing) { secrets.STRIPE_SECRET_KEY = 'sk_test_standin'; secrets.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(18).toString('hex')}`; }
  writeFileSync(join(o.dir, '.dev.vars'), Object.entries(secrets).map(([k, v]) => `${k}=${q(v)}`).join('\n') + '\n', {mode: 0o600});

  let child: ChildProcess | null = null;
  let log = '';
  async function start() {
    const c = child = spawn(process.execPath, [WRANGLER, 'dev', '--config', join(o.dir, 'wrangler.toml'), '--local', '--ip', '127.0.0.1', '--port', String(port),
      '--inspector-port', String(await freePort()), '--persist-to', join(o.dir, 'state'), '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', 'log'],
    {cwd: o.dir, env: localEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    c.stdout!.on('data', (d: Buffer) => { log += d; });
    c.stderr!.on('data', (d: Buffer) => { log += d; });
    const until = Date.now() + 120_000;
    for (;;) {
      if (c.exitCode !== null) throw new Error(`wrangler dev stopped (${c.exitCode}) before it answered:\n${log.slice(-4000)}`);
      try { if ((await fetch(`${url}/v1/health`)).ok) return; } catch { /* not yet */ }
      if (Date.now() > until) throw new Error(`the Worker did not answer at ${url} within two minutes:\n${log.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  async function stop() {
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const gone = new Promise((r) => c.once('exit', r));
    // Its whole group: wrangler and the workerd it started.
    try { process.kill(-c.pid!, 'SIGTERM'); } catch { /* gone */ }
    const hard = setTimeout(() => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }, 5000);
    await gone;
    clearTimeout(hard);
  }
  process.once('exit', () => { if (child?.pid && child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  await start();
  // The new Worker answers: the contract step and those after it, as deploy.ts runs them then.
  if (waiting) {
    const again = await reach(pg.ownerUrl(db));
    const later = owner(pg.ownerUrl(db));
    try { await migrateRemote(later.db); } finally { await later.pool.end(); await again.close(); }
    log += `\nselftest: migrations from ${waiting} applied once the Worker answered\n`;
  }
  return {
    url, port, db, databaseUrl, env: {...vars, ...secrets}, start, stop,
    sweep: async () => (await fetch(`${url}/__scheduled?cron=${encodeURIComponent(p.crons.replace(/[[\]"]/g, ''))}`)).status,
    log: () => log,
  };
}

/** The bridge (wsbridge.ts) in a process of its own; its port, and how to stop it. */
export async function bridgeProcess(delay = 0): Promise<{port: number; stop(): Promise<void>; control(path: string, method?: string): Promise<any>}> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = spawn(process.execPath, [join(OS, 'selftest', 'prod', 'wsbridge.ts'), '--delay', String(delay)], {stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    c.stdout!.on('data', (d: Buffer) => { out += d; const m = /wsbridge (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    c.once('exit', (code) => reject(new Error(`wsbridge stopped (${code})`)));
  });
  process.once('exit', () => c.kill('SIGKILL'));
  return {
    port,
    stop: () => new Promise<void>((r) => { if (c.exitCode !== null) return r(); c.once('exit', () => r()); c.kill('SIGTERM'); }),
    control: async (path, method = 'POST') => (await fetch(`http://127.0.0.1:${port}${path}`, {method})).json(),
  };
}
