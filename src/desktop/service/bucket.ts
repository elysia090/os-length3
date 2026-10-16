// Where file contents are kept: an object store with keys, as R2 is. The
// service writes each blob once, under a key that is its digest, so nothing
// here is ever overwritten in place.

export interface Bucket {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Bytes [start, end] and the object's size; null when absent. */
  range(key: string, start: number, end: number | null): Promise<{bytes: Uint8Array; size: number} | null>;
}

export function memoryBucket(): Bucket & {keys(): string[]} {
  const m = new Map<string, Uint8Array>();
  return {
    keys: () => [...m.keys()],
    async get(k) { return m.get(k)?.slice() ?? null; },
    async put(k, b) { m.set(k, b.slice()); },
    async has(k) { return m.has(k); },
    async range(k, start, end) {
      const o = m.get(k);
      return o ? {bytes: o.slice(start, end === null ? undefined : end + 1), size: o.length} : null;
    },
  };
}

interface R2Object { size: number; arrayBuffer(): Promise<ArrayBuffer> }
export interface R2Bucket {
  get(key: string, options?: {range?: {offset: number; length?: number}}): Promise<R2Object | null>;
  head(key: string): Promise<unknown | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
}

export function r2Bucket(b: R2Bucket): Bucket {
  return {
    async get(k) { const o = await b.get(k); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    async put(k, bytes) { await b.put(k, bytes); },
    async has(k) { return (await b.head(k)) !== null; },
    async range(k, start, end) {
      const o = await b.get(k, {range: {offset: start, ...(end === null ? {} : {length: end - start + 1})}});
      return o ? {bytes: new Uint8Array(await o.arrayBuffer()), size: o.size} : null;
    },
  };
}
