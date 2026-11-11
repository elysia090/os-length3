// The host, asked in one place. What sods makes runs as the same code in a browser's page, in one of its Workers
// and in node; what differs between them is answered here and nowhere else: whether this is node, what was said to
// it from outside, its own modules where it has them, its threads, how many processors it has, whether memory is
// shared between threads, whether they may run apart on it and whether this one may wait. A browser's constraints
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
