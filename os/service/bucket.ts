// Where file contents are kept: an object store with keys, as R2 is. The
// service writes each blob once, under a key that is its digest, so nothing
// here is ever overwritten in place; a blob no tree names any more is
// deleted (sweep.ts). What a release is (os/<sha256>, desktop/<file>) is put
// here by the deploy (mirror.ts) and only read by the service, a range at a
// time and as a stream, since it is larger than a Worker may hold.

export interface Bucket {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The object's size in bytes; null when absent. */
  size(key: string): Promise<number | null>;
  /** Bytes [start, end] (both within the object), as they come; null when absent. */
  read(key: string, start: number, end: number): Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
  /** These objects gone (those already gone are no matter). */
  delete(keys: string[]): Promise<void>;
}

export function memoryBucket(): Bucket & {keys(): string[]} {
  const m = new Map<string, Uint8Array>();
  return {
    keys: () => [...m.keys()],
    async get(k) { return m.get(k)?.slice() ?? null; },
    async put(k, b) { m.set(k, b.slice()); },
    async size(k) { return m.get(k)?.length ?? null; },
    async read(k, start, end) { return m.get(k)?.slice(start, end + 1) ?? null; },
    async delete(keys) { for (const k of keys) m.delete(k); },
  };
}

interface R2Object { size: number }
interface R2ObjectBody extends R2Object { body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> }
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: {range?: {offset: number; length?: number}}): Promise<R2ObjectBody | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export function r2Bucket(b: R2Bucket): Bucket {
  return {
    async get(k) { const o = await b.get(k); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    async put(k, bytes) { await b.put(k, bytes); },
    async size(k) { return (await b.head(k))?.size ?? null; },
    // R2's body is a stream of known length: a Worker hands it on without holding it.
    async read(k, start, end) { return (await b.get(k, {range: {offset: start, length: end - start + 1}}))?.body ?? null; },
    // R2 takes up to a thousand keys a call.
    async delete(keys) { for (let i = 0; i < keys.length; i += 1000) await b.delete(keys.slice(i, i + 1000)); },
  };
}
