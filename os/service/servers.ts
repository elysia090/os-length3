// Servers: the one thing whose subject is people, not a repo. A server is a
// group of people who know each other (each added by someone already in it
// whom they have accepted in the Inbox, and who has accepted them). Its boards
// are what they talk about: each is a conversation, short posts read as a
// chat is, and a TODO they keep together, the same list as Home's
// (src/todo.ts), kept here item by item and field by field so that two
// people writing never undo each other but on the very same field. (A repo
// belongs to a person, who may show it in a server, only to be seen there:
// seen.ts.)
//
// A board is its server's people's alone unless opened, board by board:
// open, anyone reads it (signed in or not); guests, an outsider may also
// write in it once they have shown an email address is theirs, by a short
// code sent to it. All of it is kept here; any of it can be taken home as
// text (archive).
//
//   GET    /v1/servers                       mine, each with its boards (?gone=1: those I may bring back)
//   POST   /v1/servers                       {name, address}: a new one, named name@domain, with a first board
//   POST   /v1/servers/ID/renew              its name for another term (its owner)
//   POST   /v1/servers/ID/back               bring back one removed or left (within the hold)
//   PATCH  /v1/servers/ID                    {name}: its owner's
//   DELETE /v1/servers/ID                    its owner's
//   GET    /v1/servers/ID/people
//   POST   /v1/servers/ID/people             {address}: someone I and they have both accepted
//   DELETE /v1/servers/ID/people/ADDR        leave (one's own), or its owner removes
//   POST   /v1/servers/ID/boards             {name}
//   GET    /v1/boards/ID                     the board and its people
//   PATCH  /v1/boards/ID                     {name?, open?, guests?}: open and guests its server's owner's
//   DELETE /v1/boards/ID                     its server's owner's: held 30 days
//   POST   /v1/boards/ID/back                within them, back at once
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
import {claim, codeOf, HOLD, liveAddress, serverAddress, shownAs, takeDown} from './names.ts';
import {ago, body, lock, qualified, refuse, rows, type Db, type Vars} from './request.ts';
import {address, board, guest, member, principalCode, REACH, repoPublic, server, talk, throttle, todoItem} from './schema.ts';

export const SERVER = {name: 64, body: 2000, perHour: 60, page: 30, maxPage: 100, boards: 100,
  /** Servers a person owns or has held for them, at most; servers they make in a day. */
  servers: 50, perDay: 10,
  /** How long a server its maker leaves with nobody else in it is held (not HOLD: no name is kept long by making and leaving). */
  alone: 86_400_000,
  /** A board's TODO: as long as Home's items may be (src/todo.ts), and so many of them. */
  todo: {title: 200, detail: 4000, items: 500},
  /**
   * A guest's code: how long it holds, how many wrong tries spend it, how soon another may be sent
   * to the same address for the same board; how many an hour one sender may ask for, and one
   * address may be sent, whatever the board; how many may wait on one board at once.
   */
  code: {minutes: 10, tries: 5, again: 60_000, perSender: 10, perEmail: 3, waiting: 20}} as const;
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

export interface ServerDeps {
  db: Db;
  /** This Remote's own domain: a server's name is claimed on it, or on a domain one of its people holds. */
  domain: string;
  /** Sends a guest their code; without it, guests cannot be checked (and the Remote says so). */
  mail?: (to: string, subject: string, text: string) => Promise<void>;
  /** Mixed into the digests of codes and tokens. */
  secret?: string;
  /** No board is opened past its people (a Remote for research: enter.ts). */
  closed?: boolean;
}

type Board = {id: string; serverId: string; name: string; reach: number; goneAt: Date | null};
/** A board as one asks for it: its server, and the asker's place in it (owner: null when not in it) and how they are shown. */
type At = {b: Board; server: {id: string; name: string; address: string}; owner: boolean | null; address: string | null};
type Post = typeof talk.$inferSelect;
type Item = typeof todoItem.$inferSelect;
const shape = (me: string | null, owner: boolean) => (p: Post) => ({
  id: p.id, by: p.by, body: p.body, at: timeOf(p.id), ...(p.userId === null ? {guest: true} : {}),
  ...(me && (p.userId === me || owner) ? {mine: p.userId === me, mayTakeDown: true} : {}),
});
const boardJson = (at: At) => ({id: at.b.id, server: at.server, name: at.b.name, open: at.b.reach >= REACH.open, guests: at.b.reach === REACH.guests});
const todoJson = (r: Item) => ({id: r.id, kind: r.kind, title: r.title, detail: r.detail, done: r.done, place: r.place, created: r.created, by: r.by});
const anyone = {'Access-Control-Allow-Origin': '*'};

export function servers(d: ServerDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  const name = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const fine = (n: string) => n.length > 0 && n.length <= SERVER.name;

  // ---- who may do what ----
  /** `me`'s place in a server that is not gone (removed or left, it answers nothing while it is held). */
  const membership = async (q: Db, serverId: string, me: string) =>
    (await q.select({owner: member.owner}).from(member).innerJoin(server, and(eq(server.id, member.serverId), isNull(server.goneAt)))
      .where(and(eq(member.serverId, serverId), eq(member.userId, me))))[0] as {owner: boolean} | undefined;
  /** A board of a server that is not gone, its server's name, and `me`'s place in it: one read. A board removed answers only `held`. */
  const boardAt = async (id: string, me: string | null, removed = false): Promise<At | null> => {
    if (!KEY.test(id)) return null;
    const [r] = await db.select({id: board.id, serverId: board.serverId, name: board.name, reach: board.reach, goneAt: board.goneAt,
      serverName: server.name, serverAddress: serverAddress(qualified(server.id)), owner: me ? member.owner : sql<null>`null`, address: me ? shownAs(me) : sql<null>`null`})
      .from(board).innerJoin(server, and(eq(server.id, board.serverId), isNull(server.goneAt)))
      .leftJoin(member, and(eq(member.serverId, board.serverId), eq(member.userId, me ?? '')))
      .where(and(eq(board.id, id), removed ? undefined : isNull(board.goneAt)));
    return r ? {b: {id: r.id, serverId: r.serverId, name: r.name, reach: r.reach, goneAt: r.goneAt}, server: {id: r.serverId, name: r.serverName, address: r.serverAddress},
      owner: r.owner, address: r.address} : null;
  };
  /** The board, if `me` is one of its server's people. */
  const mine = async (id: string, me: string) => { const at = await boardAt(id, me); return at && at.owner !== null ? at : null; };
  const notMine = () => refuse(404, {error: 'No such board of yours'});
  const people = async (q: Db, serverId: string) =>
    (await q.select({address: shownAs(qualified(member.userId)), owner: member.owner}).from(member).where(eq(member.serverId, serverId)).orderBy(member.addedAt))
      .map((r: {address: string | null; owner: boolean}) => ({address: r.address ?? '', owner: r.owner}));

  /**
   * Gone: held for whoever removed it or left it last, and its name held for it. Its maker
   * leaving it with nobody else in it holds it a day, not HOLD: its hold is counted as if it
   * went HOLD less a day ago, so nothing else needs to know.
   */
  const gone = async (tx: Db, id: string, by: string) => {
    const [s] = await tx.select({madeBy: server.madeBy, others: sql<number>`(select count(*)::int from server_member m where m.server_id = ${qualified(server.id)} and m.user_id <> ${by})`})
      .from(server).where(eq(server.id, id));
    const at = s.madeBy === by && s.others === 0 ? ago(HOLD - SERVER.alone) : sql`now()`;
    await tx.update(server).set({goneAt: at, goneBy: by}).where(eq(server.id, id));
    await tx.update(address).set({releasedAt: at}).where(and(eq(address.serverId, id), isNull(address.releasedAt)));
  };

  // ---- servers ----
  v1.get('/servers', async (c) => {
    const me = c.get('userId');
    if (c.req.query('gone') === '1') {
      const list = await db.select({id: server.id, name: server.name, address: serverAddress(qualified(server.id)), at: server.goneAt}).from(server)
        .where(and(eq(server.goneBy, me), sql`${server.goneAt} > ${ago(HOLD)}`)) as {id: string; name: string; address: string; at: Date}[];
      return c.json(list.map((x) => ({id: x.id, name: x.name, address: x.address, until: x.at.getTime() + HOLD})));
    }
    const list = await db.select({id: server.id, name: server.name, address: sql<string>`coalesce(${address.address}, '')`, owner: member.owner, until: address.until, code: principalCode.code})
      .from(member).innerJoin(server, and(eq(server.id, member.serverId), isNull(server.goneAt)))
      .leftJoin(address, eq(address.serverId, server.id)).leftJoin(principalCode, eq(principalCode.serverId, server.id))
      .where(eq(member.userId, me)).orderBy(member.addedAt) as {id: string; name: string; address: string; owner: boolean; until: Date | null; code: string | null}[];
    if (!list.length) return c.json([]);
    // A board removed is listed with when it goes for good (`gone`), so its owner may bring it back.
    const boards = await db.select({id: board.id, serverId: board.serverId, name: board.name, reach: board.reach, goneAt: board.goneAt}).from(board)
      .where(and(inArray(board.serverId, list.map((r) => r.id)), sql`(${board.goneAt} is null or ${board.goneAt} > ${ago(HOLD)})`)).orderBy(board.createdAt) as Board[];
    return c.json(list.map((r) => ({id: r.id, name: r.name, address: r.address, owner: r.owner, code: r.code ?? '', until: r.until?.getTime() ?? null,
      boards: boards.filter((b) => b.serverId === r.id).map((b) => ({id: b.id, name: b.name, open: b.reach >= REACH.open, guests: b.reach === REACH.guests,
        ...(b.goneAt ? {gone: b.goneAt.getTime() + HOLD} : {})}))})));
  });

  // A server is a principal, as a person is: its name, name@domain, is claimed in the same namespace,
  // on this Remote's domain or on a domain whoever makes it holds an address on (proven theirs).
  v1.post('/servers', async (c) => {
    const me = c.get('userId');
    const b = await body<{name?: unknown; address?: unknown; board?: unknown}>(c);
    const n = name(b?.name), first = name(b?.board) || 'general';
    if (!fine(n) || !fine(first)) return c.json({error: 'A name of at most 64 characters'}, 400);
    const wanted = name(b?.address).toLowerCase() || n.toLowerCase();
    const [handle, domain = d.domain] = wanted.split('@');
    if (!NAME.test(handle)) return c.json({error: 'Its address: letters, digits, - . _'}, 400);
    const made = await db.transaction(async (tx: Db) => {
      await lock(tx, me);
      if (!await liveAddress(tx, me)) refuse(409, {error: 'Claim an address first'});
      if (domain !== d.domain) {
        const [on] = await tx.select({a: address.address}).from(address).where(and(eq(address.userId, me), eq(address.domain, domain), isNull(address.releasedAt), isNull(address.lapsedAt)));
        if (!on) refuse(400, {error: 'Only on a domain you hold an address on'});
      }
      // Only what one owns counts, and what is held for one: being added to servers never stops anyone making one.
      const [count] = await rows<{kept: number; today: number}>(tx, sql`select
        (select count(*)::int from server_member m join server s on s.id = m.server_id and s.gone_at is null where m.user_id = ${me} and m.owner)
          + (select count(*)::int from server s where s.gone_by = ${me} and s.gone_at > ${ago(HOLD)}) as kept,
        (select count(*)::int from server s where s.made_by = ${me} and s.created_at > ${ago(86_400_000)}) as today`);
      if (count.kept >= SERVER.servers) refuse(429, {error: 'Too many servers'});
      if (count.today >= SERVER.perDay) refuse(429, {error: 'Too many servers made today'});
      const id = key(), bid = key();
      await tx.insert(server).values({id, name: n, madeBy: me});
      const got = await claim(tx, handle, domain, {serverId: id}, domain === d.domain);
      if (!got.ok) refuse(409, got.until ? {error: 'That name was let go, and is held for its owner a while', until: got.until} : {error: 'That name is taken'});
      await tx.insert(member).values({serverId: id, userId: me, owner: true});
      await tx.insert(board).values({id: bid, serverId: id, name: first});
      return {id, name: n, address: `${handle}@${domain}`, owner: true, code: await codeOf(tx, {serverId: id}), until: got.until,
        boards: [{id: bid, name: first, open: false, guests: false}]};
    });
    return c.json(made, 201);
  });

  // Its name renewed for another term, by its owner (and taken back, if its term ran out a little while ago).
  v1.post('/servers/:id/renew', async (c) => {
    const id = c.req.param('id');
    const m = await membership(db, id, c.get('userId'));
    if (!m) return c.json({error: 'No such server of yours'}, 404);
    if (!m.owner) return c.json({error: 'Only its owner renews its name'}, 403);
    const [a] = await db.select({address: address.address, name: address.name, domain: address.domain}).from(address).where(eq(address.serverId, id));
    if (!a || a.domain !== d.domain) return c.json({error: 'It has no name on this Remote to renew'}, 409);
    const got = await claim(db, a.name, a.domain, {serverId: id}, true);
    return got.ok ? c.json({address: a.address, until: got.until}) : c.json({error: 'That name is taken'}, 409);
  });

  // Back within the hold, by whoever removed it or left it last: its name too, held for it.
  v1.post('/servers/:id/back', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const out = await db.transaction(async (tx: Db) => {
      await lock(tx, me);
      const [s] = await tx.select({name: server.name}).from(server).where(and(eq(server.id, id), eq(server.goneBy, me), sql`${server.goneAt} > ${ago(HOLD)}`));
      if (!s) refuse(404, {error: 'Nothing of yours to bring back'});
      if (!await liveAddress(tx, me)) refuse(409, {error: 'Claim an address first'});
      const [a] = await tx.select({address: address.address, name: address.name, domain: address.domain}).from(address).where(eq(address.serverId, id));
      if (a) await claim(tx, a.name, a.domain, {serverId: id}, a.domain === d.domain);
      await tx.update(server).set({goneAt: null, goneBy: null}).where(eq(server.id, id));
      await tx.insert(member).values({serverId: id, userId: me, owner: true}).onConflictDoUpdate({target: [member.serverId, member.userId], set: {owner: true}});
      return {id, name: s.name, address: a?.address ?? ''};
    });
    return c.json(out);
  });

  v1.patch('/servers/:id', async (c) => {
    const id = c.req.param('id');
    const m = await membership(db, id, c.get('userId'));
    if (!m) return c.json({error: 'No such server of yours'}, 404);
    if (!m.owner) return c.json({error: 'Only its owner renames a server'}, 403);
    const n = name((await body<{name?: unknown}>(c))?.name);
    if (!fine(n)) return c.json({error: 'A name of at most 64 characters'}, 400);
    await db.update(server).set({name: n}).where(eq(server.id, id));
    return c.json({id, name: n});
  });

  v1.delete('/servers/:id', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const until = await db.transaction(async (tx: Db) => {
      if (!(await membership(tx, id, me))?.owner) refuse(403, {error: 'Only its owner removes a server'});
      await gone(tx, id, me);
      return (await tx.select({at: server.goneAt}).from(server).where(eq(server.id, id)))[0].at.getTime() + HOLD;
    });
    return c.json({until});
  });

  // ---- its people ----
  v1.get('/servers/:id/people', async (c) => {
    if (!await membership(db, c.req.param('id'), c.get('userId'))) return c.json({error: 'No such server of yours'}, 404);
    return c.json(await people(db, c.req.param('id')));
  });

  // Someone comes in by someone already in, and only when the two have accepted each other: a server
  // is people who know each other, and nobody is put in one by someone they have not accepted (or blocked).
  v1.post('/servers/:id/people', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!await membership(db, id, me)) return c.json({error: 'No such server of yours'}, 404);
    const a = name((await body<{address?: unknown}>(c))?.address).toLowerCase();
    const [who] = await rows<{user: string | null; both: number}>(db, sql`select a.user_id as user,
      (select count(*)::int from contact k where k.state = 'accepted' and ((k.user_id = ${me} and k.peer = a.user_id) or (k.user_id = a.user_id and k.peer = ${me}))) as both
      from address a where a.address = ${a} and a.released_at is null and a.lapsed_at is null and (a.until is null or a.until > now())`);
    if (!who?.user) return c.json({error: 'No one has that address'}, 404);
    if (who.both < 2) return c.json({error: 'Only your contacts can be added'}, 403);
    await db.insert(member).values({serverId: id, userId: who.user}).onConflictDoNothing();
    return c.json(await people(db, id), 201);
  });

  v1.delete('/servers/:id/people/:address', async (c) => {
    const me = c.get('userId'), id = c.req.param('id'), a = c.req.param('address').toLowerCase();
    await db.transaction(async (tx: Db) => {
      const m = await membership(tx, id, me);
      if (!m) refuse(404, {error: 'No such server of yours'});
      // Whoever has (or had) that address.
      const [them] = await tx.select({userId: member.userId, owner: member.owner}).from(member)
        .where(and(eq(member.serverId, id), sql`${qualified(member.userId)} = (select a.user_id from address a where a.address = ${a})`)) as {userId: string; owner: boolean}[];
      if (!them) refuse(404, {error: 'They are not in this server'});
      if (them.userId !== me && !m.owner) refuse(403, {error: 'Only its owner removes someone else'});
      await tx.delete(member).where(and(eq(member.serverId, id), eq(member.userId, them.userId)));
      // What they showed in it goes with them (a share hangs from their place), and what went public as it ends.
      await takeDown(tx, and(eq(repoPublic.serverId, id), eq(repoPublic.userId, them.userId)));
      const [next] = await tx.select({userId: member.userId}).from(member).where(eq(member.serverId, id)).orderBy(member.addedAt).limit(1);
      // The last to leave: the server is held for them a while, then gone. An owner leaving hands it to whoever came first.
      if (!next) await gone(tx, id, me);
      else if (them.owner) await tx.update(member).set({owner: true}).where(and(eq(member.serverId, id), eq(member.userId, next.userId)));
    });
    return c.body(null, 204);
  });

  // ---- boards ----
  v1.post('/servers/:id/boards', async (c) => {
    const id = c.req.param('id');
    if (!await membership(db, id, c.get('userId'))) return c.json({error: 'No such server of yours'}, 404);
    const n = name((await body<{name?: unknown}>(c))?.name);
    if (!fine(n)) return c.json({error: 'A name of at most 64 characters'}, 400);
    const [{n: count}] = await db.select({n: sql<number>`count(*)::int`}).from(board).where(eq(board.serverId, id));
    if (count >= SERVER.boards) return c.json({error: 'Too many boards'}, 429);
    const bid = key();
    await db.insert(board).values({id: bid, serverId: id, name: n});
    return c.json({id: bid, name: n, open: false, guests: false}, 201);
  });

  v1.get('/boards/:id', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    return c.json({...boardJson(at), people: await people(db, at.b.serverId)});
  });

  // How far a board reaches: guests write only where anyone reads, so taking guests opens it, and closing it ends them.
  v1.patch('/boards/:id', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    const b = await body<{name?: unknown; open?: unknown; guests?: unknown}>(c);
    const set: {name?: string; reach?: number} = {};
    if (b?.name !== undefined) { const n = name(b.name); if (!fine(n)) return c.json({error: 'A name of at most 64 characters'}, 400); set.name = n; }
    if (typeof b?.open === 'boolean' || typeof b?.guests === 'boolean') {
      // How far a board is open reaches past its people: its server's owner says.
      if (!at.owner) return c.json({error: 'Only its server\'s owner opens a board'}, 403);
      if (d.closed && (b.open === true || b.guests === true)) return c.json({error: 'Nothing is shown to everyone from this Remote'}, 403);
      let reach = at.b.reach;
      if (typeof b.open === 'boolean') reach = b.open ? Math.max(reach, REACH.open) : REACH.people;
      if (typeof b.guests === 'boolean') reach = b.guests ? REACH.guests : Math.min(reach, REACH.open);
      set.reach = reach;
    }
    if (Object.keys(set).length) await db.update(board).set(set).where(eq(board.id, at.b.id));
    return c.json(boardJson({...at, b: {...at.b, ...set}}));
  });

  v1.delete('/boards/:id', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    if (!at.owner) return c.json({error: 'Only its server\'s owner removes a board'}, 403);
    // Held 30 days: its talk and TODO with it, back at once until then.
    const [{goneAt}] = await db.update(board).set({goneAt: sql`now()`}).where(eq(board.id, at.b.id)).returning({goneAt: board.goneAt});
    return c.json({until: goneAt.getTime() + HOLD});
  });

  v1.post('/boards/:id/back', async (c) => {
    const at = await boardAt(c.req.param('id'), c.get('userId'), true);
    if (!at?.b.goneAt || at.owner === null) return notMine();
    if (!at.owner) return c.json({error: 'Only its server\'s owner brings a board back'}, 403);
    if (Date.now() - at.b.goneAt.getTime() > HOLD) return c.json({error: 'It is held no longer'}, 410);
    await db.update(board).set({goneAt: null}).where(eq(board.id, at.b.id));
    return c.json(boardJson({...at, b: {...at.b, goneAt: null}}));
  });

  // ---- its TODO: Home's list, kept together ----
  const todos = async (b: Board) =>
    (await db.select().from(todoItem).where(eq(todoItem.boardId, b.id)).orderBy(asc(todoItem.place), asc(todoItem.created)) as Item[]).map(todoJson);

  v1.get('/boards/:id/todos', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    return c.json(await todos(at.b));
  });

  // What changed of one item, field by field: others' changes to its other fields stay. An item that
  // is not there is made only from a whole one (a title and a place): one taken off is not brought
  // back, blank, by someone's late change to it.
  v1.put('/boards/:id/todos/:tid', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    const tid = c.req.param('tid');
    if (!TODO_ID.test(tid)) return c.json({error: 'an item'}, 400);
    const r = await body(c);
    const set: Partial<Item> = {};
    if (r?.kind !== undefined) { if (r.kind !== null && (typeof r.kind !== 'string' || !KIND.test(r.kind))) return c.json({error: 'A kind is one word of at most 16 letters'}, 400); set.kind = r.kind; }
    if (r?.title !== undefined) { if (typeof r.title !== 'string' || r.title.length > SERVER.todo.title) return c.json({error: 'A title is at most 200 characters'}, 400); set.title = r.title; }
    if (r?.detail !== undefined) { if (typeof r.detail !== 'string' || r.detail.length > SERVER.todo.detail) return c.json({error: 'A detail is at most 4000 characters'}, 400); set.detail = r.detail; }
    if (r?.done !== undefined) { if (typeof r.done !== 'boolean') return c.json({error: 'done'}, 400); set.done = r.done; }
    if (r?.place !== undefined) { if (typeof r.place !== 'number' || !Number.isFinite(r.place)) return c.json({error: 'a place'}, 400); set.place = r.place; }
    const where = and(eq(todoItem.boardId, at.b.id), eq(todoItem.id, tid));
    const changed = Object.keys(set).length
      ? await db.update(todoItem).set(set).where(where).returning() as Item[]
      : await db.select().from(todoItem).where(where) as Item[];
    if (changed.length) return c.json(todoJson(changed[0]));
    if (typeof r?.title !== 'string' || typeof r.place !== 'number') return c.json({error: 'That item was taken off'}, 404);
    if (!at.address) return c.json({error: 'Claim an address first'}, 409);
    const [{n}] = await db.select({n: sql<number>`count(*)::int`}).from(todoItem).where(eq(todoItem.boardId, at.b.id));
    if (n >= SERVER.todo.items) return c.json({error: 'Too many items'}, 429);
    const created = typeof r.created === 'number' && Number.isInteger(r.created) ? r.created : Date.now();
    // Two making the same new item at once: the second's fields are laid over the first's.
    const [made] = await db.insert(todoItem).values({boardId: at.b.id, id: tid, title: '', detail: '', done: false, place: 0, ...set, by: at.address, created})
      .onConflictDoUpdate({target: [todoItem.boardId, todoItem.id], set}).returning() as Item[];
    return c.json(todoJson(made), 201);
  });

  v1.delete('/boards/:id/todos/:tid', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    await db.delete(todoItem).where(and(eq(todoItem.boardId, at.b.id), eq(todoItem.id, c.req.param('tid'))));
    return c.body(null, 204);
  });

  // ---- the discussion ----
  const read = async (b: Board, q: Record<string, string>, me: string | null, owner: boolean) => {
    const limit = Math.min(SERVER.maxPage, Math.max(1, Number(q.limit) || SERVER.page));
    const at = (k: string) => (q[k] && ID.test(q[k]) ? q[k] : null);
    const [before, after, from, to] = ['before', 'after', 'from', 'to'].map(at);
    // One more than asked says whether there is more past the page.
    const list: Post[] = await db.select().from(talk)
      .where(and(eq(talk.boardId, b.id), before ? lt(talk.id, before) : undefined, after ? gt(talk.id, after) : undefined,
        from ? gte(talk.id, from) : undefined, to ? lte(talk.id, to) : undefined))
      .orderBy(after ? asc(talk.id) : desc(talk.id)).limit(limit + 1);
    return {posts: list.slice(0, limit).map(shape(me, owner)), more: list.length > limit};
  };

  v1.get('/boards/:id/posts', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    return c.json(await read(at.b, c.req.query(), me, !!at.owner));
  });

  const write = async (c: Context, b: Board, who: {userId?: string; guestId?: string; by: string}) => {
    const r = await body<{body?: unknown}>(c);
    const text = typeof r?.body === 'string' ? r.body.trim() : '';
    if (!text || text.length > SERVER.body) return c.json({error: 'A post is at most 2000 characters'}, 400);
    const whose = who.userId ? eq(talk.userId, who.userId) : eq(talk.guestId, who.guestId!);
    const [{n}] = await db.select({n: sql<number>`count(*)::int`}).from(talk).where(and(whose, gte(talk.id, idAt(Date.now() - 3600_000))));
    if (n >= SERVER.perHour) return c.json({error: 'Too many posts this hour'}, 429);
    const row = {id: postId(), boardId: b.id, userId: who.userId ?? null, guestId: who.guestId ?? null, by: who.by, body: text};
    await db.insert(talk).values(row);
    return c.json(shape(who.userId ?? null, false)(row), 201);
  };

  v1.post('/boards/:id/posts', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    if (!at.address) return c.json({error: 'Claim an address first'}, 409);
    return write(c, at.b, {userId: c.get('userId'), by: at.address});
  });

  v1.delete('/boards/:id/posts/:pid', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    const whose = at.owner ? undefined : eq(talk.userId, me);
    const taken = await db.delete(talk).where(and(eq(talk.id, c.req.param('pid')), eq(talk.boardId, at.b.id), whose)).returning({id: talk.id});
    return taken.length ? c.body(null, 204) : c.json({error: 'No such post of yours'}, 404);
  });

  // ---- taken home: the TODO and the discussion as text ----
  const archive = async (at: At, q: Record<string, string>) => {
    const out: string[] = [`# ${at.server.name} / ${at.b.name}`, ''];
    if (q.todo !== '0') {
      out.push('## TODO', '');
      for (const t of await todos(at.b)) {
        out.push(`- [${t.done ? 'x' : ' '}] ${t.kind ? `${t.kind}：` : ''}${t.title}`);
        if (t.detail) out.push(...t.detail.split('\n').map((l) => `  ${l}`));
      }
      out.push('');
    }
    if (q.talk !== '0') {
      const at2 = (k: string) => (q[k] && ID.test(q[k]) ? q[k] : null);
      const [from, to] = [at2('from'), at2('to')];
      const list: Post[] = await db.select().from(talk).where(and(eq(talk.boardId, at.b.id), from ? gte(talk.id, from) : undefined, to ? lte(talk.id, to) : undefined))
        .orderBy(asc(talk.id)).limit(20_000);
      out.push('## Discussion', '');
      let day = '';
      for (const p of list) {
        const t = new Date(timeOf(p.id)).toISOString();
        if (t.slice(0, 10) !== day) { day = t.slice(0, 10); out.push(`### ${day}`, ''); }
        // A name on this Remote alone, as the app shows it.
        const by = p.by.endsWith(`@${d.domain}`) ? p.by.slice(0, -d.domain.length - 1) : p.by;
        out.push(`- ${t.slice(11, 16)} ${by}${p.userId === null ? ' (guest)' : ''}: ${p.body.replace(/\n/g, '\n  ')}`);
      }
      out.push('');
    }
    return out.join('\n');
  };
  const markdown = (c: Context, text: string, b: Board) => c.body(text, 200, {'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${b.name.replace(/[^\w.-]+/g, '-')}.md"`});

  v1.get('/boards/:id/archive', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    return markdown(c, await archive(at, c.req.query()), at.b);
  });

  // ---- for anyone: open boards, and guests (made before /v1's own routes, which ask who is calling) ----
  const open = async (id: string, reach: number = REACH.open) => { const at = await boardAt(id, null); return at && at.b.reach >= reach ? at : null; };
  const noOpen = () => refuse(404, {error: 'No such open board'});
  app.get('/v1/open', async (c) => {
    const list = await db.select({id: board.id, name: board.name, reach: board.reach, server: server.name}).from(board)
      .innerJoin(server, eq(server.id, board.serverId)).where(and(gte(board.reach, REACH.open), isNull(board.goneAt), isNull(server.goneAt)))
      .orderBy(desc(board.createdAt)).limit(100) as {id: string; name: string; reach: number; server: string}[];
    return c.json(list.map((r) => ({id: r.id, name: r.name, server: r.server, guests: r.reach === REACH.guests})), 200, anyone);
  });
  app.get('/v1/open/:id', async (c) => c.json(boardJson(await open(c.req.param('id')) ?? noOpen()), 200, anyone));
  app.get('/v1/open/:id/todos', async (c) => c.json(await todos((await open(c.req.param('id')) ?? noOpen()).b), 200, anyone));
  app.get('/v1/open/:id/posts', async (c) => c.json(await read((await open(c.req.param('id')) ?? noOpen()).b, c.req.query(), null, false), 200, anyone));
  app.get('/v1/open/:id/archive', async (c) => { const at = await open(c.req.param('id')) ?? noOpen(); return markdown(c, await archive(at, c.req.query()), at.b); });

  // A guest: a code to the email they give, then a token for writing in this board.
  const guestBoard = async (id: string) => (await open(id, REACH.guests)) ?? refuse(404, {error: 'This board takes no guests'});
  const seal = (s: string) => digest(`${d.secret ?? ''}:${s}`);

  // Anyone may ask, so the asking is held to a few: an address is sent a code for one board once a
  // minute, and at most a few an hour whatever the board; one sender asks for so many an hour; a
  // board has so many waiting at once. The mail says only the code: nothing anyone chose.
  app.post('/v1/open/:id/guest', async (c) => {
    const at = await guestBoard(c.req.param('id'));
    if (!d.mail) return c.json({error: 'This Remote sends no mail'}, 503);
    const email = name((await body<{email?: unknown}>(c))?.email).toLowerCase();
    if (!EMAIL.test(email)) return c.json({error: 'That is not an email address'}, 400);
    const sender = `guest-from:${c.req.header('CF-Connecting-IP') ?? ''}`, to = `guest-to:${email}`;
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0'), sealed = await seal(code);
    await db.transaction(async (tx: Db) => {
      await lock(tx, sender);
      await lock(tx, to);
      const [n] = await rows<{again: number; sender: number; to: number; waiting: number}>(tx, sql`select
        (select count(*)::int from board_guest where board_id = ${at.b.id} and email = ${email} and code_at > ${ago(SERVER.code.again)}) as again,
        (select count(*)::int from throttle where key = ${sender} and at > ${ago(3600_000)}) as sender,
        (select count(*)::int from throttle where key = ${to} and at > ${ago(3600_000)}) as to,
        (select count(*)::int from board_guest where board_id = ${at.b.id} and email <> ${email} and code is not null
          and code_at > ${ago(SERVER.code.minutes * 60_000)}) as waiting`);
      if (n.again) refuse(429, {error: 'A code was just sent'});
      if (n.sender >= SERVER.code.perSender || n.to >= SERVER.code.perEmail) refuse(429, {error: 'Too many codes asked for; try again in an hour'});
      if (n.waiting >= SERVER.code.waiting) refuse(429, {error: 'Too many people are waiting for a code here; try again soon'});
      await tx.insert(throttle).values([{key: sender}, {key: to}]);
      await tx.insert(guest).values({id: key(), boardId: at.b.id, email, code: sealed, codeAt: sql`now()`})
        .onConflictDoUpdate({target: [guest.boardId, guest.email], set: {code: sealed, codeAt: sql`now()`, tries: 0}});
    });
    await d.mail(email, 'Your Length³ code', `Your code is ${code}. It holds for ${SERVER.code.minutes} minutes.`);
    return c.json({sent: true}, 202, anyone);
  });

  app.post('/v1/open/:id/guest/check', async (c) => {
    const at = await guestBoard(c.req.param('id'));
    const r = await body<{email?: unknown; code?: unknown}>(c);
    const email = name(r?.email).toLowerCase(), code = name(r?.code);
    // Each try is counted before it is compared, in the one statement that finds the code: a few
    // tries spend it, however many come at once.
    const [g] = await db.update(guest).set({tries: sql`${guest.tries} + 1`})
      .where(and(eq(guest.boardId, at.b.id), eq(guest.email, email), sql`${guest.code} is not null`, lt(guest.tries, SERVER.code.tries),
        sql`${guest.codeAt} > ${ago(SERVER.code.minutes * 60_000)}`))
      .returning({id: guest.id, code: guest.code}) as {id: string; code: string}[];
    if (!g || g.code !== await seal(code)) return c.json({error: 'Not that code'}, 403);
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    // A guest writes for a while (a lease), then shows the email again. The code is spent once.
    const won = await db.update(guest).set({code: null, tries: 0, token: await seal(token), tokenUntil: new Date(Date.now() + HOLD)})
      .where(and(eq(guest.id, g.id), eq(guest.code, g.code))).returning({id: guest.id});
    if (!won.length) return c.json({error: 'Not that code'}, 403);
    return c.json({token, as: email.split('@')[0]}, 200, anyone);
  });

  // Without a token that still holds, a guest is refused (403: 401 is for a session the Remote does not know).
  app.post('/v1/open/:id/posts', async (c) => {
    const at = await guestBoard(c.req.param('id'));
    const token = c.req.header('X-Guest') ?? '';
    const [g] = token ? await db.select({id: guest.id, email: guest.email}).from(guest)
      .where(and(eq(guest.boardId, at.b.id), eq(guest.token, await seal(token)), gt(guest.tokenUntil, sql`now()`))) as {id: string; email: string}[] : [];
    if (!g) return c.json({error: 'Show your email first'}, 403);
    return write(c, at.b, {guestId: g.id, by: g.email.split('@')[0]});
  });
}
