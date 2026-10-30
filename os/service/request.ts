// What every part of the Remote's HTTP surface shares: who is asking, how a
// body is read and how large it may be, how a refusal ends a request (and
// undoes the transaction it is in), the lock that makes a check and the
// write it guards one step, and the room an account may fill. Who may ask at
// all (a session) is auth.ts's signedIn.

import {eq, getTableColumns, getTableName, sql, type Column, type SQL} from 'drizzle-orm';
import type {PgTable} from 'drizzle-orm/pg-core';
import type {Context, ErrorHandler, MiddlewareHandler} from 'hono';
import {StoreFailed} from './bucket.ts';
import {bodyLimit} from 'hono/body-limit';
import {cors} from 'hono/cors';
import type {PgDatabase, PgQueryResultHKT} from 'drizzle-orm/pg-core';
import {HTTPException} from 'hono/http-exception';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import {room, throttle} from './schema.ts';

/** A Drizzle database or transaction of any Postgres driver (Neon in production, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Who is asking: their account, this session, their name as it is now, and when this session ends (ms). */
export type Vars = {Variables: {userId: string; sessionId: string; name: string; sessionEnds: number}};

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
export function refuse(status: ContentfulStatusCode, answer: Record<string, unknown>, headers?: Record<string, string>): never {
  throw new HTTPException(status, {res: Response.json(answer, {status, headers})});
}

/**
 * Asked too often: 429, `Retry-After` the seconds until the window that counted it has passed, and
 * the same seconds as `retryAfter` beside the words, every time a rate is what refused (RFC 6585 §4,
 * RFC 9110 §10.2.3). A limit on how many of a thing are kept (repos, boards) is not a rate: it
 * passes with no waiting, so it says no time.
 */
export function slowDown(seconds: number, answer: {error: string}): never {
  const s = Math.max(1, Math.ceil(seconds));
  refuse(429, {...answer, retryAfter: s}, {'Retry-After': String(s)});
}

/** The address Cloudflare saw the request come from; '' where nothing in front of the Remote says (dev, tests). */
export const addressOf = (c: Context) => c.req.header('CF-Connecting-IP') ?? '';

/**
 * One more of `key` in the window, or refused (slowDown) when `max` were there already; nothing is
 * counted for a refused one. The key's lock makes the count and the row one step, so many at once
 * are counted one by one (audit V2). Rows go with the daily sweep (throttle, an hour and more old).
 */
export async function throttled(q: Db, key: string, max: number, windowMs: number, answer: {error: string}) {
  await q.transaction(async (tx: Db) => {
    await lock(tx, key);
    if (await insertWhere(tx, throttle, {key}, sql`(select count(*) from throttle t where t.key = ${key} and t.at > ${ago(windowMs)}) < ${max}`)) return;
    const [r] = await rows<{first: number | null}>(tx, sql`select ${ms(sql`min(at)`)} as first from throttle where key = ${key} and at > ${ago(windowMs)}`);
    slowDown(((r?.first ?? Date.now()) + windowMs - Date.now()) / 1000, answer);
  });
}

/**
 * Write `values` into `table` only `when` holds (most often: fewer like it than the most there may be), the check and
 * the write one statement: a guarded write is its lock and this, not its lock, a count and the insert. Each statement
 * of a transaction sees what was committed before it began, so under the lock the check counts every write before
 * it. Whether it was written; why not is the caller's to read again, on that rarer path.
 */
export async function insertWhere(q: Db, table: PgTable, values: Record<string, unknown>, when: SQL): Promise<boolean> {
  const cols = getTableColumns(table);
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const names = sql.join(keys.map((k) => sql.identifier(cols[k].name)), sql`, `);
  const given = sql.join(keys.map((k) => sql`${values[k] === null ? null : cols[k].mapToDriverValue(values[k])}`), sql`, `);
  return (await rows(q, sql`insert into ${table} (${names}) select ${given} where ${when} returning 1`)).length > 0;
}

/**
 * Writes that are checked against what is already there (an account's room,
 * how many of a thing it has, how often something was asked) take the same
 * key's lock first, so two at once cannot both pass the check. Held until
 * the transaction ends.
 */
/**
 * Whether If-None-Match names `tag` ("…"): one of a list, weak or strong (RFC 9110 §13.1.2 compares weakly for
 * it), or `*`. Before, only the exact one tag was, and a browser's W/"…" or a list read the file again.
 */
export function unchanged(c: Context, tag: string): boolean {
  const asked = c.req.header('If-None-Match');
  if (!asked) return false;
  return asked.split(',').some((t) => { const x = t.trim(); return x === '*' || x.replace(/^W\//, '') === tag; });
}

/** A UUID as the database keeps one (lower case). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
export const rows = async <T>(q: Db, query: SQL): Promise<T[]> => ((await q.execute(query)) as {rows: T[]}).rows;

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
  fitting(r?.used ?? 0, more, quota);
}
/** As fits, with the room `used` read already (with the row it was read with: one round trip fewer). */
export function fitting(used: number, more: number, quota = QUOTA) {
  if (more > 0 && used + more > quota) refuse(507, {error: 'The Remote is full for this account', used, quota});
}
/** The room an account's rows and files take, for a select that reads it with them (fitting). */
export const usedBy = (user: string) => sql<number>`coalesce((select r.used from room r where r.user_id = ${user}), 0)::float8`;

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- what every request passes through (app.ts uses them, in this order) ----

/** Only the app's own pages may call from a browser; a passkey's challenge is a cookie between asking and answering. */
export const fromOrigins = (origins: string[]) => cors({
  origin: (o) => (origins.includes(o) ? o : null),
  // If-None-Match: a look's tag (mark.ts), from the desktop app's webview too.
  allowHeaders: ['Authorization', 'Content-Type', 'X-Guest', 'If-None-Match'],
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // The bearer plugin hands a new session's token back in this header; a look's answer, its tag (ETag).
  exposeHeaders: ['set-auth-token', 'ETag'],
  credentials: true,
  maxAge: 600,
});

/**
 * What the Remote answers is data, never a page: no document may run it, frame it or be sent on
 * from it (a JSON answer opened as a page in a tab runs nothing, embeds nothing, posts nowhere).
 * A route that answers a page of its own (the stand-in provider's, devoauth.ts) says its own policy.
 */
export const API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Nothing the Remote answers is kept by a cache (but what a route says may be kept: a file named by
 * its digest or its pinned name, files.ts), read as another type than it says, framed, taken by
 * another site's page as a resource, or reached again but by HTTPS; and a link followed from it
 * says nothing of where it came from (OWASP ASVS 14.4; the app's own files: public/_headers).
 */
export const unkept: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', API_POLICY);
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
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
/** Postgres's word that a value is not one it keeps: text it cannot hold, a number out of range or a bad one, too long, a check refused. */
const INPUT = new Set(['22021', '22P05', '22P02', '22003', '22001', '23514']);
const codeOf = (e: unknown): string => {
  for (let x = e as {code?: unknown; cause?: unknown; message?: unknown} | undefined, i = 0; x && i < 4; x = x.cause as typeof x, i++) {
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) return x.code;
    // The pool's own words for a database not reached or gone (no SQLSTATE: it never answered): class 08.
    if (typeof x.message === 'string' && /timeout exceeded when trying to connect|Connection terminated|connection (was )?closed|ECONNREFUSED|ECONNRESET/i.test(x.message)) return '08000';
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
  if (BUSY.has(code) || code.startsWith('08') || e instanceof StoreFailed) {
    c.header('Retry-After', '5');
    return c.json({error: 'The Remote is busy just now; try again', id, retryAfter: 5}, 503);
  }
  // What was sent is no text, number or value the database keeps (a NUL, a lone surrogate, a number out of range, a
  // check refused): the request's, not the Remote's, wherever a route did not say so first.
  if (INPUT.has(code)) return c.json({error: 'What was sent is not something the Remote keeps', id}, 400);
  return c.json({error: 'Something went wrong on the Remote', id}, 500);
};
