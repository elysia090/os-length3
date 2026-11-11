// What the machine under the kernel has: its memory and its storage, as the host it runs on says them, so a program
// told how much there is (/proc/meminfo, sysinfo, statfs: free, df, a build sizing its jobs) is told what is there,
// not a number made up. A host without a way to say it (an old browser) gives the floor below.
//
//   memory     the machine's memory, bytes: node's os.totalmem(), a browser's navigator.deviceMemory (in GiB, which
//              browsers round and cap, so a floor of it), else MEMORY_FLOOR
//   storage()  {total, free} bytes where the files are kept: node's statfs of the directory given, a browser's
//              storage estimate (its quota for this origin, and what of it is not used yet), read again now and then
//
// A process of its own still has at most 4 GiB of memory (a 32-bit WebAssembly memory): that is the address space a
// program is given, not the machine's memory, and mmap past it fails as on a machine out of address space.

import {builtin, steady} from '../../sods/runtime/host.ts';

const GiB = 2 ** 30;
/** What is said when the host cannot say: a small machine's. */
export const MEMORY_FLOOR = 4 * GiB;
/** How often a browser's storage estimate is asked again (it is asynchronous, and costs a little). */
const STORAGE_EVERY_MS = 5000;


/** Bytes where the files are kept: all, and what is not used yet. */
export interface Storage { total: number; free: number }
/** What the machine has (machine()): its memory, and its storage as it is now (null while a browser has not said). */
export interface Machine { memory: number; storage(): Storage | null }
/** A browser's navigator, as far as it says the machine's memory and its storage. */
interface Navigated { deviceMemory?: number; storage?: {estimate?(): Promise<{quota?: number; usage?: number}>} }

export function machine({directory = '/'}: {directory?: string} = {}): Machine {
  const os = builtin<typeof import('node:os')>('os'), fs = builtin<typeof import('node:fs')>('fs');
  const nav = (globalThis as {navigator?: Navigated}).navigator;
  const memory = os?.totalmem?.() ?? (nav?.deviceMemory ? nav.deviceMemory * GiB : MEMORY_FLOOR);
  // node: statfs as asked. A browser: the last estimate, asked again in the background once it is old.
  let estimate: Storage | null = null, asked = 0;
  const browser = (): Storage | null => {
    const now = steady();
    const estimated = nav?.storage?.estimate;
    if (now - asked > STORAGE_EVERY_MS && estimated) {
      asked = now;
      estimated.call(nav.storage).then((e) => {
        if (e?.quota) estimate = {total: e.quota, free: Math.max(0, e.quota - (e.usage ?? 0))};
      }, () => {});
    }
    return estimate;
  };
  const storage = (): Storage | null => {
    if (fs?.statfsSync) {
      try {
        const s = fs.statfsSync(directory);
        return {total: s.blocks * s.bsize, free: s.bavail * s.bsize};
      } catch { /* the directory went: as if the host could not say */ }
    }
    return browser();
  };
  browser();
  return {memory, storage};
}
