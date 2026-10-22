// Names (DESIGN.md §5, "Names"): one namespace of principals, people (an
// account's addresses) and servers alike, so the two can never be taken for
// each other.
//
// A name on this Remote is just a name, `ren` (kept as ren@ the Remote's
// domain, which is where it is kept, not a domain anyone holds): first come,
// and held for TERM at a time, renewed by its owner. A domain only lets its
// owner put a name of their choosing beside it (`ren@ren.dev`), answering
// only while that domain's DNS still names this Remote for them; it has no
// term of its own.
//
// A name let go, or not renewed, is held HOLD longer, in which only its old
// owner may take it back, so nobody else can claim it and be taken for them;
// then it is anyone's (and sweep.ts takes it away). Every principal also has
// a code: six digits to be found by, given once and never given again.

import {and, eq, isNull, sql, type SQL} from 'drizzle-orm';
import {ago, type Db} from './request.ts';
import {address, principalCode, repoPublic} from './schema.ts';

export const HOLD = 30 * 86_400_000;
/** How long a name on this Remote is held before it is renewed. */
const TERM_YEARS = 5;
export const term = (from = Date.now()) => { const d = new Date(from); d.setUTCFullYear(d.getUTCFullYear() + TERM_YEARS); return d; };

/** Names that answer: not let go, not lapsed, not past their term. */
export const live = and(isNull(address.releasedAt), isNull(address.lapsedAt), sql`(${address.until} is null or ${address.until} > now())`);
/** When a name stopped answering for its owner (let go, or past its term); null while it is theirs. */
export const freed = sql`coalesce(${address.releasedAt}, case when ${address.until} <= now() then ${address.until} end)`;
/** Still someone's: answering, or held for its owner. */
export const kept = sql`(${freed} is null or ${freed} > ${ago(HOLD)})`;

/**
 * How a person is shown: their first address that answers, else their first
 * not let go (a lapsed one says who they were); null with none.
 */
export const shownAs = (userId: SQL | string) => sql<string | null>`(select a.address from address a where a.user_id = ${userId} and a.released_at is null
  order by (a.lapsed_at is null and (a.until is null or a.until > now())) desc, a.created_at limit 1)`;

/** A person's first address that answers: what they write and make things as. */
export const liveAddress = async (db: Db, userId: string): Promise<string | null> =>
  ((await db.select({a: address.address}).from(address).where(and(eq(address.userId, userId), live)).orderBy(address.createdAt).limit(1)) as {a: string}[])[0]?.a ?? null;

/** A server's name: the address that names it ('' for one with none). */
export const serverAddress = (serverId: SQL) => sql<string>`coalesce((select a.address from address a where a.server_id = ${serverId}), '')`;

export type Owner = {userId: string} | {serverId: string};

/**
 * Claim `name@domain` for `owner` (`home`: on this Remote, so for a term):
 * free, or theirs (renewed), or theirs to take back while it is held for
 * them, or not (taken, or held for someone else until `until`). One
 * statement, so two claiming at once cannot both have it.
 */
export async function claim(db: Db, name: string, domain: string, owner: Owner, home: boolean): Promise<{ok: true; until: number | null} | {ok: false; until?: number}> {
  const a = `${name}@${domain}`;
  const until = home ? term() : null;
  const theirs = 'userId' in owner ? sql`${address.userId} = ${owner.userId}` : sql`${address.serverId} = ${owner.serverId}`;
  const done = await db.insert(address)
    .values({address: a, name, domain, until, userId: 'userId' in owner ? owner.userId : null, serverId: 'serverId' in owner ? owner.serverId : null})
    .onConflictDoUpdate({
      target: address.address,
      // Its owner's: renewed, or taken back. Held long enough: anyone's, from now.
      set: {userId: sql`excluded.user_id`, serverId: sql`excluded.server_id`, until, releasedAt: null, lapsedAt: null,
        createdAt: sql`case when ${theirs} then ${address.createdAt} else now() end`},
      setWhere: sql`${theirs} or not ${kept}`,
    }).returning({a: address.address});
  if (done.length) return {ok: true, until: until?.getTime() ?? null};
  const [row] = await db.select({freed: sql<number | null>`floor(extract(epoch from ${freed}) * 1000)::float8`}).from(address).where(eq(address.address, a)) as {freed: number | null}[];
  return row?.freed ? {ok: false, until: row.freed + HOLD} : {ok: false};
}

/**
 * Let `a` go: it answers no one from now, held HOLD for its owner. What went
 * public under it as its owner's own face is taken down with it, so the name
 * holds nothing of theirs for whoever has it next.
 */
export async function release(db: Db, a: string) {
  await db.update(address).set({releasedAt: sql`now()`}).where(and(eq(address.address, a), isNull(address.releasedAt)));
  await takeDown(db, and(eq(repoPublic.face, a), isNull(repoPublic.serverId)));
}

/** Take down the public faces `where` picks: each held HOLD for whoever had it. */
export async function takeDown(db: Db, where: SQL | undefined) {
  await db.update(repoPublic).set({releasedAt: sql`now()`}).where(and(where, isNull(repoPublic.releasedAt)));
}

/** `owner`'s code, given now if it has none: six digits no one else has had. */
export async function codeOf(db: Db, owner: Owner): Promise<string> {
  const where = 'userId' in owner ? eq(principalCode.userId, owner.userId) : eq(principalCode.serverId, owner.serverId);
  for (;;) {
    const [had] = await db.select({code: principalCode.code}).from(principalCode).where(where) as {code: string}[];
    if (had) return had.code;
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000 + 100_000;
    await db.insert(principalCode).values({code: String(n), userId: 'userId' in owner ? owner.userId : null, serverId: 'serverId' in owner ? owner.serverId : null}).onConflictDoNothing();
  }
}

/** Whose `code` is, if anyone's. */
export async function byCode(db: Db, code: string): Promise<Owner | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const [r] = await db.select().from(principalCode).where(eq(principalCode.code, code)) as (typeof principalCode.$inferSelect)[];
  return r?.userId ? {userId: r.userId} : r?.serverId ? {serverId: r.serverId} : null;
}
