// Inbox: messages between people, found by address (name@domain).
//
// Publication and discovery go through the domain: a name on this Remote's
// own domain is claimed here; a name on any other domain is that domain's
// to publish, at https://<domain>/.well-known/length3, naming this Remote
// and the account. To reach an address its domain is asked the same way.
// The address is also what an SSH connection will be made to, and being
// reachable over SSH is its own opt-in, off unless asked for.
//
// What keeps this from being anyone's free relay:
//   - every account is a provider's identity (auth.ts); to send you need an address
//   - text only, and small; no attachments: the Inbox carries words, not files
//   - a sender sends at most so many an hour; someone who has not accepted
//     you holds at most a few requests from you, and a few from strangers in all
//   - live chat is WebRTC between the two devices; the Remote carries only
//     the signalling, between accepted contacts both ways, small and short-
//     lived, and offers no TURN: what cannot connect directly stays a message
//   - messages expire

import {and, desc, eq, gt, inArray, isNull, lt, or, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {address, contact, message, signal, user} from './schema.ts';

export const INBOX = {
  body: 4000, perHour: 60, requestsPerPeer: 3, requestsInAll: 30,
  signal: 16 * 1024, signalsPerMinute: 120, signalLife: 2 * 60_000, keepDays: 90,
} as const;
const NAME = /^[a-z0-9][a-z0-9._-]{1,30}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TYPES = ['message', 'review', 'question', 'run'] as const;

export interface InboxDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  /** This Remote's own domain: names claimed here are name@domain. */
  domain: string;
  /** This Remote's address, as a domain's well-known names it. */
  baseURL: string;
  /** How a domain's well-known is read (fetch, or a stand-in in tests). */
  wellKnown?: (domain: string) => Promise<unknown>;
}

/** An address as typed: lower case, and the domain checked. */
export function parseAddress(a: string): {name: string; domain: string} | null {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(a.trim().toLowerCase());
  if (!m || !NAME.test(m[1]) || !DOMAIN.test(m[2])) return null;
  return {name: m[1], domain: m[2]};
}

type Vars = {Variables: {userId: string; sessionId: string}};

export function inbox(d: InboxDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const readWellKnown = d.wellKnown ?? (async (domain: string) => {
    const r = await fetch(`https://${domain}/.well-known/length3`, {redirect: 'error', signal: AbortSignal.timeout(5000)});
    return r.ok ? r.json() : null;
  });

  /** Whom an address reaches on this Remote, if anyone. */
  const resolve = async (a: string): Promise<{userId: string; address: string} | {why: string}> => {
    const p = parseAddress(a);
    if (!p) return {why: 'not an address'};
    const [row] = await d.db.select().from(address).where(eq(address.address, `${p.name}@${p.domain}`));
    if (row) return {userId: row.userId, address: row.address};
    if (p.domain === d.domain) return {why: 'no such address'};
    // Another domain: it says which Remote holds the name.
    const known = await readWellKnown(p.domain).catch(() => null) as {remote?: string; names?: Record<string, string>} | null;
    if (!known?.remote) return {why: 'the domain publishes no Length³ address'};
    if (known.remote.replace(/\/$/, '') !== d.baseURL.replace(/\/$/, '')) return {why: 'on another Remote, which this one does not reach yet'};
    return {why: 'no such address'};
  };

  // The Remote's own domain answers for one name at a time: no list of everyone to read.
  app.get('/.well-known/length3', async (c) => {
    const name = (c.req.query('name') ?? '').toLowerCase();
    const [row] = NAME.test(name) ? await d.db.select({a: address.address}).from(address).where(eq(address.address, `${name}@${d.domain}`)) : [];
    return c.json({remote: d.baseURL, ...(row ? {name} : {})}, 200, {'Access-Control-Allow-Origin': '*'});
  });

  const mine = async (userId: string) => (await d.db.select().from(address).where(eq(address.userId, userId)).orderBy(address.createdAt)) as (typeof address.$inferSelect)[];

  v1.get('/inbox/me', async (c) => {
    const list = await mine(c.get('userId'));
    return c.json({domain: d.domain, account: c.get('userId'), addresses: list.map((a) => ({address: a.address, ssh: Boolean(a.ssh)}))});
  });

  // Claim an address. On this Remote's domain the name is free or not; on another,
  // the domain itself must name this Remote and this account for it.
  v1.post('/inbox/addresses', async (c) => {
    const b = await c.req.json().catch(() => null) as {name?: unknown; domain?: unknown} | null;
    const name = typeof b?.name === 'string' ? b.name.trim().toLowerCase() : '';
    const domain = typeof b?.domain === 'string' && b.domain.trim() ? b.domain.trim().toLowerCase() : d.domain;
    if (!NAME.test(name)) return c.json({error: 'name'}, 400);
    if (!DOMAIN.test(domain) && domain !== d.domain) return c.json({error: 'domain'}, 400);
    if ((await mine(c.get('userId'))).length >= 5) return c.json({error: 'too many addresses'}, 409);
    if (domain !== d.domain) {
      const known = await readWellKnown(domain).catch(() => null) as {remote?: string; names?: Record<string, string>} | null;
      if (known?.remote?.replace(/\/$/, '') !== d.baseURL.replace(/\/$/, '') || known.names?.[name] !== c.get('userId')) {
        return c.json({error: 'not published', publish: {remote: d.baseURL, names: {[name]: c.get('userId')}}}, 409);
      }
    }
    const done = await d.db.insert(address).values({address: `${name}@${domain}`, userId: c.get('userId'), name, domain}).onConflictDoNothing().returning({a: address.address});
    return done.length ? c.json({address: `${name}@${domain}`}, 201) : c.json({error: 'taken'}, 409);
  });

  v1.post('/inbox/addresses/:address/ssh', async (c) => {
    const b = await c.req.json().catch(() => ({})) as {on?: unknown};
    const done = await d.db.update(address).set({ssh: b.on === true ? 1 : 0})
      .where(and(eq(address.address, c.req.param('address')), eq(address.userId, c.get('userId')))).returning({a: address.address});
    return done.length ? c.json({address: done[0].a, ssh: b.on === true}) : c.json({error: 'not yours'}, 404);
  });

  v1.get('/inbox/lookup', async (c) => {
    const r = await resolve(c.req.query('address') ?? '');
    return 'userId' in r ? c.json({address: r.address, reachable: true}) : c.json({reachable: false, why: r.why});
  });

  const relation = async (from: string, to: string) => {
    const rows = await d.db.select().from(contact).where(or(and(eq(contact.userId, from), eq(contact.peer, to)), and(eq(contact.userId, to), eq(contact.peer, from))));
    const of = (u: string) => (rows.find((r: typeof contact.$inferSelect) => r.userId === u)?.state ?? null) as string | null;
    return {mine: of(from), theirs: of(to)};
  };

  v1.post('/inbox/messages', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {to?: unknown; from?: unknown; type?: unknown; target?: unknown; body?: unknown} | null;
    const body = typeof b?.body === 'string' ? b.body.trim() : '';
    if (!body || body.length > INBOX.body) return c.json({error: 'a text of at most 4000 characters'}, 400);
    const type = TYPES.includes(b?.type as typeof TYPES[number]) ? b!.type as string : 'message';
    const target = Object.fromEntries(Object.entries(typeof b?.target === 'object' && b.target ? b.target : {})
      .filter(([k, v]) => ['repo', 'issue', 'change', 'version'].includes(k) && (typeof v === 'string' ? v.length <= 200 : typeof v === 'number')));
    const own = await mine(me);
    const from = own.find((a) => a.address === b?.from) ?? own[0];
    if (!from) return c.json({error: 'claim an address first'}, 409);
    const to = await resolve(typeof b?.to === 'string' ? b.to : '');
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    if (to.userId === me) return c.json({error: 'that is you'}, 400);
    const rel = await relation(me, to.userId);
    if (rel.theirs === 'blocked') return c.json({error: 'not accepted'}, 403);
    const hour = new Date(Date.now() - 3600_000);
    const [{sent}] = await d.db.select({sent: sql<number>`count(*)`}).from(message).where(and(eq(message.from, me), gt(message.createdAt, hour)));
    if (Number(sent) >= INBOX.perHour) return c.json({error: 'too many messages this hour'}, 429);
    // Not accepted by them yet: a request, of which they hold only a few.
    if (rel.theirs !== 'accepted') {
      const [{pair}] = await d.db.select({pair: sql<number>`count(*)`}).from(message).where(and(eq(message.from, me), eq(message.to, to.userId), isNull(message.readAt)));
      if (Number(pair) >= INBOX.requestsPerPeer) return c.json({error: 'wait for them to answer'}, 429);
      const accepted = (await d.db.select({peer: contact.peer}).from(contact).where(and(eq(contact.userId, to.userId), eq(contact.state, 'accepted')))).map((r: {peer: string}) => r.peer);
      const [{waiting}] = await d.db.select({waiting: sql<number>`count(*)`}).from(message)
        .where(and(eq(message.to, to.userId), isNull(message.readAt), accepted.length ? sql`${message.from} not in (${sql.join(accepted.map((a: string) => sql`${a}`), sql`, `)})` : sql`true`));
      if (Number(waiting) >= INBOX.requestsInAll) return c.json({error: 'their requests are full'}, 429);
    }
    // Writing to someone is accepting them.
    if (rel.mine !== 'accepted') await d.db.insert(contact).values({userId: me, peer: to.userId, state: 'accepted'}).onConflictDoUpdate({target: [contact.userId, contact.peer], set: {state: 'accepted'}});
    const id = crypto.randomUUID();
    await d.db.insert(message).values({id, to: to.userId, from: me, fromAddress: from.address, toAddress: to.address, type, target, body});
    return c.json({id, request: rel.theirs !== 'accepted'}, 201);
  });

  /** The other person's addresses (the first is how they are shown). */
  const addressesOf = async (ids: string[]) => {
    if (!ids.length) return new Map<string, string>();
    const rows = await d.db.select().from(address).where(inArray(address.userId, ids)).orderBy(address.createdAt);
    const out = new Map<string, string>();
    for (const r of rows as (typeof address.$inferSelect)[]) if (!out.has(r.userId)) out.set(r.userId, r.address);
    return out;
  };

  // Conversations, newest first: contacts, requests (they wrote, you have not accepted), and blocked.
  v1.get('/inbox/threads', async (c) => {
    const me = c.get('userId');
    await d.db.delete(message).where(and(or(eq(message.to, me), eq(message.from, me)), lt(message.createdAt, new Date(Date.now() - INBOX.keepDays * 86400_000))));
    const rows = await d.db.select().from(message).where(or(eq(message.to, me), eq(message.from, me))).orderBy(desc(message.createdAt)).limit(500);
    const contacts = await d.db.select().from(contact).where(eq(contact.userId, me));
    const state = new Map<string, string>(contacts.map((r: typeof contact.$inferSelect) => [r.peer, r.state]));
    const peers = new Map<string, {last: typeof message.$inferSelect; unread: number}>();
    for (const m of rows as (typeof message.$inferSelect)[]) {
      const peer = m.from === me ? m.to : m.from;
      const t = peers.get(peer) ?? {last: m, unread: 0};
      if (m.to === me && !m.readAt) t.unread++;
      peers.set(peer, t);
    }
    const names = await d.db.select({id: user.id, name: user.name}).from(user).where(inArray(user.id, [...peers.keys(), '']));
    const named = new Map<string, string>(names.map((u: {id: string; name: string}) => [u.id, u.name]));
    const addrs = await addressesOf([...peers.keys()]);
    return c.json([...peers].map(([peer, t]) => ({
      address: addrs.get(peer) ?? (t.last.from === me ? t.last.toAddress : t.last.fromAddress), name: named.get(peer) ?? '',
      state: state.get(peer) === 'blocked' ? 'blocked' : state.get(peer) === 'accepted' ? 'contact' : 'request',
      unread: t.unread, last: {type: t.last.type, body: t.last.body.slice(0, 140), mine: t.last.from === me, time: t.last.createdAt.getTime()},
    })));
  });

  v1.get('/inbox/threads/:address', async (c) => {
    const me = c.get('userId');
    const to = await resolve(c.req.param('address'));
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    const rows = await d.db.select().from(message)
      .where(or(and(eq(message.from, me), eq(message.to, to.userId)), and(eq(message.from, to.userId), eq(message.to, me))))
      .orderBy(desc(message.createdAt)).limit(200);
    const rel = await relation(me, to.userId);
    return c.json({address: to.address, state: rel.mine === 'blocked' ? 'blocked' : rel.mine === 'accepted' ? 'contact' : 'request', mutual: rel.mine === 'accepted' && rel.theirs === 'accepted',
      messages: (rows as (typeof message.$inferSelect)[]).reverse().map((m) => ({id: m.id, mine: m.from === me, type: m.type, target: m.target, body: m.body, time: m.createdAt.getTime(), read: Boolean(m.readAt)}))});
  });

  v1.post('/inbox/threads/:address/read', async (c) => {
    const me = c.get('userId');
    const to = await resolve(c.req.param('address'));
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    await d.db.update(message).set({readAt: new Date()}).where(and(eq(message.to, me), eq(message.from, to.userId), isNull(message.readAt)));
    return c.json({read: true});
  });

  // Accept someone (their requests become a conversation), block them, or neither.
  v1.post('/inbox/contacts', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {address?: unknown; state?: unknown} | null;
    const to = await resolve(typeof b?.address === 'string' ? b.address : '');
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    const state = b?.state === 'blocked' ? 'blocked' : b?.state === 'none' ? null : 'accepted';
    if (!state) await d.db.delete(contact).where(and(eq(contact.userId, me), eq(contact.peer, to.userId)));
    else await d.db.insert(contact).values({userId: me, peer: to.userId, state}).onConflictDoUpdate({target: [contact.userId, contact.peer], set: {state}});
    return c.json({address: to.address, state: state ?? 'none'});
  });

  // ---- WebRTC signalling: contacts both ways, small, short-lived ----

  v1.post('/inbox/signals', async (c) => {
    const me = c.get('userId');
    const b = await c.req.json().catch(() => null) as {to?: unknown; session?: unknown; kind?: unknown; data?: unknown} | null;
    const to = await resolve(typeof b?.to === 'string' ? b.to : '');
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    const rel = await relation(me, to.userId);
    if (rel.mine !== 'accepted' || rel.theirs !== 'accepted') return c.json({error: 'live chat is between accepted contacts'}, 403);
    const data = typeof b?.data === 'string' ? b.data : '';
    if (!['offer', 'answer', 'candidate', 'bye'].includes(String(b?.kind)) || data.length > INBOX.signal || typeof b?.session !== 'string' || b.session.length > 64) return c.json({error: 'a signal'}, 400);
    const minute = new Date(Date.now() - 60_000);
    const [{n}] = await d.db.select({n: sql<number>`count(*)`}).from(signal).where(and(eq(signal.from, me), gt(signal.createdAt, minute)));
    if (Number(n) >= INBOX.signalsPerMinute) return c.json({error: 'too many'}, 429);
    await d.db.insert(signal).values({id: crypto.randomUUID(), to: to.userId, from: me, session: b.session, kind: String(b.kind), data});
    return c.json({sent: true}, 201);
  });

  // What has come for this account, taken once; anything older than its life is gone.
  v1.get('/inbox/signals', async (c) => {
    const me = c.get('userId');
    await d.db.delete(signal).where(lt(signal.createdAt, new Date(Date.now() - INBOX.signalLife)));
    const rows = await d.db.delete(signal).where(eq(signal.to, me)).returning();
    const addrs = await addressesOf([...new Set((rows as (typeof signal.$inferSelect)[]).map((r) => r.from))]);
    return c.json((rows as (typeof signal.$inferSelect)[]).map((r) => ({from: addrs.get(r.from) ?? '', session: r.session, kind: r.kind, data: r.data, time: r.createdAt.getTime()})));
  });
}
