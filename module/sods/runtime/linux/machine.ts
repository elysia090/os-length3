// What the machine under the kernel has: its memory and its storage, as the host it runs on says them, so a program
// told how much there is (/proc/meminfo, sysinfo, statfs: free, df, a build sizing its jobs) is told what is there,
// not a number made up. A host without a way to say it (an old browser) gives the floor below.
//
//   memory     the machine's memory, bytes, as the host says it (sods' host.ts `memory`: node's own count, a
//              browser's rounded gibibytes), else MEMORY_FLOOR
//   storage()  {total, free} bytes where the files are kept, as the host says it (host.ts `roomNow`: node's statfs
//              of the directory given; `roomLater`: a browser's estimate of its share, read again now and then)
//
// A process of its own still has at most 4 GiB of memory (a 32-bit WebAssembly memory): that is the address space a
// program is given, not the machine's memory, and mmap past it fails as on a machine out of address space.

import {memory as hostMemory, roomLater, roomNow, steady, type Room} from '../host.ts';

const GiB = 2 ** 30;
/** What is said when the host cannot say: a small machine's. */
export const MEMORY_FLOOR = 4 * GiB;
/** How often a host that says its storage only later is asked again (it costs a little). */
const STORAGE_EVERY_MS = 5000;

/** Bytes where the files are kept: all, and what is not used yet. */
export type Storage = Room;
/** What the machine has (machine()): its memory, and its storage as it is now (null while the host has not said). */
export interface Machine { memory: number; storage(): Storage | null }

export function machine({directory = '/'}: {directory?: string} = {}): Machine {
  const memory = hostMemory() ?? MEMORY_FLOOR;
  // A host that says at once is asked each time (node's statfs). One that says later: its last answer, asked again
  // in the background once it is old.
  let estimate: Storage | null = null, asked = -Infinity;
  const later = (): Storage | null => {
    const now = steady();
    if (now - asked > STORAGE_EVERY_MS) {
      asked = now;
      void roomLater().then((room) => { if (room) estimate = room; });
    }
    return estimate;
  };
  const storage = (): Storage | null => roomNow(directory) ?? later();
  later();
  return {memory, storage};
}
