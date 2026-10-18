// The Remote's hot queries on a Postgres 16 with rows as a Remote in use has
// them, each EXPLAIN ANALYZEd (README.md here): which index each takes, what
// it reads, how long it runs. The rows are made in SQL (as the owner, the
// triggers' bookkeeping done by hand), many accounts and one heavy one, whose
// figures are what is shown: a poll is only as quick as its slowest account.
//
//   node selftest/prod/explain.ts [--scale K]   (K: 1 is 5,000 accounts; rows grow with it)

import {cluster} from './postgres.ts';
import {migrateRemote, owner, reach} from '../../service/neon.ts';

const argv = process.argv.slice(2);
const K = argv.includes('--scale') ? Number(argv[argv.indexOf('--scale') + 1]) : 1;
const U = 5000 * K;

const pg = await cluster();
try {
  pg.createdb('remote');
  const reached = await reach(pg.ownerUrl('remote'));
  const own = owner(pg.ownerUrl('remote'));
  await migrateRemote(own.db);
  await own.pool.end();
  await reached.close();
  const t0 = Date.now();
  const sha = (expr: string) => `encode(sha256(convert_to(${expr}, 'UTF8')), 'hex')`;
  // A tree of n files, named and digested by `seed`.
  const tree = (n: number, seed: string) => `(select jsonb_object_agg('src/f' || k || '.ts', ${sha(`${seed} || ':' || k`)}) from generate_series(1, ${n}) k)`;
  pg.psql(`
set session_replication_role = replica;
insert into "user" (id, name, email, email_verified) select 'u' || i, 'Person ' || i, 'p' || i || '@x.test', true from generate_series(1, ${U}) i;
insert into room (user_id, used, unswept) select 'u' || i, 0, i % 50 = 0 from generate_series(1, ${U}) i;
insert into session (id, expires_at, token, updated_at, user_id) select 's' || i, now() at time zone 'utc' + interval '30 days' - (i % 40) * interval '1 day', md5('t' || i), now(), 'u' || (1 + i % ${U}) from generate_series(1, ${2 * U}) i;
-- Repos: four an account, fifty for the heavy one (u1).
insert into repo (user_id, name) select 'u' || i, 'repo' || j from generate_series(1, ${U}) i, generate_series(1, case when i = 1 then 50 else 4 end) j;
insert into line (repo_id, name, user_id, draft, version) select r.id, 'main', r.user_id, ${tree(20, "r.id::text")}, 3 from repo r;
-- Commits: a chain in each repo, 400 a repo for the heavy one, 5 for everyone else; trees of 20 files.
insert into cut (repo_id, id, user_id, parent, tree, title, time)
  select r.id, ${sha("r.id || '/' || n")}, r.user_id, case when n > 1 then ${sha("r.id || '/' || (n - 1)")} end, ${tree(20, "r.id || '/' || n")}, 'Change ' || n, now() - (500 - n) * interval '1 hour'
  from repo r, generate_series(1, case when r.user_id = 'u1' then 400 else 5 end) n;
update line l set head = (select c.id from cut c where c.repo_id = l.repo_id order by c.time desc limit 1);
insert into blob (user_id, sha256, bytes) select 'u' || (1 + i % ${U}), ${sha("'b' || i")}, 1000 from generate_series(1, ${100 * U}) i;
-- Messages: 40 an account, 20,000 to the heavy one, nearly all read.
insert into message (to_user, from_user, from_address, to_address, body, created_at, read_at)
  select 'u' || (1 + i % ${U}), 'u' || (1 + (i * 7) % ${U}), 'a@x', 'b@x', 'hello', now() - i * interval '1 minute', case when i % 10 <> 0 then now() end from generate_series(1, ${40 * U}) i;
insert into message (to_user, from_user, from_address, to_address, body, created_at, read_at)
  select 'u1', 'u' || (2 + i % 100), 'a@x', 'b@x', 'hello', now() - i * interval '1 minute', case when i > 5 then now() end from generate_series(1, 20000) i;
insert into contact (user_id, peer, state) select 'u' || (1 + i % ${U}), 'u' || (1 + (i * 13) % ${U}), case when i % 20 = 0 then 'blocked' else 'accepted' end from generate_series(1, ${4 * U}) i where i % ${U} <> (i * 13) % ${U} on conflict do nothing;
-- Servers: one for every five accounts, ten people each, four boards each, 100 posts a board.
insert into server (id, name, made_by) select 'sv' || lpad(i::text, 10, '0'), 'Server ' || i, 'u' || i from generate_series(1, ${U / 5}) i;
insert into server_member (server_id, user_id, owner) select 'sv' || lpad(i::text, 10, '0'), 'u' || (1 + (i + j * 37) % ${U}), j = 0 from generate_series(1, ${U / 5}) i, generate_series(0, 9) j on conflict do nothing;
insert into server_member (server_id, user_id) select 'sv' || lpad(i::text, 10, '0'), 'u1' from generate_series(1, 30) i on conflict do nothing;
insert into board (id, server_id, name) select 'bd' || lpad(i::text, 9, '0') || j, 'sv' || lpad(i::text, 10, '0'), 'board' || j from generate_series(1, ${U / 5}) i, generate_series(1, 4) j;
insert into board_post (id, board_id, user_id, by, body) select lpad(n::text, 8, '0') || lpad(i::text, 8, '0') || j, 'bd' || lpad(i::text, 9, '0') || j, 'u' || (1 + (i + n) % ${U}), 'x', 'post'
  from generate_series(1, ${U / 5}) i, generate_series(1, 4) j, generate_series(1, 100) n;
insert into board_seen (board_id, user_id, post) select b.id, m.user_id, '00000050000000001' from board b join server_member m on m.server_id = b.server_id where m.user_id <> 'u1';
insert into throttle (key, at) select 'k' || (i % 5000), now() - (i % 48) * interval '1 hour' from generate_series(1, ${40 * U}) i;
insert into ssh (session_id, user_id, port, destinations) select 's' || i, 'u' || (1 + i % ${U}), 2222, '[]' from generate_series(1, ${U}) i;
set session_replication_role = origin;
analyze;
`, 'remote');
  console.log(`explain: ${U} accounts made in ${Math.round((Date.now() - t0) / 1000)} s; ${pg.psql(`select pg_size_pretty(pg_database_size('remote'))`, 'remote').trim()}`);

  const queries: [string, string][] = [
    ['session by token (every request)', `select * from session where token = md5('t1')`],
    ['moved (the poll)', `select r.stamp::text, (select coalesce(jsonb_object_agg(h.key, h.version), '{}'::jsonb) from home h where h.user_id = r.user_id) from room r where r.user_id = 'u1'`],
    ['news: unread count (heavy account)', `select count(*)::int from message m where m.to_user = 'u1' and m.read_at is null
      and not exists (select 1 from contact k where k.user_id = 'u1' and k.peer = m.from_user and k.state = 'blocked')`],
    ['news: boards with something new', `select b.id, b.server_id, n.post from server_member sm join server s on s.id = sm.server_id and s.gone_at is null
      join board b on b.server_id = sm.server_id and b.gone_at is null left join board_seen r on r.board_id = b.id and r.user_id = 'u1'
      cross join lateral (select p.id as post from board_post p where p.board_id = b.id and (p.user_id is null or p.user_id <> 'u1') order by p.id desc limit 1) n
      where sm.user_id = 'u1' and n.post > coalesce(r.post, '') order by b.created_at`],
    ['SSH beat', `update ssh set seen_at = now() where session_id = 's1' returning port`],
    ['repos list', `select r.name, l.head, l.version from repo r join line l on l.repo_id = r.id and l.name = 'main' where r.user_id = 'u1' order by l.file_bytes desc, r.name`],
    ['blobs missing (50)', `select sha256 from blob where user_id = 'u1' and sha256 in (select ${sha("'b' || i")} from generate_series(1, 250000, 5000) i)`],
    ['log walk (50)', `with recursive walk(id, n) as (select (select head from line l join repo r on r.id = l.repo_id where r.user_id = 'u1' and r.name = 'repo1' and l.name = 'main'), 1
      union all select c.parent, w.n + 1 from walk w join cut c on c.repo_id = (select id from repo where user_id = 'u1' and name = 'repo1') and c.id = w.id where c.parent is not null and w.n < 50)
      select c.id, c.title from walk w join cut c on c.repo_id = (select id from repo where user_id = 'u1' and name = 'repo1') and c.id = w.id order by w.n`],
    ['sweep: room recount (heavy account)', `select (select coalesce(sum(bytes), 0) from blob where user_id = 'u1') + (select coalesce(sum(bytes), 0) from line where user_id = 'u1')
      + (select coalesce(sum(bytes), 0) from cut where user_id = 'u1') + (select coalesce(sum(bytes), 0) from review where user_id = 'u1')`],
    ['sweep: blobs no tree names (heavy account)', `with named as (select e.value as sha from line l cross join jsonb_each_text(l.draft) e where l.user_id = 'u1'
      union select e.value from repo r join cut c on c.repo_id = r.id cross join jsonb_each_text(c.tree) e where r.user_id = 'u1')
      select count(*) from blob b where b.user_id = 'u1' and b.created_at < now() - interval '1 day' and not exists (select 1 from named where named.sha = b.sha256)`],
    ['sweep: throttle', `select count(*) from throttle where at < now() - interval '1 day'`],
    ['sweep: sessions run out', `select count(*) from session where expires_at < now() at time zone 'utc'`],
    ['plan: usage', `select (select count(*)::int from repo where user_id = 'u1'), coalesce((select used from room where user_id = 'u1'), 0)::float8`],
  ];
  for (const [what, q] of queries) {
    const plan = pg.psql(`explain (analyze, buffers, format json) ${q}`, 'remote');
    const j = JSON.parse(plan)[0];
    const nodes: string[] = [];
    const walk = (n: {['Node Type']: string; ['Relation Name']?: string; ['Index Name']?: string; Plans?: unknown[]}) => {
      if (/Scan/.test(n['Node Type'])) nodes.push(`${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`);
      for (const c of (n.Plans ?? []) as typeof n[]) walk(c);
    };
    walk(j.Plan);
    const read = (j.Plan['Shared Hit Blocks'] ?? 0) + (j.Plan['Shared Read Blocks'] ?? 0);
    console.log(`${what.padEnd(44)} ${String(j['Execution Time'].toFixed(2)).padStart(9)} ms  ${String(read).padStart(7)} blocks  ${[...new Set(nodes)].join('; ')}`);
  }
} finally {
  pg.destroy();
}
