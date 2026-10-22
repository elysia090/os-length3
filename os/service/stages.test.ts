import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {beforeWorker, firstOf, journalOf} from './stages.ts';

const MIGRATIONS = new URL('./migrations', import.meta.url).pathname;

test('a deploy runs a contract step only after the new Worker answers, and only once', () => {
  const j = journalOf(MIGRATIONS);
  const contract = j.entries.findIndex((e) => /^\d{4}_contract_/.test(e.tag));
  assert.ok(contract > 0, 'there is a contract step');
  // A database with nothing applied, or with every step before the contract one: the contract waits.
  assert.equal(beforeWorker(j, 0), contract);
  assert.equal(beforeWorker(j, j.entries[contract - 1].when), contract);
  // Once it was applied, nothing waits for it again.
  assert.equal(beforeWorker(j, j.entries[contract].when), j.entries.length);
  const made = {entries: [{idx: 0, when: 1, tag: '0000_a'}, {idx: 1, when: 2, tag: '0001_contract_b'}, {idx: 2, when: 3, tag: '0002_c'}, {idx: 3, when: 4, tag: '0003_contract_d'}]};
  assert.equal(beforeWorker(made, 0), 1);
  assert.equal(beforeWorker(made, 2), 3);
  assert.equal(beforeWorker(made, 4), 4);
});

test('SSH: the Worker before keeps working through the expand step; no address is kept after it, and the contract step drops the columns', async () => {
  const j = journalOf(MIGRATIONS);
  const expand = j.entries.findIndex((e) => e.tag.endsWith('_ssh_scope_and_no_address'));
  assert.ok(expand > 0);
  const pg = new PGlite();
  const db = drizzle(pg);
  const upTo = async (n: number) => { const dir = firstOf(MIGRATIONS, n); try { await migrate(db, {migrationsFolder: dir}); } finally { rmSync(dir, {recursive: true}); } };
  await upTo(expand);
  await pg.exec(`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ('u', 'Ren', 'ren@example.test', true, now(), now());
    insert into session (id, expires_at, token, created_at, updated_at, user_id) values ('s', now() + interval '1 day', 't', now(), now(), 'u');
    insert into ssh (session_id, user_id, port, destinations) values ('s', 'u', 22000, '["ssh -p 22000 notes@192.168.1.5"]');`);
  // The expand step: what was said of where is gone, and the Worker before (it writes and reads both columns) still works.
  await upTo(expand + 1);
  assert.deepEqual((await pg.query('select port, destinations, scope from ssh')).rows, [{port: null, destinations: [], scope: 'device'}]);
  await pg.exec(`insert into ssh (session_id, user_id, port, destinations) values ('s', 'u', 22000, '["ssh -p 22000 trip@10.0.0.7"]')
    on conflict (session_id) do update set port = excluded.port, destinations = excluded.destinations`);
  assert.equal((await pg.query('select port, destinations from ssh')).rows.length, 1);
  // The Worker after it writes neither.
  await pg.exec(`delete from ssh; insert into ssh (session_id, user_id, scope) values ('s', 'u', 'network')`);
  await assert.rejects(pg.exec(`update ssh set scope = 'everyone'`));
  // The contract step, once the new Worker answers: the columns, and whatever an old l3 sent meanwhile, are gone.
  await migrate(db, {migrationsFolder: MIGRATIONS});
  const columns = (await pg.query<{column_name: string}>(`select column_name from information_schema.columns where table_name = 'ssh' order by ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ['session_id', 'user_id', 'since', 'seen_at', 'scope']);
  assert.deepEqual((await pg.query('select scope from ssh')).rows, [{scope: 'network'}]);
  await pg.close();
});
