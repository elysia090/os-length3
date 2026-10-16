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
export interface Usage {
  host_total: number; host_free: number; host: Certainty;
  repos: RepoUsage[]; home: number; allocated: number; reclaimable: number;
  leftovers: {path: string; allocated: number}[];
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
