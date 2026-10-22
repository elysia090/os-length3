// A Postgres 16 of the selftest's own on this machine: a cluster made in a
// new directory, listening on 127.0.0.1 only (and a socket in its own
// directory), on a free port, stopped and its directory gone at the end.
// What Neon is in production, as close as this machine has: the owner (the
// cluster's superuser here, neondb_owner there) runs the migrations; the
// Worker logs in as remote_worker with a password, over the network
// interface, as Neon's proxy takes a password (cleartext, pipelined: the
// driver's pipelineConnect), never as a superuser.
//
// Postgres will not run as root: when this process is root, the cluster is
// the postgres user's, in a directory under the system's temporary one (a
// home directory of root's is not one it can enter), made 0700.

import {spawnSync, execFileSync} from 'node:child_process';
import {chownSync, existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir, userInfo} from 'node:os';
import {join} from 'node:path';

const BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
const asRoot = userInfo().uid === 0;

/** A port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const p = (s.address() as {port: number}).port;
      s.close(() => resolve(p));
    });
  });
}

/** Run a Postgres program as the cluster's user. */
function pg(program: string, args: string[], o: {input?: string; quiet?: boolean} = {}) {
  const [cmd, argv] = asRoot ? ['runuser', ['-u', 'postgres', '--', join(BIN, program), ...args]] : [join(BIN, program), args];
  const r = spawnSync(cmd, argv, {encoding: 'utf8', input: o.input, cwd: tmpdir()});
  if (r.status !== 0) throw new Error(`${program} ${args.slice(0, 3).join(' ')}: ${r.status}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

export interface Cluster {
  port: number;
  dir: string;
  /** The owner's connection string for `db` (a superuser, on 127.0.0.1, by password). */
  ownerUrl(db?: string): string;
  /** SQL as the owner, through psql; its rows as text, tab separated. */
  psql(sql: string, db?: string): string;
  /** A new empty database. */
  createdb(name: string): void;
  stop(mode?: 'fast' | 'immediate'): void;
  start(): void;
  /** Stopped (immediate: as a crash), then started again: every connection open goes. */
  restart(mode?: 'fast' | 'immediate'): void;
  /** Stopped for good and its directory gone. */
  destroy(): void;
}

export async function cluster(): Promise<Cluster> {
  if (!existsSync(join(BIN, 'postgres'))) throw new Error(`no Postgres at ${BIN} (PG_BIN names another)`);
  const dir = mkdtempSync(join(tmpdir(), 'length3-prod-pg-'));
  if (asRoot) chownSync(dir, Number(execFileSync('id', ['-u', 'postgres']).toString()), Number(execFileSync('id', ['-g', 'postgres']).toString()));
  const data = join(dir, 'data'), sock = dir, port = await freePort();
  const password = `owner${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const pwfile = join(dir, 'pw');
  writeFileSync(pwfile, password, {mode: 0o600});
  if (asRoot) chownSync(pwfile, Number(execFileSync('id', ['-u', 'postgres']).toString()), 0);
  pg('initdb', ['-D', data, '-U', 'owner', '--pwfile', pwfile, '-A', 'scram-sha-256', '--auth-local', 'trust', '-E', 'UTF8', '--locale', 'C.UTF-8'], {quiet: true});
  rmSync(pwfile);
  // Listening on this machine only; remote_worker by password (cleartext over loopback: Neon's proxy takes it
  // so, inside TLS), so the driver pipelines its startup as it does to Neon. Everyone else by SCRAM.
  writeFileSync(join(data, 'pg_hba.conf'), [
    'local all all trust',
    'host all remote_worker 127.0.0.1/32 password',
    'host all all 127.0.0.1/32 scram-sha-256',
  ].join('\n') + '\n');
  const conf = [
    `listen_addresses = '127.0.0.1'`, `port = ${port}`, `unix_socket_directories = '${sock}'`,
    // As a small Neon compute: a few connections at a time, short statements.
    'max_connections = 100', 'shared_buffers = 128MB', 'fsync = on', 'synchronous_commit = on',
    `log_destination = 'stderr'`, 'logging_collector = off', `log_min_messages = warning`,
  ];
  writeFileSync(join(data, 'postgresql.auto.conf'), conf.join('\n') + '\n');
  if (asRoot) execFileSync('chown', ['-R', 'postgres:postgres', data]);
  const log = join(dir, 'postgres.log');
  if (asRoot) { writeFileSync(log, ''); execFileSync('chown', ['postgres:postgres', log]); }
  const start = () => { pg('pg_ctl', ['-D', data, '-l', log, '-w', '-t', '60', 'start']); };
  const stop = (mode: 'fast' | 'immediate' = 'fast') => { pg('pg_ctl', ['-D', data, '-m', mode, '-w', '-t', '60', 'stop']); };
  start();
  const psql = (sql: string, db = 'postgres') => pg('psql', ['-h', sock, '-p', String(port), '-U', 'owner', '-d', db, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {input: sql});
  let gone = false;
  return {
    port, dir,
    ownerUrl: (db = 'postgres') => `postgresql://owner:${password}@127.0.0.1:${port}/${db}`,
    psql,
    createdb: (name) => { psql(`create database "${name}"`); },
    stop, start,
    restart: (mode = 'fast') => { stop(mode); start(); },
    destroy: () => {
      if (gone) return;
      gone = true;
      try { stop('immediate'); } catch { /* already stopped */ }
      rmSync(dir, {recursive: true, force: true});
    },
  };
}
