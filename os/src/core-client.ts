// The core in a browser: the same Rust the app runs (core/src/api.rs), built for the web and run in a
// worker of this tab (core.worker.ts) over files this browser keeps. A page asks it what the app asks
// through Tauri, by name with JSON; the answers come back in the order asked.

import {coreWorker} from './core-worker.ts';

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
  if (worker) worker.postMessage({id: next++, env: environment});
}

function started(): Worker {
  if (worker) return worker;
  const w = coreWorker();
  w.postMessage({init: {env: environment, tab}});
  w.onmessage = (e: MessageEvent<{id: number} & Answer>) => {
    const {id, ...answer} = e.data;
    const p = waiting.get(id);
    if (!p) return;
    waiting.delete(id);
    p.resolve(answer);
  };
  // A worker that cannot start (its file not served, a browser without module workers) fails every question.
  w.onerror = (e) => {
    const why = new Error(e.message || 'The core could not start');
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

/** Ask the core in this tab's worker. */
export const ask: Ask = (name, args) => new Promise<Answer>((resolve, reject) => {
  const w = started();
  const id = next++;
  waiting.set(id, {resolve, reject});
  w.postMessage({id, name, args});
});

/** Hear another tab's core change what is kept: the paths it wrote or removed, as the core names them. */
export function onElsewhere(fn: (paths: string[]) => void): () => void { heard.add(fn); return () => heard.delete(fn); }

/** Where the core keeps the repos and Home's state, as it names them (its LENGTH3_HOME). */
export const home = () => environment.LENGTH3_HOME;
