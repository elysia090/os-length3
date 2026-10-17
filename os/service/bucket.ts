// Where file contents are kept: an object store with keys, as R2 is. The
// service writes each blob once, under a key that is its digest, so nothing
// here is ever overwritten in place; a blob no tree names any more is
// deleted (sweep.ts).

export interface Bucket {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Bytes [start, end] and the object's size; null when absent. */
  range(key: string, start: number, end: number | null): Promise<{bytes: Uint8Array; size: number} | null>;
  /** These objects gone (those already gone are no matter). */
  delete(keys: string[]): Promise<void>;
}

export function memoryBucket(): Bucket & {keys(): string[]} {
  const m = new Map<string, Uint8Array>();
  return {
    keys: () => [...m.keys()],
    async get(k) { return m.get(k)?.slice() ?? null; },
    async put(k, b) { m.set(k, b.slice()); },
    async range(k, start, end) {
      const o = m.get(k);
      return o ? {bytes: o.slice(start, end === null ? undefined : end + 1), size: o.length} : null;
    },
    async delete(keys) { for (const k of keys) m.delete(k); },
  };
}

interface R2Object { size: number; arrayBuffer(): Promise<ArrayBuffer> }
export interface R2Bucket {
  get(key: string, options?: {range?: {offset: number; length?: number}}): Promise<R2Object | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export function r2Bucket(b: R2Bucket): Bucket {
  return {
    async get(k) { const o = await b.get(k); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    async put(k, bytes) { await b.put(k, bytes); },
    async range(k, start, end) {
      const o = await b.get(k, {range: {offset: start, ...(end === null ? {} : {length: end - start + 1})}});
      return o ? {bytes: new Uint8Array(await o.arrayBuffer()), size: o.size} : null;
    },
    // R2 takes up to a thousand keys a call.
    async delete(keys) { for (let i = 0; i < keys.length; i += 1000) await b.delete(keys.slice(i, i + 1000)); },
  };
}
