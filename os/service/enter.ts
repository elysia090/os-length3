// A Remote for research: nobody signs up. It has one account (`as`), and
// whoever is given its link enters as it. The link carries the key in its
// fragment (https://…/#enter=KEY), which a browser never sends anywhere: the
// page reads it, takes it out of the address bar, and sends it here once.
//
// What keeps a link from becoming more than it is:
//   - the key is a Worker secret, compared as digests (no timing to learn
//     it by), and an address that keeps guessing is held off
//   - a session made by it lasts a day from when it was made and is never
//     drawn out by use (auth.ts), so a new key ends every old link's reach
//     within a day; nothing else lets anyone back in (no provider admits
//     anyone, no passkey can be added)
//   - entering is proof the person is at the device just now, as a passkey
//     sign-in is, so turning a repo off works as it does anywhere
//   - nothing here is shown to everyone (seen.ts, servers.ts: closed)

import {eq, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {signedToken, type Auth} from './auth.ts';
import {ago, body, lock, rows, slowDown, type Db, type Vars} from './request.ts';
import {guard, throttle, user} from './schema.ts';

export interface Enter {
  /** The one account's name, as it is shown. */
  as: string;
  /** What the link carries. */
  key: string;
}

/** The address the one account is kept under: never a real one, so no provider's can be it. */
export const enterEmail = (as: string) => `${as.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}@enter.length3.invalid`;

/** An account's id, as Better Auth makes them: 32 letters and digits. */
const id = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');

/** Tries an address may make in an hour. */
const TRIES = 20;

const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
/** Whether `a` is `b`, in the same time whatever they are. */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function enter(d: {db: Db; auth: Auth; enter: Enter}, app: Hono<Vars>) {
  const email = enterEmail(d.enter.as);
  app.post('/v1/enter', async (c) => {
    const b = await body<{key?: unknown}>(c);
    const from = `enter:${c.req.header('CF-Connecting-IP') ?? ''}`;
    // Counted before it is compared, so guessing at once is held off as guessing in turn is.
    const tries = await d.db.transaction(async (tx: Db) => {
      await lock(tx, from);
      const [n] = await rows<{n: number}>(tx, sql`select count(*)::int as n from throttle where key = ${from} and at > ${ago(3600_000)}`);
      // One refused for trying too often is not counted again: the hour runs from the tries that were let try.
      if (n.n < TRIES) await tx.insert(throttle).values({key: from});
      return n.n;
    });
    if (tries >= TRIES) slowDown(3600, {error: 'Too many attempts; retry in an hour'});
    if (typeof b?.key !== 'string' || !d.enter.key || !await same(b.key, d.enter.key)) return c.json({error: 'Invite link invalid for this Remote'}, 403);
    // The one account is made the first time it is entered: its row is ours to make (no provider
    // stands behind it), its sessions Better Auth's.
    await d.db.insert(user).values({id: id(), name: d.enter.as, email, emailVerified: true}).onConflictDoNothing({target: user.email});
    const [one] = await d.db.select({id: user.id, name: user.name}).from(user).where(eq(user.email, email)) as {id: string; name: string}[];
    const ctx = await d.auth.$context;
    const session = await ctx.internalAdapter.createSession(one.id, false, {userAgent: c.req.header('User-Agent') ?? '', ipAddress: c.req.header('CF-Connecting-IP') ?? ''});
    // Entering is proof the person is here just now, as a passkey sign-in is (app.ts proven).
    const at = new Date(), proof = {proofSession: session.id, proofAt: at, signedSession: session.id, signedAt: at};
    await d.db.insert(guard).values({userId: one.id, ...proof}).onConflictDoUpdate({target: guard.userId, set: proof});
    return c.json({token: await signedToken(d.auth, session.token), name: one.name});
  });
}
