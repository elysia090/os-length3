// The host, asked in one place. What sods makes runs as the same code in a browser's page, in one of its Workers
// and in node; what differs between them is answered here and nowhere else: whether this is node, what was said to
// it from outside, its own modules where it has them, its threads, how many processors it has, whether memory is
// shared between threads, whether they may run apart on it and whether this one may wait, its clocks and its random
// bytes, its memory and the room it has for files, a digest, what it keeps from earlier runs and what it fetches.
// A browser's constraints
// and a host system's differences are sods' to take on: what runs over this asks, and never looks for itself.

/** node (or what stands in for it), not a browser. */
export const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/** What was said from outside under `name` (the environment, where there is one); a browser is told nothing. */
export const said = (name: string): string | undefined => (typeof process !== 'undefined' ? process.env?.[name] : undefined) || undefined;

/** The host's own module of this name, where it has one (node), without importing it where there is none. */
export const builtin = <T>(name: string): T | null => (globalThis.process?.getBuiltinModule?.(name) as T | undefined) ?? null;

/** node's threads, where this is node: asked for, so that a browser never is. */
export const nodeThreads = async (): Promise<typeof import('node:worker_threads') | null> => (isNode ? await import('node:worker_threads') : null);

/** Whether these bytes are shared between threads. */
export const isShared = (buffer: ArrayBufferLike): boolean => typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;

/**
 * Whether threads can run apart here: memory shared between them, and waiting on it without blocking. In a browser
 * that is a page set apart from other origins' (cross-origin isolated), and no other.
 */
export const canRunApart = (): boolean => typeof SharedArrayBuffer === 'function' && typeof Atomics.waitAsync === 'function'
  && (isNode || globalThis.crossOriginIsolated === true);

/** Whether this thread may wait where it stands (Atomics.wait): a Worker, or node's main thread; not a page's. */
export const mayWait = isNode || 'WorkerGlobalScope' in globalThis;

/** How many processors the host says it has, from 1 to 64. */
export const processors = (): number => Math.max(1, Math.min(64, globalThis.navigator?.hardwareConcurrency ?? 1));

/** Bytes somewhere files are kept: all of it, and what is not used yet. */
export interface Room { total: number; free: number }

/**
 * The machine's memory in bytes, as the host says it: node's own count; a browser's, in the gibibytes it rounds
 * and caps (so a floor of it); null where the host says none.
 */
export function memory(): number | null {
  const os = builtin<typeof import('node:os')>('os');
  if (os?.totalmem) return os.totalmem();
  const told = (globalThis.navigator as {deviceMemory?: number} | undefined)?.deviceMemory;
  return told ? told * 2 ** 30 : null;
}

/** The room where `directory` is kept, where the host says it at once (node's statfs); null where it does not. */
export function roomNow(directory: string): Room | null {
  const fs = builtin<typeof import('node:fs')>('fs');
  if (!fs?.statfsSync) return null;
  try {
    const s = fs.statfsSync(directory);
    return {total: s.blocks * s.bsize, free: s.bavail * s.bsize};
  } catch { return null; }
}

/** The room the host gives what is kept here, where it says so only later (a browser's estimate of its share); null where it says none. */
export async function roomLater(): Promise<Room | null> {
  const storage = (globalThis.navigator as {storage?: {estimate?(): Promise<{quota?: number; usage?: number}>}} | undefined)?.storage;
  const e = storage?.estimate ? await storage.estimate().catch(() => null) : null;
  return e?.quota ? {total: e.quota, free: Math.max(0, e.quota - (e.usage ?? 0))} : null;
}

/**
 * The host's clocks. `steady()`: milliseconds since this thread of the host began, as finely as the host tells them,
 * never set back. `began`: when that was, in milliseconds since 1970 by the same clock (a thread elsewhere began at
 * another time, and is told this one's: linux/clock.ts). `epoch()`: the calendar's time now, in milliseconds since
 * 1970, which the host may set.
 */
export const steady = (): number => performance.now();
export const began: number = performance.timeOrigin;
export const epoch = (): number => Date.now();

/**
 * `n` bytes no one could have guessed, from the host's own source of them: at most 65536 at one asking (a browser
 * gives no more at once, so no host is asked for more).
 */
export const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));

/** The SHA-256 of `bytes`, by the host's own. */
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/**
 * What the host keeps from earlier runs under `name`: asked for by its address, its bytes or null where nothing is
 * kept there. A browser's is its Cache Storage; a host with none keeps nothing, and says so to every address.
 */
export async function kept(name: string): Promise<(url: string) => Promise<Uint8Array<ArrayBuffer> | null>> {
  if (typeof caches === 'undefined') return async () => null;
  const cache = await caches.open(name);
  return async (url) => { const r = await cache.match(url); return r ? new Uint8Array(await r.arrayBuffer()) : null; };
}

/** What a host answered to a range asked of it: its status (206 the range, 200 the whole) and the bytes it sent. */
export interface Ranged { status: number; bytes: Uint8Array<ArrayBuffer> }

/** Bytes [at, at + length) of what is at `url`, asked of the host as that range: what it answered, once it has. */
export async function range(url: string, at: number, length: number): Promise<Ranged> {
  const r = await fetch(url, {headers: {Range: `bytes=${at}-${at + length - 1}`}});
  return {status: r.status, bytes: new Uint8Array(await r.arrayBuffer())};
}

/**
 * The same range, had where this thread stands, without waiting for a later turn: for a thread that may wait
 * (`mayWait`) and must have the bytes inside a call. A browser's Worker asks synchronously; a host with no way to
 * says so.
 */
export function rangeNow(url: string, at: number, length: number): Ranged {
  if (typeof XMLHttpRequest === 'undefined') throw new Error('this host fetches nothing without waiting');
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.responseType = 'arraybuffer';
  x.setRequestHeader('Range', `bytes=${at}-${at + length - 1}`);
  x.send();
  return {status: x.status, bytes: new Uint8Array(x.response as ArrayBuffer)};
}
