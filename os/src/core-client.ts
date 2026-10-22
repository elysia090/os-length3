// The core in a browser: the same Rust the app runs (core/src/api.rs), built for the web and run in a
// worker of this tab (core.worker.ts) over files this browser keeps. A page asks it what the app asks
// through Tauri, by name with JSON; the answers come back in the order asked.

export type Ask = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

let worker: Worker | null = null;
let next = 1;
const waiting = new Map<number, {resolve(v: unknown): void; reject(e: Error): void}>();
const heard = new Set<() => void>();

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
  const w = new Worker(new URL('./core.worker.ts', import.meta.url), {type: 'module'});
  w.postMessage({init: {env: environment}});
  w.onmessage = (e: MessageEvent<{id: number; ok?: unknown; error?: string}>) => {
    const p = waiting.get(e.data.id);
    if (!p) return;
    waiting.delete(e.data.id);
    if (e.data.error !== undefined) p.reject(new Error(e.data.error));
    else p.resolve(e.data.ok ?? null);
  };
  // A worker that cannot start (its file not served, a browser without module workers) fails every question.
  w.onerror = (e) => {
    const why = new Error(e.message || 'The core could not start');
    for (const p of waiting.values()) p.reject(why);
    waiting.clear();
  };
  // Another tab's core wrote: what this tab shows is read again.
  if (typeof BroadcastChannel === 'function') new BroadcastChannel('length3-core').onmessage = () => { for (const fn of [...heard]) fn(); };
  return worker = w;
}

/** Ask the core in this tab's worker. */
export const ask: Ask = <T>(name: string, args: Record<string, unknown>) => new Promise<T>((resolve, reject) => {
  const w = started();
  const id = next++;
  waiting.set(id, {resolve: resolve as (v: unknown) => void, reject});
  w.postMessage({id, name, args});
});

/** Hear another tab's core change what is kept; returns how to stop. */
export function onElsewhere(fn: () => void): () => void { heard.add(fn); return () => heard.delete(fn); }
