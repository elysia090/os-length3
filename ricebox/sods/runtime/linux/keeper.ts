// Copies kept from earlier runs, read where the kernel runs. Whoever keeps them (a page: ricebox's runtime/root.ts,
// within its share of the browser's room) keeps them where the host keeps such things (host.ts `kept`: a browser's
// Cache Storage), each program's under the origin of its file in the root (its pack, named by its digest, and its
// place in it), and says at the start which there are: kept = {cache, at: {[origin]: {main, more}}}, the URL of a
// program's translation and that of the code it reached later (or null). A program run for the first time in this
// kernel is then read from there, not translated again, and the exec that wants it waits only for that read. Each
// copy ends with the SHA-256 of what comes before it, checked as it is read: one that is not what was kept is not
// used. What a copy holds is ../translation/kept.ts's (`taken`).

import {kept, sha256} from '../host.ts';
import {taken, type Taken} from '../translation/kept.ts';

/** What is kept, by the origin of each program's file: the cache, and the URLs of its translation and later code. */
export interface Kept { cache: string; at: Record<string, {main: string; more: string | null}> }
/** A keeper reading from what the host keeps: what a kernel asks of it, and how many reads are under way (what waits, waits for them). */
export interface Reading { has(origin: string): boolean; take(origin: string): Taken | null | undefined; reading(): number }
/** Closing suppresses future delivery, not the underlying host read. Previously
 * returned Taken values remain the caller's; callback failures are inspectable. */
export interface RetirableReading extends Reading { close(): void; readonly failures: readonly unknown[] }

/**
 * {has(origin), take(origin)} for a Kernel: take starts reading what is kept for `origin` and says undefined until it
 * is read, then gives it once, or null for good if it could not be had. `ready` is called
 * whenever a read ends (the kernel looks again); `read(urls)` hears what was read, for the page to count as used.
 * Notifications are synchronous: returned promises are not awaited or observed.
 */
export function keeper(kept: Kept, ready: () => void, read: (urls: string[]) => void = () => {}): RetirableReading {
  return readImages(
    origin => Object.hasOwn(kept.at, origin),
    origin => load(kept.cache, kept.at[origin]!).catch(() => null),
    ready,
    origin => {
      const {main, more} = kept.at[origin]!;
      read(more ? [main, more] : [main]);
    },
  );
}

/** Coalesce concurrent execs of one source while the host loads its image.
 * A reader can report a missing optional cache entry or a failed required asset. */
export function readImages(has: (origin: string) => boolean, read: (origin: string) => Promise<Taken | null>,
                           ready: () => void, used = (_origin: string) => {}): RetirableReading {
  type Result = Taken | {error: unknown} | null;
  const state = new Map<string, 'reading' | Result>();
  const failures: unknown[] = [];
  let callbacks: {ready: () => void; used: (origin: string) => void} | null = {ready, used};
  let closed = false, pending = 0;
  return {
    failures,
    close() { closed = true; callbacks = null; state.clear(); },
    has: (origin) => !closed && has(origin) && state.get(origin) !== null,
    reading: () => pending,
    take(origin) {
      if (closed || !has(origin)) return null;
      const s = state.get(origin);
      if (s === 'reading') return undefined;
      if (s === null) return null;
      if (s !== undefined) {
        if ('error' in s) throw s.error;
        state.delete(origin);
        return s;
      }
      state.set(origin, 'reading'); pending++;
      const finish = (value: Result): void => {
        pending--;
        if (closed) return;
        state.set(origin, value);
        if (value && 'module' in value) {
          try { callbacks?.used(origin); }
          catch (failure) { failures.push(failure); }
        }
        // read may close reentrantly. A failing diagnostic must not skip wake,
        // whereas explicit close must suppress it. Never leave a finally chain
        // rejected solely because a notification callback threw.
        try { callbacks?.ready(); } catch (failure) { failures.push(failure); }
      };
      void Promise.resolve().then(() => read(origin)).then(finish, error => finish({error}));
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

/** A kept copy, as a kernel takes it; null when it is not there or not what was kept. */
async function load(name: string, {main, more}: {main: string; more: string | null}): Promise<Taken | null> {
  const read = await kept(name);
  const [m, x] = await Promise.all([checked(read, main), more ? checked(read, more).catch(() => null) : null]);
  return m ? taken(m, x) : null;
}
