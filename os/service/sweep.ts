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
//   what was asked of the Remote a day ago (throttle)
//   a session, a device's code or a sign-in's verification that ran out (Better Auth's own: it lets
//                                     one go only when it is asked for again)
//   a blob no draft or commit of its account names (a day after it came, so a diff can name it first),
//                                     looked for only in accounts whose room says something changed

import {sql, type SQL} from 'drizzle-orm';
import {blobKey, type Bucket} from './bucket.ts';
import {HOLD} from './names.ts';
import {ago, lock, rows, type Db} from './request.ts';

/** How long a repo turned off is kept. */
export const KEPT = 30 * 86_400_000;
/** How long a repo that went is remembered as gone. */
export const REMEMBERED = 90 * 86_400_000;
const DAY = 86_400_000;

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
  const run = async (what: string, q: Db, query: SQL) => { gone[what] = (gone[what] ?? 0) + (await rows(q, sql`${query} returning 1`)).length; };

  Object.assign(gone, await db.transaction((tx: Db) => purge(tx, sql`r.off_at < ${ago(KEPT)}`)));
  await run('remembered', db, sql`delete from repo_gone where at < ${ago(REMEMBERED)}`);
  await run('line', db, sql`delete from line l using change c where l.name <> 'main' and c.repo_id = l.repo_id and c.line = l.name
    and c.state = 'merged' and c.updated_at < ${ago(KEPT)}`);

  await run('server', db, sql`delete from server where gone_at < ${ago(HOLD)}`);
  await run('board', db, sql`delete from board where gone_at < ${ago(HOLD)}`);
  // A name on a domain whose DNS has not named this Remote for HOLD is let go then, and held HOLD more.
  await run('lapsed', db, sql`update address set released_at = lapsed_at + make_interval(secs => ${HOLD / 1000})
    where released_at is null and lapsed_at < ${ago(HOLD)}`);
  await run('address', db, sql`delete from address where coalesce(released_at, until) < ${ago(HOLD)}`);
  await run('repo_public', db, sql`delete from repo_public p where p.released_at < ${ago(HOLD)}
    or (p.server_id is null and not exists (select 1 from address a where a.address = p.face and a.user_id = p.user_id))`);

  await run('message', db, sql`delete from message where read_at is not null and created_at < ${ago(90 * DAY)}`);
  await run('signal', db, sql`delete from signal where created_at < ${ago(2 * 60_000)}`);
  await run('proof', db, sql`update guard set proof_session = null, proof_at = null where proof_at < ${ago(5 * 60_000)}`);
  await run('guard', db, sql`delete from guard where off_digest is null and proof_at is null`);
  await run('guest', db, sql`delete from board_guest where token_until < now()`);
  await run('invite', db, sql`delete from board_invite where uses = 0 or until < now()`);
  await run('throttle', db, sql`delete from throttle where at < ${ago(DAY)}`);
  // Better Auth's moments are kept without a zone, as UTC.
  for (const t of ['session', 'device_code', 'verification']) await run(t, db, sql`delete from ${sql.identifier(t)} where expires_at < now() at time zone 'utc'`);

  // Blobs no tree of their account names any more: their rows, then their bytes. Only accounts whose
  // room says something their blobs are named by changed; each under its lock, as an upload is, so
  // nothing is sent between a blob going and its bytes going. A room stays unswept while it holds a
  // blob too new to be taken for unnamed. With no bucket, none goes: a row is how its bytes are found
  // again once there is one to take them from.
  if (!bucket) return gone;
  const rooms = await rows<{user_id: string}>(db, sql`select user_id from room where unswept`);
  for (const {user_id: user} of rooms) {
    await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const unnamed = await rows<{sha256: string}>(tx, sql`with named as (
          select e.value as sha from line l cross join jsonb_each_text(l.draft) e where l.user_id = ${user}
          union select e.value from repo r join cut c on c.repo_id = r.id cross join jsonb_each_text(c.tree) e where r.user_id = ${user})
        delete from blob b where b.user_id = ${user} and b.created_at < ${ago(DAY)}
          and not exists (select 1 from named where named.sha = b.sha256)
        returning b.sha256`);
      if (unnamed.length) gone.blob = (gone.blob ?? 0) + unnamed.length;
      await tx.execute(sql`update room set unswept = exists (select 1 from blob b where b.user_id = ${user} and b.created_at >= ${ago(DAY)})
        where user_id = ${user}`);
      // Bytes that fail to go are only room taken: the blob is no longer anyone's.
      if (unnamed.length) await bucket.delete(unnamed.map((b) => blobKey(user, b.sha256))).catch((e: unknown) => console.error('sweep: bytes stay', e));
    });
  }
  return gone;
}
