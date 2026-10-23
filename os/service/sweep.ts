// What goes, goes here: the one place the Remote lets go of what was held
// long enough. Run once a day by a Cron Trigger (worker.ts), and when the
// Remote starts on this machine (dev.ts). The one thing a person makes go at
// once is a repo turned off, by discarding it (app.ts): it goes as the sweep
// lets one go (purge), only sooner. Reads already leave out what has run out.
//
//   a repo turned off 30 days ago     with all that hangs from it (lines, commits, changes, shares,
//                                     public names); its name remembered as gone
//   a repo gone 90 days ago           the memory of it
//   a line merged 30 days ago         its draft (its commits stay: main's history names them)
//   a server or a board held 30 days  with all that hangs from it (boards, talk, TODO, guests, invitations, shares, name)
//   a name held 30 days               (let go, past its term, or lapsed 30 days and then held 30)
//   a public name held 30 days        or one whose face its owner no longer has
//   a message read, 90 days after it was sent (one unread waits for its reader)
//   a signal two minutes old, a passkey sign-in five minutes old, a guest whose lease ran out (their
//                                     posts stay, a guest's still), an invitation used up or run out,
//   what was asked of the Remote a day ago (throttle), a Stripe event taken 30 days ago, what was counted of
//                                     a day or a month gone (usage)
//   a session, a device's code or a sign-in's verification that ran out (Better Auth's own: it lets
//                                     one go only when it is asked for again)
//   a blob no draft or commit of its account names (a day after it came, so a diff can name it first),
//                                     looked for only in accounts whose room says something changed

import {sql, type SQL} from 'drizzle-orm';
import {blobKey, type Bucket} from './bucket.ts';
import {HOLD, TERM_YEARS} from './names.ts';
import {KEEP_EVENTS} from './plan.ts';
import {recount} from './budget.ts';
import {ago, lock, rows, type Db} from './request.ts';

/** How long a repo turned off is kept. */
export const KEPT = 30 * 86_400_000;
/** How long a repo that went is remembered as gone. */
export const REMEMBERED = 90 * 86_400_000;
const DAY = 86_400_000;
/** How long the sweep goes on through the rooms (a cron run may take 15 minutes in all). */
const ROOMS_FOR = 10 * 60_000;

/**
 * Every repo that is off and fits `which` (a condition on it, r) goes whole,
 * now, and the name it went under is remembered as gone. All of a repo hangs
 * from it, so one statement takes it all; one turned on meanwhile no longer
 * fits and is left whole, never half gone. What went, counted.
 */
export async function purge(tx: Db, which: SQL): Promise<{repo: number}> {
  const went = await rows<{name: string}>(tx, sql`with went as (
      delete from repo r where r.off_at is not null and (${which}) returning r.user_id, r.name)
    insert into repo_gone (user_id, name) select user_id, name from went
    on conflict (user_id, name) do update set at = now() returning name`);
  return {repo: went.length};
}

/** Let go of everything held long enough; what went, counted. */
export async function sweep(db: Db, bucket: Bucket | null): Promise<Record<string, number>> {
  const gone: Record<string, number> = {};
  // Each step on its own: one that fails (a statement out of time) is said in the log and counted as failed, and
  // every step after it still runs, today and every day. Only how many went comes back, not the rows.
  const failed = (what: string, e: unknown) => { console.error(`sweep: ${what} failed`, e); gone.failed = (gone.failed ?? 0) + 1; };
  // A step may take longer than a request's statement may (the Worker's role: 15 s): a day of backlog after days
  // the sweep failed, or a large account. Each runs in a transaction of its own, given minutes.
  const long = async <T>(f: (tx: Db) => Promise<T>): Promise<T> => db.transaction(async (tx: Db) => {
    await tx.execute(sql`set local statement_timeout = '5min'`);
    return f(tx);
  });
  const run = async (what: string, query: SQL) => {
    try {
      const [r] = await long((tx) => rows<{n: number}>(tx, sql`with done as (${query} returning 1) select count(*)::int as n from done`));
      gone[what] = (gone[what] ?? 0) + r.n;
    } catch (e) { failed(what, e); }
  };
  const began = Date.now();

  try { Object.assign(gone, await long((tx: Db) => purge(tx, sql`r.off_at < ${ago(KEPT)}`))); } catch (e) { failed('repo', e); }
  await run('remembered', sql`delete from repo_gone where at < ${ago(REMEMBERED)}`);
  // A line merged a while ago, unless it was worked on (or begun again for the same issue) after the merge.
  await run('line', sql`delete from line l using change c where l.name <> 'main' and c.repo_id = l.repo_id and c.line = l.name
    and c.state = 'merged' and c.updated_at < ${ago(KEPT)} and l.started_at <= c.updated_at and l.updated_at <= c.updated_at`);

  await run('server', sql`delete from server where gone_at < ${ago(HOLD)}`);
  await run('board', sql`delete from board where gone_at < ${ago(HOLD)}`);
  // A name on a domain whose DNS has not named this Remote for HOLD is let go then, and held HOLD more.
  await run('lapsed', sql`update address set released_at = lapsed_at + make_interval(secs => ${HOLD / 1000})
    where released_at is null and lapsed_at < ${ago(HOLD)}`);
  // A name held by someone still here (a session that has not run out: used within its 60 days) is renewed while a
  // year of its term is left, as they would renew it themselves: before, every name stopped answering after five
  // years unless renewed by hand, and was anyone's 30 days later.
  await run('renewed', sql`update address set until = until + make_interval(years => ${TERM_YEARS})
    where released_at is null and lapsed_at is null and until is not null and until < now() + interval '1 year'
      and exists (select 1 from session s where s.expires_at > now() at time zone 'utc'
        and (s.user_id = address.user_id or s.user_id = (select v.made_by from server v where v.id = address.server_id and v.gone_at is null)))`);
  await run('address', sql`delete from address where coalesce(released_at, until) < ${ago(HOLD)}`);
  await run('repo_public', sql`delete from repo_public p where p.released_at < ${ago(HOLD)}
    or (p.server_id is null and not exists (select 1 from address a where a.address = p.face and a.user_id = p.user_id))`);

  await run('message', sql`delete from message where read_at is not null and created_at < ${ago(90 * DAY)}`);
  await run('signal', sql`delete from signal where created_at < ${ago(2 * 60_000)}`);
  await run('proof', sql`update guard set proof_session = null, proof_at = null where proof_at < ${ago(5 * 60_000)}`);
  await run('guard', sql`delete from guard where off_digest is null and proof_at is null`);
  await run('guest', sql`delete from board_guest where token_until < now()`);
  await run('invite', sql`delete from board_invite where uses = 0 or until < now()`);
  await run('throttle', sql`delete from throttle where at < ${ago(DAY)}`);
  // What was counted of a day or a month gone (budget.ts): the days before yesterday, the months before last.
  await run('usage', sql`delete from usage where (char_length(period) = 10 and period < to_char(now() - interval '2 days', 'YYYY-MM-DD'))
    or (char_length(period) = 7 and period < to_char(now() - interval '40 days', 'YYYY-MM'))`);
  // Stripe's events taken a while ago: one that old is not taken again anyway (plan.ts KEEP_EVENTS).
  await run('billing_event', sql`delete from billing_event where at < ${ago(KEEP_EVENTS)}`);
  // Better Auth's moments are kept without a zone, as UTC.
  for (const t of ['session', 'device_code', 'verification']) await run(t, sql`delete from ${sql.identifier(t)} where expires_at < now() at time zone 'utc'`);

  // Blobs no tree of their account names any more: their rows, then their bytes. Only accounts whose
  // room says something their blobs are named by changed; each under its lock, as an upload is, so
  // nothing is sent between a blob going and its bytes going. A room stays unswept while it holds a
  // blob too new to be taken for unnamed. With no bucket, no blob goes and its room stays unswept: a row
  // is how its bytes are found again once there is one to take them from. The room is counted again
  // either way: the plan reads it, and that is rows alone.
  // Bytes in R2 no row names (an upload whose row failed and whose clean-up failed too, a Worker stopped between
  // the two): a thousand keys a day, from where the last day left off, each put more than a day ago without its row
  // let go, under its account's lock as an upload's row is written. Nothing else ever found them, and R2 billed them.
  if (bucket?.list) {
    try {
      const [m] = await rows<{at: string}>(db, sql`select at from sweep_mark where name = 'r2'`);
      const {keys, next} = await bucket.list('u/', m?.at ?? '', 1000);
      const old = keys.filter((k) => k.at < Date.now() - DAY).map((k) => /^u\/([^/]+)\/([0-9a-f]{64})$/.exec(k.key)).filter((x) => x !== null);
      const byUser = new Map<string, string[]>();
      for (const [, user, sha] of old) byUser.set(user, [...(byUser.get(user) ?? []), sha]);
      for (const [user, shas] of byUser) {
        await db.transaction(async (tx: Db) => {
          await lock(tx, user);
          const named = new Set((await rows<{sha256: string}>(tx, sql`select sha256 from blob where user_id = ${user} and sha256 in ${shas}`)).map((r) => r.sha256));
          const loose = shas.filter((sha) => !named.has(sha));
          if (loose.length) { await bucket.delete(loose.map((sha) => blobKey(user, sha))); gone.loose = (gone.loose ?? 0) + loose.length; }
        });
      }
      await db.execute(sql`insert into sweep_mark (name, at) values ('r2', ${next}) on conflict (name) do update set at = excluded.at`);
    } catch (e) { failed('loose bytes', e); }
  }
  // What R2 holds, counted again from the rows that name its bytes (budget.ts): before the rooms, so a run that
  // stops at its time still does it (what the rooms let go of is counted as it goes, by its triggers).
  try { if (await recount(db)) gone.restored = 1; } catch (e) { failed('usage recount', e); }
  // In no fixed order, and no longer than ROOMS_FOR: a room not reached is still unswept, and is the next day's
  // (in the same order each day, one slow account first would hold every account after it back for good).
  const rooms = await rows<{user_id: string}>(db, sql`select user_id from room where unswept order by random()`).catch((e: unknown) => { failed('rooms', e); return []; });
  for (const {user_id: user} of rooms) {
    if (Date.now() - began > ROOMS_FOR) { gone.later = (gone.later ?? 0) + 1; continue; }
    try {
      const unnamed: string[] = await long(async (tx: Db) => {
        await lock(tx, user);
        const went = !bucket ? [] : await rows<{sha256: string}>(tx, sql`with named as (
            select e.value as sha from line l cross join jsonb_each_text(l.draft) e where l.user_id = ${user}
            union select e.value from repo r join cut c on c.repo_id = r.id cross join jsonb_each_text(c.tree) e where r.user_id = ${user})
          delete from blob b where b.user_id = ${user} and b.created_at < ${ago(DAY)}
            and not exists (select 1 from named where named.sha = b.sha256)
          returning b.sha256`);
        if (bucket) await tx.execute(sql`update room set unswept = exists (select 1 from blob b where b.user_id = ${user} and b.created_at >= ${ago(DAY)})
          where user_id = ${user}`);
        // What the room counts, counted again from its rows: the triggers keep it so with every row, and
        // a room that ever disagreed (a row written past them) is put right here, before the plan reads it.
        const fixed = await rows(tx, sql`update room set used = n.used from (select
            (select coalesce(sum(bytes), 0) from blob where user_id = ${user}) + (select coalesce(sum(bytes), 0) from line where user_id = ${user})
            + (select coalesce(sum(bytes), 0) from cut where user_id = ${user}) + (select coalesce(sum(bytes), 0) from review where user_id = ${user}) as used) n
          where room.user_id = ${user} and room.used <> n.used returning 1`);
        if (fixed.length) gone.recounted = (gone.recounted ?? 0) + 1;
        return went.map((b) => b.sha256);
      });
      if (unnamed.length) gone.blob = (gone.blob ?? 0) + unnamed.length;
      // Their bytes go once the rows' going is kept, never before (rows back without bytes would be files lost),
      // under the account's lock again, and only those no row names by now (one sent again meanwhile stays).
      if (bucket && unnamed.length) {
        await db.transaction(async (tx: Db) => {
          await lock(tx, user);
          const back = new Set((await rows<{sha256: string}>(tx, sql`select sha256 from blob where user_id = ${user} and sha256 in ${unnamed}`)).map((r) => r.sha256));
          // Bytes that fail to go are only room taken in R2: the blob is no longer anyone's.
          await bucket.delete(unnamed.filter((sha) => !back.has(sha)).map((sha) => blobKey(user, sha))).catch((e: unknown) => console.error('sweep: bytes stay', e));
        });
      }
    } catch (e) { failed(`room ${user}`, e); }
  }
  return gone;
}
