// One shell, two hosts. Inside Tauri the facts come from the native side;
// in a browser they come from the origin's storage estimate. Each reading
// says which layer measured it so the two are never presented as one.

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

export const isNative = '__TAURI_INTERNALS__' in globalThis;

/** How a figure is known (core/src/usage.rs). */
export type Certainty = 'Verified' | 'Estimated' | 'Unknown';
export interface RepoUsage { name: string; files: number; logical: number; allocated: number; history: number }
/** Why a root is on the device (core/src/usage.rs). */
export type RootHeld = 'Current' | 'Previous' | 'Older';
export interface SystemUsage { name: string; version: string; sha256: string; allocated: number; held: RootHeld }
export interface Usage {
  host_total: number; host_free: number; host: Certainty;
  repos: RepoUsage[]; system: SystemUsage[]; home: number; allocated: number; reclaimable: number;
  leftovers: {path: string; allocated: number; what: string}[];
}
export interface Reclaim {
  freed: number; freed_certainty: Certainty; removed: number; kept: [string, string][];
  host_free_before: number; host_free_after: number; host_change: Certainty; reflected_ms: number | null;
}

async function native<T>(command: string): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command);
}

/** What this OS holds on the device and what is reclaimable; desktop only. */
export const readUsage = (): Promise<Usage | null> => (isNative ? native<Usage>('usage').catch(() => null) : Promise.resolve(null));
/** この端末の容量を空ける; desktop only. */
export const reclaim = (): Promise<Reclaim> => native<Reclaim>('reclaim');

export async function readCapacity(): Promise<Capacity | null> {
  try {
    if (isNative) {
      const {invoke} = await import('@tauri-apps/api/core');
      const c = await invoke<{total: number; free: number; app: number}>('capacity');
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

export interface Installed { name: string; version: string; sha256: string; files: number; bytes: number }
export interface RootStatus {
  current: Installed | null;
  held: [Installed, boolean][];
  release: {name: string; version: string; bytes: number};
}
/** What a Prompt's processes hold: how many, and their memory (Pss). */
export interface Held { processes: number; memory: number }
/** How a Prompt stopped: what it held, what was left, how long until none. */
export interface Stopped { before: Held; left: number; ms: number | null }

export const rootStatus = (): Promise<RootStatus | null> => (isNative ? native<RootStatus>('root_status').catch(() => null) : Promise.resolve(null));

/** Fetch and install the release root, hearing how far it is. */
export async function rootFetch(progress: (got: number, of: number, retry: string | null) => void): Promise<Installed> {
  const {listen} = await import('@tauri-apps/api/event');
  const unlisten = await listen<{got: number; of: number; retry: string | null}>('root-fetch', (e) => progress(e.payload.got, e.payload.of, e.payload.retry));
  try { return await native<Installed>('root_fetch'); } finally { unlisten(); }
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** A Prompt on the root: what it prints, and how it ends. */
export async function promptOpen(repo: string, on: {output(text: string): void; exit(code: number): void}): Promise<{
  id: number; input(text: string): Promise<void>; interrupt(): Promise<void>; held(): Promise<Held | null>; close(): Promise<Stopped>; forget(): void;
}> {
  const {listen} = await import('@tauri-apps/api/event');
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
    held: () => call<Held | null>('prompt_held', {id}),
    close: () => call<Stopped>('prompt_close', {id}),
    forget: unlisten,
  };
}
