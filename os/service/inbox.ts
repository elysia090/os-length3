// Inbox: messages between people, found by address (name@domain).
//
// Publication and discovery go through the domain: a name on this Remote's
// own domain is claimed here; a name on any other domain needs its owner to
// say so in the domain's DNS, as mail says where it goes with MX:
//
//   _length3.example.org  TXT  "v=length3; remote=remote.length3.com; proof=<26 letters>"
//
// remote= is which Remote holds the domain's addresses (what another Remote
// asks to reach one), and proof= is an HMAC of the account and the domain
// under this Remote's secret: only that account can be handed it, it proves
// whoever controls the domain's DNS put it there for that account, nothing
// is kept to check it, and it is checked again whenever it matters.
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
//   - messages read expire (sweep.ts)

import {and, eq, gt, isNull, or, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {byCode, claim, codeOf, HOLD, kept, live, release} from './names.ts';
import {ago, body, ms, refuse, rows, type Db, type Vars} from './request.ts';
import {address, contact, message, signal} from './schema.ts';

export const INBOX = {
  body: 4000, perHour: 60, requestsPerPeer: 3, requestsInAll: 30, addresses: 5,
  signal: 16 * 1024, signalsPerMinute: 120, signalLife: 2 * 60_000, keepDays: 90,
} as const;
const NAME = /^[a-z0-9][a-z0-9._-]{1,30}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TYPES = ['message', 'review', 'question', 'run'] as const;

export interface InboxDeps {
  db: Db;
  /** This Remote's own domain: names claimed here are name@domain. */
  domain: string;
  /** This Remote's address; a domain's record names its host. */
  baseURL: string;
  /** The key a domain's proof is made with (the service's secret). */
  secret: string;
  /** A name's TXT records (DNS over HTTPS, or a stand-in in tests). */
  txt?: (name: string) => Promise<string[]>;
  /** How long what a domain's DNS said is taken as still so (an hour; tests read it every time). */
  recheck?: number;
}

/** A name's TXT records through DNS over HTTPS (Cloudflare's resolver), each record's strings joined; throws when DNS could not be asked. */
async function txtOverHttps(name: string): Promise<string[]> {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    {headers: {accept: 'application/dns-json'}, signal: AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error(`DNS over HTTPS: ${r.status}`);
  const body = await r.json() as {Answer?: {type: number; data: string}[]};
  return (body.Answer ?? []).filter((a) => a.type === 16).map((a) => [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('') || a.data);
}

/** The fields of a length3 record ("v=length3; remote=…; proof=…"), or null for another record. */
function readRecord(text: string): {remote: string; proof: string} | null {
  const f = Object.fromEntries(text.split(';').map((p) => p.trim().split('=').map((x) => x.trim())).filter((kv) => kv.length === 2)) as Record<string, string>;
  return f.v === 'length3' && f.remote ? {remote: f.remote.toLowerCase(), proof: f.proof ?? ''} : null;
}

/** An address as typed: lower case, and the domain checked. */
function parseAddress(a: string): {name: string; domain: string} | null {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(a.trim().toLowerCase());
  if (!m || !NAME.test(m[1]) || !DOMAIN.test(m[2])) return null;
  return {name: m[1], domain: m[2]};
}

type Address = typeof address.$inferSelect;

export function inbox(d: InboxDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  const txt = d.txt ?? txtOverHttps;
  const host = new URL(d.baseURL || 'https://localhost').host.toLowerCase();
  /** The proof for an account on a domain: HMAC-SHA256 under the secret, 26 letters of base32. */
  const proofOf = async (userId: string, domain: string) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(d.secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`length3-domain\n${userId}\n${domain}`)));
    const abc = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, value = 0, out = '';
    for (const byte of mac) { value = (value << 8) | byte; bits += 8; while (bits >= 5 && out.length < 26) { out += abc[(value >>> (bits - 5)) & 31]; bits -= 5; } }
    return out;
  };
  const recordName = (domain: string) => `_length3.${domain}`;
  /**
   * What the domain's DNS says of Length³: its records, read now. DNS that
   * could not be asked is not DNS saying nothing: the request is refused (503),
   * and nothing is lapsed for it.
   */
  const published = async (domain: string) => {
    const records = await txt(recordName(domain)).catch((e: unknown) => {
      console.error(`DNS for ${domain}`, e);
      return refuse(503, {error: 'The domain\'s DNS could not be read; try again'});
    });
    return records.map(readRecord).filter(Boolean) as {remote: string; proof: string}[];
  };

  /**
   * Whether a name on another domain still answers: its domain's DNS still
   * names this Remote for its owner. Read again at most hourly an owner and
   * domain (this Remote's isolate keeps what it read). Lapsed, it answers no
   * one until the record is back; lapsed long enough, sweep.ts lets it go.
   */
  const seen = new Map<string, {at: number; ok: boolean}>();
  const stillNamed = async (row: Address) => {
    if (row.domain === d.domain || !row.userId) return true;
    const key = `${row.domain}\n${row.userId}`, was = seen.get(key);
    if (was && Date.now() - was.at < (d.recheck ?? 3600_000)) return was.ok;
    const proof = await proofOf(row.userId, row.domain);
    // DNS that cannot be asked now leaves the name as it was found last (and asks again next time).
    const records = await published(row.domain).catch((e: unknown) => { if (e instanceof HTTPException) return null; throw e; });
    if (!records) return !row.lapsedAt;
    const ok = records.some((r) => r.remote === host && r.proof === proof);
    seen.set(key, {at: Date.now(), ok});
    if (ok === !!row.lapsedAt) await db.update(address).set({lapsedAt: ok ? null : new Date()}).where(eq(address.address, row.address));
    return ok;
  };

  /** An account's addresses: not let go (a lapsed or ended one is still theirs, and says so). */
  const mine = async (userId: string) => (await db.select().from(address).where(and(eq(address.userId, userId), isNull(address.releasedAt))).orderBy(address.createdAt)) as Address[];

  /**
   * Whom `a` reaches on this Remote, if anyone: a person's live address. A
   * name alone is a name on this Remote (`ren`), six digits a code.
   */
  const resolve = async (a: string): Promise<{userId: string; address: string} | {why: string}> => {
    const q = a.trim().toLowerCase();
    if (/^\d{6}$/.test(q)) {
      const who = await byCode(db, q);
      if (!who) return {why: 'No one has that code'};
      if (!('userId' in who)) return {why: 'That is a server, not a person'};
      const [first] = await db.select({a: address.address}).from(address).where(and(eq(address.userId, who.userId), live)).orderBy(address.createdAt).limit(1);
      return first ? {userId: who.userId, address: first.a} : {why: 'No one has that name'};
    }
    const p = parseAddress(q.includes('@') ? q : `${q}@${d.domain}`);
    if (!p) return {why: 'That is not a name'};
    const [row] = await db.select().from(address).where(and(eq(address.address, `${p.name}@${p.domain}`), isNull(address.releasedAt))) as Address[];
    if (row?.until && row.until.getTime() <= Date.now()) return {why: 'No one has that name'};
    if (row?.userId) {
      if (!await stillNamed(row)) return {why: 'Its domain no longer names this Remote'};
      return {userId: row.userId, address: row.address};
    }
    if (row) return {why: 'That is a server, not a person'};
    if (p.domain === d.domain) return {why: 'No one has that name'};
    // Another domain: its DNS says which Remote holds its addresses.
    const records = await published(p.domain);
    if (!records.length) return {why: 'The domain publishes no Length³ address'};
    if (!records.some((r) => r.remote === host)) return {why: 'It is on another Remote, which this one does not reach yet'};
    return {why: 'No one has that name'};
  };

  // The Remote's own domain answers for one name at a time: no list of everyone to read.
  app.get('/.well-known/length3', async (c) => {
    const name = (c.req.query('name') ?? '').toLowerCase();
    const [row] = NAME.test(name) ? await db.select({a: address.address}).from(address).where(and(eq(address.address, `${name}@${d.domain}`), live)) : [];
    return c.json({remote: d.baseURL, ...(row ? {name} : {})}, 200, {'Access-Control-Allow-Origin': '*'});
  });

  // What to put in a domain's DNS so this account may use it here.
  v1.get('/inbox/domains/:domain', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    if (!DOMAIN.test(domain) || domain === d.domain) return c.json({error: 'That is not a domain'}, 400);
    const proof = await proofOf(c.get('userId'), domain);
    const records = await published(domain);
    return c.json({name: recordName(domain), type: 'TXT', value: `v=length3; remote=${host}; proof=${proof}`,
      found: records.some((r) => r.remote === host && r.proof === proof)});
  });

  v1.get('/inbox/me', async (c) => {
    const list = await mine(c.get('userId'));
    const code = await codeOf(db, {userId: c.get('userId')});
    return c.json({domain: d.domain, account: c.get('userId'), code, addresses: list.map((a) => ({address: a.address, ssh: a.ssh,
      ...(a.until ? {until: a.until.getTime(), ...(a.until.getTime() <= Date.now() ? {ended: true} : {})} : {}), ...(a.lapsedAt ? {lapsed: true} : {})}))});
  });

  // Claim an address. On this Remote's domain the name is free or not; on another,
  // the domain itself must name this Remote and this account for it.
  v1.post('/inbox/addresses', async (c) => {
    const me = c.get('userId');
    const b = await body<{name?: unknown; domain?: unknown}>(c);
    const name = typeof b?.name === 'string' ? b.name.trim().toLowerCase() : '';
    const domain = typeof b?.domain === 'string' && b.domain.trim() ? b.domain.trim().toLowerCase() : d.domain;
    if (!NAME.test(name)) return c.json({error: 'A name is 2–31 letters, digits, dots, dashes or underscores'}, 400);
    if (!DOMAIN.test(domain) && domain !== d.domain) return c.json({error: 'That is not a domain'}, 400);
    // So many names an account keeps, those let go and still held for it among them; taking one of its own back is no new one.
    const [{n, own}] = await db.select({n: sql<number>`count(*)::int`, own: sql<number>`count(*) filter (where ${address.address} = ${`${name}@${domain}`})::int`})
      .from(address).where(and(eq(address.userId, me), kept));
    if (!own && n >= INBOX.addresses) return c.json({error: 'Too many names'}, 409);
    if (domain !== d.domain) {
      // The domain's owner says, in its DNS, that this Remote holds it for this account.
      const proof = await proofOf(me, domain);
      if (!(await published(domain)).some((r) => r.remote === host && r.proof === proof)) {
        return c.json({error: 'The domain does not name this account yet', publish: {name: recordName(domain), type: 'TXT', value: `v=length3; remote=${host}; proof=${proof}`}}, 409);
      }
    }
    // One namespace with servers' names; on this Remote, first come, for a term; a name let go is held for its old owner a while.
    const got = await claim(db, name, domain, {userId: me}, domain === d.domain);
    if (got.ok) return c.json({address: `${name}@${domain}`, until: got.until}, 201);
    return c.json(got.until ? {error: 'That name was let go, and is held for its owner a while', until: got.until} : {error: 'That name is taken'}, 409);
  });

  // Renew a name on this Remote: held for another term from now (and taken back, if its term ran out a little while ago).
  v1.post('/inbox/addresses/:address/renew', async (c) => {
    const a = c.req.param('address').toLowerCase();
    const [row] = await db.select().from(address).where(and(eq(address.address, a), eq(address.userId, c.get('userId')), isNull(address.releasedAt))) as Address[];
    if (!row || row.domain !== d.domain) return c.json({error: 'That name is not yours'}, 404);
    const got = await claim(db, row.name, row.domain, {userId: c.get('userId')}, true);
    return got.ok ? c.json({address: a, until: got.until}) : c.json({error: 'That name is taken'}, 409);
  });

  // Let an address go: it stops answering at once, and is held for this account a while (it may take it back).
  v1.delete('/inbox/addresses/:address', async (c) => {
    const a = c.req.param('address').toLowerCase();
    const [row] = await db.select({a: address.address}).from(address).where(and(eq(address.address, a), eq(address.userId, c.get('userId')), isNull(address.releasedAt)));
    if (!row) return c.json({error: 'That name is not yours'}, 404);
    await db.transaction((tx: Db) => release(tx, a));
    return c.json({address: a, until: Date.now() + HOLD});
  });

  v1.post('/inbox/addresses/:address/ssh', async (c) => {
    const b = await body<{on?: unknown}>(c);
    const done = await db.update(address).set({ssh: b?.on === true})
      .where(and(eq(address.address, c.req.param('address')), eq(address.userId, c.get('userId')))).returning({a: address.address});
    return done.length ? c.json({address: done[0].a, ssh: b?.on === true}) : c.json({error: 'That name is not yours'}, 404);
  });

  v1.get('/inbox/lookup', async (c) => {
    const r = await resolve(c.req.query('address') ?? '');
    return 'userId' in r ? c.json({address: r.address, reachable: true}) : c.json({reachable: false, why: r.why});
  });

  /** How each side stands with the other: its own word (accepted, blocked) or none. */
  const relation = async (me: string, them: string) => {
    const list = await db.select().from(contact).where(or(and(eq(contact.userId, me), eq(contact.peer, them)), and(eq(contact.userId, them), eq(contact.peer, me))));
    const of = (u: string) => (list.find((r: typeof contact.$inferSelect) => r.userId === u)?.state ?? null) as string | null;
    return {mine: of(me), theirs: of(them)};
  };

  /**
   * `me` has just accepted `peer`: each server `peer` asked them into (a message about it, target.server)
   * within the last 30 days takes them in, now that the two have accepted each other, so long as `peer`
   * is still in it. As Server's own adding (servers.ts): only someone in it, and only someone both sides accepted.
   */
  const cameIn = (me: string, peer: string) => db.execute(sql`insert into server_member (server_id, user_id)
    select distinct sm.server_id, ${me}::text from message m
    join server_member sm on sm.server_id = m.target->>'server' and sm.user_id = m.from_user
    join server s on s.id = sm.server_id and s.gone_at is null
    where m.to_user = ${me} and m.from_user = ${peer} and m.created_at > ${ago(HOLD)}
      and exists (select 1 from contact k where k.user_id = ${peer} and k.peer = ${me} and k.state = 'accepted')
    on conflict do nothing`);

  v1.post('/inbox/messages', async (c) => {
    const me = c.get('userId');
    const b = await body<{to?: unknown; from?: unknown; type?: unknown; target?: unknown; body?: unknown}>(c);
    const text = typeof b?.body === 'string' ? b.body.trim() : '';
    if (!text || text.length > INBOX.body) return c.json({error: 'A message is at most 4000 characters'}, 400);
    const type = TYPES.includes(b?.type as typeof TYPES[number]) ? b!.type as string : 'message';
    const target = Object.fromEntries(Object.entries(typeof b?.target === 'object' && b.target ? b.target : {})
      .filter(([k, v]) => ['repo', 'issue', 'change', 'version', 'server'].includes(k) && (typeof v === 'string' ? v.length <= 200 : typeof v === 'number')));
    const own = await mine(me);
    const from = own.find((a) => a.address === b?.from) ?? own[0];
    if (!from) return c.json({error: 'Claim a name first'}, 409);
    const to = await resolve(typeof b?.to === 'string' ? b.to : '');
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    if (to.userId === me) return c.json({error: 'That is you'}, 400);
    const rel = await relation(me, to.userId);
    if (rel.theirs === 'blocked') return c.json({error: 'They do not accept messages from you'}, 403);
    // What this sender sent within the hour, what waits unread from them, and from anyone they have not accepted: one read.
    const hour = new Date(Date.now() - 3600_000);
    const [n] = await rows<{sent: number; pair: number; waiting: number}>(db, sql`select
      (select count(*)::int from message where from_user = ${me} and created_at > ${hour}) as sent,
      (select count(*)::int from message where from_user = ${me} and to_user = ${to.userId} and read_at is null) as pair,
      (select count(*)::int from message m where m.to_user = ${to.userId} and m.read_at is null
        and not exists (select 1 from contact k where k.user_id = ${to.userId} and k.peer = m.from_user and k.state = 'accepted')) as waiting`);
    if (n.sent >= INBOX.perHour) return c.json({error: 'Too many messages this hour'}, 429);
    // Not accepted by them yet: a request, of which they hold only a few.
    if (rel.theirs !== 'accepted') {
      if (n.pair >= INBOX.requestsPerPeer) return c.json({error: 'Wait for them to answer before writing more'}, 429);
      if (n.waiting >= INBOX.requestsInAll) return c.json({error: 'They have too many requests waiting'}, 429);
    }
    // Writing to someone is accepting them.
    if (rel.mine !== 'accepted') {
      await db.insert(contact).values({userId: me, peer: to.userId, state: 'accepted'}).onConflictDoUpdate({target: [contact.userId, contact.peer], set: {state: 'accepted'}});
      await cameIn(me, to.userId);
    }
    const id = crypto.randomUUID();
    await db.insert(message).values({id, to: to.userId, from: me, fromAddress: from.address, toAddress: to.address, type, target, body: text});
    return c.json({id, request: rel.theirs !== 'accepted'}, 201);
  });

  // Conversations, newest first: contacts, requests (they wrote, you have not accepted), and blocked.
  // Each the last message with each person and how many are unread, in one read.
  v1.get('/inbox/threads', async (c) => {
    const me = c.get('userId');
    const list = await rows<{peer: string; type: string; body: string; mine: boolean; time: number; from_address: string; to_address: string;
      unread: number; name: string | null; state: string | null; address: string | null}>(db, sql`
      select t.*, u.name, k.state,
        (select a.address from address a where a.user_id = t.peer and a.released_at is null order by a.created_at limit 1) as address
      from (
        select distinct on (peer) peer, type, left(body, 140) as body, from_user = ${me} as mine, ${ms(sql`created_at`)} as time, from_address, to_address,
          (count(*) filter (where to_user = ${me} and read_at is null) over (partition by peer))::int as unread
        from (select m.*, case when m.from_user = ${me} then m.to_user else m.from_user end as peer from message m where m.to_user = ${me} or m.from_user = ${me}) x
        order by peer, created_at desc
      ) t
      left join "user" u on u.id = t.peer
      left join contact k on k.user_id = ${me} and k.peer = t.peer
      order by t.time desc`);
    return c.json(list.map((t) => ({
      address: t.address ?? (t.mine ? t.to_address : t.from_address), name: t.name ?? '',
      state: t.state === 'blocked' ? 'blocked' : t.state === 'accepted' ? 'contact' : 'request',
      unread: t.unread, last: {type: t.type, body: t.body, mine: t.mine, time: t.time},
    })));
  });

  v1.get('/inbox/threads/:address', async (c) => {
    const me = c.get('userId');
    const to = await resolve(c.req.param('address'));
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    const list = await db.select().from(message)
      .where(or(and(eq(message.from, me), eq(message.to, to.userId)), and(eq(message.from, to.userId), eq(message.to, me))))
      .orderBy(sql`${message.createdAt} desc`).limit(200) as (typeof message.$inferSelect)[];
    const rel = await relation(me, to.userId);
    return c.json({address: to.address, state: rel.mine === 'blocked' ? 'blocked' : rel.mine === 'accepted' ? 'contact' : 'request', mutual: rel.mine === 'accepted' && rel.theirs === 'accepted',
      messages: list.reverse().map((m) => ({id: m.id, mine: m.from === me, type: m.type, target: m.target, body: m.body, time: m.createdAt.getTime(), read: Boolean(m.readAt)}))});
  });

  v1.post('/inbox/threads/:address/read', async (c) => {
    const me = c.get('userId');
    const to = await resolve(c.req.param('address'));
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    await db.update(message).set({readAt: sql`now()`}).where(and(eq(message.to, me), eq(message.from, to.userId), isNull(message.readAt)));
    return c.json({read: true});
  });

  // Accept someone (their requests become a conversation), block them, or neither: each side says its own.
  v1.post('/inbox/contacts', async (c) => {
    const me = c.get('userId');
    const b = await body<{address?: unknown; state?: unknown}>(c);
    const to = await resolve(typeof b?.address === 'string' ? b.address : '');
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    const state = b?.state === 'blocked' ? 'blocked' : b?.state === 'none' ? null : 'accepted';
    if (!state) await db.delete(contact).where(and(eq(contact.userId, me), eq(contact.peer, to.userId)));
    else await db.insert(contact).values({userId: me, peer: to.userId, state}).onConflictDoUpdate({target: [contact.userId, contact.peer], set: {state}});
    if (state === 'accepted') await cameIn(me, to.userId);
    return c.json({address: to.address, state: state ?? 'none'});
  });

  // ---- WebRTC signalling: contacts both ways, small, short-lived ----

  v1.post('/inbox/signals', async (c) => {
    const me = c.get('userId');
    const b = await body<{to?: unknown; session?: unknown; kind?: unknown; data?: unknown}>(c);
    const to = await resolve(typeof b?.to === 'string' ? b.to : '');
    if (!('userId' in to)) return c.json({error: to.why}, 404);
    const rel = await relation(me, to.userId);
    if (rel.mine !== 'accepted' || rel.theirs !== 'accepted') return c.json({error: 'Live chat is between accepted contacts'}, 403);
    const data = typeof b?.data === 'string' ? b.data : '';
    if (!['offer', 'answer', 'candidate', 'bye'].includes(String(b?.kind)) || data.length > INBOX.signal || typeof b?.session !== 'string' || b.session.length > 64) return c.json({error: 'a signal'}, 400);
    const [{n}] = await db.select({n: sql<number>`count(*)::int`}).from(signal).where(and(eq(signal.from, me), gt(signal.createdAt, new Date(Date.now() - 60_000))));
    if (n >= INBOX.signalsPerMinute) return c.json({error: 'too many'}, 429);
    await db.insert(signal).values({id: crypto.randomUUID(), to: to.userId, from: me, session: b.session, kind: String(b.kind), data});
    return c.json({sent: true}, 201);
  });

  // What has come from one person, taken once: their offers (a line not begun yet), and the rest
  // of the one session asked for. Another chat, or another device's session, keeps its own.
  v1.get('/inbox/signals', async (c) => {
    const me = c.get('userId');
    const from = await resolve(c.req.query('from') ?? '');
    if (!('userId' in from)) return c.json({error: from.why}, 404);
    const session = c.req.query('session') ?? '';
    const taken = await db.delete(signal).where(and(eq(signal.to, me), eq(signal.from, from.userId), gt(signal.createdAt, new Date(Date.now() - INBOX.signalLife)),
      session ? or(eq(signal.kind, 'offer'), eq(signal.session, session)) : eq(signal.kind, 'offer'))).returning() as (typeof signal.$inferSelect)[];
    return c.json(taken.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({from: from.address, session: r.session, kind: r.kind, data: r.data, time: r.createdAt.getTime()})));
  });
}
