// What the Remote answers without its database: whether anything a look reads was written since the look before.
//
// Neon sleeps once nothing has asked it anything for five minutes, and a query wakes it for five more. What asked
// it on a timer, whether or not anyone was doing anything, kept it awake: a page left open looks every few seconds
// for what moved and what came (GET /v1/moved, /v1/news; a conversation's rows, a board's posts and TODO while they
// are on screen), and a device whose SSH is on asks every 30 s whether it still is (POST /v1/ssh/this/beat), each
// with its session looked up first. One window left open, or one device listening, was a database awake all day.
//
// The mark is a number kept outside the database (a Durable Object on Workers, MarkObject; this process's memory in
// dev.ts) that moves after every request that writes, but those that write nothing a look reads (STILL), and after
// the sweep. An answer to a look carries a tag (its ETag; the beat's, `tag` in its JSON) that says, signed with a
// key of its own (keys.ts `mark`), what was asked, by which bearer token, at which mark, and until when it holds.
// Asked again with it (If-None-Match; the beat's body), while the mark has not moved, the answer is 304 (a beat:
// {on: true}) and nothing else is asked: not the database, not the session. Only a bearer token is taken so (a
// browser's cookie is not: no page elsewhere can send a tag, but nothing is answered for a cookie unlooked-up).
//
// What a tag cannot know it is not taken past: it holds until the next six hours of UTC (0, 6, 12, 18 h) and never
// past its session's end, so what changed outside any request (an operator's SQL, a session ended in the database)
// is seen by then; a session ended through the Remote (sign-out, a device ended) is a write and moves the mark at
// once. The page asks without its tags when its window comes back (remote.ts). One mark for the whole Remote: a
// write by anyone has every look read again once, which is what a database awake for that write costs anyway.

import type {Context, MiddlewareHandler} from 'hono';
import {credentialOf} from './auth.ts';
import {same} from './keys.ts';
import {body, type Vars} from './request.ts';

export interface Marks {
  /** The mark now; with `beat`, also that this session's device was heard just now, when `tag` is the one it was given. */
  now(beat?: {session: string; tag: string}): Promise<string>;
  /** Something was written: the mark moves. */
  move(): Promise<void>;
  /** The tag a session's beat was given (a beat answered by the mark counts as heard only with it). */
  gave(session: string, tag: string): Promise<void>;
  /** When each of `sessions`' devices was last heard by a beat answered by the mark (ms); those never heard so, absent. */
  heard(sessions: string[]): Promise<Record<string, number>>;
  /** What was heard before `before` is let go (the sweep). */
  forget(before: number): Promise<void>;
}

const random = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The mark in this process (dev.ts, the tests): a Remote that is one process. */
export function memoryMarks(): Marks & {moves: () => number} {
  const epoch = random();
  let n = 0;
  const beats = new Map<string, {tag: string; at: number}>();
  return {
    moves: () => n,
    async now(beat) {
      const b = beat && beats.get(beat.session);
      if (b && beat && same(b.tag, beat.tag)) b.at = Date.now();
      return `${epoch}.${n}`;
    },
    async move() { n++; },
    async gave(session, tag) { beats.set(session, {tag, at: Date.now()}); },
    async heard(sessions) { return Object.fromEntries(sessions.flatMap((s) => { const b = beats.get(s); return b ? [[s, b.at]] : []; })); },
    async forget(before) { for (const [s, b] of beats) if (b.at < before) beats.delete(s); },
  };
}

// ---- on Workers: a Durable Object of its own, one for the Remote ----

interface ObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(o: {prefix: string; limit?: number; startAfter?: string}): Promise<Map<string, T>>;
}
interface ObjectState { storage: ObjectStorage; blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> }

/**
 * The mark on Workers (wrangler.toml MARK): its number kept in the object's storage, so an object started again
 * (evicted while nothing asked it) goes on from it, and a new one (none kept) starts from a new epoch, so no tag
 * given before it can match. The beats it heard are kept beside it, each with the tag its session was given.
 */
export class MarkObject {
  private state: ObjectState;
  private mark = '';
  private n = 0;
  private epoch = '';
  constructor(state: ObjectState) {
    this.state = state;
    void state.blockConcurrencyWhile(async () => {
      let epoch = await state.storage.get<string>('epoch');
      if (!epoch) { epoch = random(); await state.storage.put('epoch', epoch); }
      this.epoch = epoch;
      this.n = (await state.storage.get<number>('n')) ?? 0;
      this.mark = `${this.epoch}.${this.n}`;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url), s = this.state.storage;
    if (u.pathname === '/now') {
      const session = u.searchParams.get('session'), tag = u.searchParams.get('tag');
      if (session && tag) {
        const b = await s.get<{tag: string; at: number}>(`beat:${session}`);
        if (b && same(b.tag, tag)) await s.put(`beat:${session}`, {tag, at: Date.now()});
      }
      return new Response(this.mark);
    }
    if (req.method !== 'POST') return new Response('', {status: 405});
    if (u.pathname === '/move') {
      this.n++;
      this.mark = `${this.epoch}.${this.n}`;
      await s.put('n', this.n);
      return new Response(this.mark);
    }
    if (u.pathname === '/gave') {
      const {session, tag} = await req.json() as {session: string; tag: string};
      await s.put(`beat:${session}`, {tag, at: Date.now()});
      return new Response('');
    }
    if (u.pathname === '/heard') {
      const ids = ((await req.json()) as string[]).slice(0, 128);
      const got = ids.length ? await s.get<{tag: string; at: number}>(ids.map((id) => `beat:${id}`)) : new Map<string, {tag: string; at: number}>();
      return Response.json(Object.fromEntries([...got].map(([k, v]) => [k.slice(5), v.at])));
    }
    if (u.pathname === '/forget') {
      const before = Number(u.searchParams.get('before'));
      let after: string | undefined;
      for (;;) {
        const page = await s.list<{at: number}>({prefix: 'beat:', limit: 500, ...(after ? {startAfter: after} : {})});
        if (!page.size) break;
        const old = [...page].filter(([, v]) => v.at < before).map(([k]) => k);
        if (old.length) await s.delete(old);
        after = [...page.keys()].pop();
        if (page.size < 500) break;
      }
      return new Response('');
    }
    return new Response('', {status: 404});
  }
}

/** What the Worker is given for MARK: a Durable Object namespace, as much of it as is used. */
export interface MarkNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {fetch(input: string, init?: RequestInit): Promise<Response>};
}

/** The mark through its Durable Object; one that does not answer in `wait` ms is as if it were not there. */
export function objectMarks(ns: MarkNamespace, wait = 3000): Marks {
  const ask = async (path: string, init: RequestInit = {}) => {
    const r = await ns.get(ns.idFromName('remote')).fetch(`https://mark${path}`, {...init, signal: AbortSignal.timeout(wait)});
    if (!r.ok) throw new Error(`the mark answered ${r.status}`);
    return r;
  };
  const post = (path: string, value?: unknown) => ask(path, {method: 'POST', ...(value === undefined ? {} : {body: JSON.stringify(value)})});
  return {
    now: async (beat) => (await ask(`/now${beat ? `?${new URLSearchParams({session: beat.session, tag: beat.tag})}` : ''}`)).text(),
    // Asked twice before it is given up: a move missed leaves looks answered from before it until their tags end.
    move: async () => { await post('/move').catch(() => post('/move')); },
    gave: async (session, tag) => { await post('/gave', {session, tag}); },
    heard: async (sessions) => (sessions.length ? await (await post('/heard', sessions)).json() as Record<string, number> : {}),
    forget: async (before) => { await post(`/forget?before=${before}`); },
  };
}

// ---- tags, and the requests that move the mark or are answered by it ----

/** The looks answered by the mark: what the app asks every little while. */
const LOOKS = /^\/v1\/(moved|news|inbox\/threads|boards\/[^/]+\/(posts|todos))$/;
const BEAT = '/v1/ssh/this/beat';
/**
 * Writes that write nothing a look reads, which do not move it: a beat (when a device was heard), the live line's
 * signals, a file's bytes (a draft names them, and moves it), a device's sign-in polling for its session.
 */
const STILL = /^\/(v1\/ssh\/this\/beat|v1\/inbox\/signals(\/take)?|v1\/blobs\/(missing|read|[0-9a-f]{64})|api\/auth\/device\/(code|token))$/;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** How long a tag holds at most: until the next of these, counted from midnight UTC. */
const SPAN = 6 * 3600_000;
/** Until when a tag given at `now` holds: the next six hours of UTC, and never past `ends` (its session's end). */
export const tagUntil = (now: number, ends = Infinity) => Math.min(Math.floor(now / SPAN) * SPAN + SPAN, ends);

const keys = new Map<string, Promise<CryptoKey>>();
/** A tag's signature: 32 hex digits of HMAC-SHA256 under the mark's own key. */
async function sign(key: string, parts: string[]): Promise<string> {
  let k = keys.get(key);
  if (!k) { k = crypto.subtle.importKey('raw', new TextEncoder().encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']); keys.set(key, k); }
  const d = new Uint8Array(await crypto.subtle.sign('HMAC', await k, new TextEncoder().encode(parts.join('\n'))));
  return [...d.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A tag as sent back: until (base 36), the session (a beat's; else empty), the signature. */
const TAG = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{0,64})\.([0-9a-f]{32})$/;
const tagOf = (s: string) => { const m = TAG.exec(s); return m ? {until: parseInt(m[1], 36), session: m[2], mac: m[3]} : null; };

/** `p` after the answer is sent (the Worker's waitUntil), or before it where nothing outlives a request (dev, tests). */
async function later(c: Context, p: Promise<unknown>) {
  let ctx: {waitUntil(p: Promise<unknown>): void} | undefined;
  try { ctx = c.executionCtx; } catch { /* none here */ }
  if (ctx) ctx.waitUntil(p); else await p;
}

/**
 * Every request: one that writes moves the mark once it is answered (but STILL); a look with a tag still good is
 * answered here; a look answered by the routes gets its tag. Without the mark (a Remote with no MARK), nothing.
 */
export function marked(d: {marks: Marks; key: string}): MiddlewareHandler<Vars> {
  const moved = (c: Context) => later(c, d.marks.move().catch((e: unknown) => console.error('the mark did not move', e)));
  return async (c, next) => {
    const method = c.req.method, path = c.req.path;
    const beat = method === 'POST' && path === BEAT;
    if (!beat && !(method === 'GET' && LOOKS.test(path))) {
      await next();
      if (!SAFE.has(method) && !STILL.test(path)) await moved(c);
      return;
    }
    const cred = credentialOf(c.req.raw.headers);
    if (cred?.kind !== 'bearer') return next();
    const said = beat ? await body<{tag?: unknown; scope?: unknown}>(c) : null;
    const what = beat ? `${method} ${path} ${typeof said?.scope === 'string' ? said.scope : ''}` : `${method} ${path}${new URL(c.req.url).search}`;
    const asked = beat ? (typeof said?.tag === 'string' ? said.tag : '')
      : (c.req.header('If-None-Match') ?? '').split(',')[0].trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
    const now = Date.now();
    const t = tagOf(asked);
    const good = t && t.until > now ? t : null;
    let mark: string;
    try { mark = await d.marks.now(beat && good ? {session: good.session, tag: asked} : undefined); } catch (e) {
      // Not answered: the look is answered by the routes, as without the mark, and given no tag.
      console.error('the mark did not answer', e);
      return next();
    }
    if (good && same(good.mac, await sign(d.key, [what, cred.key, mark, String(good.until), good.session]))) {
      return beat ? c.json({on: true, tag: asked}) : c.body(null, 304, {ETag: `"${asked}"`});
    }
    await next();
    if (c.res.status !== 200) return;
    const session = beat ? c.get('sessionId') ?? '' : '';
    const until = tagUntil(now, c.get('sessionEnds'));
    const tag = `${until.toString(36)}.${session}.${await sign(d.key, [what, cred.key, mark, String(until), session])}`;
    if (!beat) { c.header('ETag', `"${tag}"`); return; }
    const answer = await c.res.clone().json().catch(() => null) as {on?: unknown} | null;
    if (answer?.on !== true || !session) return;
    c.res = c.json({...answer, tag});
    await later(c, d.marks.gave(session, tag).catch((e: unknown) => console.error('the mark did not keep a beat\'s tag', e)));
  };
}
