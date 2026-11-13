// Copies kept from earlier runs, read where the kernel runs (module/prompt/runtime/kernel.worker.ts). The page keeps them
// (why/app/prompt/userland.ts, within its share of the browser's room) where the host keeps such things (sods'
// host.ts `kept`: a browser's Cache Storage), each program's under the
// origin of its file in the root (pack.ts: its pack, named by its digest, and its place in it), and says at the start
// which there are: kept = {cache, at: {[origin]: {main, more}}}, the URL of a program's translation and that of the
// code it reached later (or null). A program run for the first time in this kernel is then read from there, not
// translated again, and the exec that wants it waits only for that read. Each copy ends with the SHA-256 of what
// comes before it, checked as it is read: one that is not what was kept is not used.
//
// What a copy holds is not the keeper's: `open(main, more)` makes of the bodies what the kernel takes
// (sods/runtime/kept.ts taken), or null when they are not that.

import {kept, sha256} from '../host.ts';

/** What is kept, by the origin of each program's file: the cache, and the URLs of its translation and later code. */
export interface Kept { cache: string; at: Record<string, {main: string; more: string | null}> }
/** What a kernel asks of a keeper: whether something is kept for an origin, and to take it. */
export interface Keeper<T> { has(origin: string): boolean; take(origin: string): T | null | undefined }
/** A keeper reading from Cache Storage: also how many reads are under way (what waits, waits for them). */
export interface Reading<T> extends Keeper<T> { reading(): number }
/** What the kernel takes, made of a copy's bodies: null when they are not what it takes. */
export type Open<T> = (main: Uint8Array<ArrayBuffer>, more: Uint8Array<ArrayBuffer> | null) => T | null;

/**
 * {has(origin), take(origin)} for a Kernel: take starts reading what is kept for `origin` and says undefined until it
 * is read, then gives it once (`open` of its bodies), or null for good if it could not be had. `ready` is called
 * whenever a read ends (the kernel looks again); `read(urls)` hears what was read, for the page to count as used.
 */
export function keeper<T>(kept: Kept, open: Open<T>, ready: () => void, read: (urls: string[]) => void = () => {}): Reading<T> {
  const state = new Map<string, 'reading' | T | null>(); // origin -> 'reading' | what was read | null
  return {
    has: (origin) => Object.hasOwn(kept.at, origin) && state.get(origin) !== null,
    /** How many are being read now. */
    reading: () => [...state.values()].filter((s) => s === 'reading').length,
    take(origin) {
      const s = state.get(origin);
      if (s === 'reading') return undefined;
      if (s === null) return null;
      // Given once: freed later (Kernel.free), it is read again rather than held here.
      if (s !== undefined) { state.delete(origin); return s; }
      state.set(origin, 'reading');
      const urls = kept.at[origin];
      load(kept.cache, urls, open).then((v) => { state.set(origin, v); if (v) read([urls.main, ...(urls.more ? [urls.more] : [])]); },
        () => state.set(origin, null)).finally(ready);
      return undefined;
    },
  };
}

/** What is kept at `url` without its digest, if it is what was kept. */
async function checked(read: (url: string) => Promise<Uint8Array<ArrayBuffer> | null>, url: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const all = await read(url);
  if (!all || all.length < 40) return null;
  const body = all.subarray(0, all.length - 32);
  const sum = await sha256(body);
  for (let i = 0; i < 32; i++) if (sum[i] !== all[all.length - 32 + i]) return null;
  return body;
}

/** What `open` makes of a kept copy; null when it is not there or not what was kept. */
async function load<T>(name: string, {main, more}: {main: string; more: string | null}, open: Open<T>): Promise<T | null> {
  const read = await kept(name);
  const [m, x] = await Promise.all([checked(read, main), more ? checked(read, more).catch(() => null) : null]);
  return m ? open(m, x) : null;
}
