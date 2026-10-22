// What every part of the Remote's HTTP surface shares: who is asking, how a
// body is read and how large it may be, how a refusal ends a request (and
// undoes the transaction it is in), the lock that makes a check and the
// write it guards one step, and the room an account may fill. Who may ask at
// all (a session) is auth.ts's signedIn.

import {eq, getTableName, sql, type Column, type SQL} from 'drizzle-orm';
import type {Context, ErrorHandler, MiddlewareHandler} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {cors} from 'hono/cors';
import {HTTPException} from 'hono/http-exception';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import {room} from './schema.ts';

/** A Drizzle database or transaction of any Postgres driver (Neon in production, PGlite in tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

/** Who is asking: their account, this session, and their name as it is now. */
export type Vars = {Variables: {userId: string; sessionId: string; name: string}};

/**
 * The body, if it was sent as JSON; else null. A form or a text body is not
 * read as JSON: a page elsewhere can make a browser send those unasked.
 */
export async function body<T = Record<string, unknown>>(c: Context): Promise<T | null> {
  if (!/^application\/json\b/i.test(c.req.header('Content-Type') ?? '')) return null;
  // A body that does not parse is no body: the route answers that it lacks one (400).
  const v: unknown = await c.req.json().catch(() => null);
  return v !== null && typeof v === 'object' ? v as T : null;
}

/** End the request with `status` and `answer`. Thrown inside a transaction, nothing it wrote stays. */
export function refuse(status: ContentfulStatusCode, answer: Record<string, unknown>): never {
  throw new HTTPException(status, {res: Response.json(answer, {status})});
}

/**
 * Writes that are checked against what is already there (an account's room,
 * how many of a thing it has, how often something was asked) take the same
 * key's lock first, so two at once cannot both pass the check. Held until
 * the transaction ends.
 */
export const lock = (tx: Db, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

/**
 * A moment as whole milliseconds since the epoch, as clients read them. Postgres keeps microseconds:
 * unfloored, a moment made by now() reads as 1792307357528.123, which core and l3 refuse (a u64).
 */
export const ms = (moment: SQL) => sql<number>`floor(extract(epoch from ${moment}) * 1000)::float8`;

/** That many milliseconds before now, as Postgres reads it (`at > ${ago(KEPT)}`): a parameter, never text in the query. */
export const ago = (span: number) => sql`(now() - make_interval(secs => ${span / 1000}))`;

/**
 * A column named with its table, always. Inside a subquery an outer column
 * must say whose it is: Drizzle may write a one-table select's column bare,
 * and a column of the same name in the subquery's own table would answer.
 */
export const qualified = (c: Column) => sql`${sql.identifier(getTableName(c.table))}.${sql.identifier(c.name)}`;

/** The rows a raw query returned, whichever driver ran it. */
export const rows = async <T>(q: Db, query: SQL): Promise<T[]> => (await q.execute(query)).rows as T[];

// ---- limits ----

export const HEX = /^[0-9a-f]{64}$/;
export const LIMIT = {blob: 16 << 20, files: 20_000, diff: 5_000, words: 2_000, log: 200,
  /** A tree as JSON: what one request parses and writes whole (20,000 entries of 400 characters). */
  tree: 8 << 20,
  /** Settings: so many keys, each so long. */
  homeKeys: 8, home: 1 << 20,
  /** Repos an account has, lines of work a repo has (besides main). */
  repos: 200, lines: 100,
  /** Reviews a change keeps; lines one review marks, and how much they say in all. */
  reviews: 50, marks: 200, markChars: 32 * 1024,
  /** A request's body: a draft's diff or a setting at most as large as a file may be, anything else a little. */
  body: 16 << 20, request: 1 << 20};

/** How large a body `method` `path` may send: a file, a draft's diff and a setting are large, nothing else is. */
export function roomFor(method: string, path: string): number {
  if (method === 'PUT' && /^\/v1\/blobs\/[^/]+$/.test(path)) return LIMIT.blob;
  if ((method === 'PATCH' && /^\/v1\/repos\/[^/]+\/draft$/.test(path)) || (method === 'PUT' && /^\/v1\/home\/[^/]+$/.test(path))) return LIMIT.body;
  return LIMIT.request;
}

/** What one account may keep, unless the deployment says otherwise. */
const QUOTA = 2 * 1024 ** 3;

/**
 * Refused (507) unless `more` bytes fit in what the account may keep: its blobs, and the trees its
 * drafts and commits hold and its reviews, as counted in its room. The caller holds the account's lock.
 */
export async function fits(q: Db, user: string, more: number, quota = QUOTA) {
  if (more <= 0) return;
  const [r] = await q.select({used: room.used}).from(room).where(eq(room.userId, user)) as {used: number}[];
  const used = r?.used ?? 0;
  if (used + more > quota) refuse(507, {error: 'The Remote is full for this account', used, quota});
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- what every request passes through (app.ts uses them, in this order) ----

/** Only the app's own pages may call from a browser; a passkey's challenge is a cookie between asking and answering. */
export const fromOrigins = (origins: string[]) => cors({
  origin: (o) => (origins.includes(o) ? o : null),
  allowHeaders: ['Authorization', 'Content-Type', 'X-Guest'],
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // The bearer plugin hands a new session's token back in this header.
  exposeHeaders: ['set-auth-token'],
  credentials: true,
  maxAge: 600,
});

/**
 * Nothing the Remote answers is kept by a cache, or read as another type than it says; but what a
 * route says may be kept is (a file named by its digest or its pinned name: files.ts).
 */
export const unkept: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
};

/**
 * A body is read whole before it is looked at, by anyone's request (signing in, a guest's invitation, a link's key):
 * none is read past what its route can take, counted as it comes, whatever it says its length is.
 */
export const bounded: MiddlewareHandler = (c, next) =>
  bodyLimit({maxSize: roomFor(c.req.method, c.req.path), onError: (c) => c.json({error: 'What was sent is too large'}, 413)})(c, next);

// ---- what fails unforeseen ----

/**
 * Postgres's word that the database could not do it just now, not that the request was wrong: a lock
 * or a statement out of time, a conflict to try again, too many connections, the server going away or
 * not reached (class 08).
 */
const BUSY = new Set(['55P03', '57014', '40001', '40P01', '53300', '57P01', '57P02', '57P03']);
const codeOf = (e: unknown): string => {
  for (let x = e as {code?: unknown; cause?: unknown} | undefined, i = 0; x && i < 4; x = x.cause as typeof x, i++) {
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) return x.code;
  }
  return '';
};

/**
 * Every answer is JSON with words, an unforeseen failure too (app.onError): a refusal (refuse()) is
 * its own answer; the database busy or out of reach is 503 with when to try again; anything else is
 * 500. Either says an id, which the log line beside it says too, and nothing of what failed.
 */
export const failed: ErrorHandler = (e, c) => {
  if (e instanceof HTTPException) return e.getResponse();
  const id = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const code = codeOf(e);
  console.error('remote failed', id, c.req.method, c.req.path, code, e);
  if (BUSY.has(code) || code.startsWith('08')) {
    c.header('Retry-After', '5');
    return c.json({error: 'The Remote is busy just now; try again', id}, 503);
  }
  return c.json({error: 'Something went wrong on the Remote', id}, 500);
};
