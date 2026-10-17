// Servers: the one thing whose subject is people, not a repo. A server is a
// group of people who know each other (each added by someone already in it,
// from their Inbox contacts), for talking loosely and for planning in
// earnest. Its boards are what they talk about: each holds a plan, one text
// its people write together, and the discussion around it, short posts read
// as a conversation. (A repo belongs to a person; a server's own repos, and
// its plans kept in one, come next.)
//
// The plan is changed by hunks of lines against the version they were made
// on (src/plan.ts): a change made on an older version is merged with what
// came meanwhile, and where two people changed the same lines differently
// nothing is overwritten: the writer is shown the plan as it now is.
//
// A board is its server's people's alone unless opened, board by board:
// `open`, anyone reads it (signed in or not); `guests`, an outsider may write
// in it once they have shown an email address is theirs, by a short code
// sent to it. All of it is kept here; any of it can be taken home as text
// (archive).
//
//   GET    /v1/servers                       mine, each with its boards
//   POST   /v1/servers                       {name}: a new one, with a first board
//   PATCH  /v1/servers/ID                    {name}
//   DELETE /v1/servers/ID                    its owner's
//   GET    /v1/servers/ID/people
//   POST   /v1/servers/ID/people             {address}: one of my contacts
//   DELETE /v1/servers/ID/people/ADDR        leave (one's own), or its owner removes
//   POST   /v1/servers/ID/boards             {name}
//   GET    /v1/boards/ID                     the board, its plan and version, its people
//   PATCH  /v1/boards/ID                     {name?, open?, guests?}
//   DELETE /v1/boards/ID
//   PUT    /v1/boards/ID/plan                {base, hunks}
//   GET    /v1/boards/ID/posts               ?before= | ?after= | ?from=&to=
//   POST   /v1/boards/ID/posts               {body}
//   DELETE /v1/boards/ID/posts/PID           its writer's, or the server owner's
//   GET    /v1/boards/ID/archive             ?from=&to=&plan=0|1&talk=0|1: markdown
// and, for anyone, on open boards (and guests on boards that take them):
//   GET    /v1/open                          the open boards
//   GET    /v1/open/ID | /posts | /archive
//   POST   /v1/open/ID/guest                 {email}: a code is sent to it
//   POST   /v1/open/ID/guest/check           {email, code}: a token to write with
//   POST   /v1/open/ID/posts                 {body}, with X-Guest: token

import {and, asc, desc, eq, gt, gte, inArray, lt, lte, sql} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import {hunks, lines, merge, text, valid} from '../src/plan.ts';
import {address, board, contact, guest, member, planVersion, server, talk} from './schema.ts';

export const SERVER = {name: 64, body: 2000, plan: 64 * 1024, perHour: 60, page: 30, maxPage: 100, servers: 50, boards: 100,
  /** A guest's code: how long it holds, how many wrong tries spend it, how soon another may be sent. */
  code: {minutes: 10, tries: 5, again: 60_000}, versions: 200} as const;
const ID = /^[0-9a-z]{17}$/;
const KEY = /^[0-9a-z]{12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** An id that sorts as its time: milliseconds in base 36 (nine places), then eight random places. */
export function postId(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  const tail = [...random].map((n) => n.toString(36).padStart(7, '0').slice(-4)).join('');
  return now.toString(36).padStart(9, '0') + tail;
}
const idAt = (ms: number) => Math.max(0, ms).toString(36).padStart(9, '0');
const timeOf = (id: string) => parseInt(id.slice(0, 9), 36);
const key = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => (b % 36).toString(36)).join('');
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
async function digest(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

type Vars = {Variables: {userId: string; sessionId: string}};

export interface ServerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  /** Sends a guest their code; without it, guests cannot be checked (and the Remote says so). */
  mail?: (to: string, subject: string, text: string) => Promise<void>;
  /** Mixed into the digests of codes and tokens. */
  secret?: string;
}

type Board = typeof board.$inferSelect;
type Post = typeof talk.$inferSelect;
const shape = (me: string | null, owner: boolean) => (p: Post) => ({
  id: p.id, by: p.by, body: p.body, at: timeOf(p.id), ...(p.guestId ? {guest: true} : {}),
  ...(me && (p.userId === me || owner) ? {mine: p.userId === me, mayTakeDown: true} : {}),
});

export function servers(d: ServerDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  const name = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const fine = (n: string) => n.length > 0 && n.length <= SERVER.name;

  // ---- who may do what ----
  const membership = async (serverId: string, me: string) =>
    (await db.select().from(member).where(and(eq(member.serverId, serverId), eq(member.userId, me))))[0] as typeof member.$inferSelect | undefined;
  const boardOf = async (id: string) => (KEY.test(id) ? (await db.select().from(board).where(eq(board.id, id)))[0] as Board | undefined : undefined);
  /** The board, if `me` is one of its server's people; else null. */
  const mine = async (id: string, me: string) => {
    const b = await boardOf(id);
    const m = b && await membership(b.serverId, me);
    return b && m ? {b, m} : null;
  };
  const myAddress = async (me: string) =>
    ((await db.select({a: address.address}).from(address).where(eq(address.userId, me)).orderBy(address.createdAt)) as {a: string}[])[0]?.a ?? null;

  const boardJson = async (b: Board) => {
    const [s] = await db.select().from(server).where(eq(server.id, b.serverId));
    return {id: b.id, server: {id: s.id, name: s.name}, name: b.name, plan: b.plan, version: b.version, open: !!b.open, guests: !!b.guests};
  };
  const people = async (serverId: string) =>
    (await db.select({address: member.address, owner: member.owner}).from(member).where(eq(member.serverId, serverId)).orderBy(member.addedAt))
      .map((r: {address: string; owner: number}) => ({address: r.address, owner: !!r.owner}));

  // ---- servers ----
  v1.get('/servers', async (c) => {
    const me = c.get('userId');
    const rows = await db.select({id: server.id, name: server.name, owner: member.owner}).from(member)
      .innerJoin(server, eq(server.id, member.serverId)).where(eq(member.userId, me)).orderBy(member.addedAt) as {id: string; name: string; owner: number}[];
    if (!rows.length) return c.json([]);
    const boards = await db.select({id: board.id, serverId: board.serverId, name: board.name, open: board.open, guests: board.guests}).from(board)
      .where(inArray(board.serverId, rows.map((r) => r.id))).orderBy(board.createdAt) as {id: string; serverId: string; name: string; open: number; guests: number}[];
    return c.json(rows.map((r) => ({id: r.id, name: r.name, owner: !!r.owner,
      boards: boards.filter((b) => b.serverId === r.id).map((b) => ({id: b.id, name: b.name, open: !!b.open, guests: !!b.guests}))})));
  });

  v1.post('/servers', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {name?: unknown; board?: unknown} | null;
    const n = name(b?.name), first = name(b?.board) || 'general';
    if (!fine(n) || !fine(first)) return c.json({error: `a name of at most ${SERVER.name} characters`}, 400);
    const at = await myAddress(me);
    if (!at) return c.json({error: 'claim an address first'}, 409);
    const [{n: held}] = await db.select({n: sql<number>`count(*)`}).from(member).where(eq(member.userId, me));
    if (Number(held) >= SERVER.servers) return c.json({error: 'too many servers'}, 429);
    const id = key(), bid = key();
    await db.insert(server).values({id, name: n});
    await db.insert(member).values({serverId: id, userId: me, address: at, owner: 1});
    await db.insert(board).values({id: bid, serverId: id, name: first});
    return c.json({id, name: n, owner: true, boards: [{id: bid, name: first, open: false, guests: false}]}, 201);
  });

  v1.patch('/servers/:id', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!await membership(id, me)) return c.json({error: 'no such server of yours'}, 404);
    const n = name((await c.req.json().catch(() => null) as {name?: unknown} | null)?.name);
    if (!fine(n)) return c.json({error: `a name of at most ${SERVER.name} characters`}, 400);
    await db.update(server).set({name: n}).where(eq(server.id, id));
    return c.json({id, name: n});
  });

  v1.delete('/servers/:id', async (c) => {
    const m = await membership(c.req.param('id'), c.get('userId'));
    if (!m?.owner) return c.json({error: 'only its owner removes a server'}, 403);
    await db.delete(server).where(eq(server.id, m.serverId));
    return c.body(null, 204);
  });

  // ---- its people ----
  v1.get('/servers/:id/people', async (c) => {
    if (!await membership(c.req.param('id'), c.get('userId'))) return c.json({error: 'no such server of yours'}, 404);
    return c.json(await people(c.req.param('id')));
  });

  // Someone comes in by someone already in, from their own contacts: a server is people who know each other.
  v1.post('/servers/:id/people', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!await membership(id, me)) return c.json({error: 'no such server of yours'}, 404);
    const a = name((await c.req.json().catch(() => null) as {address?: unknown} | null)?.address).toLowerCase();
    const [who] = await db.select({userId: address.userId}).from(address).where(eq(address.address, a)) as {userId: string}[];
    if (!who) return c.json({error: 'no such address'}, 404);
    const [known] = await db.select().from(contact).where(and(eq(contact.userId, me), eq(contact.peer, who.userId), eq(contact.state, 'accepted')));
    if (!known) return c.json({error: 'only your contacts can be added'}, 403);
    await db.insert(member).values({serverId: id, userId: who.userId, address: a}).onConflictDoNothing();
    return c.json(await people(id), 201);
  });

  v1.delete('/servers/:id/people/:address', async (c) => {
    const me = c.get('userId'), id = c.req.param('id'), a = c.req.param('address').toLowerCase();
    const m = await membership(id, me);
    if (!m) return c.json({error: 'no such server of yours'}, 404);
    const [them] = await db.select().from(member).where(and(eq(member.serverId, id), eq(member.address, a))) as (typeof member.$inferSelect)[];
    if (!them) return c.json({error: 'not in this server'}, 404);
    if (them.userId !== me && !m.owner) return c.json({error: 'only its owner removes someone else'}, 403);
    await db.delete(member).where(and(eq(member.serverId, id), eq(member.userId, them.userId)));
    const left = await db.select().from(member).where(eq(member.serverId, id)).orderBy(member.addedAt) as (typeof member.$inferSelect)[];
    // The last to leave takes the server with them; an owner leaving hands it to whoever came first.
    if (!left.length) await db.delete(server).where(eq(server.id, id));
    else if (them.owner) await db.update(member).set({owner: 1}).where(and(eq(member.serverId, id), eq(member.userId, left[0].userId)));
    return c.body(null, 204);
  });

  // ---- boards ----
  v1.post('/servers/:id/boards', async (c) => {
    const id = c.req.param('id');
    if (!await membership(id, c.get('userId'))) return c.json({error: 'no such server of yours'}, 404);
    const n = name((await c.req.json().catch(() => null) as {name?: unknown} | null)?.name);
    if (!fine(n)) return c.json({error: `a name of at most ${SERVER.name} characters`}, 400);
    const [{n: count}] = await db.select({n: sql<number>`count(*)`}).from(board).where(eq(board.serverId, id));
    if (Number(count) >= SERVER.boards) return c.json({error: 'too many boards'}, 429);
    const bid = key();
    await db.insert(board).values({id: bid, serverId: id, name: n});
    return c.json({id: bid, name: n, open: false, guests: false}, 201);
  });

  v1.get('/boards/:id', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    return c.json({...await boardJson(at.b), people: await people(at.b.serverId)});
  });

  v1.patch('/boards/:id', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    const b = await c.req.json().catch(() => null) as {name?: unknown; open?: unknown; guests?: unknown} | null;
    const set: Partial<Board> = {};
    if (b?.name !== undefined) { const n = name(b.name); if (!fine(n)) return c.json({error: 'a name'}, 400); set.name = n; }
    if (typeof b?.open === 'boolean') set.open = b.open ? 1 : 0;
    if (typeof b?.guests === 'boolean') set.guests = b.guests ? 1 : 0;
    if (Object.keys(set).length) await db.update(board).set(set).where(eq(board.id, at.b.id));
    return c.json(await boardJson({...at.b, ...set}));
  });

  v1.delete('/boards/:id', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    if (!at.m.owner) return c.json({error: 'only its server\'s owner removes a board'}, 403);
    await db.delete(board).where(eq(board.id, at.b.id));
    return c.body(null, 204);
  });

  // ---- the plan ----
  v1.put('/boards/:id/plan', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me);
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    const r = await c.req.json().catch(() => null) as {base?: unknown; hunks?: unknown} | null;
    const base = Number(r?.base);
    if (!Number.isInteger(base) || base < 0 || base > at.b.version) return c.json({error: 'a version'}, 400);
    // What the change was made on: the plan then.
    const then = base === at.b.version ? at.b.plan
      : base === 0 ? '' : ((await db.select({t: planVersion.text}).from(planVersion).where(and(eq(planVersion.boardId, at.b.id), eq(planVersion.version, base))))[0] as {t: string} | undefined)?.t;
    if (then === undefined) return c.json({error: 'that version is no longer kept', plan: at.b.plan, version: at.b.version}, 409);
    const was = lines(then);
    if (!valid(r?.hunks, was.length)) return c.json({error: 'hunks of that version'}, 400);
    const now = lines(at.b.plan);
    const out = base === at.b.version ? merge(was, r!.hunks as never, []) : merge(was, r!.hunks as never, hunks(was, now));
    // The same lines changed differently: nothing is overwritten; the writer is shown the plan as it is.
    if (!out) return c.json({error: 'changed meanwhile', plan: at.b.plan, version: at.b.version}, 409);
    const plan = text(out);
    if (plan.length > SERVER.plan) return c.json({error: `a plan of at most ${SERVER.plan} characters`}, 413);
    const version = at.b.version + 1;
    // Only over the version read: a change that came in between makes this one try again.
    const moved = await db.update(board).set({plan, version}).where(and(eq(board.id, at.b.id), eq(board.version, at.b.version))).returning({id: board.id});
    if (!moved.length) return c.json({error: 'changed meanwhile', ...await boardJson((await boardOf(at.b.id))!)}, 409);
    await db.insert(planVersion).values({boardId: at.b.id, version, text: plan, by: at.m.address});
    await db.delete(planVersion).where(and(eq(planVersion.boardId, at.b.id), lte(planVersion.version, version - SERVER.versions)));
    return c.json({plan, version, merged: base !== at.b.version});
  });

  // ---- the discussion ----
  const read = async (b: Board, q: Record<string, string>, me: string | null, owner: boolean) => {
    const limit = Math.min(SERVER.maxPage, Math.max(1, Number(q.limit) || SERVER.page));
    const at = (k: string) => (q[k] && ID.test(q[k]) ? q[k] : null);
    const [before, after, from, to] = ['before', 'after', 'from', 'to'].map(at);
    // One more than asked says whether there is more past the page.
    const rows: Post[] = await db.select().from(talk)
      .where(and(eq(talk.boardId, b.id), before ? lt(talk.id, before) : undefined, after ? gt(talk.id, after) : undefined,
        from ? gte(talk.id, from) : undefined, to ? lte(talk.id, to) : undefined))
      .orderBy(after ? asc(talk.id) : desc(talk.id)).limit(limit + 1);
    return {posts: rows.slice(0, limit).map(shape(me, owner)), more: rows.length > limit};
  };

  v1.get('/boards/:id/posts', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me);
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    return c.json(await read(at.b, c.req.query(), me, !!at.m.owner));
  });

  const write = async (c: Context, b: Board, who: {userId?: string; guestId?: string; by: string}) => {
    const r = await c.req.json().catch(() => null) as {body?: unknown} | null;
    const body = typeof r?.body === 'string' ? r.body.trim() : '';
    if (!body || body.length > SERVER.body) return c.json({error: `a text of at most ${SERVER.body} characters`}, 400);
    const whose = who.userId ? eq(talk.userId, who.userId) : eq(talk.guestId, who.guestId!);
    const [{n}] = await db.select({n: sql<number>`count(*)`}).from(talk).where(and(whose, gte(talk.id, idAt(Date.now() - 3600_000))));
    if (Number(n) >= SERVER.perHour) return c.json({error: 'too many posts this hour'}, 429);
    const row = {id: postId(), boardId: b.id, userId: who.userId ?? null, guestId: who.guestId ?? null, by: who.by, body};
    await db.insert(talk).values(row);
    return c.json(shape(who.userId ?? null, false)(row), 201);
  };

  v1.post('/boards/:id/posts', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    return write(c, at.b, {userId: c.get('userId'), by: at.m.address});
  });

  v1.delete('/boards/:id/posts/:pid', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me);
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    const whose = at.m.owner ? undefined : eq(talk.userId, me);
    const gone = await db.delete(talk).where(and(eq(talk.id, c.req.param('pid')), eq(talk.boardId, at.b.id), whose)).returning({id: talk.id});
    return gone.length ? c.body(null, 204) : c.json({error: 'no such post of yours'}, 404);
  });

  // ---- taken home: the plan and the discussion as text ----
  const archive = async (b: Board, q: Record<string, string>) => {
    const s = await boardJson(b);
    const out: string[] = [`# ${s.server.name} / ${b.name}`, ''];
    if (q.plan !== '0') out.push(`## Plan (version ${b.version})`, '', b.plan || '(empty)', '');
    if (q.talk !== '0') {
      const at = (k: string) => (q[k] && ID.test(q[k]) ? q[k] : null);
      const [from, to] = [at('from'), at('to')];
      const rows: Post[] = await db.select().from(talk).where(and(eq(talk.boardId, b.id), from ? gte(talk.id, from) : undefined, to ? lte(talk.id, to) : undefined))
        .orderBy(asc(talk.id)).limit(20_000);
      out.push('## Discussion', '');
      let day = '';
      for (const p of rows) {
        const t = new Date(timeOf(p.id)).toISOString();
        if (t.slice(0, 10) !== day) { day = t.slice(0, 10); out.push(`### ${day}`, ''); }
        out.push(`- ${t.slice(11, 16)} ${p.by}${p.guestId ? ' (guest)' : ''}: ${p.body.replace(/\n/g, '\n  ')}`);
      }
      out.push('');
    }
    return out.join('\n');
  };
  const markdown = (c: Context, body: string, b: Board) => c.body(body, 200, {'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${b.name.replace(/[^\w.-]+/g, '-')}.md"`});

  v1.get('/boards/:id/archive', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    return markdown(c, await archive(at.b, c.req.query()), at.b);
  });

  // ---- for anyone: open boards, and guests (made before /v1's own routes, which ask who is calling) ----
  const open = async (id: string) => { const b = await boardOf(id); return b?.open ? b : undefined; };
  const anyone = {'Access-Control-Allow-Origin': '*'};
  app.get('/v1/open', async (c) => {
    const rows = await db.select({id: board.id, name: board.name, guests: board.guests, server: server.name}).from(board)
      .innerJoin(server, eq(server.id, board.serverId)).where(eq(board.open, 1)).orderBy(desc(board.createdAt)).limit(100) as {id: string; name: string; guests: number; server: string}[];
    return c.json(rows.map((r) => ({id: r.id, name: r.name, server: r.server, guests: !!r.guests})), 200, anyone);
  });
  app.get('/v1/open/:id', async (c) => {
    const b = await open(c.req.param('id'));
    return b ? c.json(await boardJson(b), 200, anyone) : c.json({error: 'no such open board'}, 404);
  });
  app.get('/v1/open/:id/posts', async (c) => {
    const b = await open(c.req.param('id'));
    return b ? c.json(await read(b, c.req.query(), null, false), 200, anyone) : c.json({error: 'no such open board'}, 404);
  });
  app.get('/v1/open/:id/archive', async (c) => {
    const b = await open(c.req.param('id'));
    return b ? markdown(c, await archive(b, c.req.query()), b) : c.json({error: 'no such open board'}, 404);
  });

  // A guest: a code to the email they give, then a token for writing in this board.
  const guestBoard = async (id: string) => { const b = await boardOf(id); return b?.guests ? b : undefined; };
  const seal = (s: string) => digest(`${d.secret ?? ''}:${s}`);
  app.post('/v1/open/:id/guest', async (c) => {
    const b = await guestBoard(c.req.param('id'));
    if (!b) return c.json({error: 'this board takes no guests'}, 404);
    if (!d.mail) return c.json({error: 'this Remote sends no mail'}, 503);
    const email = name((await c.req.json().catch(() => null) as {email?: unknown} | null)?.email).toLowerCase();
    if (!EMAIL.test(email)) return c.json({error: 'an email address'}, 400);
    const [g] = await db.select().from(guest).where(and(eq(guest.boardId, b.id), eq(guest.email, email))) as (typeof guest.$inferSelect)[];
    // One code a minute to an address, so asking cannot be used to flood it.
    if (g?.codeUntil && g.codeUntil.getTime() - SERVER.code.minutes * 60_000 > Date.now() - SERVER.code.again) return c.json({error: 'a code was just sent'}, 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    const until = new Date(Date.now() + SERVER.code.minutes * 60_000);
    if (g) await db.update(guest).set({code: await seal(code), codeUntil: until, tries: 0}).where(eq(guest.id, g.id));
    else await db.insert(guest).values({id: key(), boardId: b.id, email, code: await seal(code), codeUntil: until});
    await d.mail(email, `Your code for ${b.name}`, `Your code to write in "${b.name}" is ${code}. It holds for ${SERVER.code.minutes} minutes.`);
    return c.json({sent: true}, 202, anyone);
  });
  app.post('/v1/open/:id/guest/check', async (c) => {
    const b = await guestBoard(c.req.param('id'));
    if (!b) return c.json({error: 'this board takes no guests'}, 404);
    const r = await c.req.json().catch(() => null) as {email?: unknown; code?: unknown} | null;
    const email = name(r?.email).toLowerCase(), code = name(r?.code);
    const [g] = await db.select().from(guest).where(and(eq(guest.boardId, b.id), eq(guest.email, email))) as (typeof guest.$inferSelect)[];
    if (!g?.code || !g.codeUntil || g.codeUntil.getTime() < Date.now()) return c.json({error: 'not that code'}, 403);
    if (g.code !== await seal(code)) {
      // A few wrong tries spend the code: six digits are not guessed by asking.
      const tries = g.tries + 1;
      await db.update(guest).set(tries >= SERVER.code.tries ? {code: null, codeUntil: null, tries} : {tries}).where(eq(guest.id, g.id));
      return c.json({error: 'not that code'}, 403);
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    await db.update(guest).set({code: null, codeUntil: null, token: await seal(token)}).where(eq(guest.id, g.id));
    return c.json({token, as: email.split('@')[0]}, 200, anyone);
  });
  app.post('/v1/open/:id/posts', async (c) => {
    const b = await guestBoard(c.req.param('id'));
    if (!b) return c.json({error: 'this board takes no guests'}, 404);
    const token = c.req.header('X-Guest') ?? '';
    const [g] = token ? await db.select().from(guest).where(and(eq(guest.boardId, b.id), eq(guest.token, await seal(token)))) as (typeof guest.$inferSelect)[] : [];
    if (!g) return c.json({error: 'show your email first'}, 401);
    return write(c, b, {guestId: g.id, by: g.email.split('@')[0]});
  });
}
