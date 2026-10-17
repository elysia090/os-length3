// What every part of the Remote's HTTP surface shares: who is asking, how a
// body is read, how a refusal ends a request (and undoes the transaction it
// is in), and the lock that makes a check and the write it guards one step.

import {getTableName, sql, type Column, type SQL} from 'drizzle-orm';
import type {Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {ContentfulStatusCode} from 'hono/utils/http-status';

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

/** A moment as milliseconds since the epoch, as clients read them. */
export const ms = (moment: SQL) => sql<number>`(extract(epoch from ${moment}) * 1000)::float8`;

/** A span of milliseconds as Postgres counts it, in days (KEPT, HOLD, REMEMBERED). */
export const days = (span: number) => sql.raw(`interval '${span / 86_400_000} days'`);

/**
 * A column named with its table, always. Inside a subquery an outer column
 * must say whose it is: Drizzle may write a one-table select's column bare,
 * and a column of the same name in the subquery's own table would answer.
 */
export const qualified = (c: Column) => sql`${sql.identifier(getTableName(c.table))}.${sql.identifier(c.name)}`;

/** The rows a raw query returned, whichever driver ran it. */
export const rows = async <T>(q: Db, query: SQL): Promise<T[]> => (await q.execute(query)).rows as T[];
