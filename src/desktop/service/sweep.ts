// What goes, goes here: the one place the Remote lets go of what was held
// long enough. Run once a day by a Cron Trigger (worker.ts), and when the
// Remote starts on this machine (dev.ts). The one thing a person makes go at
// once is a repo turned off, by discarding it (app.ts): it goes as the sweep
// lets one go (purge), only sooner. Reads already leave out what has run out.
//
//   a repo turned off 30 days ago     every line, change, commit, share and public name of it; its name remembered as gone
//   a repo gone 90 days ago           the memory of it
//   a line merged 30 days ago         its draft (its commits stay: main's history names them)
//   a server or a board held 30 days  with its boards, talk, TODO, guests, shares and name
//   a name held 30 days               (let go, past its term, or lapsed 30 days and then held 30)
//   a public name held 30 days        or one whose face its owner no longer has
//   a message read, 90 days after it was sent (one unread waits for its reader)
//   a signal two minutes old, a passkey sign-in five minutes old, a guest whose code and lease ran out,
//   what was asked of the Remote a day ago (throttle)
//   a blob no draft or commit of its account names (a day after it came, so a diff can name it first)

import {sql, type SQL} from 'drizzle-orm';
import type {Bucket} from './bucket.ts';
import {HOLD} from './names.ts';
import {days, lock, rows, type Db} from './request.ts';

/** How long a repo turned off is kept. */
export const KEPT = 30 * 86_400_000;
/** How long a repo that went is remembered as gone. */
export const REMEMBERED = 90 * 86_400_000;

/**
 * Every repo that is off and fits `which` (a condition on its main line, m)
 * goes whole, now: every line, commit, change, share and public name of it,
 * and the name it went under is remembered as gone. Its main lines are read
 * and held first, so one turned on meanwhile is left whole, never half gone.
 * Run in the caller's transaction; what went, counted.
 */
export async function purge(tx: Db, which: SQL): Promise<Record<string, number>> {
  const off = await rows<{user_id: string; name: string}>(tx, sql`select m.user_id, m.name from repo m
    where m.line = 'main' and m.off_at is not null and (${which}) for update`);
  const gone: Record<string, number> = {};
  if (!off.length) return gone;
  const g = sql`jsonb_to_recordset(${JSON.stringify(off)}::jsonb) as g(user_id text, name text)`;
  const run = async (what: string, query: SQL) => { gone[what] = (await rows(tx, sql`${query} returning 1`)).length; };
  await run('gone', sql`insert into repo_gone (user_id, name) select g.user_id, g.name from ${g} on conflict (user_id, name) do update set at = now()`);
  for (const t of ['change', 'cut', 'repo_share', 'repo_public']) await run(t, sql`delete from ${sql.identifier(t)} x using ${g} where x.user_id = g.user_id and x.repo = g.name`);
  await run('repo', sql`delete from repo x using ${g} where x.user_id = g.user_id and x.name = g.name`);
  return gone;
}

/** Let go of everything held long enough; what went, counted. */
export async function sweep(db: Db, bucket: Bucket): Promise<Record<string, number>> {
  const gone: Record<string, number> = {};
  const run = async (what: string, q: Db, query: SQL) => { gone[what] = (gone[what] ?? 0) + (await rows(q, sql`${query} returning 1`)).length; };

  // A repo off long enough goes whole, in one step, as one discarded does.
  Object.assign(gone, await db.transaction((tx: Db) => purge(tx, sql`m.off_at < now() - ${days(KEPT)}`)));
  await run('remembered', db, sql`delete from repo_gone where at < now() - ${days(REMEMBERED)}`);
  await run('line', db, sql`delete from repo r using change c where r.line <> 'main' and c.user_id = r.user_id and c.repo = r.name and c.line = r.line
    and c.state = 'merged' and c.updated_at < now() - ${days(KEPT)}`);

  await run('server', db, sql`delete from server where gone_at < now() - ${days(HOLD)}`);
  await run('board', db, sql`delete from server_board where gone_at < now() - ${days(HOLD)}`);
  // A name on a domain whose DNS has not named this Remote for HOLD is let go then, and held HOLD more.
  await run('lapsed', db, sql`update address set released_at = lapsed_at + ${days(HOLD)} where released_at is null and lapsed_at < now() - ${days(HOLD)}`);
  await run('address', db, sql`delete from address where coalesce(released_at, until) < now() - ${days(HOLD)}`);
  await run('repo_public', db, sql`delete from repo_public p where p.released_at < now() - ${days(HOLD)}
    or (p.server_id is null and not exists (select 1 from address a where a.address = p.face and a.user_id = p.user_id))`);

  await run('message', db, sql`delete from message where read_at is not null and created_at < now() - interval '90 days'`);
  await run('signal', db, sql`delete from signal where created_at < now() - interval '2 minutes'`);
  await run('proof', db, sql`update guard set proof_session = null, proof_at = null where proof_at < now() - interval '5 minutes'`);
  await run('guard', db, sql`delete from guard where off_digest is null and proof_at is null`);
  await run('guest', db, sql`delete from server_guest where (token_until is null or token_until < now())
    and (code is null or code_at is null or code_at < now() - interval '10 minutes')`);
  await run('throttle', db, sql`delete from throttle where at < now() - interval '1 day'`);

  // Blobs no tree of their account names any more: their rows, then their bytes. Each account under
  // its lock, as an upload is, so nothing is sent between a blob going and its bytes going.
  const owners = await rows<{user_id: string}>(db, sql`select distinct user_id from blob where created_at < now() - interval '1 day'`);
  for (const {user_id: user} of owners) {
    await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const unnamed = await rows<{sha256: string}>(tx, sql`with named as (
          select e.value as sha from repo r cross join jsonb_each_text(r.draft) e where r.user_id = ${user}
          union select e.value from cut c cross join jsonb_each_text(c.tree) e where c.user_id = ${user})
        delete from blob b where b.user_id = ${user} and b.created_at < now() - interval '1 day'
          and not exists (select 1 from named where named.sha = b.sha256)
        returning b.sha256`);
      gone.blob = (gone.blob ?? 0) + unnamed.length;
      // Bytes that fail to go are only room taken: the blob is no longer anyone's.
      if (unnamed.length) await bucket.delete(unnamed.map((b) => `u/${user}/${b.sha256}`)).catch((e: unknown) => console.error('sweep: bytes stay', e));
    });
  }
  return gone;
}
