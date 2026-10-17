// Topic: short posts, one timeline for everyone on this Remote, newest first.
//
// A post is text only and short, made from one of its author's addresses
// (how a person is found, as in the Inbox: one is needed to post), and kept
// until its author takes it down. A post's id sorts as its time, so the
// timeline is read a page at a time as a range of ids on one index:
//
//   GET /v1/topic?before=ID   older than ID, newest first (no ID: the newest)
//   GET /v1/topic?after=ID    newer than ID, oldest first, so a reader that
//                             was away takes in what came, page after page,
//                             with no gap between what it had and what came
//   GET /v1/topic?from=A&to=B a page again: the ids from A to B, newest first
//   GET /v1/topic?by=me       one's own, with how many there are
//
// A page read again is the same page, less what was taken down: a reader can
// let go of what it read and read it again when it is back in view.
//
// What keeps this from being anyone's megaphone: every account is a
// provider's identity, posting needs an address, and a post is text only,
// short, and only so many an hour.

import {and, asc, desc, eq, gt, gte, lt, lte, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {address, post, user} from './schema.ts';

export const TOPIC = {body: 500, perHour: 30, page: 30, maxPage: 100} as const;
const ID = /^[0-9a-z]{9}[0-9a-z]{8}$/;

/** An id that sorts as its time: milliseconds in base 36 (nine places), then eight random places. */
export function postId(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  const tail = [...random].map((n) => n.toString(36).padStart(7, '0').slice(-4)).join('');
  return now.toString(36).padStart(9, '0') + tail;
}

type Vars = {Variables: {userId: string; sessionId: string}};

export interface TopicDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

export function topic(d: TopicDeps, v1: Hono<Vars>) {
  const shape = (me: string) => (r: {id: string; userId: string; address: string; name: string | null; body: string; createdAt: Date}) =>
    ({id: r.id, address: r.address, name: r.name ?? '', body: r.body, at: r.createdAt.getTime(), mine: r.userId === me});
  const columns = {id: post.id, userId: post.userId, address: post.address, name: user.name, body: post.body, createdAt: post.createdAt};

  v1.get('/topic', async (c) => {
    const me = c.get('userId');
    const q = c.req.query();
    const limit = Math.min(TOPIC.maxPage, Math.max(1, Number(q.limit) || TOPIC.page));
    const before = q.before && ID.test(q.before) ? q.before : null;
    const after = q.after && ID.test(q.after) ? q.after : null;
    const from = q.from && ID.test(q.from) ? q.from : null;
    const to = q.to && ID.test(q.to) ? q.to : null;
    const by = q.by === 'me' ? eq(post.userId, me) : undefined;
    // One more than asked says whether there is more past the page.
    const rows = await d.db.select(columns).from(post).leftJoin(user, eq(user.id, post.userId))
      .where(and(by, before ? lt(post.id, before) : undefined, after ? gt(post.id, after) : undefined,
        from ? gte(post.id, from) : undefined, to ? lte(post.id, to) : undefined))
      .orderBy(after ? asc(post.id) : desc(post.id)).limit(limit + 1);
    const more = rows.length > limit;
    const out: Record<string, unknown> = {posts: rows.slice(0, limit).map(shape(me)), more};
    if (by) out.total = Number((await d.db.select({n: sql<number>`count(*)`}).from(post).where(by))[0].n);
    return c.json(out);
  });

  v1.post('/topic', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {body?: unknown; from?: unknown} | null;
    const body = typeof b?.body === 'string' ? b.body.trim() : '';
    if (!body || body.length > TOPIC.body) return c.json({error: `a text of at most ${TOPIC.body} characters`}, 400);
    const own = await d.db.select().from(address).where(eq(address.userId, me)).orderBy(address.createdAt) as {address: string}[];
    const from = own.find((a) => a.address === b?.from) ?? own[0];
    if (!from) return c.json({error: 'claim an address first'}, 409);
    const hour = new Date(Date.now() - 3600_000);
    const [{made}] = await d.db.select({made: sql<number>`count(*)`}).from(post).where(and(eq(post.userId, me), gt(post.createdAt, hour)));
    if (Number(made) >= TOPIC.perHour) return c.json({error: 'too many posts this hour'}, 429);
    const id = postId();
    await d.db.insert(post).values({id, userId: me, address: from.address, body});
    const [row] = await d.db.select(columns).from(post).leftJoin(user, eq(user.id, post.userId)).where(eq(post.id, id));
    return c.json(shape(me)(row), 201);
  });

  // Taking a post down is its author's alone.
  v1.delete('/topic/:id', async (c) => {
    const gone = await d.db.delete(post).where(and(eq(post.id, c.req.param('id')), eq(post.userId, c.get('userId')))).returning({id: post.id});
    return gone.length ? c.body(null, 204) : c.json({error: 'no such post of yours'}, 404);
  });
}
