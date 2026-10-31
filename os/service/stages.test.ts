import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {test} from 'node:test';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {beforeWorker, firstOf, journalOf} from './stages.ts';
import {initdbDatabase} from './testing.ts';

const MIGRATIONS = new URL('./migrations', import.meta.url).pathname;

test('a deploy runs a contract step only after the new Worker answers, and only once', () => {
  const j = journalOf(MIGRATIONS);
  const contract = j.entries.findIndex((e) => /^\d{4}_contract_/.test(e.tag));
  assert.ok(contract > 0, 'there is a contract step');
  // A database with nothing applied, or with every step before the contract one: the contract waits.
  assert.equal(beforeWorker(j, 0), contract);
  assert.equal(beforeWorker(j, j.entries[contract - 1].when), contract);
  // Once it was applied, nothing waits for it again: what runs before the Worker is everything up to the next one.
  const next = j.entries.findIndex((e, i) => i > contract && /^\d{4}_contract_/.test(e.tag));
  assert.equal(beforeWorker(j, j.entries[contract].when), next < 0 ? j.entries.length : next);
  const made = {entries: [{idx: 0, when: 1, tag: '0000_a'}, {idx: 1, when: 2, tag: '0001_contract_b'}, {idx: 2, when: 3, tag: '0002_c'}, {idx: 3, when: 4, tag: '0003_contract_d'}]};
  assert.equal(beforeWorker(made, 0), 1);
  assert.equal(beforeWorker(made, 2), 3);
  assert.equal(beforeWorker(made, 4), 4);
});

test('SSH: the Worker before keeps working through the expand step; no address is kept after it, and the contract step drops the columns', async () => {
  const j = journalOf(MIGRATIONS);
  const expand = j.entries.findIndex((e) => e.tag.endsWith('_ssh_scope_and_no_address'));
  assert.ok(expand > 0);
  const pg = await initdbDatabase();
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

test('drafts as rows: the Worker before stays in step through the expand step until the new one changes a line; the contract step drops draft', async () => {
  const j = journalOf(MIGRATIONS);
  const expand = j.entries.findIndex((e) => /^\d{4}_draft_as_rows$/.test(e.tag));
  assert.ok(expand > 0);
  const pg = await initdbDatabase();
  const db = drizzle(pg);
  const upTo = async (n: number) => { const dir = firstOf(MIGRATIONS, n); try { await migrate(db, {migrationsFolder: dir}); } finally { rmSync(dir, {recursive: true}); } };
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(64));
  const rows = async (l = 'main') => (await pg.query(`select f.path, f.sha from line_file f where f.line = '${l}' order by f.path`)).rows;
  const counted = async (l = 'main') => (await pg.query<{draft: unknown; paths: number; bytes: number; files: number}>(`select draft, paths, bytes, file_bytes::int as files from line where name = '${l}'`)).rows[0];
  await upTo(expand);
  await pg.exec(`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ('u', 'Ren', 'ren@example.test', true, now(), now());
    insert into blob (user_id, sha256, bytes) values ('u', '${a}', 10), ('u', '${b}', 20), ('u', '${c}', 40);
    insert into repo (user_id, name) values ('u', 'r');
    insert into line (repo_id, name, user_id, draft, version) select id, 'main', 'u', '{"a.txt": "${a}", "d": null}', 1 from repo`);
  const bytes = Number((await pg.query<{n: number}>(`select octet_length(draft::text) as n from line`)).rows[0].n);
  // The expand step: every draft as rows, counted as it was.
  await upTo(expand + 1);
  assert.deepEqual(await rows(), [{path: 'a.txt', sha: a}, {path: 'd', sha: null}]);
  assert.deepEqual(await counted(), {draft: {'a.txt': a, d: null}, paths: 2, bytes, files: 10});
  // The Worker before, saving as it does (the draft whole, or laid on where it is): the rows and the counts follow.
  await pg.exec(`update line set draft = (draft - array['d']) || '{"b.txt": "${b}"}', version = 2`);
  assert.deepEqual(await rows(), [{path: 'a.txt', sha: a}, {path: 'b.txt', sha: b}]);
  assert.deepEqual({...await counted(), draft: undefined}, {draft: undefined, paths: 2, bytes: Number((await pg.query<{n: number}>(`select octet_length(draft::text) as n from line`)).rows[0].n), files: 30});
  // ... and making a line of work, its draft with it.
  await pg.exec(`insert into line (repo_id, name, user_id, draft, version) select id, '001', 'u', '{"c.txt": "${c}"}', 1 from repo`);
  assert.deepEqual(await rows('001'), [{path: 'c.txt', sha: c}]);
  // The new Worker changes the line (its version moves, draft never named): the Worker before can no more read its draft,
  // and what it would write there is refused as the database busy, laid whole or laid on where it is.
  await pg.exec(`update line set version = 3, paths = 3 where name = 'main'; insert into line_file (repo_id, line, path, sha) select id, 'main', 'c.txt', '${c}' from repo`);
  assert.equal((await counted()).draft, null);
  for (const write of [`update line set draft = '{}', version = 4 where name = 'main'`, `update line set draft = draft || '{"x": null}', version = 4 where name = 'main'`]) {
    await assert.rejects(pg.exec(write), (e: {code?: string}) => e.code === '40001');
  }
  assert.equal((await rows()).length, 3);
  // A line it makes has no draft to read.
  await pg.exec(`insert into line (repo_id, name, user_id, version) select id, '002', 'u', 1 from repo`);
  assert.equal((await counted('002')).draft, null);
  // The Worker before's sweep, which reads blobs' names from drafts, cannot take a blob only the rows name.
  await pg.exec(`delete from blob where sha256 = '${c}'`);
  assert.equal((await pg.query(`select 1 from blob where sha256 = '${c}'`)).rows.length, 1);
  // The contract step, once the new Worker answers: draft and what kept the Worker before in step are gone.
  await migrate(db, {migrationsFolder: MIGRATIONS});
  const columns = (await pg.query<{column_name: string}>(`select column_name from information_schema.columns where table_name = 'line'`)).rows.map((r) => r.column_name);
  assert.ok(!columns.includes('draft') && columns.includes('paths'));
  await pg.exec(`delete from line_file where sha = '${c}'; delete from blob where sha256 = '${c}'`);
  assert.equal((await pg.query(`select 1 from blob where sha256 = '${c}'`)).rows.length, 0);
  await pg.close();
});
