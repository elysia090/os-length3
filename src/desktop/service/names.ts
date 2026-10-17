// Names (DESIGN.md §0, "Names"): one namespace of principals, people (an
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
// owner may take it back, so nobody else can claim it and be taken for them.
// Every principal also has a code: six digits to be found by, given once and
// never given again.

import {and, eq, isNull, sql} from 'drizzle-orm';
import {address, principalCode} from './schema.ts';

export const HOLD = 30 * 86_400_000;
/** How long a name on this Remote is held before it is renewed. */
export const TERM_YEARS = 5;
export const term = (from = Date.now()) => { const d = new Date(from); d.setUTCFullYear(d.getUTCFullYear() + TERM_YEARS); return d; };

/** Names that answer: not let go, not lapsed, not past their term. */
export const live = and(isNull(address.releasedAt), isNull(address.lapsedAt), sql`(${address.until} is null or ${address.until} > now())`);

type Row = typeof address.$inferSelect;
export type Owner = {userId: string} | {serverId: string};
const ownedBy = (r: Row, o: Owner) => ('userId' in o ? r.userId === o.userId : r.serverId === o.serverId);

/**
 * Claim `name@domain` for `owner` (`home`: on this Remote, so for a term):
 * free, or theirs (renewed), or theirs to take back while it is held for
 * them, or not (taken, or held for someone else until `until`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function claim(db: any, name: string, domain: string, owner: Owner, home: boolean, now = Date.now()): Promise<{ok: true; until: number | null} | {ok: false; until?: number}> {
  const a = `${name}@${domain}`;
  const until = home ? term(now) : null;
  const [row] = await db.select().from(address).where(eq(address.address, a)) as Row[];
  if (row) {
    // When it stopped answering for its owner: let go, or past its term.
    const freed = row.releasedAt?.getTime() ?? (row.until && row.until.getTime() <= now ? row.until.getTime() : null);
    if (freed === null && !ownedBy(row, owner)) return {ok: false};
    if (freed !== null && freed + HOLD > now && !ownedBy(row, owner)) return {ok: false, until: freed + HOLD};
    if (freed === null || freed + HOLD > now) {
      // Its owner's: renewed, or taken back.
      await db.update(address).set({releasedAt: null, lapsedAt: null, until}).where(eq(address.address, a));
      return {ok: true, until: until?.getTime() ?? null};
    }
    // Held long enough: it is anyone's again.
    await db.delete(address).where(eq(address.address, a));
  }
  const values = {address: a, name, domain, until, userId: 'userId' in owner ? owner.userId : null, serverId: 'serverId' in owner ? owner.serverId : null};
  const done = await db.insert(address).values(values).onConflictDoNothing().returning({a: address.address});
  return done.length ? {ok: true, until: until?.getTime() ?? null} : {ok: false};
}

/** Let `a` go (held HOLD for its owner from now). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function release(db: any, a: string, now = new Date()) {
  await db.update(address).set({releasedAt: now}).where(and(eq(address.address, a), isNull(address.releasedAt)));
}

/** Names on this Remote made before names had a term: their term counts from when they were made. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function termsFor(db: any, home: string) {
  await db.update(address).set({until: sql`${address.createdAt} + interval '${sql.raw(String(TERM_YEARS))} years'`})
    .where(and(eq(address.domain, home), isNull(address.until)));
}

/** `owner`'s code, given now if it has none: six digits no one else has had. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function codeOf(db: any, owner: Owner): Promise<string> {
  const where = 'userId' in owner ? eq(principalCode.userId, owner.userId) : eq(principalCode.serverId, owner.serverId);
  for (;;) {
    const [had] = await db.select({code: principalCode.code}).from(principalCode).where(where) as {code: string}[];
    if (had) return had.code;
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000 + 100_000;
    await db.insert(principalCode).values({code: String(n), userId: 'userId' in owner ? owner.userId : null, serverId: 'serverId' in owner ? owner.serverId : null}).onConflictDoNothing();
  }
}

/** Whose `code` is, if anyone's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function byCode(db: any, code: string): Promise<Owner | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const [r] = await db.select().from(principalCode).where(eq(principalCode.code, code)) as (typeof principalCode.$inferSelect)[];
  return r?.userId ? {userId: r.userId} : r?.serverId ? {serverId: r.serverId} : null;
}
