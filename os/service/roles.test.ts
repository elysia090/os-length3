import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inspect} from 'node:util';
import {drizzle} from 'drizzle-orm/pglite';
import {RoleFailed, retireWorkers, WORKER_ROLE, workerName, workerRole} from './neon.ts';
import {database} from './testing.ts';

// The Worker's login role, as deploy.ts makes it (issue #40), and what is said when making it fails (issue #41).

const FAKE = 'FakeTestPassword0123456789abcdef';

/** Everything an error carries, as Node would print it with its causes, hidden fields and all. */
const whole = (e: unknown) => inspect(e, {depth: 20, showHidden: true}) + JSON.stringify(e, Object.getOwnPropertyNames(e as object));

/** What `f` printed while it ran. */
async function printed(f: () => Promise<unknown>): Promise<{out: string; err: unknown}> {
  const said: string[] = [];
  const {log, error, warn} = console;
  console.log = console.error = console.warn = (...a: unknown[]) => { said.push(a.map((x) => inspect(x, {depth: 20})).join(' ')); };
  let err: unknown = null;
  try { await f(); } catch (e) { err = e; } finally { Object.assign(console, {log, error, warn}); }
  return {out: said.join('\n'), err};
}

test('the Worker\'s role is made new, a member of remote_app with its time limits; the ones before it go once it is in use', async () => {
  const pg = await database();
  const db = drizzle(pg) as unknown as Parameters<typeof workerRole>[0];
  try {
    // A deploy before this one, and one that stopped half-way: their roles are there.
    await pg.exec(`create role remote_worker login password 'old'; grant remote_app to remote_worker;
      create role remote_worker_20260101000000 login password 'half';`);
    const name = await workerRole(db, FAKE, 'remote_worker_20261023000000');
    assert.match(name, WORKER_ROLE);
    const [r] = (await pg.query<{super: boolean; createrole: boolean; createdb: boolean; login: boolean; app: boolean; config: string[]}>(`select rolsuper as super,
      rolcreaterole as createrole, rolcreatedb as createdb, rolcanlogin as login, pg_has_role(rolname, 'remote_app', 'member') as app, rolconfig as config
      from pg_roles where rolname = $1`, [name])).rows;
    assert.deepEqual({...r, config: [...r.config].sort()}, {super: false, createrole: false, createdb: false, login: true, app: true,
      config: ["idle_in_transaction_session_timeout=15s", 'lock_timeout=5s', 'statement_timeout=15s']});
    // Never changed: asked for again by the same name, it is refused, not altered.
    await assert.rejects(workerRole(db, FAKE, name), /there already/);
    const gone = await retireWorkers(db, name);
    assert.deepEqual(gone, {dropped: ['remote_worker', 'remote_worker_20260101000000'], left: []});
    assert.deepEqual((await pg.query<{n: string}>(`select rolname as n from pg_roles where rolname like 'remote_worker%'`)).rows.map((x) => x.n), [name]);
  } finally { await pg.close(); }
});

test('a role\'s name is one of the Worker\'s names, by when it is made', () => {
  assert.equal(workerName(new Date('2026-10-23T06:20:18.123Z')), 'remote_worker_20261023062018');
  assert.match(workerName(), WORKER_ROLE);
  assert.doesNotMatch('remote_worker_1; drop table x', WORKER_ROLE);
});

test('making the role refused (an owner without CREATEROLE): the step, its SQLSTATE and Postgres\'s words are said, never the password', async () => {
  const pg = await database();
  const db = drizzle(pg) as unknown as Parameters<typeof workerRole>[0];
  try {
    await pg.exec(`create role weak login; set role weak;`);
    const {out, err} = await printed(() => workerRole(db, FAKE, 'remote_worker_20261023000001'));
    assert.ok(err instanceof RoleFailed, String(err));
    assert.equal((err as RoleFailed).code, '42501');
    assert.match((err as Error).message, /remote_worker_20261023000001: create: refused \(SQLSTATE 42501\): permission denied/);
    assert.equal((err as Error).cause, undefined);
    assert.ok(!whole(err).includes(FAKE), whole(err));
    assert.ok(!out.includes(FAKE), out);
  } finally { await pg.close(); }
});

test('a failure that carries the statement, its parameters and causes (as Drizzle\'s does) leaves none of them in what is thrown or printed', async () => {
  const leak = `ALTER ROLE remote_worker WITH LOGIN PASSWORD '${FAKE}'`;
  const pgError = Object.assign(new Error('permission denied to alter role'), {code: '42501', detail: 'Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.', query: leak});
  const drizzleError = Object.assign(new Error(`Failed query: ${leak}\nparams: ${FAKE}`, {cause: pgError}), {query: leak, params: [FAKE]});
  const fake = {execute: async (q: unknown) => {
    // The read of pg_roles answers; the statement that carries the password fails as Drizzle fails.
    if (inspect(q, {depth: 10}).includes('pg_roles')) return {rows: []};
    throw drizzleError;
  }} as unknown as Parameters<typeof workerRole>[0];
  const {out, err} = await printed(() => workerRole(fake, FAKE, 'remote_worker_20261023000002'));
  assert.ok(err instanceof RoleFailed);
  assert.match((err as Error).message, /SQLSTATE 42501\): permission denied to alter role Only roles with the SUPERUSER attribute/);
  assert.ok(!whole(err).includes(FAKE), whole(err));
  assert.ok(!out.includes(FAKE), out);
  // A failure with no SQLSTATE says none, and still nothing of the statement (its words may quote it).
  const odd = {execute: async (q: unknown) => { if (inspect(q, {depth: 10}).includes('pg_roles')) return {rows: []}; throw new Error(`syntax error at or near "${FAKE}"`); }} as unknown as Parameters<typeof workerRole>[0];
  const other = await printed(() => workerRole(odd, FAKE, 'remote_worker_20261023000003'));
  assert.match((other.err as Error).message, /create: refused \(SQLSTATE none\)$/);
  assert.ok(!whole(other.err).includes(FAKE));
});
