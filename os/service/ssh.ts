// SSH into a repo's Prompt: which of the account's devices listen, kept here
// so any page can see them and stop one. The listening itself is the
// device's (l3's listener, cli/src/ssh.rs); what is kept is a row a device,
// keyed by its session (signing it out takes the row with it), and in it
// only that the device listens, to whom (its scope: `device`, from that
// device only, or `network`, from its network's PCs too), since when, and
// when it last said so. No address, port or repo name is sent or kept:
// where a device is reached is worked out and shown on that device alone.
//
//   GET    /v1/ssh               each device listening: [{device, agent, scope, since, seen, current}]
//   PUT    /v1/ssh/this          {scope?}: this device listens (only a device says so: never a page)
//   POST   /v1/ssh/this/beat     {scope?, tag?}: still listening -> {on, tag?}; on false, it was turned off elsewhere
//   DELETE /v1/ssh/this          this device stopped
//   POST   /v1/ssh/:device/off   stop that device's (any session of the account, a page too)
//
// Turning on is a device's statement about itself, made by the session it
// listens as: no session can turn another's on, and a request a browser
// makes (it always carries Origin, which l3 and the app's core never send)
// is refused it, so the web can only turn a device's SSH off. A device asks
// with its beat every 30 s or so, and stops at once when its row is gone.
// The beat carries the tag its last answer gave (`tag`): while nothing was
// written on the Remote it is answered on without the database (mark.ts),
// and GET /v1/ssh takes when it was heard from the mark. Whatever else a
// body carries (an older l3 sent its destinations) is not read, and not kept.

import {and, desc, eq, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import type {Marks} from './mark.ts';
import {body, ms, type Db, type Vars} from './request.ts';
import {session, ssh} from './schema.ts';

/** To whom a device listens: from itself only, or from its network's PCs too. */
const SCOPES = ['device', 'network'] as const;
export type Scope = typeof SCOPES[number];

/** The scope a device says, checked: absent is `device`; null when it is not one. */
function scopeOf(v: unknown): Scope | null {
  if (v === undefined) return 'device';
  return SCOPES.includes(v as Scope) ? v as Scope : null;
}

export function sshRoutes(d: {db: Db; /** Beats answered without the database say when they were heard here (mark.ts). */ marks?: Marks}, v1: Hono<Vars>) {
  const db = d.db;

  v1.get('/ssh', async (c) => {
    const list = await db.select({device: ssh.sessionId, agent: session.userAgent, scope: ssh.scope,
      since: ms(sql`${ssh.since}`), seen: ms(sql`${ssh.seenAt}`)})
      .from(ssh).innerJoin(session, eq(session.id, ssh.sessionId)).where(eq(ssh.userId, c.get('userId'))).orderBy(desc(ssh.since)) as {device: string; seen: number}[];
    // A beat the mark answered was heard there, not here: the later of the two is when the device last said it listens.
    const heard = d.marks && list.length ? await d.marks.heard(list.map((r) => r.device)).catch(() => ({} as Record<string, number>)) : {};
    return c.json(list.map((r) => ({...r, seen: Math.max(r.seen, heard[r.device] ?? 0), current: r.device === c.get('sessionId')})));
  });

  v1.put('/ssh/this', async (c) => {
    // A page cannot turn SSH on: that is done at the device (l3 address, the app's switch).
    if (c.req.header('Origin')) return c.json({error: 'SSH is turned on at the device itself'}, 403);
    const scope = scopeOf((await body<{scope?: unknown}>(c))?.scope);
    if (!scope) return c.json({error: 'device or network'}, 400);
    await db.insert(ssh).values({sessionId: c.get('sessionId'), userId: c.get('userId'), scope})
      .onConflictDoUpdate({target: ssh.sessionId, set: {scope, since: sql`now()`, seenAt: sql`now()`}});
    return c.json({on: true});
  });

  // Never makes a row: one gone was turned off, and stays off until the device turns it on again.
  v1.post('/ssh/this/beat', async (c) => {
    const said = (await body<{scope?: unknown}>(c))?.scope;
    const scope = said === undefined ? undefined : scopeOf(said);
    if (scope === null) return c.json({error: 'device or network'}, 400);
    const done = await db.update(ssh).set({seenAt: sql`now()`, ...(scope ? {scope} : {})})
      .where(eq(ssh.sessionId, c.get('sessionId'))).returning({device: ssh.sessionId});
    return c.json({on: done.length > 0});
  });

  v1.delete('/ssh/this', async (c) => {
    const done = await db.delete(ssh).where(eq(ssh.sessionId, c.get('sessionId'))).returning({device: ssh.sessionId});
    return c.json({on: false, changed: done.length > 0});
  });

  v1.post('/ssh/:device/off', async (c) => {
    const done = await db.delete(ssh).where(and(eq(ssh.sessionId, c.req.param('device')), eq(ssh.userId, c.get('userId')))).returning({device: ssh.sessionId});
    return done.length ? c.json({device: done[0].device, on: false}) : c.json({error: 'No device of yours listens there'}, 404);
  });
}
