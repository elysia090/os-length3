// Servers: the one thing whose subject is people, not a repo. A server is a
// group of people who know each other (each added by someone already in it,
// from their Inbox contacts). Its boards are what they talk about: each is a
// conversation, short posts read as a chat is, and a TODO they keep
// together, the same list as Home's (src/todo.ts), kept here item by item
// and field by field so that two people writing never undo each other but
// on the very same field. (A repo belongs to a person, who may show it in a
// server, only to be seen there: seen.ts. A server's own repos come next.)
//
// A board is its server's people's alone unless opened, board by board:
// `open`, anyone reads it (signed in or not); `guests`, an outsider may write
// in it once they have shown an email address is theirs, by a short code
// sent to it. All of it is kept here; any of it can be taken home as text
// (archive).
//
//   GET    /v1/servers                       mine, each with its boards (?gone=1: those I may bring back)
//   POST   /v1/servers                       {name, address}: a new one, named name@domain, with a first board
//   POST   /v1/servers/ID/back               bring back one removed or left (within the hold)
//   PATCH  /v1/servers/ID                    {name}: its owner's
//   DELETE /v1/servers/ID                    its owner's
//   GET    /v1/servers/ID/people
//   POST   /v1/servers/ID/people             {address}: one of my contacts
//   DELETE /v1/servers/ID/people/ADDR        leave (one's own), or its owner removes
//   POST   /v1/servers/ID/boards             {name}
//   GET    /v1/boards/ID                     the board and its people
//   PATCH  /v1/boards/ID                     {name?, open?, guests?}: open and guests its server's owner's
//   DELETE /v1/boards/ID
//   GET    /v1/boards/ID/todos               its TODO, in order
//   PUT    /v1/boards/ID/todos/TID           {kind?, title?, detail?, done?, place?, created?}: what changed of an item, or a new one
//   DELETE /v1/boards/ID/todos/TID
//   GET    /v1/boards/ID/posts               ?before= | ?after= | ?from=&to=
//   POST   /v1/boards/ID/posts               {body}
//   DELETE /v1/boards/ID/posts/PID           its writer's, or the server owner's
//   GET    /v1/boards/ID/archive             ?from=&to=&todo=0|1&talk=0|1: markdown
// and, for anyone, on open boards (and guests on boards that take them):
//   GET    /v1/open                          the open boards
//   GET    /v1/open/ID | /todos | /posts | /archive
//   POST   /v1/open/ID/guest                 {email}: a code is sent to it
//   POST   /v1/open/ID/guest/check           {email, code}: a token to write with
//   POST   /v1/open/ID/posts                 {body}, with X-Guest: token

import {and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import {claim, codeOf, HOLD, live, release} from './names.ts';
import {takeDown} from './seen.ts';
import {address, board, contact, guest, member, repoPublic, repoShare, server, talk, todoItem} from './schema.ts';

export const SERVER = {name: 64, body: 2000, perHour: 60, page: 30, maxPage: 100, servers: 50, boards: 100,
  /** A board's TODO: as long as Home's items may be (src/todo.ts), and so many of them. */
  todo: {title: 200, detail: 4000, items: 500},
  /** A guest's code: how long it holds, how many wrong tries spend it, how soon another may be sent. */
  code: {minutes: 10, tries: 5, again: 60_000}} as const;
const TODO_ID = /^[0-9a-z-]{1,40}$/;
const KIND = /^[A-Za-z][A-Za-z0-9-]{0,15}$/;
const ID = /^[0-9a-z]{17}$/;
const KEY = /^[0-9a-z]{12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** A principal's name before @, as an address's is (inbox.ts). */
const NAME = /^[a-z0-9][a-z0-9._-]{1,30}$/;

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
  /** This Remote's own domain: a server's name is claimed on it, or on a domain one of its people holds. */
  domain: string;
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
  // A server removed or left by its last person answers nothing while it is held.
  const membership = async (serverId: string, me: string) =>
    (await db.select({serverId: member.serverId, userId: member.userId, address: member.address, owner: member.owner, addedAt: member.addedAt}).from(member)
      .innerJoin(server, eq(server.id, member.serverId))
      .where(and(eq(member.serverId, serverId), eq(member.userId, me), isNull(server.goneAt))))[0] as typeof member.$inferSelect | undefined;
  const boardOf = async (id: string) => (KEY.test(id)
    ? (await db.select({b: board}).from(board).innerJoin(server, eq(server.id, board.serverId)).where(and(eq(board.id, id), isNull(server.goneAt))))[0]?.b as Board | undefined
    : undefined);
  /** The board, if `me` is one of its server's people; else null. */
  const mine = async (id: string, me: string) => {
    const b = await boardOf(id);
    const m = b && await membership(b.serverId, me);
    return b && m ? {b, m} : null;
  };
  /** How `me` is shown: their first address that answers. */
  const myAddress = async (me: string) =>
    ((await db.select({a: address.address}).from(address).where(and(eq(address.userId, me), live)).orderBy(address.createdAt)) as {a: string}[])[0]?.a ?? null;
  /** Gone, held for whoever removed it or left it last; its name is let go (held too). */
  const gone = async (id: string, by: string) => {
    const [s] = await db.update(server).set({goneAt: new Date(), goneBy: by}).where(eq(server.id, id)).returning({address: server.address});
    if (s?.address) await release(db, s.address);
  };

  const boardJson = async (b: Board) => {
    const [s] = await db.select().from(server).where(eq(server.id, b.serverId));
    return {id: b.id, server: {id: s.id, name: s.name, address: s.address}, name: b.name, open: !!b.open, guests: !!b.guests};
  };
  const people = async (serverId: string) =>
    (await db.select({address: member.address, owner: member.owner}).from(member).where(eq(member.serverId, serverId)).orderBy(member.addedAt))
      .map((r: {address: string; owner: number}) => ({address: r.address, owner: !!r.owner}));

  // ---- servers ----
  v1.get('/servers', async (c) => {
    const me = c.get('userId');
    // Held long enough: gone for good (its boards, their TODOs and talk with it).
    await db.delete(server).where(lt(server.goneAt, new Date(Date.now() - HOLD)));
    if (c.req.query('gone') === '1') {
      const held = await db.select({id: server.id, name: server.name, address: server.address, at: server.goneAt}).from(server)
        .where(and(eq(server.goneBy, me), gte(server.goneAt, new Date(Date.now() - HOLD)))) as {id: string; name: string; address: string; at: Date}[];
      return c.json(held.map((x) => ({id: x.id, name: x.name, address: x.address, until: x.at.getTime() + HOLD})));
    }
    const rows = await db.select({id: server.id, name: server.name, address: server.address, owner: member.owner, until: address.until}).from(member)
      .innerJoin(server, eq(server.id, member.serverId)).leftJoin(address, eq(address.address, server.address))
      .where(and(eq(member.userId, me), isNull(server.goneAt))).orderBy(member.addedAt) as {id: string; name: string; address: string; owner: number; until: Date | null}[];
    if (!rows.length) return c.json([]);
    const codes = await Promise.all(rows.map((r) => codeOf(db, {serverId: r.id})));
    const boards = await db.select({id: board.id, serverId: board.serverId, name: board.name, open: board.open, guests: board.guests}).from(board)
      .where(inArray(board.serverId, rows.map((r) => r.id))).orderBy(board.createdAt) as {id: string; serverId: string; name: string; open: number; guests: number}[];
    return c.json(rows.map((r, i) => ({id: r.id, name: r.name, address: r.address, owner: !!r.owner, code: codes[i], until: r.until?.getTime() ?? null,
      boards: boards.filter((b) => b.serverId === r.id).map((b) => ({id: b.id, name: b.name, open: !!b.open, guests: !!b.guests}))})));
  });

  // A server is a principal, as a person is: its name, name@domain, is claimed in the same namespace,
  // on this Remote's domain or on a domain whoever makes it holds an address on (proven theirs).
  v1.post('/servers', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {name?: unknown; address?: unknown; board?: unknown} | null;
    const n = name(b?.name), first = name(b?.board) || 'general';
    if (!fine(n) || !fine(first)) return c.json({error: `a name of at most ${SERVER.name} characters`}, 400);
    const at = await myAddress(me);
    if (!at) return c.json({error: 'claim an address first'}, 409);
    const wanted = name(b?.address).toLowerCase() || n.toLowerCase();
    const [handle, domain = d.domain] = wanted.split('@');
    if (!NAME.test(handle)) return c.json({error: 'an address for it: letters, digits, - . _'}, 400);
    if (domain !== d.domain) {
      const [held] = await db.select({a: address.address}).from(address).where(and(eq(address.userId, me), eq(address.domain, domain), live));
      if (!held) return c.json({error: 'a domain you hold an address on'}, 400);
    }
    const [{n: count}] = await db.select({n: sql<number>`count(*)`}).from(member).where(eq(member.userId, me));
    if (Number(count) >= SERVER.servers) return c.json({error: 'too many servers'}, 429);
    const id = key(), bid = key();
    await db.insert(server).values({id, name: n, address: `${handle}@${domain}`});
    const got = await claim(db, handle, domain, {serverId: id}, domain === d.domain);
    if (!got.ok) {
      await db.delete(server).where(eq(server.id, id));
      return c.json(got.until ? {error: 'held', until: got.until} : {error: 'taken'}, 409);
    }
    await db.insert(member).values({serverId: id, userId: me, address: at, owner: 1});
    await db.insert(board).values({id: bid, serverId: id, name: first});
    return c.json({id, name: n, address: `${handle}@${domain}`, owner: true, code: await codeOf(db, {serverId: id}), until: got.until,
      boards: [{id: bid, name: first, open: false, guests: false}]}, 201);
  });

  // Its name renewed for another term, by its owner (and taken back, if its term ran out a little while ago).
  v1.post('/servers/:id/renew', async (c) => {
    const m = await membership(c.req.param('id'), c.get('userId'));
    if (!m) return c.json({error: 'no such server of yours'}, 404);
    if (!m.owner) return c.json({error: 'only its owner renews its name'}, 403);
    const [s] = await db.select({address: server.address}).from(server).where(eq(server.id, m.serverId)) as {address: string}[];
    const [h, dom] = (s?.address ?? '').split('@');
    if (!h || dom !== d.domain) return c.json({error: 'no name of this Remote to renew'}, 409);
    const got = await claim(db, h, dom, {serverId: m.serverId}, true);
    return got.ok ? c.json({address: s.address, until: got.until}) : c.json({error: 'taken'}, 409);
  });

  // Back within the hold, by whoever removed it or left it last: its name too, held for it.
  v1.post('/servers/:id/back', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const [s] = await db.select().from(server).where(and(eq(server.id, id), eq(server.goneBy, me), gte(server.goneAt, new Date(Date.now() - HOLD)))) as (typeof server.$inferSelect)[];
    if (!s) return c.json({error: 'nothing of yours to bring back'}, 404);
    const at = await myAddress(me);
    if (!at) return c.json({error: 'claim an address first'}, 409);
    if (s.address) { const [h, dom] = s.address.split('@'); await claim(db, h, dom, {serverId: id}, dom === d.domain); }
    await db.update(server).set({goneAt: null, goneBy: null}).where(eq(server.id, id));
    await db.insert(member).values({serverId: id, userId: me, address: at, owner: 1}).onConflictDoUpdate({target: [member.serverId, member.userId], set: {owner: 1}});
    return c.json({id, name: s.name, address: s.address});
  });

  v1.patch('/servers/:id', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const m = await membership(id, me);
    if (!m) return c.json({error: 'no such server of yours'}, 404);
    if (!m.owner) return c.json({error: 'only its owner renames a server'}, 403);
    const n = name((await c.req.json().catch(() => null) as {name?: unknown} | null)?.name);
    if (!fine(n)) return c.json({error: `a name of at most ${SERVER.name} characters`}, 400);
    await db.update(server).set({name: n}).where(eq(server.id, id));
    return c.json({id, name: n});
  });

  v1.delete('/servers/:id', async (c) => {
    const m = await membership(c.req.param('id'), c.get('userId'));
    if (!m?.owner) return c.json({error: 'only its owner removes a server'}, 403);
    await gone(m.serverId, c.get('userId'));
    return c.json({until: Date.now() + HOLD});
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
    const [who] = await db.select({userId: address.userId}).from(address).where(and(eq(address.address, a), live)) as {userId: string | null}[];
    if (!who?.userId) return c.json({error: 'no such address'}, 404);
    const [known] = await db.select().from(contact).where(and(eq(contact.userId, me), eq(contact.peer, who.userId), eq(contact.state, 'accepted')));
    if (!known) return c.json({error: 'only your contacts can be added'}, 403);
    await db.insert(member).values({serverId: id, userId: who.userId!, address: a}).onConflictDoNothing();
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
    // What they showed in it goes with them, and what went public as it ends: a share lasts as long as its owner's place.
    await db.delete(repoShare).where(and(eq(repoShare.serverId, id), eq(repoShare.userId, them.userId)));
    await takeDown(db, and(eq(repoPublic.serverId, id), eq(repoPublic.userId, them.userId)));
    const left = await db.select().from(member).where(eq(member.serverId, id)).orderBy(member.addedAt) as (typeof member.$inferSelect)[];
    // The last to leave: the server is held for them a while, then gone. An owner leaving hands it to whoever came first.
    if (!left.length) await gone(id, me);
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
    // How far a board is open reaches past its people: its server's owner says.
    if ((typeof b?.open === 'boolean' || typeof b?.guests === 'boolean') && !at.m.owner) return c.json({error: 'only its server\'s owner opens a board'}, 403);
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

  // ---- its TODO: Home's list, kept together ----
  type Item = typeof todoItem.$inferSelect;
  const todoJson = (r: Item) => ({id: r.id, kind: r.kind, title: r.title, detail: r.detail, done: !!r.done, place: r.place, created: r.created, by: r.by});
  const todos = async (b: Board) =>
    (await db.select().from(todoItem).where(eq(todoItem.boardId, b.id)).orderBy(asc(todoItem.place), asc(todoItem.created)) as Item[]).map(todoJson);

  v1.get('/boards/:id/todos', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    return c.json(await todos(at.b));
  });

  // What changed of one item, field by field (a new one: all of it): others' changes to its other fields stay.
  v1.put('/boards/:id/todos/:tid', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    const tid = c.req.param('tid');
    if (!TODO_ID.test(tid)) return c.json({error: 'an item'}, 400);
    const r = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const set: Partial<Item> = {};
    if (r?.kind !== undefined) { if (r.kind !== null && (typeof r.kind !== 'string' || !KIND.test(r.kind))) return c.json({error: 'a kind'}, 400); set.kind = r.kind; }
    if (r?.title !== undefined) { if (typeof r.title !== 'string' || r.title.length > SERVER.todo.title) return c.json({error: 'a title'}, 400); set.title = r.title; }
    if (r?.detail !== undefined) { if (typeof r.detail !== 'string' || r.detail.length > SERVER.todo.detail) return c.json({error: 'a detail'}, 400); set.detail = r.detail; }
    if (r?.done !== undefined) { if (typeof r.done !== 'boolean') return c.json({error: 'done'}, 400); set.done = r.done ? 1 : 0; }
    if (r?.place !== undefined) { if (typeof r.place !== 'number' || !Number.isFinite(r.place)) return c.json({error: 'a place'}, 400); set.place = r.place; }
    const where = and(eq(todoItem.boardId, at.b.id), eq(todoItem.id, tid));
    const changed = Object.keys(set).length
      ? await db.update(todoItem).set({...set, updatedAt: new Date()}).where(where).returning() as Item[]
      : await db.select().from(todoItem).where(where) as Item[];
    if (changed.length) return c.json(todoJson(changed[0]));
    const [{n}] = await db.select({n: sql<number>`count(*)`}).from(todoItem).where(eq(todoItem.boardId, at.b.id));
    if (Number(n) >= SERVER.todo.items) return c.json({error: 'too many items'}, 429);
    const created = typeof r?.created === 'number' && Number.isInteger(r.created) ? r.created : Date.now();
    const [made] = await db.insert(todoItem).values({boardId: at.b.id, id: tid, title: '', detail: '', done: 0, place: 0, ...set, by: at.m.address, created})
      .onConflictDoUpdate({target: [todoItem.boardId, todoItem.id], set: {...set, updatedAt: new Date()}}).returning() as Item[];
    return c.json(todoJson(made), 201);
  });

  v1.delete('/boards/:id/todos/:tid', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId'));
    if (!at) return c.json({error: 'no such board of yours'}, 404);
    await db.delete(todoItem).where(and(eq(todoItem.boardId, at.b.id), eq(todoItem.id, c.req.param('tid'))));
    return c.body(null, 204);
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

  // ---- taken home: the TODO and the discussion as text ----
  const archive = async (b: Board, q: Record<string, string>) => {
    const s = await boardJson(b);
    const out: string[] = [`# ${s.server.name} / ${b.name}`, ''];
    if (q.todo !== '0') {
      out.push('## TODO', '');
      for (const t of await todos(b)) {
        out.push(`- [${t.done ? 'x' : ' '}] ${t.kind ? `${t.kind}：` : ''}${t.title}`);
        if (t.detail) out.push(...t.detail.split('\n').map((l) => `  ${l}`));
      }
      out.push('');
    }
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
        // A name on this Remote alone, as the app shows it.
        const by = p.by.endsWith(`@${d.domain}`) ? p.by.slice(0, -d.domain.length - 1) : p.by;
        out.push(`- ${t.slice(11, 16)} ${by}${p.guestId ? ' (guest)' : ''}: ${p.body.replace(/\n/g, '\n  ')}`);
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
      .innerJoin(server, eq(server.id, board.serverId)).where(and(eq(board.open, 1), isNull(server.goneAt))).orderBy(desc(board.createdAt)).limit(100) as {id: string; name: string; guests: number; server: string}[];
    return c.json(rows.map((r) => ({id: r.id, name: r.name, server: r.server, guests: !!r.guests})), 200, anyone);
  });
  app.get('/v1/open/:id', async (c) => {
    const b = await open(c.req.param('id'));
    return b ? c.json(await boardJson(b), 200, anyone) : c.json({error: 'no such open board'}, 404);
  });
  app.get('/v1/open/:id/todos', async (c) => {
    const b = await open(c.req.param('id'));
    return b ? c.json(await todos(b), 200, anyone) : c.json({error: 'no such open board'}, 404);
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
    // A guest writes for a while (a lease), then shows the email again.
    await db.update(guest).set({code: null, codeUntil: null, token: await seal(token), tokenUntil: new Date(Date.now() + HOLD)}).where(eq(guest.id, g.id));
    return c.json({token, as: email.split('@')[0]}, 200, anyone);
  });
  app.post('/v1/open/:id/posts', async (c) => {
    const b = await guestBoard(c.req.param('id'));
    if (!b) return c.json({error: 'this board takes no guests'}, 404);
    const token = c.req.header('X-Guest') ?? '';
    const [g] = token ? await db.select().from(guest).where(and(eq(guest.boardId, b.id), eq(guest.token, await seal(token)))) as (typeof guest.$inferSelect)[] : [];
    if (!g || !g.tokenUntil || g.tokenUntil.getTime() < Date.now()) return c.json({error: 'show your email first'}, 401);
    return write(c, b, {guestId: g.id, by: g.email.split('@')[0]});
  });
}
