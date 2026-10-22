// The core in a browser: the very core the app runs (core/web), over files kept in memory (wasi.ts) and in
// IndexedDB. Each tab runs a worker of its own; their calls take turns under one Web Lock, and a worker
// that finds the files changed by another tab reads them again before it calls.
//
// Page → worker: {init: {env}} first, then {id, name, args}, or {id, env} to change the environment.
// Worker → page: {id, ok} or {id, error}, in the order asked. A change kept is said on
// BroadcastChannel('length3-core') as {changed: true}.

import coreWasm from 'virtual:length3-core.wasm?url';
import {Core, type Answer, type Send} from './core-abi.ts';
import {MemoryFS, WASI, type Changes, type Entry} from './wasi.ts';

const NAME = 'length3-core';
const NODES = 'nodes';
const META = 'meta';
const GENERATION = 'generation';

const scope = self as unknown as {postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null};
const channel = new BroadcastChannel(NAME);
const encoder = new TextEncoder();

const fs = new MemoryFS();
let env: Record<string, string> = {};
let module: Promise<WebAssembly.Module> | undefined;
let wasi: WASI | undefined;
let core: Core | undefined;
// The generation of what fs holds; -1 until read (or once it can no longer be trusted).
let seen = -1;

// ---- the network: synchronously, as the core waits for its answer (a worker may) ----

const send: Send = (head, body) => {
  const x = new XMLHttpRequest();
  try {
    x.open(head.method, head.url, false);
    x.responseType = 'arraybuffer';
    if (head.timeout) x.timeout = head.timeout;
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

/** One call, with this tab's files as the last write (of any tab) left them, and what it changed kept. */
function call(name: string, args: unknown): Promise<Answer> {
  return locked(async () => {
    const db = await open();
    if (db && (seen < 0 || await generation(db) !== seen)) {
      const all = await readAll(db);
      fs.restore(all.entries);
      seen = all.generation;
      // What the core held in its memory was of the files before.
      core = undefined;
    }
    let answer: Answer;
    try {
      answer = (await instance()).call(name, args);
    } catch (e) {
      // A trap (a panic is one) ends the instance; the files it wrote are outside it, and are kept below.
      core = undefined;
      answer = {error: `the core stopped: ${said(e)}`};
    }
    wasi?.flushOutput();
    if (!fs.dirty) return answer;
    const changes = fs.flush();
    if (!db) return answer;
    try {
      await keep(db, changes, seen + 1);
      seen++;
      channel.postMessage({changed: true});
    } catch (e) {
      // What is in memory is no longer what is kept: the next call reads the files again.
      seen = -1;
      return {error: `the browser did not keep the change: ${said(e)}`};
    }
    return answer;
  });
}

interface Message { id?: number; init?: {env?: Record<string, string>}; env?: Record<string, string>; name?: string; args?: unknown }

async function handle(m: Message) {
  if (m.init) {
    env = {...m.init.env};
    core = undefined;
    // Compiled while the page is still drawing, so the first call finds it ready.
    compiled().catch(() => {});
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
    const answer = await call(m.name ?? '', m.args);
    scope.postMessage({id, ...answer});
  } catch (e) {
    scope.postMessage({id, error: said(e)});
  }
}

let turn = Promise.resolve();
scope.onmessage = (e) => { turn = turn.then(() => handle(e.data as Message)); };
