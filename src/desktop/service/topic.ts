// Topic: short posts, newest first. Anyone may read; posting needs an
// account and an address (how a person is found, as in the Inbox).
//
// A post does not go to everyone at once. It starts as a locked account's
// would: its author's accepted contacts see it, and so does a small random
// share of the readers signed in here. If those who saw it keep it often
// enough, it widens to the next ring (a sixteenth, a quarter, everyone
// signed in), and at last to everyone, signed in or not: each ring is a
// test of the post on a sample, and only what the sample keeps is shown to
// more. It stops widening after a few days.
//
// Nothing is computed per post beyond its own row. A post has a random
// salt and a reader a seed (a hash of their account); the reader is in the
// post's ring when (salt ^ seed) mod 1024 falls under the ring's share,
// checked in the same query that reads the page. So each post has its own
// random audience, each ring holds the one before, and spreading is a
// counter and a compare: no copies to followers, no ranking, nothing run
// in the background.
//
//   GET /v1/topic/everyone?before=ID  what everyone may read (no account)
//   GET /v1/topic?before=ID       what this reader may read; counts it seen
//   GET /v1/topic?after=ID        newer, oldest first (no gap: page on)
//   GET /v1/topic?from=A&to=B     a page again (quiet=1: not counted again)
//   GET /v1/topic?by=me           one's own, with how many and how far each went
//   POST /v1/topic                {body}
//   POST|DELETE /v1/topic/ID/keep keep it, or not
//   DELETE /v1/topic/ID           its author takes it down
//
// A post is kept as little as it can be: no profile, only the address it was
// made from; its time is its id.

import {and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {address, keep, post, user} from './schema.ts';

export const TOPIC = {body: 500, perHour: 30, page: 30, maxPage: 100, spreadDays: 3} as const;
/** Each ring's share of signed-in readers, of 1024; past the last, everyone. */
export const RINGS = [16, 64, 256, 1024] as const;
export const PUBLIC = RINGS.length;
/** To widen, a ring's readers have seen it this often and kept it at least this share. */
export const SPREAD = {seen: 8, rate: 0.1} as const;
/** A ring is never fewer readers than this, where there are as many: a small Remote's rings are all of it. */
export const FLOOR = 24;
const ID = /^[0-9a-z]{17}$/;

/** An id that sorts as its time: milliseconds in base 36 (nine places), then eight random places. */
export function postId(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  const tail = [...random].map((n) => n.toString(36).padStart(7, '0').slice(-4)).join('');
  return now.toString(36).padStart(9, '0') + tail;
}
/** The first id at `ms`: posts made from then on sort at or after it. */
const idAt = (ms: number) => Math.max(0, ms).toString(36).padStart(9, '0');
const timeOf = (id: string) => parseInt(id.slice(0, 9), 36);

/** A reader's seed: a hash of their account (FNV-1a), the same every time. */
export function seedOf(userId: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < userId.length; k++) { h ^= userId.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

type Vars = {Variables: {userId: string; sessionId: string}};

export interface TopicDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  /** FLOOR unless said (tests watch a ring on a few accounts). */
  floor?: number;
}

export function topic(d: TopicDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  // How many accounts there are, looked at now and then: a ring reaches at least FLOOR of them.
  let people = {n: 0, at: 0};
  const shares = async () => {
    if (Date.now() - people.at > 600_000) {
      people = {n: Number((await d.db.select({n: sql<number>`count(*)`}).from(user))[0].n), at: Date.now()};
    }
    const floor = Math.ceil(1024 * Math.min(1, (d.floor ?? FLOOR) / Math.max(1, people.n)));
    return RINGS.map((r) => Math.max(r, floor));
  };

  type Row = {id: string; userId: string; address: string; body: string; ring: number; keeps: number; mine: string | null};
  const shape = (me: string | null) => (r: Row) => ({
    id: r.id, by: r.address, body: r.body, at: timeOf(r.id), keeps: r.keeps,
    ...(me ? {kept: r.mine !== null} : {}),
    // How far it went is for its author to see.
    ...(me && r.userId === me ? {mine: true, ring: r.ring} : {}),
  });

  const read = async (q: Record<string, string>, me: string | null) => {
    const limit = Math.min(TOPIC.maxPage, Math.max(1, Number(q.limit) || TOPIC.page));
    const at = (k: string) => (q[k] && ID.test(q[k]) ? q[k] : null);
    const [before, after, from, to] = ['before', 'after', 'from', 'to'].map(at);
    let may;
    if (!me) may = gte(post.ring, PUBLIC);
    else if (q.by === 'me') may = eq(post.userId, me);
    else {
      const [r0, r1, r2] = await shares();
      const seed = seedOf(me);
      may = or(
        gte(post.ring, RINGS.length - 1),
        eq(post.userId, me),
        sql`${post.userId} in (select user_id from contact where peer = ${me} and state = 'accepted')`,
        sql`((${post.salt} # ${seed}::int) & 1023) < (case ${post.ring} when 0 then ${r0}::int when 1 then ${r1}::int else ${r2}::int end)`,
      );
    }
    const columns = {id: post.id, userId: post.userId, address: post.address, body: post.body, ring: post.ring, keeps: post.keeps, mine: me ? keep.userId : sql<null>`null`};
    let query = d.db.select(columns).from(post);
    if (me) query = query.leftJoin(keep, and(eq(keep.postId, post.id), eq(keep.userId, me)));
    // One more than asked says whether there is more past the page.
    const rows: Row[] = await query
      .where(and(may, before ? lt(post.id, before) : undefined, after ? gt(post.id, after) : undefined,
        from ? gte(post.id, from) : undefined, to ? lte(post.id, to) : undefined))
      .orderBy(after ? asc(post.id) : desc(post.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    // Seen: what is still spreading, by others, shown to this reader the first time (a page read
    // again is quiet). One update for the page, then whatever its readers kept enough widens.
    if (me && q.quiet !== '1' && q.by !== 'me') {
      const spreading = page.filter((r) => r.ring < PUBLIC && r.userId !== me).map((r) => r.id);
      if (spreading.length) {
        await d.db.update(post).set({seen: sql`${post.seen} + 1`}).where(inArray(post.id, spreading));
        await widen(spreading);
      }
    }
    const out: Record<string, unknown> = {posts: page.map(shape(me)), more: rows.length > limit};
    if (q.by === 'me') out.total = Number((await d.db.select({n: sql<number>`count(*)`}).from(post).where(eq(post.userId, me!)))[0].n);
    return out;
  };

  /** Each of `ids` whose ring saw it enough and kept enough of it goes one ring wider. */
  const widen = (ids: string[]) => d.db.update(post).set({ring: sql`${post.ring} + 1`, seen: 0, kept: 0}).where(and(
    inArray(post.id, ids), lt(post.ring, PUBLIC), gte(post.id, idAt(Date.now() - TOPIC.spreadDays * 86_400_000)),
    gte(post.seen, SPREAD.seen), sql`${post.kept} >= ${post.seen} * ${SPREAD.rate}::real`));

  // Anyone may read what has gone everywhere (made before /v1's own routes, which ask who is calling).
  app.get('/v1/topic/everyone', async (c) => c.json(await read(c.req.query(), null), 200, {'Access-Control-Allow-Origin': '*'}));
  v1.get('/topic', async (c) => c.json(await read(c.req.query(), c.get('userId'))));

  v1.post('/topic', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {body?: unknown; from?: unknown} | null;
    const body = typeof b?.body === 'string' ? b.body.trim() : '';
    if (!body || body.length > TOPIC.body) return c.json({error: `a text of at most ${TOPIC.body} characters`}, 400);
    const own = await d.db.select({address: address.address}).from(address).where(eq(address.userId, me)).orderBy(address.createdAt) as {address: string}[];
    const from = own.find((a) => a.address === b?.from) ?? own[0];
    if (!from) return c.json({error: 'claim an address first'}, 409);
    const [{made}] = await d.db.select({made: sql<number>`count(*)`}).from(post).where(and(eq(post.userId, me), gte(post.id, idAt(Date.now() - 3600_000))));
    if (Number(made) >= TOPIC.perHour) return c.json({error: 'too many posts this hour'}, 429);
    const row = {id: postId(), userId: me, address: from.address, body, ring: 0, salt: crypto.getRandomValues(new Int32Array(1))[0], keeps: 0, mine: null};
    await d.db.insert(post).values({id: row.id, userId: me, address: row.address, body, salt: row.salt});
    return c.json(shape(me)(row), 201);
  });

  // Keeping counts once a reader, toward its ring's share and in all.
  v1.post('/topic/:id/keep', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const [p] = await d.db.select({userId: post.userId}).from(post).where(eq(post.id, id)) as {userId: string}[];
    if (!p) return c.json({error: 'no such post'}, 404);
    if (p.userId === me) return c.json({error: 'that is yours'}, 400);
    const added = await d.db.insert(keep).values({postId: id, userId: me}).onConflictDoNothing().returning({id: keep.postId});
    if (added.length) {
      await d.db.update(post).set({kept: sql`${post.kept} + 1`, keeps: sql`${post.keeps} + 1`}).where(eq(post.id, id));
      await widen([id]);
    }
    return c.json({kept: true});
  });
  v1.delete('/topic/:id/keep', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const gone = await d.db.delete(keep).where(and(eq(keep.postId, id), eq(keep.userId, me))).returning({id: keep.postId});
    if (gone.length) await d.db.update(post).set({kept: sql`greatest(${post.kept} - 1, 0)`, keeps: sql`greatest(${post.keeps} - 1, 0)`}).where(eq(post.id, id));
    return c.json({kept: false});
  });

  // Taking a post down is its author's alone.
  v1.delete('/topic/:id', async (c) => {
    const gone = await d.db.delete(post).where(and(eq(post.id, c.req.param('id')), eq(post.userId, c.get('userId')))).returning({id: post.id});
    return gone.length ? c.body(null, 204) : c.json({error: 'no such post of yours'}, 404);
  });
}
