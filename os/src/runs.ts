// How work that repeats or overlaps is run, the same way everywhere: a look
// taken every little while never runs twice at once, rests while the page is
// hidden and ends with what it was for; a deed asked for again while it runs
// is done once more after it, not twice side by side; the same deed for the
// same thing, asked twice, is one.

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

// ---- whether anyone is here ----
//
// A look at the Remote taken every little while is for someone looking at the page. Nobody has touched
// it for two minutes: a minute between looks at least; for ten, ten minutes (the Remote's database
// sleeps after five without a request, and a window left open on a desk is not someone waiting).
// Touched again, every paced look is taken at once, then at its own pace.

/** Nobody for this long: a minute between looks at least; for AWAY, ten minutes. */
const IDLE = 2 * 60_000, AWAY = 10 * 60_000;
let lastHeard = Date.now();
const backs = new Set<() => void>();
/** Someone is here (a key, a click, the window taken up): told to every paced look if nobody was for IDLE. */
export function heard(at = Date.now()) {
  const was = at - lastHeard >= IDLE;
  lastHeard = at;
  if (was) for (const f of [...backs]) f();
}
if (typeof addEventListener === 'function' && typeof document !== 'undefined') {
  for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus']) addEventListener(e, () => heard(), {capture: true, passive: true});
  document.addEventListener('visibilitychange', () => { if (!pageHidden()) heard(); });
}
/** `ms`, give or take a fifth: many devices told the same wait do not all ask again in the same second. */
export const jitter = (ms: number, r = Math.random()): number => Math.round(ms * (0.8 + 0.4 * r));

/** `ms` while someone is here; at least a minute once nobody has been for two; ten once nobody has been for ten. */
export function paced(ms: number, at = Date.now()): number {
  const quiet = at - lastHeard;
  return quiet < IDLE ? ms : Math.max(ms, quiet < AWAY ? 60_000 : AWAY);
}

export interface EveryOptions {
  /** Still wanted (its element still on screen): once false, it ends. */
  alive?: () => boolean;
  /** While the page is hidden, this often instead (0, the default: not at all until it is shown again). */
  whileHidden?: number;
  /** Told once when it ends, by stop() or by `alive`. */
  ended?: () => void;
  /** Whether the page is hidden (a test gives its own). */
  hidden?: () => boolean;
  /** A look at the Remote: slower while nobody is here (paced), and taken at once when someone comes back. */
  paced?: boolean;
}

/**
 * `step` every `ms` (or as often as it says each time), counted from the end of the last one, so two never run at
 * once however slow one is. A step that fails is said in the console and the
 * next goes on.
 */
export function every(ms: number | (() => number), step: () => unknown, o: EveryOptions = {}): {stop(): void} {
  const {alive = () => true, whileHidden = 0, ended, hidden = pageHidden} = o;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, running = false;
  const next = () => { const m = typeof ms === 'function' ? ms() : ms; return hidden() && whileHidden ? whileHidden : o.paced ? paced(m) : m; };
  const back = () => { if (!running && !stopped) { clearTimeout(timer); void tick(); } };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    backs.delete(back);
    ended?.();
  };
  const tick = async () => {
    if (stopped) return;
    if (!alive()) { stop(); return; }
    const away = hidden();
    if (!away || whileHidden) {
      running = true;
      try { await step(); } catch (e) { console.error('a look taken every little while failed; the next goes on', e); } finally { running = false; }
    }
    if (stopped) return;
    timer = setTimeout(tick, next());
  };
  if (o.paced) backs.add(back);
  timer = setTimeout(tick, next());
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
