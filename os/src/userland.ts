import {digest, download, Fatal} from './fetch.ts';
import {errorText} from './errors.ts';
import {t} from './i18n.ts';
import {prepare, type Segment} from '../../xlat/runtime/share.mjs';

export type {Segment};

/**
 * Whether each guest thread runs in a Worker of its own, all at once: the page
 * shares memory (cross-origin isolated: COOP and COEP, public/_headers) and
 * a Worker can wait on it. Otherwise they take turns in the Prompt's Worker.
 */
export const threadsApart = (): boolean => typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true
  && typeof (Atomics as {waitAsync?: unknown}).waitAsync === 'function';

// l3, the one thing the Prompt depends on: the release root the desktop app
// installs (core/src/root.rs pins it, one entry for both), read here as the
// browser reads it (scripts/l3.mjs). l3.json says which l3 it is (its
// version, and the sha256 of the root it was made from) and names its index
// by digest; everything else is named by its digest too:
//
//   index-<sha256>.json  every path of the root, and where each file's bytes are
//   packs/<sha256>.pack  one per package: a file is read from it only when a
//                        program first opens it (the Worker, one Range request)
//   blobs/<sha256>.bin   the translator, and the hot programs (BusyBox: sh and
//                        its applets; l3) with their translations made ahead
//                        of time, gzip'd
//
// The first Prompt fetches l3.json, the index, the translator and BusyBox
// with its translation; l3's own translation follows once the Prompt is up,
// compiled quietly, for the Prompts started after (until then l3 is
// translated here as it runs, as every other program is). What is fetched is kept in Cache Storage under
// its digest (the packs, in the browser's HTTP cache, under theirs), so a
// Prompt after the first fetches only l3.json. What is kept is derived and
// never canonical: it is checked against its digest whenever it is read,
// whatever the current l3 no longer names goes, and it is only kept while
// the browser's storage has room for it (StorageManager.estimate), the
// least recently used going first. Every Prompt's Worker gets the same
// compiled modules: a Module is shared, not copied.

export interface Blob { path: string; sha256: string; size: number; bytes: number }
export interface About {
  name: string; version: string;
  /** The root this l3 was made from, by the digest core/src/root.rs pins: the same as the app's. */
  sha256: string; bytes: number; file: string;
  root: {name: string; profile: string};
  index: {path: string; sha256: string; size: number};
  translator: {name: string; version: string};
}
export interface Translation { path: string; sha256: string; elf: Blob; wasm: Blob }
export interface Index {
  name: string; version: string; sha256: string; codec: string;
  packs: {name: string; owner: string; bytes: number}[];
  dirs: {path: string; mode: number}[];
  links: {path: string; target: string}[];
  files: {path: string; mode: number; size: number; pack: number; at: number; len: number; raw?: boolean}[];
  translator: Blob & {name: string; version: string; wasm: string};
  translations: Translation[];
}

export interface L3 {
  about: About;
  index: Index;
  translator: WebAssembly.Module;
  /**
   * What the Worker is given beside the packs: each hot program at its own path in the root, with its translation
   * (its module, its data kept outside it, and whether its memory is shared: threads in Workers of their own).
   */
  files: {path: string; bytes: Uint8Array; module: WebAssembly.Module | null; mode: number; segments: Segment[] | null; shared: boolean}[];
  /** Where the packs are (the Worker reads them under packs/). */
  url: string;
}

/** Where loading is, for whoever is waiting on it. */
export type Stage =
  | {at: 'fetch'; got: number; of: number; quiet?: number}
  | {at: 'retry'; attempt: number; why: string; got: number; of: number}
  | {at: 'prepare'}
  | {at: 'ready'}
  | {at: 'failed'; message: string};

/** The hot programs a first Prompt waits for; the others in the index come after it. */
export const FIRST = ['/usr/bin/busybox'];
const BASE = '/l3/';
const CACHE = 'l3';
/** Of what the browser says this origin may hold, the part l3's copies may take (the rest is the repos'). */
const SHARE = 0.25;

const watchers = new Set<(s: Stage) => void>();
let last: Stage = {at: 'prepare'};
const tell = (s: Stage) => { last = s; for (const w of [...watchers]) w(s); };

/** Hear where loading is (at once, then as it moves); returns how to stop. */
export function watchLoad(fn: (s: Stage) => void): () => void {
  watchers.add(fn);
  fn(last);
  return () => watchers.delete(fn);
}

/** What l3 this build carries; null when it carries none (a build made without `npm run l3`). Not reached: the reason. */
export const about = async (): Promise<About | null> => {
  const r = await fetch(`${BASE}l3.json`, {cache: 'no-cache'});
  // This build carries none (a server without it answers 404, or with the page itself).
  if (r.status === 404 || !r.headers.get('content-type')?.includes('json')) { await r.body?.cancel(); return null; }
  if (!r.ok) throw new Fatal(`l3.json: ${r.status}`);
  return await r.json() as About;
};

// ---- what is kept: Cache Storage, by digest ----

/** When each kept copy was last used (this browser's; lost, the oldest is simply unknown). */
const USES = 'length3.l3.used';
const uses = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(USES) ?? '{}'); } catch { return {}; } };
const used = (url: string, at = Date.now()) => {
  try { const u = uses(); u[url] = at; localStorage.setItem(USES, JSON.stringify(u)); } catch { /* not remembered: it goes first */ }
};
const open = async (): Promise<Cache | null> => { try { return 'caches' in globalThis ? await caches.open(CACHE) : null; } catch { return null; } };

/** A kept copy of `url`, if it is still exactly the digest it was kept under. */
async function kept(url: string, sha256: string): Promise<Uint8Array | null> {
  const c = await open();
  const r = await c?.match(url).catch(() => undefined);
  if (!c || !r) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (await digest(bytes) === sha256) { used(url); return bytes; }
  await c.delete(url).catch(() => false);
  return null;
}

/**
 * Keep `bytes` as `url` when the browser has room: what is kept may take a
 * share of this origin's quota, the least recently used going first to make
 * room, and what does not fit is not kept (it is fetched again next time).
 */
async function keep(url: string, bytes: Uint8Array): Promise<boolean> {
  const c = await open();
  if (!c) return false;
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.quota) {
      const budget = e.quota * SHARE;
      let mine = await keptBytes(c);
      if (bytes.length > budget) return false;
      const u = uses();
      const oldest = (await c.keys()).map((r) => r.url).filter((k) => k !== new URL(url, location.href).href)
        .sort((a, b) => (u[new URL(a).pathname] ?? 0) - (u[new URL(b).pathname] ?? 0));
      // Room is the share left, and what the origin as a whole may still take.
      const room = () => Math.min(budget - mine, e.quota! - (e.usage ?? 0));
      while (room() < bytes.length && oldest.length) {
        const k = oldest.shift()!;
        const r = await c.match(k);
        mine -= Number(r?.headers.get('content-length') ?? 0);
        await c.delete(k);
      }
      if (room() < bytes.length) return false;
    }
    await c.put(url, new Response(bytes as BlobPart, {headers: {'content-type': 'application/octet-stream', 'content-length': String(bytes.length)}}));
    used(url);
    return true;
  } catch { return false; }
}

async function keptBytes(c: Cache): Promise<number> {
  let n = 0;
  for (const k of await c.keys()) n += Number((await c.match(k))?.headers.get('content-length') ?? 0);
  return n;
}

/** What l3's kept copies hold here, and how many there are (Runtime's On this device). */
export async function keptL3(): Promise<{bytes: number; files: number}> {
  const c = await open();
  if (!c) return {bytes: 0, files: 0};
  return {bytes: await keptBytes(c), files: (await c.keys()).length};
}

/** Whatever the current l3 does not name goes: an l3 before, or what a browser kept of it. */
async function forgetOthers(live: Set<string>) {
  const c = await open();
  if (!c) return;
  for (const r of await c.keys()) if (!live.has(new URL(r.url).pathname)) await c.delete(r).catch(() => false);
  try {
    const u = uses();
    for (const k of Object.keys(u)) if (!live.has(k)) delete u[k];
    localStorage.setItem(USES, JSON.stringify(u));
  } catch { /* nothing remembered */ }
}

/** `path` under l3 (its digest checked), from what is kept or else the network; kept for next time. */
async function bytesOf(path: string, expect: {sha256: string; size: number}, progress?: Parameters<typeof download>[2]): Promise<Uint8Array> {
  const url = `${BASE}${path}`;
  const have = await kept(url, expect.sha256);
  if (have) { progress?.bytes(expect.size); return have; }
  const bytes = await download(url, expect, progress);
  void keep(url, bytes);
  return bytes;
}

const gunzip = async (bytes: Uint8Array) =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

/** A blob's bytes, unpacked and checked against what it says it is (a program's against its sha256). */
async function unblob(b: Blob, progress?: Parameters<typeof download>[2], sha256?: string): Promise<Uint8Array> {
  const bytes = await gunzip(await bytesOf(b.path, b, progress));
  if (bytes.length !== b.bytes || (sha256 && await digest(bytes) !== sha256)) throw new Fatal(`l3: ${b.path} is not what its index says`);
  return bytes;
}

/**
 * What a Prompt is given for a hot program: its bytes and its compiled
 * translation. A translation the engine will not compile is made again by
 * the translator when its program runs.
 */
async function hot(t: Translation, mode: number, progress?: Parameters<typeof download>[2]) {
  const [bytes, wasm] = await Promise.all([unblob(t.elf, progress, t.sha256), unblob(t.wasm, progress)]);
  // As the kernel runs it (xlat/runtime/share.mjs): its data kept beside it, its memory shared where the page may share memory.
  const shared = threadsApart();
  const p = prepare(wasm, {shared});
  const module = await WebAssembly.compile(p.wasm as BufferSource).catch(() => null);
  return {path: t.path, bytes, module, mode, segments: module ? p.segments : null, shared};
}

/**
 * The rest of the hot programs (l3), after a Prompt is up: fetched (or read
 * from what is kept) and compiled quietly, then given to every Prompt
 * started after. Never waited for: compiling l3's translation takes seconds,
 * and until it is ready l3 is translated as it runs, as every other program.
 */
const later = new Map<string, L3['files'][number]>();
let warming: Promise<void> | null = null;
function warm(index: Index) {
  warming ??= (async () => {
    for (const t of index.translations) {
      if (FIRST.includes(t.path) || later.has(t.path)) continue;
      const f = await hot(t, index.files.find((x) => x.path === t.path)?.mode ?? 0o755).catch(() => null);
      if (f?.module) later.set(t.path, f);
    }
  })();
}

/** l3's index, for what only reads it (File's "/"): from what is kept or fetched; null when this build carries none. */
let indexing: Promise<Index | null> | null = null;
export const l3Index = (): Promise<Index | null> => (indexing ??= (async () => {
  const a = await about();
  if (!a) return null;
  return JSON.parse(new TextDecoder().decode(await bytesOf(a.index.path, a.index))) as Index;
})().catch((e) => { indexing = null; throw e; }));

let loading: Promise<L3> | null = null;
/** l3 for a Prompt: its index, the translator and the hot programs (once per page; again after a failure). */
export const loadL3 = (): Promise<L3> => (loading ??= (async () => {
  const a = await download(`${BASE}l3.json`, {}, undefined, {attempts: 4}).then((b) => {
    // Not JSON is a build without l3 (the host answered with the page): said so, never the parser's words.
    try { return JSON.parse(new TextDecoder().decode(b)) as About; } catch { throw new Fatal(t('There is no l3 (npm run l3)')); }
  });
  const index0 = await bytesOf(a.index.path, a.index);
  const index = JSON.parse(new TextDecoder().decode(index0)) as Index;
  if (index.sha256 !== a.sha256 || index.version !== a.version) throw new Fatal(`l3: its index is of another root (${index.version})`);
  const modeOf = (path: string) => index.files.find((f) => f.path === path)?.mode ?? 0o755;
  const first = index.translations.filter((t) => FIRST.includes(t.path));
  const live = new Set([`${BASE}${a.index.path}`, `${BASE}${index.translator.path}`, ...index.translations.flatMap((t) => [`${BASE}${t.elf.path}`, `${BASE}${t.wasm.path}`])]);
  void forgetOthers(live);
  // Progress over everything this start waits for: the translator and each program it is given now.
  const parts = [index.translator, ...first.flatMap((t) => [t.elf, t.wasm])];
  const of = parts.reduce((n, p) => n + p.size, 0);
  const got = new Map<string, number>();
  const progress = (p: Blob) => ({
    bytes(n: number) { got.set(p.path, n); tell({at: 'fetch', got: [...got.values()].reduce((x, y) => x + y, 0), of}); },
    retry(attempt: number, why: string) { tell({at: 'retry', attempt, why, got: [...got.values()].reduce((x, y) => x + y, 0), of}); },
    waiting(quiet: number) { tell({at: 'fetch', got: [...got.values()].reduce((x, y) => x + y, 0), of, quiet}); },
  });
  tell({at: 'fetch', got: 0, of});
  const [translatorWasm, ...files] = await Promise.all([
    unblob(index.translator, progress(index.translator)),
    ...first.map((t) => hot(t, modeOf(t.path), progress(t.wasm))),
  ]);
  tell({at: 'prepare'});
  const translator = await WebAssembly.compile(translatorWasm as BufferSource);
  tell({at: 'ready'});
  return {about: a, index, translator, files: files as L3['files'], url: new URL(BASE, location.href).href};
})().catch((e) => {
  loading = null;
  tell({at: 'failed', message: errorText(e)});
  throw e;
}));

/** Once a Prompt is up: what the next one is given ahead of time comes now, quietly. */
export const warmL3 = (l3: L3) => warm(l3.index);

/** What a Prompt starting now is given beside the packs: BusyBox, and each other hot program once it is ready. */
export const filesNow = (l3: L3): L3['files'] => [...l3.files, ...later.values()];

/** The Prompt's Worker: xlat running l3's root (pages/terminal.ts gives it l3 and the repo). */
export const promptWorker = (): Worker => new Worker(new URL('../../xlat/runtime/worker.mjs', import.meta.url), {type: 'module'});
