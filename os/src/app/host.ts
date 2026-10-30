// One shell, two hosts. Inside Tauri the facts come from the native side;
// in a browser they come from the origin's storage estimate. Each reading
// says which layer measured it so the two are never presented as one.

import {ask, type Answer, type Ask} from '../core/client.ts';
import {RemoteError} from '../remote/connection.ts';
import {invoke, listen} from './tauri.ts';

export interface Capacity {
  /** Bytes the measured layer can hold in total. */
  total: number;
  /** Bytes still available to it. */
  free: number;
  /** Bytes this app holds there. */
  app: number;
  /** Which layer was measured. */
  layer: 'host-filesystem' | 'browser-origin';
}

/** Which host this build is for (vite.config.ts), so each build carries only its own; run from source (the tests), the page says. */
declare const __LENGTH3_HOST__: 'native' | 'web' | undefined;
export const isNative: boolean = typeof __LENGTH3_HOST__ === 'string' ? __LENGTH3_HOST__ === 'native' : '__TAURI_INTERNALS__' in globalThis;

/** How a figure is known (core/src/usage.rs). */
export type Certainty = 'Verified' | 'Estimated' | 'Unknown';
/** What can be done with a thing this OS holds: it can go, it can go once sent, or it stays (and why). */
export type Room = 'Free' | 'SyncFree' | 'Keep';
/** One thing this OS holds on the device: "repo:<name>", "root:<sha>", "path:<path>" or "home". */
export interface Item { id: string; what: string; detail: string; allocated: number; room: Room; why: string }
export interface Space { host_total: number; host_free: number; host: Certainty; allocated: number; freeable: number; items: Item[] }
export interface Freed {
  freed: number; freed_certainty: Certainty; removed: string[]; kept: [string, string][];
  host_free_before: number; host_free_after: number; host_change: Certainty; reflected_ms: number | null;
}

/** A command of the app's own, around the core: what only a host does (open a page, a Prompt on the root, SSH). */
export const native = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => invoke<T>(command, args);

let asked: Ask = isNative ? (name, args) => native<Answer>('core', {name, args}) : ask;
/** Ask another core (tests run it in their own process). */
export const useCore = (a: Ask) => { asked = a; };

/** A command of the core's (core/src/api.rs), by name: the one code a repo, its history and the Remote
 *  are kept by, whichever host runs it (the app's own, or the same built for the web in a worker). */
export async function core<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const a = await asked(name, args);
  if ('ok' in a) return a.ok as T;
  // The Remote's refusal is the same RemoteError the page's own requests give (a plan's rule, offline, …).
  throw a.status === undefined ? new Error(a.error) : new RemoteError(a.status, a.error, a.detail ?? {});
}


export async function readCapacity(): Promise<Capacity | null> {
  try {
    if (isNative) {
      const c = await core<{total: number; free: number; app: number}>('capacity');
      return {total: c.total, free: c.free, app: c.app, layer: 'host-filesystem'};
    }
    const e = await navigator.storage?.estimate?.();
    if (!e?.quota) return null;
    const usage = e.usage ?? 0;
    return {total: e.quota, free: Math.max(0, e.quota - usage), app: usage, layer: 'browser-origin'};
  } catch {
    return null;
  }
}

/**
 * Whether this browser has agreed not to clear what this site keeps when
 * room runs short (StorageManager.persisted); null where it cannot say.
 * The app keeps everything on disk, so there it is always true.
 */
export async function persisted(): Promise<boolean | null> {
  if (isNative) return true;
  try { return await navigator.storage?.persisted?.() ?? null; } catch { return null; }
}

/** Ask the browser to keep this site's data (once work exists to keep). */
export async function askToKeep(): Promise<boolean | null> {
  if (isNative) return true;
  try { return await navigator.storage?.persist?.() ?? null; } catch { return null; }
}

// ---- the distribution's root on this machine (app only; core/src/root.rs, launch.rs) ----

export interface Installed { name: string; version: string; sha256: string; files: number; bytes: number; distro?: string }
export interface RootStatus {
  current: Installed | null;
  held: [Installed, boolean][];
  release: {name: string; version: string; bytes: number};
  /** Other distributions' roots that can be used. */
  distros: {id: string; name: string; version: string; bytes: number; sha256: string}[];
}
/** What a Prompt's processes hold: how many, and their memory (Pss). */
export interface Held { processes: number; memory: number }
/** What a Prompt on the root holds now, and whether it is still being prepared (.packages, .setup). */
export interface Holding extends Held { preparing: boolean }
/** How a Prompt stopped: what it held, what was left, how long until none. */
export interface Stopped { before: Held; left: number; ms: number | null }

/** The roots this machine holds (the app only; a browser has none). */
export const rootStatus = (): Promise<RootStatus | null> => (isNative ? native<RootStatus>('root_status') : Promise.resolve(null));

/** The release root on its way: asked for again meanwhile (a second Prompt, Runtime's Fetch), the same one is waited on. */
let fetching: Promise<Installed> | null = null;
/** Fetch and install the release root, hearing how far it is. */
export async function rootFetch(progress: (got: number, of: number, retry: string | null) => void): Promise<Installed> {
  const unlisten = await listen<{got: number; of: number; retry: string | null}>('root-fetch', (e) => progress(e.payload.got, e.payload.of, e.payload.retry));
  try { return await (fetching ??= native<Installed>('root_fetch').finally(() => { fetching = null; })); } finally { unlisten(); }
}

/** Make `id` (l3, ubuntu, debian) the root Prompts run on, fetched first if it is not here. */
export async function rootUse(id: string, progress: (got: number, of: number, retry: string | null) => void): Promise<Installed> {
  const unlisten = await listen<{got: number; of: number; retry: string | null}>('root-fetch', (e) => progress(e.payload.got, e.payload.of, e.payload.retry));
  try { return await native<Installed>('root_use', {id}); } finally { unlisten(); }
}

const call = native;

/** A Prompt on the root: what it prints, and how it ends. */
export async function promptOpen(repo: string, on: {output(text: string): void; exit(code: number): void}): Promise<{
  id: number; input(text: string): Promise<void>; interrupt(): Promise<void>; held(): Promise<Holding | null>; close(): Promise<Stopped>; forget(): void;
}> {
  type Event = {id: number; kind: string; text: string; code: number};
  let id = -1;
  // What arrives before the id is known is held, then handed on in order.
  const early: Event[] = [];
  const deliver = (p: Event) => { if (p.kind === 'output') on.output(p.text); else on.exit(p.code); };
  const unlisten = await listen<Event>('prompt', (e) => {
    if (id < 0) { early.push(e.payload); return; }
    if (e.payload.id === id) deliver(e.payload);
  });
  id = await call<number>('prompt_open', {repo}).catch((e) => { unlisten(); throw e; });
  for (const p of early) if (p.id === id) deliver(p);
  return {
    id,
    input: (text) => call('prompt_input', {id, text}),
    interrupt: () => call('prompt_interrupt', {id}),
    held: () => call<Holding | null>('prompt_held', {id}),
    close: () => call<Stopped>('prompt_close', {id}),
    forget: unlisten,
  };
}
