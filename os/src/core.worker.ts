// The core in a browser: the very core the app runs (core/web), over files kept in memory (wasi.ts) and in
// IndexedDB. Each tab runs a worker of its own; their calls take turns under one Web Lock, and a worker
// that finds the files changed by another tab reads them again before it calls.
//
// Page → worker: {init: {env, tab}} first, then {id, name, args}, or {id, env} to change the environment,
// or {batch: [{id, name, args}…]}: what the page asked in one go, made one after another under one turn of the
// lock (one look at what is kept), and answered in one message.
// Worker → page: {id, ok} or {id, error, status?, detail?} (core/src/api.rs answer), in the order asked; for a
// batch, {batch: [answer…]} in its order. A change kept is said on BroadcastChannel('length3-core') as
// {changed: true, from: tab, paths}: each file's path.
//
// Started with {init: {…, reader: true}}, it is the tab's reader: the same core over the same files as they are kept,
// answering only what reads them (READS), while the tab's own worker waits on the Remote (a sync sends and takes in
// over the network, the worker held the whole time, and a file opened meanwhile waited for it: core-client.ts). It
// looks at what is kept before each turn and reads it again when anything was written since; it never writes.

import coreWasm from 'virtual:length3-core.wasm?url';
import {Core, type Answer, type Send} from './core-abi.ts';
import {MemoryFS, WASI, type Changes, type Entry} from './wasi.ts';

const NAME = 'length3-core';
const NODES = 'nodes';
const META = 'meta';
const GENERATION = 'generation';

const scope = self as unknown as {postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null};
const channel = new BroadcastChannel(NAME);
/** The tab this worker answers, so it does not hear of its own writes as another's. */
let tab = '';
const encoder = new TextEncoder();

const fs = new MemoryFS();
let env: Record<string, string> = {};
let module: Promise<WebAssembly.Module> | undefined;
let wasi: WASI | undefined;
let core: Core | undefined;
// The generation of what fs holds; -1 until read (or once it can no longer be trusted).
let seen = -1;
// Another tab wrote since this one last read what is kept: the next call reads it again first.
let behind = true;
/** This worker is the tab's reader (only READS, never writing). */
let reader = false;
channel.onmessage = (e: MessageEvent<{from?: string}>) => { if (e.data?.from !== tab) behind = true; };

/**
 * Calls that only read this device's files (no network, nothing written): with nothing new from another tab
 * they need no turn and no look at what is kept, so a page reading a repo is not a lock and a transaction a
 * file. One that wrote after all is kept as any other.
 */
const READS = new Set(['repo_list', 'repo_tree', 'repo_read', 'repo_bytes', 'state_get', 'remote_status', 'capacity']);

// ---- the network: synchronously, as the core waits for its answer (a worker may) ----

/** The slowest line a file still goes over (bytes a millisecond: 32 KB/s), and the largest file (service LIMIT.blob). */
const SLOW = 32, BLOB = 16 << 20;

const send: Send = (head, body) => {
  const x = new XMLHttpRequest();
  try {
    x.open(head.method, head.url, false);
    x.responseType = 'arraybuffer';
    // The core's timeout is for nothing read in so long (net.rs), a request's here is for the whole of it: as long
    // again as its bytes take at 32 KB/s, and a file's (a blob, up to 16 MB) as long as the largest does, so a
    // slow line still finishes what it sends and gets, not cut at a minute and sent again from the start.
    if (head.timeout) x.timeout = head.timeout + Math.ceil(body.length / SLOW) + (/\/v1\/blobs\/[0-9a-f]{64}$/.test(head.url) && head.method === 'GET' ? Math.ceil(BLOB / SLOW) : 0);
    for (const [k, v] of head.headers) x.setRequestHeader(k, v);
    x.send(body.length ? (body as Uint8Array<ArrayBuffer>) : null);
  } catch (e) {
    // A synchronous request says only that it failed (refused, no name, a policy, a cut), or that it timed out.
    return {status: 0, body: encoder.encode(e instanceof Error && e.name === 'TimeoutError' ? 'it timed out' : 'no connection')};
  }
  if (!x.status) return {status: 0, body: encoder.encode('no connection')};
  return {status: x.status, body: new Uint8Array((x.response as ArrayBuffer | null) ?? new ArrayBuffer(0))};
};

// ---- IndexedDB: every node by its path, and a generation each write moves on ----

let database: Promise<IDBDatabase | null> | undefined;

const asked = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('the write was abandoned'));
});

function open(): Promise<IDBDatabase | null> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(NODES, {keyPath: 'path'});
      r.result.createObjectStore(META);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    // A browser that keeps nothing (a private window may refuse): the files last as long as this worker.
    console.warn('length3: IndexedDB is not available; nothing is kept past this tab', e);
    return null;
  });
  return database;
}

async function generation(db: IDBDatabase): Promise<number> {
  return (await asked(db.transaction(META).objectStore(META).get(GENERATION)) as number | undefined) ?? 0;
}

async function readAll(db: IDBDatabase): Promise<{entries: Entry[]; generation: number}> {
  const tx = db.transaction([NODES, META]);
  const [entries, g] = await Promise.all([
    asked(tx.objectStore(NODES).getAll() as IDBRequest<Entry[]>),
    asked(tx.objectStore(META).get(GENERATION) as IDBRequest<number | undefined>),
  ]);
  return {entries, generation: g ?? 0};
}

async function keep(db: IDBDatabase, changes: Changes, g: number) {
  const tx = db.transaction([NODES, META], 'readwrite');
  const nodes = tx.objectStore(NODES);
  for (const path of changes.removed) nodes.delete(path);
  for (const e of changes.put) nodes.put(e);
  tx.objectStore(META).put(g, GENERATION);
  await finished(tx);
}

// ---- the core ----

async function compile(): Promise<WebAssembly.Module> {
  const r = await fetch(coreWasm);
  if (!r.ok) throw new Error(`the core (${coreWasm}) could not be fetched: ${r.status}`);
  // A server that names it otherwise than application/wasm cannot stream it; the bytes are the same.
  try { return await WebAssembly.compileStreaming(r.clone()); } catch { return WebAssembly.compile(await r.arrayBuffer()); }
}

/** The module, compiled once; a failure is tried again at the next call. */
const compiled = () => (module ??= compile().catch((e) => { module = undefined; throw e; }));

async function instance(): Promise<Core> {
  if (core) return core;
  const m = await compiled();
  wasi =new WASI({fs, env, out: (line, fd) => (fd === 2 ? console.warn : console.log)(`core: ${line}`)});
  core = await Core.start(m, wasi, send);
  return core;
}

const locked = <T>(f: () => Promise<T>): Promise<T> =>
  navigator.locks ? navigator.locks.request(NAME, f) as Promise<T> : f();

const said = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e));

/** The core's answer; a trap (a panic is one) ends the instance, the files it wrote being outside it. */
async function run(name: string, args: unknown): Promise<Answer> {
  try {
    return (await instance()).call(name, args);
  } catch (e) {
    core = undefined;
    return {error: `the core stopped: ${said(e)}`};
  } finally {
    wasi?.flushOutput();
  }
}

/** Keep what the last call changed, and tell the other tabs each path; under the lock. */
async function persist(db: IDBDatabase | null, answer: Answer): Promise<Answer> {
  if (!fs.dirty) return answer;
  const changes = fs.flush();
  if (!db) return answer;
  try {
    await keep(db, changes, seen + 1);
    seen++;
    channel.postMessage({changed: true, from: tab, paths: [...changes.put.map((e) => e.path), ...changes.removed]});
  } catch (e) {
    // What is in memory is no longer what is kept: the next call reads the files again.
    seen = -1;
    return {error: `the browser did not keep the change: ${said(e)}`};
  }
  return answer;
}

/** Under the lock: this tab's files as the last write (of any tab) left them. */
async function current(): Promise<IDBDatabase | null> {
  const db = await open();
  behind = false;
  if (db && (seen < 0 || await generation(db) !== seen)) {
    const all = await readAll(db);
    fs.restore(all.entries);
    seen = all.generation;
    // What the core held in its memory was of the files before.
    core = undefined;
  }
  return db;
}

/** One call, with this tab's files as the last write (of any tab) left them, and what it changed kept. */
async function call(name: string, args: unknown): Promise<Answer> {
  if (READS.has(name) && !behind && seen >= 0) {
    const answer = await run(name, args);
    return fs.dirty ? locked(async () => persist(await open(), answer)) : answer;
  }
  return locked(async () => { const db = await current(); return persist(db, await run(name, args)); });
}

/**
 * As the reader: the files as last kept (read again when anything was written since), then each call, which only
 * reads; anything a read changed after all is not kept here, and what is kept is read again before the next turn.
 */
async function read(list: {name: string; args: unknown}[]): Promise<Answer[]> {
  if (list.some((c) => !READS.has(c.name))) return list.map(() => ({error: 'the reader only reads'}));
  const db = await open();
  if (db && (seen < 0 || await generation(db) !== seen)) {
    const all = await readAll(db);
    fs.restore(all.entries);
    seen = all.generation;
    core = undefined;
  }
  const out: Answer[] = [];
  for (const c of list) out.push(await run(c.name, c.args));
  if (fs.dirty) { fs.flush(); seen = -1; }
  return out;
}

/**
 * Calls asked in one go, one after another, each as `call` makes it: those that only read with nothing new from
 * another tab as they come; otherwise all under one turn of the lock, the files looked at once, each call's change
 * kept before the next is made.
 */
async function calls(list: {name: string; args: unknown}[]): Promise<Answer[]> {
  if (reader) return read(list);
  const out: Answer[] = [];
  if (list.every((c) => READS.has(c.name))) {
    for (const c of list) out.push(await call(c.name, c.args));
    return out;
  }
  return locked(async () => {
    const db = await current();
    for (const c of list) out.push(await persist(db, await run(c.name, c.args)));
    return out;
  });
}

interface Call { id: number; name: string; args?: unknown }
interface Message { id?: number; init?: {env?: Record<string, string>; tab?: string; reader?: boolean}; env?: Record<string, string>; name?: string; args?: unknown; batch?: Call[] }

async function handle(m: Message) {
  if (m.init) {
    env = {...m.init.env};
    tab = m.init.tab ?? '';
    reader = !!m.init.reader;
    core = undefined;
    // Compiled while the page is still drawing, so the first call finds it ready.
    compiled().catch(() => {});
    return;
  }
  if (m.batch) {
    const list = m.batch;
    try {
      const answers = await calls(list.map((c) => ({name: c.name ?? '', args: c.args})));
      scope.postMessage({batch: list.map((c, k) => ({id: c.id, ...answers[k]}))});
    } catch (e) {
      scope.postMessage({batch: list.map((c) => ({id: c.id, error: said(e)}))});
    }
    return;
  }
  const id = m.id;
  try {
    if (m.env) {
      // The core reads its environment once, when it starts: a new one is a new instance.
      env = {...env, ...m.env};
      core = undefined;
      scope.postMessage({id, ok: null});
      return;
    }
    const answer = reader ? (await read([{name: m.name ?? '', args: m.args}]))[0] : await call(m.name ?? '', m.args);
    scope.postMessage({id, ...answer});
  } catch (e) {
    scope.postMessage({id, error: said(e)});
  }
}

let turn = Promise.resolve();
scope.onmessage = (e) => { turn = turn.then(() => handle(e.data as Message)); };
