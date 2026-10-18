// SSH into a repo's Prompt: which of the account's devices listen, kept here
// so any page can see them and stop one. The listening itself is the
// device's (l3's listener, cli/src/ssh.rs); what is kept is a row a device,
// keyed by its session (signing it out takes the row with it).
//
//   GET    /v1/ssh               each device listening: [{device, agent, port, destinations, since, seen, current}]
//   PUT    /v1/ssh/this          {port, destinations}: this device listens (only a device says so: never a page)
//   POST   /v1/ssh/this/beat     {destinations?}: still listening -> {on}; on false, it was turned off elsewhere
//   DELETE /v1/ssh/this          this device stopped
//   POST   /v1/ssh/:device/off   stop that device's (any session of the account, a page too)
//
// Turning on is a device's statement about itself, made by the session it
// listens as: no session can turn another's on, and a request a browser
// makes (it always carries Origin, which l3 and the app's core never send)
// is refused it, so the web can only turn a device's SSH off. A device asks
// with its beat every few seconds, and stops at once when its row is gone.

import {and, desc, eq, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {body, ms, type Db, type Vars} from './request.ts';
import {session, ssh} from './schema.ts';

/** A destination as a device gives it: `ssh -p PORT REPO@HOST`, plain characters only. */
const DESTINATION = /^ssh -p [0-9]{1,5} [A-Za-z0-9_-][A-Za-z0-9._-]{0,63}@[0-9A-Za-z.:%_-]{1,253}$/;
export const SSH = {destinations: 200};

/** What a device sends of where it listens, checked; null when it is not that. */
function destinations(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > SSH.destinations || !v.every((d) => typeof d === 'string' && DESTINATION.test(d))) return null;
  return v as string[];
}

export function sshRoutes(d: {db: Db}, v1: Hono<Vars>) {
  const db = d.db;

  v1.get('/ssh', async (c) => {
    const list = await db.select({device: ssh.sessionId, agent: session.userAgent, port: ssh.port, destinations: ssh.destinations,
      since: ms(sql`${ssh.since}`), seen: ms(sql`${ssh.seenAt}`)})
      .from(ssh).innerJoin(session, eq(session.id, ssh.sessionId)).where(eq(ssh.userId, c.get('userId'))).orderBy(desc(ssh.since));
    return c.json(list.map((r: {device: string}) => ({...r, current: r.device === c.get('sessionId')})));
  });

  v1.put('/ssh/this', async (c) => {
    // A page cannot turn SSH on: that is done at the device (l3 address, the app's switch).
    if (c.req.header('Origin')) return c.json({error: 'SSH is turned on at the device itself'}, 403);
    const b = await body<{port?: unknown; destinations?: unknown}>(c);
    const port = b?.port, list = destinations(b?.destinations);
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || !list) return c.json({error: 'a port and destinations'}, 400);
    const row = {sessionId: c.get('sessionId'), userId: c.get('userId'), port, destinations: list};
    await db.insert(ssh).values(row).onConflictDoUpdate({target: ssh.sessionId, set: {port, destinations: list, since: sql`now()`, seenAt: sql`now()`}});
    return c.json({on: true});
  });

  // Never makes a row: one gone was turned off, and stays off until the device turns it on again.
  v1.post('/ssh/this/beat', async (c) => {
    const b = await body<{destinations?: unknown}>(c);
    const list = b?.destinations === undefined ? undefined : destinations(b.destinations);
    if (list === null) return c.json({error: 'destinations'}, 400);
    const done = await db.update(ssh).set({seenAt: sql`now()`, ...(list ? {destinations: list} : {})})
      .where(eq(ssh.sessionId, c.get('sessionId'))).returning({port: ssh.port});
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
