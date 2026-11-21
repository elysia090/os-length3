/**
 * Transactions for the browser worker's local volume. The caller opens and authorizes it.
 * Strict durability requests do not prevent browser eviction.
 */
export interface Layout {nodes: string; data: string; meta: string; generation: IDBValidKey}
export interface Entry {path: string; kind: string; data?: Uint8Array; size?: number}
export interface Changes {put: Entry[]; removed: string[]}

/** Request success alone is not commit success; callers that promise a saved write must await finished. */
export const asked = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
export const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  // A request's error bubbles here before the transaction finishes aborting. Only the terminal events release
  // the caller: running a synchronous guest on `error` could block the abort and its other storage readers.
  tx.onabort = () => reject(tx.error ?? new Error('the write was abandoned'));
});

/** A read and the transaction ending, before a synchronous guest may block this thread again. */
export async function whole<T>(tx: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  const result = asked(request).then(value => ({value}), error => ({error}));
  await finished(tx);
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

export class StaleVolume extends Error {
  constructor() { super('the disk changed since it was read'); this.name = 'StaleVolume'; }
}

/**
 * Atomically replace changed entries and advance the volume's generation. Compare inside the write transaction,
 * not only under a host lock: another writer cannot publish an old snapshot over a newer one. Node metadata is
 * opaque apart from path/kind/data/size, so filesystem-specific modes, links and times survive unchanged.
 * No database creation, owner lookup, automatic persistence, cache fallback or deletion of the volume occurs here.
 */
export async function commit(db: IDBDatabase, layout: Layout, changes: Changes, expected: number): Promise<number> {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected === Number.MAX_SAFE_INTEGER) throw new RangeError('disk: invalid generation');
  const tx = db.transaction([layout.nodes, layout.data, layout.meta], 'readwrite', {durability: 'strict'});
  const done = finished(tx);
  try {
    const meta = tx.objectStore(layout.meta);
    const current = await asked(meta.get(layout.generation));
    if ((current ?? 0) !== expected) throw new StaleVolume();
    const nodes = tx.objectStore(layout.nodes), data = tx.objectStore(layout.data);
    for (const path of changes.removed) { nodes.delete(path); data.delete(path); }
    for (const {data: bytes, ...entry} of changes.put) {
      if (entry.kind === 'file') {
        if (!(bytes instanceof Uint8Array)) throw new TypeError('disk: changed file has no bytes');
        nodes.put({...entry, size: bytes.length});
        data.put({path: entry.path, data: bytes});
      } else { nodes.put(entry); data.delete(entry.path); }
    }
    meta.put(expected + 1, layout.generation);
  } catch (error) {
    try { tx.abort(); } catch { /* it already ended */ }
    await done.catch(() => {});
    throw error;
  }
  await done;
  return expected + 1;
}
