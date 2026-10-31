// The core's reader of what is kept: a file's bytes from IndexedDB for the core's worker (core/worker.ts), which asks
// in the middle of a call, the core reading its files there and then while IndexedDB answers only later. A worker of
// its own, so the core's can wait for it (Atomics.wait) while it reads; the bytes come back through shared memory.
//
// Worker → loader: {ctl, buf} first (the shared state and the buffer the bytes are put in), answered {ready}; then
// {path, seq} for a file, or {under, seq} for every file whose path begins so (each as its path's length and UTF-8,
// its bytes' length and bytes), or {buf, seq} with a larger buffer when that answer was too big for the one before.
// Each answer says which question it is (seq), so one the worker stopped waiting for is never taken for the next.

import {DATA, NAME, NONE, READ, TOO_BIG, stand} from './kept.ts';

const scope = self as unknown as {onmessage: ((e: MessageEvent) => void) | null};
/** [0] which question and how it stands (kept.ts stand), [1] how many bytes the answer has. */
let ctl: Int32Array | undefined;
let buf: SharedArrayBuffer | undefined;
/** Bytes read that did not fit in the buffer, until a larger one comes, and the question they answer. */
let waiting: {bytes: Uint8Array; seq: number} | null = null;
let db: Promise<IDBDatabase> | undefined;

/** What is kept, as it is now (no version asked: the core's worker made it what it is). */
const opened = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open(NAME);
  r.onsuccess = () => {
    // A newer page changes how it is kept: this lets go, and opens it again when next asked.
    r.result.onversionchange = () => { r.result.close(); db = undefined; };
    resolve(r.result);
  };
  r.onerror = () => reject(r.error);
}).catch((e) => { db = undefined; throw e; }));

function answer(seq: number, state: number, length = 0) {
  Atomics.store(ctl!, 1, length);
  Atomics.store(ctl!, 0, stand(seq, state));
  Atomics.notify(ctl!, 0);
}

/** Hand `bytes` over, or say how many there are when the buffer is too small for them. */
function hand(seq: number, bytes: Uint8Array) {
  if (bytes.length > buf!.byteLength) { waiting = {bytes, seq}; answer(seq, TOO_BIG, bytes.length); return; }
  waiting = null;
  new Uint8Array(buf!, 0, bytes.length).set(bytes);
  answer(seq, READ, bytes.length);
}

const asked = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/** Every file kept under `under`, one after another: path length, path, bytes' length, bytes. */
function packed(files: {path: string; data: Uint8Array}[]): Uint8Array {
  const encoder = new TextEncoder();
  const paths = files.map((f) => encoder.encode(f.path));
  const out = new Uint8Array(files.reduce((n, f, k) => n + 8 + paths[k].length + f.data.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  files.forEach((f, k) => {
    view.setUint32(at, paths[k].length, true); out.set(paths[k], at + 4); at += 4 + paths[k].length;
    view.setUint32(at, f.data.length, true); out.set(f.data, at + 4); at += 4 + f.data.length;
  });
  return out;
}

interface Question { ctl?: SharedArrayBuffer; buf?: SharedArrayBuffer; path?: string; under?: string; seq?: number }

async function handle(m: Question) {
  if (m.ctl) { ctl = new Int32Array(m.ctl); buf = m.buf; (self as unknown as {postMessage(m: unknown): void}).postMessage({ready: true}); return; }
  const seq = m.seq ?? 0;
  if (m.buf) { buf = m.buf; if (waiting?.seq === seq) hand(seq, waiting.bytes); return; }
  try {
    const store = (await opened()).transaction(DATA).objectStore(DATA);
    if (m.under !== undefined) {
      hand(seq, packed(await asked(store.getAll(IDBKeyRange.bound(m.under, `${m.under}\uffff`)) as IDBRequest<{path: string; data: Uint8Array}[]>)));
      return;
    }
    if (m.path === undefined) return;
    const kept = await asked(store.get(m.path) as IDBRequest<{data?: Uint8Array} | undefined>);
    if (kept?.data) hand(seq, new Uint8Array(kept.data)); else answer(seq, NONE);
  } catch { answer(seq, NONE); }
}

// One question at a time: the shared buffer holds one answer.
let turn = Promise.resolve();
scope.onmessage = (e: MessageEvent<Question>) => { turn = turn.then(() => handle(e.data)); };
