// Names (DESIGN.md §0, "Names"): one namespace of principals, name@domain,
// for people (an account's addresses) and for servers alike, so the two can
// never be taken for each other. A name is held as long as its owner holds
// it; let go, it is held HOLD longer, in which only its old owner may take it
// back, so nobody else can claim it and be taken for them. A name on another
// domain answers only while that domain's DNS still names this Remote for its
// owner; lapsed for HOLD, it is let go.

import {and, eq, isNull} from 'drizzle-orm';
import {address} from './schema.ts';

export const HOLD = 30 * 86_400_000;

/** Names that answer: not let go, not lapsed. */
export const live = and(isNull(address.releasedAt), isNull(address.lapsedAt));

type Row = typeof address.$inferSelect;
export type Owner = {userId: string} | {serverId: string};
const ownedBy = (r: Row, o: Owner) => ('userId' in o ? r.userId === o.userId : r.serverId === o.serverId);

/**
 * Claim `name@domain` for `owner`: free, or theirs to take back while it is
 * held for them, or not (taken, or held for someone else until `until`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function claim(db: any, name: string, domain: string, owner: Owner, now = Date.now()): Promise<{ok: true} | {ok: false; until?: number}> {
  const a = `${name}@${domain}`;
  const [row] = await db.select().from(address).where(eq(address.address, a)) as Row[];
  if (row) {
    const until = row.releasedAt ? row.releasedAt.getTime() + HOLD : null;
    if (until === null) return {ok: false};
    if (until > now && !ownedBy(row, owner)) return {ok: false, until};
    if (until > now) { await db.update(address).set({releasedAt: null, lapsedAt: null}).where(eq(address.address, a)); return {ok: true}; }
    // Held long enough: it is anyone's again.
    await db.delete(address).where(eq(address.address, a));
  }
  const values = {address: a, name, domain, userId: 'userId' in owner ? owner.userId : null, serverId: 'serverId' in owner ? owner.serverId : null};
  const done = await db.insert(address).values(values).onConflictDoNothing().returning({a: address.address});
  return done.length ? {ok: true} : {ok: false};
}

/** Let `a` go (held HOLD for its owner from now). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function release(db: any, a: string, now = new Date()) {
  await db.update(address).set({releasedAt: now}).where(and(eq(address.address, a), isNull(address.releasedAt)));
}
