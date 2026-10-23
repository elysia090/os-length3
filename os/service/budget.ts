// What the Remote may spend, and the counting that keeps it there: checked before R2 or Postgres is asked,
// never found out from the bill afterwards. Each figure is a deployment's (wrangler.toml [vars]); unsaid, it is
// within what Cloudflare and Neon give free.
//
//   R2      the bytes it holds (blobs, release files)          R2_STORED_MB      8192
//           its puts in a month (class A)                      R2_WRITES_MONTH   900000
//           its gets and heads in a month (class B)            R2_READS_MONTH    9000000
//           what one account uploads in a day                  UPLOAD_MB_DAY     512
//   Neon    the database's size, past which only reads and     PG_MB             450
//           deletes are taken
//
// What is counted is rows of `usage` (schema.ts). A put is counted in the transaction that names its blob, so
// one undone is not counted; reads are taken a few at a time by each Worker isolate, so most reads ask the
// database nothing (what an isolate had left when it went counts as spent: the count only ever runs ahead).
// Deletes cost R2 nothing and are never refused: they are how room comes back.

import {sql} from 'drizzle-orm';
import {NO_FILES, type Bucket} from './bucket.ts';
import {refuse, rows, slowDown, type Db} from './request.ts';

const MB = 1024 ** 2;

export interface Limits {
  /** Bytes R2 may hold, blobs and release files together. */
  stored: number;
  /** R2 puts in a calendar month (UTC). */
  writes: number;
  /** R2 gets and heads in a calendar month (UTC). */
  reads: number;
  /** Bytes one account may upload in a day (UTC). */
  upload: number;
  /** Bytes the database may take; past them, what would add to it is refused. */
  database: number;
}

export const LIMITS: Limits = {stored: 8192 * MB, writes: 900_000, reads: 9_000_000, upload: 512 * MB, database: 450 * MB};

/** A deployment's limits, from its variables; one not given (or not a number above nothing) is LIMITS's. */
export function limitsOf(env: Record<string, string | undefined>): Limits {
  const n = (v: string | undefined, d: number, unit = 1) => (v && Number(v) > 0 ? Number(v) * unit : d);
  return {stored: n(env.R2_STORED_MB, LIMITS.stored, MB), writes: n(env.R2_WRITES_MONTH, LIMITS.writes),
    reads: n(env.R2_READS_MONTH, LIMITS.reads), upload: n(env.UPLOAD_MB_DAY, LIMITS.upload, MB), database: n(env.PG_MB, LIMITS.database, MB)};
}

export const month = (now: number) => new Date(now).toISOString().slice(0, 7);
export const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Seconds until the month after `now` (UTC) begins, or the day after. */
const untilNext = (now: number, unit: 'month' | 'day') => {
  const d = new Date(now);
  const next = unit === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return (next - now) / 1000;
};

/** `n` more of `kind` in `period`, if that stays within `cap`: one statement; false (and nothing counted) when it would not. */
export async function take(q: Db, period: string, kind: string, n: number, cap: number): Promise<boolean> {
  if (n > cap) return false;
  const r = await rows<{n: number}>(q, sql`insert into usage (period, kind, n) values (${period}, ${kind}, ${n})
    on conflict (period, kind) do update set n = usage.n + excluded.n where usage.n + excluded.n <= ${cap} returning n`);
  return r.length > 0;
}

/** How many of `kind` in `period` there are. */
export async function spent(q: Db, period: string, kind: string): Promise<number> {
  const [r] = await rows<{n: number}>(q, sql`select n from usage where period = ${period} and kind = ${kind}`);
  return Number(r?.n ?? 0);
}

/** R2 is out of what it may do this month: no file moves until the next, and the work stays on the device. */
const spentFor = (now: number): never => refuse(503, {...NO_FILES, budget: true}, {'Retry-After': String(Math.ceil(untilNext(now, 'month')))});

/** Reads an isolate takes at once: one statement in so many reads. */
const READS_AT_ONCE = 64;

/** The Remote's budget: what it spends of R2 and of its database, counted before either is asked. */
export class Budget {
  private period = '';
  private reads = 0;
  private refill: Promise<void> | null = null;
  private sized: {at: number; full: boolean} | null = null;
  readonly limits: Limits;
  private now: () => number;
  constructor(limits: Limits, now: () => number = Date.now) { this.limits = limits; this.now = now; }

  /**
   * `n` R2 reads, or refused (503, no files) when the month has had all it may. Reads asked at once wait for one
   * refill (never one each: 64 asked together are 64, not 64 × 64); `n` of 64 and more are taken as they are.
   */
  async read(q: Db, n = 1) {
    const now = this.now(), p = month(now);
    if (p !== this.period) { this.period = p; this.reads = 0; }
    if (this.reads >= n) { this.reads -= n; return; }
    if (n < READS_AT_ONCE) {
      this.refill ??= take(q, p, 'r2:b', READS_AT_ONCE, this.limits.reads)
        .then((ok) => { if (ok && this.period === p) this.reads += READS_AT_ONCE; })
        .finally(() => { this.refill = null; });
      await this.refill;
      if (this.reads >= n) { this.reads -= n; return; }
    }
    // Near the end of the month's reads (or many at once), only what is asked for.
    if (await take(q, p, 'r2:b', n, this.limits.reads)) return;
    spentFor(now);
  }

  /** One R2 put, counted in `q` (the transaction that names what is put, so one undone is not counted). */
  async write(q: Db) {
    const now = this.now();
    if (!await take(q, month(now), 'r2:a', 1, this.limits.writes)) spentFor(now);
  }

  /**
   * Refused as `upload` and `held` would refuse, asked before the bytes are put (nothing counted): what an account
   * may not send is never put in R2 at all, so a refusal leaves no bytes behind but in a race of uploads at once.
   */
  async ahead(q: Db, user: string, bytes: number) {
    const now = this.now();
    if (await spent(q, day(now), `up:${user}`) + bytes > this.limits.upload) {
      slowDown(untilNext(now, 'day'), {error: 'This account has sent all it may today; the rest is sent tomorrow'});
    }
    if (await spent(q, 'all', 'r2:stored') + bytes > this.limits.stored) {
      refuse(507, {error: 'The Remote holds all the files it may just now; your work stays on this device', files: false, budget: true});
    }
  }

  /** `bytes` more uploaded by `user` today, or refused until tomorrow (429). In `q`, the upload's transaction. */
  async upload(q: Db, user: string, bytes: number) {
    const now = this.now();
    if (!await take(q, day(now), `up:${user}`, bytes, this.limits.upload)) {
      slowDown(untilNext(now, 'day'), {error: 'This account has sent all it may today; the rest is sent tomorrow'});
    }
  }

  /**
   * Refused (507, no files) when R2 would hold more than it may, asked once the row that names the bytes is in:
   * its trigger has counted them (usage_stored, 0011) with the count's row locked, so uploads of other accounts
   * at once are counted one after another and cannot pass the limit together. In `q`, the upload's transaction.
   */
  async held(q: Db) {
    if (await spent(q, 'all', 'r2:stored') > this.limits.stored) {
      refuse(507, {error: 'The Remote holds all the files it may just now; your work stays on this device', files: false, budget: true});
    }
  }

  /**
   * Whether the database has taken all it may, as asked of it at most every five minutes by this isolate:
   * its size is its own to say (pg_database_size), and a write more or less between asks is no matter.
   */
  async full(q: Db): Promise<boolean> {
    const now = this.now();
    if (this.sized && now - this.sized.at < 300_000) return this.sized.full;
    const [r] = await rows<{bytes: number}>(q, sql`select pg_database_size(current_database())::float8 as bytes`);
    this.sized = {at: now, full: Number(r?.bytes ?? 0) >= this.limits.database};
    return this.sized.full;
  }
}

/** What R2 holds, counted again from the rows that name its bytes (the sweep, each day): a count that drifted is put right. */
export async function recount(q: Db): Promise<boolean> {
  const r = await rows(q, sql`insert into usage (period, kind, n)
      select 'all', 'r2:stored', (select coalesce(sum(bytes), 0) from blob) + (select coalesce(sum(bytes), 0) from release_file)
    on conflict (period, kind) do update set n = excluded.n where usage.n <> excluded.n returning 1`);
  return r.length > 0;
}

/**
 * A bucket whose every read is counted first (Budget.read), so none is asked of R2 past the month's. A put is
 * counted by its caller in the transaction it is part of (Budget.write: files.ts), and a delete is free.
 */
export function metered(bucket: Bucket, budget: Budget, db: Db): Bucket {
  return {
    async get(k) { await budget.read(db); return bucket.get(k); },
    async put(k, b) { return bucket.put(k, b); },
    async size(k) { await budget.read(db); return bucket.size(k); },
    async read(k, start, end) { await budget.read(db); return bucket.read(k, start, end); },
    async delete(keys) { return bucket.delete(keys); },
  };
}
