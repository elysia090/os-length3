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
// write in it, let in by an invitation one of its people made and handed
// them (the Remote sends nothing to anyone), under a name they choose that
// is always shown as a guest's. All of it is kept here; any of it can be
// taken home as text (archive).
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
//   POST   /v1/boards/ID/seen                {post}: read so far (news.ts tells what came past it)
//   GET    /v1/boards/ID/archive             ?from=&to=&todo=0|1&talk=0|1: markdown
//   GET    /v1/boards/ID/guests              its invitations out and its guests
//   POST   /v1/boards/ID/invites             {uses?, days?}: an invitation, its link said once
//   DELETE /v1/boards/ID/invites/IID         revoked: its maker's, or the server owner's
//   DELETE /v1/boards/ID/guests/GID          removed, their posts with them: whoever invited them, or the server owner
// and, for anyone, on open boards (and guests on boards that take them):
//   GET    /v1/open                          the open boards
//   GET    /v1/open/ID | /todos | /posts | /archive
//   POST   /v1/open/ID/guest                 {invite, name}: a token to write with
//   GET    /v1/open/ID/guest                 who one is here, with X-Guest: token
//   POST   /v1/open/ID/posts                 {body}, with X-Guest: token

import {and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import {claim, codeOf, HOLD, liveAddress, serverAddress, shownAs, takeDown} from './names.ts';
import type {Plans} from './plan.ts';
import {ago, body, lock, qualified, refuse, rows, type Db, type Vars} from './request.ts';
import {address, board, boardSeen, guest, invite, member, principalCode, REACH, repoPublic, server, talk, todoItem} from './schema.ts';

export const SERVER = {name: 64, body: 2000, perHour: 60, page: 30, maxPage: 100, boards: 100,
  /** Servers a person owns or has held for them, at most; servers they make in a day. */
  servers: 50, perDay: 10,
  /** How long a server its maker leaves with nobody else in it is held (not HOLD: no name is kept long by making and leaving). */
  alone: 86_400_000,
  /** A board's TODO: as long as Home's items may be (src/todo.ts), and so many of them. */
  todo: {title: 200, detail: 4000, items: 500},
  /**
   * Guests: an invitation lets in so many (one unless asked, at most 20) for so many days (7 unless
   * asked, at most 30); a board has so many invitations out and so many guests at once; a guest
   * writes so many posts an hour, and a board's guests together so many; a guest's name is so long.
   */
  guest: {uses: 20, days: 7, maxDays: 30, invites: 20, guests: 100, perHour: 20, boardPerHour: 100, name: 32}} as const;
const TODO_ID = /^[0-9a-z-]{1,40}$/;
const KIND = /^[A-Za-z][A-Za-z0-9-]{0,15}$/;
const ID = /^[0-9a-z]{17}$/;
const KEY = /^[0-9a-z]{12}$/;
/** An invitation: 128 random bits, as hex. */
const INVITE = /^[0-9a-f]{32}$/;
/**
 * A guest's name: a few words of their choosing, but no @ (so it is never written as an address is)
 * and nothing that is not seen as itself (control characters, and the invisible marks that turn
 * text around or join it), so what one reads is what they chose.
 */
const guestName = (n: string) => n.length > 0 && [...n].length <= SERVER.guest.name && !/[@\p{C}]/u.test(n);
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
  /** The web app's origin: an invitation's link opens it (…/#guest=BOARD.INVITE). */
  appOrigin?: string;
  /** Mixed into the digests of invitations and tokens. */
  secret?: string;
  /** No board is opened past its people (a Remote for research: enter.ts). */
  closed?: boolean;
  /** What the account's plan allows (plan.ts): making a server is paid. */
  plans?: Plans;
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
  /** An invitation's or a token's digest: what is kept of it, so the Remote's copy opens nothing. */
  const seal = (s: string) => digest(`${d.secret ?? ''}:${s}`);

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
    const list = await db.select({id: server.id, name: server.name, address: sql<string>`coalesce(${address.address}, '')`, owner: member.owner, until: address.until, code: principalCode.code, madeBy: server.madeBy})
      .from(member).innerJoin(server, and(eq(server.id, member.serverId), isNull(server.goneAt)))
      .leftJoin(address, eq(address.serverId, server.id)).leftJoin(principalCode, eq(principalCode.serverId, server.id))
      .where(eq(member.userId, me)).orderBy(member.addedAt) as {id: string; name: string; address: string; owner: boolean; until: Date | null; code: string | null; madeBy: string | null}[];
    if (!list.length) return c.json([]);
    // A board removed is listed with when it goes for good (`gone`), so its owner may bring it back.
    const boards = await db.select({id: board.id, serverId: board.serverId, name: board.name, reach: board.reach, goneAt: board.goneAt}).from(board)
      .where(and(inArray(board.serverId, list.map((r) => r.id)), sql`(${board.goneAt} is null or ${board.goneAt} > ${ago(HOLD)})`)).orderBy(board.createdAt) as Board[];
    // `made`: whether the asker made it, so what leaving or removing it comes to is said before (its maker alone: a day).
    return c.json(list.map((r) => ({id: r.id, name: r.name, address: r.address, owner: r.owner, made: r.madeBy === me, code: r.code ?? '', until: r.until?.getTime() ?? null,
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
    if (!NAME.test(handle)) return c.json({error: 'Its name: letters, digits, - . _'}, 400);
    const made = await db.transaction(async (tx: Db) => {
      await lock(tx, me);
      // Making one is the plan's to allow; being asked into one, and writing in it, never is.
      await d.plans?.makeServer(tx, me);
      if (!await liveAddress(tx, me)) refuse(409, {error: 'Claim a name first'});
      if (domain !== d.domain) {
        const [on] = await tx.select({a: address.address}).from(address).where(and(eq(address.userId, me), eq(address.domain, domain), isNull(address.releasedAt), isNull(address.lapsedAt)));
        if (!on) refuse(400, {error: 'Only on a domain you hold a name on'});
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
      return {id, name: n, address: `${handle}@${domain}`, owner: true, made: true, code: await codeOf(tx, {serverId: id}), until: got.until,
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
      if (!await liveAddress(tx, me)) refuse(409, {error: 'Claim a name first'});
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
    if (!who?.user) return c.json({error: 'No one has that name'}, 404);
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
    await db.transaction(async (tx: Db) => {
      if (Object.keys(set).length) await tx.update(board).set(set).where(eq(board.id, at.b.id));
      // No longer taking guests ends its invitations and its guests: taking them again lets nobody back by an old link.
      if (set.reach !== undefined && set.reach < REACH.guests) {
        await tx.delete(invite).where(eq(invite.boardId, at.b.id));
        await tx.delete(guest).where(eq(guest.boardId, at.b.id));
      }
    });
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
    if (!at.address) return c.json({error: 'Claim a name first'}, 409);
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

  const write = async (c: Context, b: Board, who: {userId?: string; guestId?: string; by: string}, perHour: number = SERVER.perHour) => {
    const r = await body<{body?: unknown}>(c);
    const text = typeof r?.body === 'string' ? r.body.trim() : '';
    if (!text || text.length > SERVER.body) return c.json({error: 'A post is at most 2000 characters'}, 400);
    const whose = who.userId ? eq(talk.userId, who.userId) : eq(talk.guestId, who.guestId!);
    const [{n}] = await db.select({n: sql<number>`count(*)::int`}).from(talk).where(and(whose, gte(talk.id, idAt(Date.now() - 3600_000))));
    if (n >= perHour) return c.json({error: 'Too many posts this hour'}, 429);
    const row = {id: postId(), boardId: b.id, userId: who.userId ?? null, guestId: who.guestId ?? null, by: who.by, body: text};
    await db.insert(talk).values(row);
    return c.json(shape(who.userId ?? null, false)(row), 201);
  };

  v1.post('/boards/:id/posts', async (c) => {
    const at = await mine(c.req.param('id'), c.get('userId')) ?? notMine();
    if (!at.address) return c.json({error: 'Claim a name first'}, 409);
    return write(c, at.b, {userId: c.get('userId'), by: at.address});
  });

  v1.delete('/boards/:id/posts/:pid', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    const whose = at.owner ? undefined : eq(talk.userId, me);
    const taken = await db.delete(talk).where(and(eq(talk.id, c.req.param('pid')), eq(talk.boardId, at.b.id), whose)).returning({id: talk.id});
    return taken.length ? c.body(null, 204) : c.json({error: 'No such post of yours'}, 404);
  });

  // Read so far, by one of its people: the newest post they have had on screen. It only goes forward,
  // so a device that read less, later, takes nothing back.
  v1.post('/boards/:id/seen', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    const post = (await body<{post?: unknown}>(c))?.post;
    if (typeof post !== 'string' || !ID.test(post)) return c.json({error: 'a post'}, 400);
    await db.insert(boardSeen).values({boardId: at.b.id, userId: me, post})
      .onConflictDoUpdate({target: [boardSeen.boardId, boardSeen.userId], set: {post: sql`greatest(${qualified(boardSeen.post)}, excluded.post)`}});
    return c.body(null, 204);
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

  // ---- its guests: let in by invitations its people hand out themselves ----
  //
  // Nothing is sent by the Remote: one of its people makes an invitation and passes it on as they
  // like. Every one of its people sees the invitations live and the guests in; an invitation is
  // revoked by whoever made it or by the server's owner, and a guest removed (their posts with them)
  // by whoever invited them or by the server's owner.

  v1.get('/boards/:id/guests', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    const invites = await db.select({id: invite.id, userId: invite.userId, by: shownAs(qualified(invite.userId)), uses: invite.uses, until: invite.until}).from(invite)
      .where(and(eq(invite.boardId, at.b.id), gt(invite.uses, 0), gt(invite.until, sql`now()`))).orderBy(invite.createdAt) as
      {id: string; userId: string; by: string | null; uses: number; until: Date}[];
    const guests = await db.select({id: guest.id, name: guest.name, invitedBy: guest.invitedBy, by: shownAs(qualified(guest.invitedBy)), until: guest.tokenUntil}).from(guest)
      .where(and(eq(guest.boardId, at.b.id), gt(guest.tokenUntil, sql`now()`))).orderBy(guest.createdAt) as
      {id: string; name: string; invitedBy: string | null; by: string | null; until: Date}[];
    return c.json({
      invites: invites.map((x) => ({id: x.id, by: x.by ?? '', uses: x.uses, until: x.until.getTime(), mine: x.userId === me, mayRevoke: x.userId === me || !!at.owner})),
      guests: guests.map((x) => ({id: x.id, name: x.name, by: x.by ?? '', until: x.until.getTime(), mayRemove: x.invitedBy === me || !!at.owner})),
    });
  });

  // An invitation: for one person unless more are asked for (at most 20), for a week unless fewer or
  // more days are (at most 30). Its link is said once, here: the Remote keeps only its digest.
  v1.post('/boards/:id/invites', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    if (at.b.reach !== REACH.guests) return c.json({error: 'This board takes no guests'}, 409);
    const r = await body<{uses?: unknown; days?: unknown}>(c);
    const whole = (v: unknown, otherwise: number, most: number) => (v === undefined ? otherwise : Number.isInteger(v) && (v as number) >= 1 && (v as number) <= most ? v as number : NaN);
    const uses = whole(r?.uses, 1, SERVER.guest.uses), days = whole(r?.days, SERVER.guest.days, SERVER.guest.maxDays);
    if (Number.isNaN(uses) || Number.isNaN(days)) return c.json({error: 'For 1 to 20 people, for 1 to 30 days'}, 400);
    const code = hex(crypto.getRandomValues(new Uint8Array(16))), id = key(), until = new Date(Date.now() + days * 86_400_000);
    await db.transaction(async (tx: Db) => {
      await lock(tx, `guests:${at.b.id}`);
      const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(invite)
        .where(and(eq(invite.boardId, at.b.id), gt(invite.uses, 0), gt(invite.until, sql`now()`)));
      if (n >= SERVER.guest.invites) refuse(429, {error: 'This board has as many invitations out as it takes; revoke one first'});
      await tx.insert(invite).values({id, boardId: at.b.id, serverId: at.b.serverId, userId: me, digest: await seal(code), uses, until});
    });
    const link = `${(d.appOrigin ?? '').replace(/\/$/, '')}/#guest=${at.b.id}.${code}`;
    return c.json({id, invite: code, link, uses, until: until.getTime()}, 201);
  });

  v1.delete('/boards/:id/invites/:iid', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    const gone = await db.delete(invite).where(and(eq(invite.id, c.req.param('iid')), eq(invite.boardId, at.b.id), at.owner ? undefined : eq(invite.userId, me)))
      .returning({id: invite.id});
    return gone.length ? c.body(null, 204) : c.json({error: 'No such invitation of yours'}, 404);
  });

  // A guest removed writes no more, and what they wrote here is taken down with them.
  v1.delete('/boards/:id/guests/:gid', async (c) => {
    const me = c.get('userId');
    const at = await mine(c.req.param('id'), me) ?? notMine();
    // Their posts first: the guest going would let go of whose they are (guest_id is set null).
    const gone = await db.transaction(async (tx: Db) => {
      const [g] = await tx.select({id: guest.id}).from(guest)
        .where(and(eq(guest.id, c.req.param('gid')), eq(guest.boardId, at.b.id), at.owner ? undefined : eq(guest.invitedBy, me))).for('update') as {id: string}[];
      if (!g) return null;
      await tx.delete(talk).where(and(eq(talk.boardId, at.b.id), eq(talk.guestId, g.id)));
      await tx.delete(guest).where(eq(guest.id, g.id));
      return g;
    });
    return gone ? c.body(null, 204) : c.json({error: 'No such guest of yours'}, 404);
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

  // A guest: an invitation one of its people handed them, and a name they choose; then a token for
  // writing in this board, and nothing else.
  const guestBoard = async (id: string) => (await open(id, REACH.guests)) ?? refuse(404, {error: 'This board takes no guests'});

  // The invitation is the whole proof: 128 random bits, kept only as a digest, so it is not found by
  // trying and the Remote's copy opens nothing. Spending a use, checking the name and letting the guest
  // in are one transaction: refused at any step, the use is not spent. The answer is the same for an
  // invitation that is wrong, revoked, used up or run out, so none of them is told from another.
  app.post('/v1/open/:id/guest', async (c) => {
    const at = await guestBoard(c.req.param('id'));
    const r = await body<{invite?: unknown; name?: unknown}>(c);
    const code = typeof r?.invite === 'string' ? r.invite.trim().toLowerCase() : '';
    const as = name(r?.name);
    if (!guestName(as)) return c.json({error: 'A name of at most 32 characters, without @'}, 400);
    if (!INVITE.test(code)) return c.json({error: 'This invitation does not open this board'}, 403);
    const sealed = await seal(code), token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const g = await db.transaction(async (tx: Db) => {
      await lock(tx, `guests:${at.b.id}`);
      const [used] = await tx.update(invite).set({uses: sql`${invite.uses} - 1`})
        .where(and(eq(invite.digest, sealed), eq(invite.boardId, at.b.id), gt(invite.uses, 0), gt(invite.until, sql`now()`)))
        .returning({by: invite.userId}) as {by: string}[];
      if (!used) refuse(403, {error: 'This invitation does not open this board'});
      // Never one of its people's names, nor the server's: a guest is not taken for someone they are not.
      const [n] = await rows<{taken: boolean; guests: number}>(tx, sql`select
        exists (select 1 from address a where a.released_at is null and lower(a.name) = lower(${as})
          and (a.server_id = ${at.b.serverId} or a.user_id in (select m.user_id from server_member m where m.server_id = ${at.b.serverId}))) as taken,
        (select count(*)::int from board_guest where board_id = ${at.b.id} and token_until > now()) as guests`);
      if (n.taken) refuse(409, {error: 'That name is taken here'});
      if (n.guests >= SERVER.guest.guests) refuse(429, {error: 'This board has as many guests as it takes'});
      const [made] = await tx.insert(guest).values({id: key(), boardId: at.b.id, name: as, token: await seal(token),
        tokenUntil: new Date(Date.now() + HOLD), invitedBy: used.by}).onConflictDoNothing().returning({id: guest.id}) as {id: string}[];
      if (!made) refuse(409, {error: 'That name is taken here'});
      return made;
    });
    return c.json({id: g.id, token, as}, 200, anyone);
  });

  /** The guest a token names on this board, while it holds; else refused (403: 401 is for a session the Remote does not know). */
  const guestOf = async (c: Context, b: Board) => {
    const token = c.req.header('X-Guest') ?? '';
    const [g] = /^[0-9a-f]{64}$/.test(token) ? await db.select({id: guest.id, name: guest.name}).from(guest)
      .where(and(eq(guest.boardId, b.id), eq(guest.token, await seal(token)), gt(guest.tokenUntil, sql`now()`))) as {id: string; name: string}[] : [];
    return g ?? refuse(403, {error: 'You are not a guest here'});
  };

  // Who one is here, as a guest: so a guest removed, or whose lease ran out, is told so before writing.
  app.get('/v1/open/:id/guest', async (c) => {
    const at = await guestBoard(c.req.param('id'));
    const g = await guestOf(c, at.b);
    return c.json({id: g.id, as: g.name}, 200, anyone);
  });

  // A guest writes so many posts an hour, and a board's guests together so many: one invitation passed
  // around cannot fill a board.
  app.post('/v1/open/:id/posts', async (c) => {
    const at = await guestBoard(c.req.param('id'));
    const g = await guestOf(c, at.b);
    const [{n}] = await db.select({n: sql<number>`count(*)::int`}).from(talk)
      .where(and(eq(talk.boardId, at.b.id), isNull(talk.userId), gte(talk.id, idAt(Date.now() - 3600_000))));
    if (n >= SERVER.guest.boardPerHour) return c.json({error: 'Guests have written as much as they may here this hour'}, 429);
    return write(c, at.b, {guestId: g.id, by: g.name}, SERVER.guest.perHour);
  });
}
