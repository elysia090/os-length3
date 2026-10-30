// Names (DESIGN.md §5, "Names"): one namespace of principals, people (an
// account's addresses) and servers alike, so the two can never be taken for
// each other.
//
// A name on this Remote is just a name, `ren` (kept as ren@ the Remote's
// domain, which is where it is kept, not a domain anyone holds): first come,
// and its owner's as long as the account (or the server) is, as a username
// is anywhere: nothing to renew, nothing that lapses. A domain only lets its
// owner put a name of their choosing beside it (`ren@ren.dev`), answering
// only while that domain's DNS still names this Remote for them.
//
// A name let go is held HOLD longer, in which only its old owner may take it
// back, so nobody else can claim it and be taken for them; then it is
// anyone's (and sweep.ts takes it away). Every principal also has a code:
// six digits to be found by, given once and never given again.

import {and, eq, isNull, sql, type SQL} from 'drizzle-orm';
import {ago, refuse, type Db} from './request.ts';
import {address, home, principalCode, repoPublic, user} from './schema.ts';

export const HOLD = 30 * 86_400_000;
/** A principal's name before @ (schema.ts's `re.name`, as Postgres checks it). */
export const NAME = /^[a-z0-9][a-z0-9._-]{1,30}$/;

/** Names that answer: not let go, and (on a domain) still named by its DNS. */
export const live = and(isNull(address.releasedAt), isNull(address.lapsedAt));
/** Still someone's: answering, or let go so lately it is held for its owner. */
export const kept = sql`(${address.releasedAt} is null or ${address.releasedAt} > ${ago(HOLD)})`;

/**
 * How a person is shown: their first address that answers, else their first
 * not let go (a lapsed one says who they were); null with none.
 */
export const shownAs = (userId: SQL | string) => sql<string | null>`(select a.address from address a where a.user_id = ${userId} and a.released_at is null
  order by (a.lapsed_at is null) desc, a.created_at limit 1)`;

/** A person's first address that answers: what they write and make things as. */
export const liveAddress = async (db: Db, userId: string): Promise<string | null> =>
  ((await db.select({a: address.address}).from(address).where(and(eq(address.userId, userId), live)).orderBy(address.createdAt).limit(1)) as {a: string}[])[0]?.a ?? null;

/** A server's name: the address that names it ('' for one with none). */
export const serverAddress = (serverId: SQL) => sql<string>`coalesce((select a.address from address a where a.server_id = ${serverId}), '')`;

export type Owner = {userId: string} | {serverId: string};

/**
 * Claim `name@domain` for `owner`: free, or theirs already (or theirs to take
 * back while it is held for them), or not (taken, or held for someone else
 * until `until`). One statement, so two claiming at once cannot both have it.
 */
export async function claim(db: Db, name: string, domain: string, owner: Owner): Promise<{ok: true} | {ok: false; until?: number}> {
  const a = `${name}@${domain}`;
  const theirs = 'userId' in owner ? sql`${address.userId} = ${owner.userId}` : sql`${address.serverId} = ${owner.serverId}`;
  const done = await db.insert(address)
    .values({address: a, name, domain, userId: 'userId' in owner ? owner.userId : null, serverId: 'serverId' in owner ? owner.serverId : null})
    .onConflictDoUpdate({
      target: address.address,
      // Its owner's: taken back. Held long enough: anyone's, from now.
      set: {userId: sql`excluded.user_id`, serverId: sql`excluded.server_id`, releasedAt: null, lapsedAt: null,
        createdAt: sql`case when ${theirs} then ${address.createdAt} else now() end`},
      setWhere: sql`${theirs} or not ${kept}`,
    }).returning({a: address.address});
  if (done.length) return {ok: true};
  const [row] = await db.select({freed: sql<number | null>`floor(extract(epoch from ${address.releasedAt}) * 1000)::float8`}).from(address).where(eq(address.address, a)) as {freed: number | null}[];
  return row?.freed ? {ok: false, until: row.freed + HOLD} : {ok: false};
}

/**
 * A username made of what a person is called (`Ada Lovelace`, `ada.l@example.com`, a handle written on Home): one
 * that is a name already as it is (`kai.dev`, `@kai.dev`); else lowercase letters and digits, what is between them a
 * dash, at most 31; '' where nothing is left (a name all in another script). Accents come off (`Zoë` is zoe), as a
 * username anywhere is written.
 */
function usernameFrom(said: string): string {
  const plain = said.trim().replace(/^@/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (NAME.test(plain)) return plain;
  const name = plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31).replace(/-+$/, '');
  return name.length >= 2 ? name : '';
}

/** What a person is called, to make their username of, in order: the handle they wrote on Home, their name, their
 *  email's first part. */
async function hintsOf(db: Db, userId: string): Promise<string[]> {
  const [u] = await db.select({name: user.name, email: user.email, profile: home.value}).from(user)
    .leftJoin(home, and(eq(home.userId, user.id), eq(home.key, 'profile'))).where(eq(user.id, userId)) as {name: string; email: string; profile: string | null}[];
  if (!u) return [];
  let handle = '';
  try { handle = String((JSON.parse(u.profile ?? '{}') as {handle?: unknown}).handle ?? ''); } catch { /* no handle written */ }
  return [handle, u.name, u.email.split('@')[0]];
}

/**
 * `userId`'s name on this Remote (`domain`), given now if they have none: the first of what they are called
 * (hintsOf) that makes a username, as it is if free, else with the first number after it that is (`ada`, `ada2`…),
 * else with digits. Asked wherever a person needs a name to be anyone (Inbox, a server, a post, a public repo), so
 * nobody is ever asked to claim one first: they have one, and change it if they like. Two asking at once give the
 * same name (each tries the same names in the same order, and a name one's own already is theirs to claim again).
 */
export async function nameFor(db: Db, userId: string, domain: string): Promise<string> {
  const had = await db.select({a: address.address}).from(address)
    .where(and(eq(address.userId, userId), eq(address.domain, domain), isNull(address.releasedAt))).orderBy(address.createdAt).limit(1) as {a: string}[];
  if (had[0]) return had[0].a;
  const base = (await hintsOf(db, userId)).map(usernameFrom).find(Boolean) ?? 'user';
  const tries = [base, ...Array.from({length: 8}, (_, i) => `${base.slice(0, 29)}${i + 2}`),
    ...Array.from({length: 8}, () => `${base.slice(0, 24)}-${crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000}`)];
  for (const name of tries) if ((await claim(db, name, domain, {userId})).ok) return `${name}@${domain}`;
  refuse(503, {error: 'No name is free to give just now'});
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
  // Codes are never given twice: as they run out each takes more tries, and with none left, none is given (not a
  // loop for good inside the transaction that asked, holding its lock).
  for (let tries = 0; ; tries++) {
    const [had] = await db.select({code: principalCode.code}).from(principalCode).where(where) as {code: string}[];
    if (had) return had.code;
    if (tries >= 64) refuse(503, {error: 'No code is left to give just now'});
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
