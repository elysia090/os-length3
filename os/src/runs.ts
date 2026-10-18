// How work that repeats or overlaps is run, the same way everywhere: a look
// taken every little while never runs twice at once, rests while the page is
// hidden and ends with what it was for; a deed asked for again while it runs
// is done once more after it, not twice side by side; the same deed for the
// same thing, asked twice, is one.

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export interface EveryOptions {
  /** Still wanted (its element still on screen): once false, it ends. */
  alive?: () => boolean;
  /** While the page is hidden, this often instead (0, the default: not at all until it is shown again). */
  whileHidden?: number;
  /** Told once when it ends, by stop() or by `alive`. */
  ended?: () => void;
  /** Whether the page is hidden (a test gives its own). */
  hidden?: () => boolean;
}

/**
 * `step` every `ms`, counted from the end of the last one, so two never run at
 * once however slow one is. A step that fails is said in the console and the
 * next goes on.
 */
export function every(ms: number, step: () => unknown, o: EveryOptions = {}): {stop(): void} {
  const {alive = () => true, whileHidden = 0, ended, hidden = pageHidden} = o;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    ended?.();
  };
  const tick = async () => {
    if (stopped) return;
    if (!alive()) { stop(); return; }
    const away = hidden();
    if (!away || whileHidden) {
      try { await step(); } catch (e) { console.error('a look taken every little while failed; the next goes on', e); }
    }
    if (stopped) return;
    timer = setTimeout(tick, hidden() && whileHidden ? whileHidden : ms);
  };
  timer = setTimeout(tick, hidden() && whileHidden ? whileHidden : ms);
  return {stop};
}

/**
 * `run`, called however often, never twice at once: a call while it runs is
 * taken up by one more run after it, which every call meanwhile shares (their
 * arguments joined by `join`, the latest by default). So each call is
 * followed by a run that began after it, and no more runs than that.
 */
export function coalesced<A = void>(run: (a: A) => Promise<void>, join: (was: A, now: A) => A = (_was, now) => now): (a: A) => Promise<void> {
  let busy = false;
  let waiting: {arg: A; done: Promise<void>; resolve(): void; reject(e: unknown): void} | null = null;
  const go = async (a: A): Promise<void> => {
    busy = true;
    try { await run(a); } finally {
      busy = false;
      const w = waiting;
      waiting = null;
      if (w) go(w.arg).then(w.resolve, w.reject);
    }
  };
  return (a: A) => {
    if (!busy) return go(a);
    if (waiting) { waiting.arg = join(waiting.arg, a); return waiting.done; }
    let resolve!: () => void, reject!: (e: unknown) => void;
    const done = new Promise<void>((y, n) => { resolve = y; reject = n; });
    waiting = {arg: a, done, resolve, reject};
    return done;
  };
}

/** `f` over `items`, at most `n` at a time (requests side by side, not one after another), the answers in the items' order. */
export async function atMost<T, R>(n: number, items: readonly T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const one = async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]); } };
  await Promise.all(Array.from({length: Math.min(n, items.length)}, one));
  return out;
}

/** `run` for one key at a time: asked again for a key while it runs, the same promise answers. */
export function shared<K, T>(run: (k: K) => Promise<T>): (k: K) => Promise<T> {
  const running = new Map<K, Promise<T>>();
  return (k: K) => {
    let p = running.get(k);
    if (!p) {
      p = run(k).finally(() => running.delete(k));
      running.set(k, p);
    }
    return p;
  };
}
