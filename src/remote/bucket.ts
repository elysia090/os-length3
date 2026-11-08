// Where file contents are kept: an object store with keys, as R2 is. The
// service writes each blob once, under a key that is its digest, so nothing
// here is ever overwritten in place; a blob no tree names any more is
// deleted (sweep.ts). What a release is (os/<sha256>, desktop/<file>) is put
// here by the deploy (mirror.ts) and only read by the service, a range at a
// time and as a stream, since it is larger than a Worker may hold.
//
// The bucket is the only thing the Remote needs besides its database, and
// only for bytes: a Remote with none bound (no R2 yet, `dev.ts --no-bucket`)
// does everything else, and each route that would move bytes answers
// `noFiles` instead (files.ts, seen.ts), so a client keeps its files where
// they are and says so.

import type {Context} from 'hono';

export interface Bucket {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The object's size in bytes; null when absent. */
  size(key: string): Promise<number | null>;
  /** Bytes [start, end] (both within the object), as they come; null when absent. */
  read(key: string, start: number, end: number): Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
  /** These objects gone (those already gone are no matter). */
  delete(keys: string[]): Promise<void>;
  /** Up to `limit` keys under `prefix` after `after`, in order, each with when it was put (ms); `next`, '' at the end. */
  list?(prefix: string, after: string, limit: number): Promise<{keys: {key: string; at: number}[]; next: string}>;
}

/** Where an account's blob is kept: one key per account and digest. */
export const blobKey = (user: string, sha: string) => `u/${user}/${sha}`;

/** What a Remote with no bucket says to a request that would move bytes: one answer, everywhere. */
export const NO_FILES = {error: 'Remote cannot store files right now', files: false} as const;
export const noFiles = (c: Context) => c.json(NO_FILES, 503);

export function memoryBucket(): Bucket & {keys(): string[]; at: Map<string, number>} {
  const m = new Map<string, Uint8Array>(), at = new Map<string, number>();
  return {
    keys: () => [...m.keys()],
    at,
    async get(k) { return m.get(k)?.slice() ?? null; },
    async put(k, b) { m.set(k, b.slice()); at.set(k, Date.now()); },
    async list(prefix, after, limit) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix) && k > after).sort().slice(0, limit);
      return {keys: keys.map((key) => ({key, at: at.get(key) ?? 0})), next: keys.length === limit ? keys[keys.length - 1] : ''};
    },
    async size(k) { return m.get(k)?.length ?? null; },
    async read(k, start, end) { return m.get(k)?.slice(start, end + 1) ?? null; },
    async delete(keys) { for (const k of keys) m.delete(k); },
  };
}

interface R2Object { key: string; size: number; uploaded: Date }
interface R2ObjectBody extends R2Object { body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> }
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: {range?: {offset: number; length?: number}}): Promise<R2ObjectBody | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(o: {prefix?: string; startAfter?: string; limit?: number}): Promise<{objects: R2Object[]; truncated: boolean}>;
}

/** R2 failed to do what it was asked (not the request's fault): 503 with when to try again (request.ts failed), never a 500. */
export class StoreFailed extends Error {}
const kept = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f(); } catch (e) { throw new StoreFailed('R2 did not do what it was asked', {cause: e}); }
};

export function r2Bucket(b: R2Bucket): Bucket {
  return {
    get: (k) => kept(async () => { const o = await b.get(k); return o ? new Uint8Array(await o.arrayBuffer()) : null; }),
    put: (k, bytes) => kept(async () => { await b.put(k, bytes); }),
    size: (k) => kept(async () => (await b.head(k))?.size ?? null),
    // R2's body is a stream of known length: a Worker hands it on without holding it.
    read: (k, start, end) => kept(async () => (await b.get(k, {range: {offset: start, length: end - start + 1}}))?.body ?? null),
    // R2 takes up to a thousand keys a call.
    delete: (keys) => kept(async () => { for (let i = 0; i < keys.length; i += 1000) await b.delete(keys.slice(i, i + 1000)); }),
    list: (prefix, after, limit) => kept(async () => {
      const r = await b.list({prefix, limit, ...(after ? {startAfter: after} : {})});
      const keys = r.objects.map((o) => ({key: o.key, at: o.uploaded.getTime()}));
      return {keys, next: r.truncated && keys.length ? keys[keys.length - 1].key : ''};
    }),
  };
}
