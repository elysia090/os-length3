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
// over the network, the worker held the whole time, and a file opened meanwhile waited for it: core/client.ts). It
// looks at what is kept before each turn and reads it again when anything was written since; it never writes.

import coreWasm from 'virtual:length3-core.wasm?url';
import {Core, type Answer, type Send} from './abi.ts';
import {MemoryFS, WASI, type Changes, type Entry} from './wasi.ts';
import {ASKED, DATA, GENERATION, META, NAME, NODES, READ, TOO_BIG, VERSION, stand} from './kept.ts';

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

// ---- IndexedDB: every node by its path, a file's bytes apart from it (kept.ts), and a generation each write moves on ----

let database: Promise<IDBDatabase | null> | undefined;
/**
 * Whether a file's bytes can be read when the core first wants them (the loader, through memory shared with it): only
 * a page isolated from other origins has shared memory. Without it, every file's bytes are read with the rest.
 */
const lazily = typeof SharedArrayBuffer === 'function' && (self as {crossOriginIsolated?: boolean}).crossOriginIsolated !== false;

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
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = (e) => {
      const db = r.result;
      if (e.oldVersion < 1) { db.createObjectStore(NODES, {keyPath: 'path'}); db.createObjectStore(META); }
      if (e.oldVersion < 2) {
        const data = db.createObjectStore(DATA, {keyPath: 'path'});
        // Kept by a page before: each file's bytes move to a store of their own; what stays is what a listing needs.
        if (e.oldVersion >= 1) {
          r.transaction!.objectStore(NODES).openCursor().onsuccess = (ev) => {
            const c = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!c) return;
            const {data: bytes, ...node} = c.value as Entry;
            if (node.kind === 'file') { data.put({path: node.path, data: bytes ?? new Uint8Array(0)}); c.update({...node, size: bytes?.length ?? 0}); }
            c.continue();
          };
        }
      }
    };
    // A page of an older build in another tab keeps it open: this one waits for it (it lets go as it is closed).
    r.onblocked = () => console.warn('length3: another tab of an older Length³ OS holds what is kept; close it to go on');
    r.onsuccess = () => {
      // A newer page changes how it is kept: this lets go, so that one can, and opens it again when next asked.
      r.result.onversionchange = () => { r.result.close(); database = undefined; seen = -1; };
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    // A browser that keeps nothing (a private window may refuse): the files last as long as this worker.
    console.warn('length3: IndexedDB is not available; nothing is kept past this tab', e);
    return null;
  });
  return database;
}

/**
 * Each read of what is kept is waited for to its transaction's end, not only its answer: the core may be called right
 * after, in the same task, and wait for its loader; a transaction of this worker still open then would hold a write
 * (another worker's) back, which the loader's read waits behind, and none of them ended (bug: the tab's reader, called
 * as its read of the nodes answered, waited out PATIENCE as the tab's worker kept a change, and a file just written
 * was taken as unreadable).
 */
async function whole<T>(tx: IDBTransaction, r: IDBRequest<T>): Promise<T> {
  return (await Promise.all([asked(r), finished(tx)]))[0];
}

async function generation(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(META);
  return (await whole(tx, tx.objectStore(META).get(GENERATION)) as number | undefined) ?? 0;
}

/** Every node as kept (a file's bytes left where they are, unless they cannot be read later), and the generation. */
async function readAll(db: IDBDatabase): Promise<{entries: Entry[]; generation: number}> {
  const tx = db.transaction([NODES, DATA, META]);
  const [entries, g, bytes] = await Promise.all([
    asked(tx.objectStore(NODES).getAll() as IDBRequest<Entry[]>),
    asked(tx.objectStore(META).get(GENERATION) as IDBRequest<number | undefined>),
    lazily ? null : asked(tx.objectStore(DATA).getAll() as IDBRequest<{path: string; data: Uint8Array}[]>),
    finished(tx),
  ]);
  if (bytes) {
    const by = new Map(bytes.map((b) => [b.path, b.data]));
    for (const e of entries) if (e.kind === 'file') e.data = by.get(e.path) ?? new Uint8Array(0);
  }
  return {entries, generation: g ?? 0};
}

/**
 * This worker's change being kept in IndexedDB. The core is not called meanwhile (run): one waiting for its loader
 * would hold back the very events that end the write, while the loader's read of DATA waits for the write to end (as
 * `whole` has it for reads).
 */
let keeping: Promise<void> = Promise.resolve();

async function keep(db: IDBDatabase, changes: Changes, g: number) {
  const tx = db.transaction([NODES, DATA, META], 'readwrite');
  const nodes = tx.objectStore(NODES), data = tx.objectStore(DATA);
  for (const path of changes.removed) { nodes.delete(path); data.delete(path); }
  for (const {data: bytes, ...e} of changes.put) {
    if (e.kind === 'file') { nodes.put({...e, size: bytes?.length ?? 0}); data.put({path: e.path, data: bytes ?? new Uint8Array(0)}); }
    else { nodes.put(e); data.delete(e.path); }
  }
  tx.objectStore(META).put(g, GENERATION);
  const done = finished(tx);
  keeping = done.catch(() => {});
  await done;
}

// ---- a file's bytes, read when the core first wants them (core/loader.ts) ----

let loader: Worker | null = null;
/** Once the loader runs: until then the core is not called (its waiting would keep the loader from starting). */
let loaderReady: Promise<void> = Promise.resolve();
/** [0] which question and how it stands (kept.ts stand), [1] how many bytes; `buf` holds them. */
let ctl: Int32Array | undefined;
let buf: SharedArrayBuffer | undefined;
/** The last question asked of the loader. */
let asking = 0;
/** How long the core waits for the loader before taking the file as unreadable. */
const PATIENCE = 15_000;

function startLoader() {
  if (loader || !lazily) return;
  const l = loader = new Worker(new URL('./loader.ts', import.meta.url), {type: 'module'});
  ctl = new Int32Array(new SharedArrayBuffer(8));
  buf = new SharedArrayBuffer(1 << 20);
  loaderReady = new Promise((ready) => {
    l.onmessage = (e: MessageEvent<{ready?: boolean}>) => { if (e.data?.ready) ready(); };
    // A loader that cannot start: the core is not kept waiting for it (each read it would have answered fails).
    l.onerror = () => ready();
  });
  l.postMessage({ctl: ctl.buffer, buf});
}

/** How many files of one repo a call reads one by one before the rest of the repo is read in at once. */
const SINGLY = 8;
/** What the running call has read one by one, by repo. */
const readSingly = new Map<string, number>();

/** The repo `path` is in (its directory, with the slash), if it is in one. */
function repoOf(path: string): string | null {
  const root = `${env.LENGTH3_REPOS || `${env.LENGTH3_HOME ?? ''}/repos`}/`;
  if (!path.startsWith(root)) return null;
  const end = path.indexOf('/', root.length);
  return end < 0 ? null : path.slice(0, end + 1);
}

/**
 * The bytes kept at `path`, there and then, read by the loader while the core waits (a worker may). A call that goes
 * on reading one repo's files (a walk over it: its digests, a search) has the rest of the repo read in at once.
 */
function readKept(path: string): Uint8Array | null {
  const repo = repoOf(path);
  if (repo) {
    const n = (readSingly.get(repo) ?? 0) + 1;
    readSingly.set(repo, n);
    if (n === SINGLY) {
      const all = ask({under: repo});
      let got: Uint8Array | null = null;
      if (all) unpack(all, (p, bytes) => { if (p === path) got = bytes; else fs.fill(p, bytes); });
      if (got) return got;
    }
  }
  return ask({path});
}

/** Each file of a packed answer (loader.ts packed): its path and bytes. */
function unpack(all: Uint8Array, each: (path: string, bytes: Uint8Array) => void) {
  const view = new DataView(all.buffer, all.byteOffset, all.byteLength), decoder = new TextDecoder();
  for (let at = 0; at < all.length;) {
    const pl = view.getUint32(at, true), p = decoder.decode(all.subarray(at + 4, at + 4 + pl));
    at += 4 + pl;
    const dl = view.getUint32(at, true);
    each(p, all.slice(at + 4, at + 4 + dl));
    at += 4 + dl;
  }
}

/** One question to the loader, waited for: the bytes it hands over, or null (none kept, or no answer in time). */
function ask(question: {path: string} | {under: string}): Uint8Array | null {
  startLoader();
  if (!loader) return null;
  const seq = ++asking, until = performance.now() + PATIENCE, waiting = stand(seq, ASKED);
  Atomics.store(ctl!, 0, waiting);
  loader.postMessage({...question, seq});
  for (;;) {
    const left = until - performance.now();
    if (left <= 0 || Atomics.wait(ctl!, 0, waiting, left) === 'timed-out') {
      console.warn('length3: what is kept did not come in time; taken as unreadable:', 'path' in question ? question.path : `${question.under}…`);
      return null;
    }
    const now = Atomics.load(ctl!, 0);
    // An answer to a question given up on before: not this one's. Waited past, unless this one's came meanwhile.
    if (now >>> 3 !== (seq & 0xfffffff)) { Atomics.compareExchange(ctl!, 0, now, waiting); continue; }
    const state = now & 7;
    if (state === READ) return new Uint8Array(buf!, 0, Atomics.load(ctl!, 1)).slice();
    if (state !== TOO_BIG) return null;
    // Larger than the buffer: a buffer that holds it (and the next ones as large), and the loader hands them over.
    buf = new SharedArrayBuffer(2 ** Math.ceil(Math.log2(Atomics.load(ctl!, 1))));
    Atomics.store(ctl!, 0, waiting);
    loader.postMessage({buf, seq});
  }
}
fs.loader = readKept;

/** Calls that read every file of the repo they name: its changes and diffs, a commit, a sync, a move (all kept again). */
const WHOLE = /^(history_(changes|diff|cut|push|submit|reset)|issue_commit|issues_settle|work_|change_|sync_repo$|repo_fetch$|repo_move$|repo_rename$)/;

/**
 * The files of the repos such calls name, read in at once (one read of each repo's range) before they run, rather
 * than one by one as the core opens them.
 */
async function readInRepos(db: IDBDatabase | null, list: {name: string; args: unknown}[]) {
  if (!db || !lazily) return;
  const repos = new Set<string>();
  for (const {name, args} of list) {
    if (!WHOLE.test(name)) continue;
    const a = args as {repo?: unknown; repos?: unknown} | null | undefined;
    if (typeof a?.repo === 'string') repos.add(a.repo);
    if (Array.isArray(a?.repos)) for (const r of a.repos) if (typeof r === 'string') repos.add(r);
  }
  const root = env.LENGTH3_REPOS || `${env.LENGTH3_HOME ?? ''}/repos`;
  for (const repo of repos) {
    const under = `${root}/${repo}/`;
    if (!fs.unreadUnder(under).length) continue;
    const tx = db.transaction(DATA);
    const got = await whole(tx, tx.objectStore(DATA).getAll(IDBKeyRange.bound(under, `${under}\uffff`)) as IDBRequest<{path: string; data: Uint8Array}[]>);
    for (const g of got) fs.fill(g.path, g.data);
  }
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
  await loaderReady;
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
  await keeping;
  readSingly.clear();
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
  return locked(async () => {
    const db = await current();
    await readInRepos(db, [{name, args}]);
    return persist(db, await run(name, args));
  });
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
    await readInRepos(db, list);
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
    // Compiled, what this browser keeps opened and its loader started, while the page is still drawing, so the first
    // call finds them ready.
    compiled().catch(() => {});
    if (!reader) void open();
    startLoader();
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
