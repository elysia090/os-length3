// The core in a browser: the same Rust the app runs (core/src/api.rs), built for the web and run in a
// worker of this tab (core/worker.ts) over files this browser keeps. A page asks it what the app asks
// through Tauri, by name with JSON; the answers come back in the order asked. What is asked in one go
// (one turn of the page: a list read with Promise.all) goes to the worker as one message and comes back
// as one, so a hundred files read cost the page one trip to the worker and back, not a hundred, each
// waiting its turn behind whatever the page is drawing.
//
// While the worker waits on the Remote (a sync, a push: the core asks it synchronously, and the worker does nothing
// else meanwhile, a few hundred milliseconds to seconds), what only reads this device's files (a file opened, the
// tree, a search) is asked of a second worker instead, the tab's reader (core/worker.ts), over the same files as
// they are kept, so it does not wait for the Remote. What is written always goes to the one worker, in order.

import {coreWorker} from './spawn.ts';

/** What the core answers (core/src/api.rs answer): a value, or why not; a refusal of the Remote's says its status and detail. */
export type Answer = {ok: unknown} | {error: string; status?: number; detail?: Record<string, unknown>};
export type Ask = (name: string, args: Record<string, unknown>) => Promise<Answer>;

let worker: Worker | null = null;
/** This tab, as its worker's word that it wrote names it. */
const tab = Math.random().toString(36).slice(2);
let next = 1;
const waiting = new Map<number, {resolve(v: Answer): void; reject(e: Error): void}>();
const heard = new Set<(paths: string[]) => void>();

/** What the core is told about where it runs: its files, the Remote, this device's name (a page has no host name). */
let environment: Record<string, string> = {LENGTH3_HOME: '/data', LENGTH3_DEVICE: deviceOf(globalThis.navigator?.userAgent ?? '')};

/** This device in words a file's name can carry ("Chrome Linux"): what a file both sides changed is kept beside under. */
export function deviceOf(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' ') || 'browser';
}

/** Tell the core where it runs before its first answer (and again when it changes). */
export function setEnvironment(env: Record<string, string>) {
  environment = {...environment, ...env};
  // After what was asked before it, as it was asked before it.
  send();
  if (worker) worker.postMessage({id: next++, env: environment});
  if (reader) reader.postMessage({id: next++, env: environment});
}

type Call = {id: number; name: string; args: Record<string, unknown>};
/** What was asked in this turn of the page and not sent yet: of the worker, and of the reader. */
let queued: Call[] = [];
let toRead: Call[] = [];
/** Send what is asked so far: alone as itself, more as one batch (core/worker.ts answers a batch in one message). */
function send() {
  const q = queued, r = toRead;
  queued = [];
  toRead = [];
  if (q.length) started().postMessage(q.length === 1 ? q[0] : {batch: q});
  if (r.length) {
    for (const c of r) reading.set(c.id, c);
    readerOf().postMessage(r.length === 1 ? r[0] : {batch: r});
  }
}
const answered = (id: number, answer: Answer) => {
  if (remote.delete(id)) away--;
  writing.delete(id);
  reading.delete(id);
  const p = waiting.get(id);
  if (!p) return;
  waiting.delete(id);
  p.resolve(answer);
};

/** What only reads this device's files (core/worker.ts READS, less what may ask the Remote): the reader may answer it. */
const ANYWHERE = new Set(['repo_list', 'repo_tree', 'repo_read', 'repo_bytes', 'state_get', 'capacity']);
/** What may wait on the Remote: while one is asked of the worker, what only reads goes to the reader. */
const REMOTE = /^(sync_repo|repo_fetch|home_sync|remote_(?!status$)|history_(push|submit|reset|log|cut)$|change_|changes_list$|work_(lines|start|switch|standings)$|issue_commit$|issues_settle$|plan_page$|app_page$)/;
/** The calls asked of the worker that may wait on the Remote, and how many there are. */
const remote = new Set<number>();
let away = 0;
/**
 * The calls asked of the worker that write here (neither only reading nor asking the Remote): while one is not
 * answered, a read goes to the worker after it, as it was asked after it, so it reads what was written.
 */
const writing = new Set<number>();
/** The tab's reader, made when first wanted; null once it could not start (the worker answers everything then). */
let reader: Worker | null | undefined;
/** What the reader was asked and has not answered: asked of the worker instead, should the reader stop. */
const reading = new Map<number, Call>();
function readerOf(): Worker {
  if (reader) return reader;
  const r = coreWorker();
  r.postMessage({init: {env: environment, tab, reader: true}});
  r.onmessage = (e: MessageEvent<({id: number} & Answer) | {batch: ({id: number} & Answer)[]}>) => {
    for (const {id, ...answer} of 'batch' in e.data ? e.data.batch : [e.data]) answered(id, answer as Answer);
  };
  r.onerror = () => {
    reader = null;
    const again = [...reading.values()];
    reading.clear();
    if (again.length) started().postMessage({batch: again});
  };
  return reader = r;
}

function started(): Worker {
  if (worker) return worker;
  const w = coreWorker();
  w.postMessage({init: {env: environment, tab}});
  w.onmessage = (e: MessageEvent<({id: number} & Answer) | {batch: ({id: number} & Answer)[]}>) => {
    for (const {id, ...answer} of 'batch' in e.data ? e.data.batch : [e.data]) answered(id, answer as Answer);
  };
  // A worker that cannot start (its file not served, a browser without module workers) fails every question.
  w.onerror = (e) => {
    const why = new Error(e.message || 'The core could not start');
    remote.clear();
    writing.clear();
    away = 0;
    for (const p of waiting.values()) p.reject(why);
    waiting.clear();
  };
  // Another tab's core wrote: what this tab shows is read again.
  if (typeof BroadcastChannel === 'function') {
    new BroadcastChannel('length3-core').onmessage = (e: MessageEvent<{from?: string; paths?: string[]}>) => {
      if (e.data?.from !== tab) for (const fn of [...heard]) fn(e.data?.paths ?? []);
    };
  }
  return worker = w;
}

/** Ask the core in this tab's worker: sent once this turn of the page is done asking, with what else it asked. */
export const ask: Ask = (name, args) => new Promise<Answer>((resolve, reject) => {
  started();
  const id = next++;
  waiting.set(id, {resolve, reject});
  // Only read, while the worker may be waiting on the Remote: the reader answers it.
  if (away > 0 && !writing.size && reader !== null && ANYWHERE.has(name)) toRead.push({id, name, args});
  else {
    if (REMOTE.test(name)) { remote.add(id); away++; } else if (!ANYWHERE.has(name)) writing.add(id);
    queued.push({id, name, args});
  }
  if (queued.length + toRead.length === 1) queueMicrotask(send);
});

/** Hear another tab's core change what is kept: the paths it wrote or removed, as the core names them. */
export function onElsewhere(fn: (paths: string[]) => void): () => void { heard.add(fn); return () => heard.delete(fn); }

/** Where the core keeps the repos and Home's state, as it names them (its LENGTH3_HOME). */
export const home = () => environment.LENGTH3_HOME;
