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
