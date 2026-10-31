import {digest, download, Fatal, type Check} from './l3-files.ts';
import {errorText} from '../app/errors.ts';
import {t} from '../i18n.ts';
import {prepare, type Segment} from '../../../xlat/runtime/share.mjs';
import {unpackMore} from '../../../xlat/runtime/keeper.mjs';

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
interface Translation { path: string; sha256: string; elf: Blob; wasm: Blob }
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
  files: {path: string; bytes: Uint8Array; module: WebAssembly.Module | null; mode: number; segments: Segment[] | null; shared: boolean; more?: More[]}[];
  /** Where the packs are (the Worker reads them under packs/). */
  url: string;
}

/** A module of code a hot program reached later in a Prompt, as its kernel made it (xlat/runtime/process.mjs Image.adopt). */
export interface More { module: WebAssembly.Module; bytes: Uint8Array; base: number }

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
const whole = (url: string) => new URL(url, location.href).href;
/**
 * The size of each kept copy, by its whole URL: read from what is kept once a page (each copy's head), then
 * followed as copies are kept and let go, so what is kept is counted without opening every copy each time.
 */
let sizes: Promise<Map<string, number>> | null = null;
const sizesOf = (c: Cache) => (sizes ??= (async () => {
  const m = new Map<string, number>();
  for (const r of await c.keys()) m.set(r.url, Number((await c.match(r))?.headers.get('content-length') ?? 0));
  return m;
})());
const gone = (c: Cache, url: string) => void sizesOf(c).then((m) => m.delete(whole(url)));

/**
 * The page's work that no one waits for (the rest of l3's programs readied after a Prompt is up) is done a step
 * at a time in the moments nothing else is being done, so it never comes between a key and what it writes.
 */
const idle = () => new Promise<void>((r) => ('requestIdleCallback' in globalThis ? requestIdleCallback(() => r(), {timeout: 3000}) : setTimeout(r, 100)));
/** The worker that checks l3's files (check.worker.ts), made when first asked; null where there is none. */
let checker: Worker | null | undefined;
let asking = 0;
const answers = new Map<number, (r: {bytes?: ArrayBuffer; sha256?: string; error?: string}) => void>();
const worker = (): Worker | null => {
  if (checker !== undefined) return checker;
  try {
    checker = new Worker(new URL('./check.worker.ts', import.meta.url), {type: 'module'});
    checker.addEventListener('message', (e) => { answers.get(e.data.id)?.(e.data); answers.delete(e.data.id); });
    checker.addEventListener('error', () => { checker = null; for (const f of answers.values()) f({error: 'stopped'}); answers.clear(); });
  } catch { checker = null; }
  return checker;
};
/**
 * `bytes` (unpacked first when `unpack`) and their SHA-256, worked out off the page's thread, which the browser
 * otherwise does on it, holding it 27 ms for 8 MB. `lend`: its buffer is the caller's alone, and is given to the
 * worker and back rather than copied; the caller goes on with the bytes this gives back. Without a worker it is
 * worked out here, as before; a worker stopped with lent bytes in it fails the check (they are read again).
 */
async function checked(bytes: Uint8Array, unpack: boolean, lend: boolean): Promise<{bytes: Uint8Array; sha256: string}>;
/** The same for a translation, given back as the kernel runs it (`as`: xlat's share.mjs prepare), with its size before. */
async function checked(bytes: Uint8Array, unpack: boolean, lend: boolean, as: {shared: boolean}): Promise<{bytes: Uint8Array; sha256: string; size: number; segments: Segment[] | null}>;
async function checked(bytes: Uint8Array, unpack: boolean, lend: boolean, as?: {shared: boolean}): Promise<{bytes: Uint8Array; sha256: string; size?: number; segments?: Segment[] | null}> {
  const w = worker();
  if (w) {
    const own = lend && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const buf = (own ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
    const id = ++asking;
    const r = await new Promise<{bytes?: ArrayBuffer; sha256?: string; size?: number; segments?: Segment[] | null; error?: string}>((resolve) => {
      answers.set(id, resolve);
      w.postMessage({id, bytes: buf, unpack, ...(as ? {prepare: as} : {})}, [buf]);
    });
    if (r.bytes && r.sha256) return {bytes: new Uint8Array(r.bytes), sha256: r.sha256, ...(as ? {size: r.size, segments: r.segments ?? null} : {})};
    // Not worked out there: here, with what was lent back (or the caller's own, when it was a copy that went).
    if (own) bytes = r.bytes ? new Uint8Array(r.bytes) : bytes;
    if (own && !r.bytes) throw new Error('l3: a file could not be checked');
  }
  const b = unpack ? await gunzip(bytes) : bytes;
  const sha256 = await digest(b);
  if (!as) return {bytes: b, sha256};
  const p = prepare(b, as);
  return {bytes: p.wasm, sha256, size: b.length, segments: p.segments};
}
/** A download's check, off the page's thread: the bytes joined are the download's own, lent. */
const offThread: Check = (bytes) => checked(bytes, false, true);

/** No waiting: what a Prompt starting needs, waited for. */
const atOnce = async () => {};

/** A kept copy of `url`, if it is still exactly the digest it was kept under. */
async function kept(url: string, sha256: string): Promise<Uint8Array | null> {
  const c = await open();
  const r = await c?.match(url).catch(() => undefined);
  if (!c || !r) return null;
  // Not checked (its worker stopped): as if it were not kept, it is fetched again.
  const c0 = await checked(new Uint8Array(await r.arrayBuffer()), false, true).catch(() => null);
  if (!c0) return null;
  if (c0.sha256 === sha256) { used(url); return c0.bytes; }
  await c.delete(url).catch(() => false);
  gone(c, url);
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
        gone(c, k);
      }
      if (room() < bytes.length) return false;
    }
    await c.put(url, new Response(bytes as BlobPart, {headers: {'content-type': 'application/octet-stream', 'content-length': String(bytes.length)}}));
    void sizesOf(c).then((m) => m.set(whole(url), bytes.length));
    used(url);
    return true;
  } catch { return false; }
}

async function keptBytes(c: Cache): Promise<number> {
  let n = 0;
  for (const v of (await sizesOf(c)).values()) n += v;
  return n;
}

/** What l3's kept copies hold here, and how many there are (Runtime's On this device). */
export async function keptL3(): Promise<{bytes: number; files: number}> {
  const c = await open();
  if (!c) return {bytes: 0, files: 0};
  return {bytes: await keptBytes(c), files: (await sizesOf(c)).size};
}

/** Whatever the current l3 does not name goes: an l3 before, or what a browser kept of it. */
async function forgetOthers(live: (path: string) => boolean) {
  const c = await open();
  if (!c) return;
  for (const r of await c.keys()) if (!live(new URL(r.url).pathname)) { await c.delete(r).catch(() => false); gone(c, r.url); }
  try {
    const u = uses();
    for (const k of Object.keys(u)) if (!live(k)) delete u[k];
    localStorage.setItem(USES, JSON.stringify(u));
  } catch { /* nothing remembered */ }
}

/**
 * `path` under l3 (its digest checked), from what is kept or else the network; kept for next time. `keptOnly`: from
 * what is kept or not at all (it throws), as what is read ahead on the last start's word is (loadL3).
 */
async function bytesOf(path: string, expect: {sha256: string; size: number}, progress?: Parameters<typeof download>[2], keptOnly = false): Promise<Uint8Array> {
  const url = `${BASE}${path}`;
  const have = await kept(url, expect.sha256);
  if (have) { progress?.bytes(expect.size); return have; }
  if (keptOnly) throw new Error(`l3: ${path} is not kept`);
  const bytes = await download(url, expect, progress, {check: offThread});
  void keep(url, bytes);
  return bytes;
}

const gunzip = async (bytes: Uint8Array) =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

/** A translation's blob, unpacked, checked against what it says it is, and given back as the kernel runs it (prepare), off the page's thread. */
async function translation(b: Blob, shared: boolean, progress?: Parameters<typeof download>[2], step = atOnce, keptOnly = false): Promise<{wasm: Uint8Array; segments: Segment[] | null}> {
  await step();
  const {bytes, size, segments} = await checked(await bytesOf(b.path, b, progress, keptOnly), true, false, {shared});
  await step();
  if (size !== b.bytes) throw new Fatal(`l3: ${b.path} is not what its index says`);
  return {wasm: bytes, segments};
}

/** A blob's bytes, unpacked and checked against what it says it is (a program's against its sha256). */
async function unblob(b: Blob, progress?: Parameters<typeof download>[2], sha256?: string, step = atOnce, keptOnly = false): Promise<Uint8Array> {
  await step();
  // Unpacked and checked off the page's thread; a copy goes, as what was fetched may be on its way to be kept.
  const {bytes, sha256: is} = await checked(await bytesOf(b.path, b, progress, keptOnly), true, false);
  await step();
  if (bytes.length !== b.bytes || (sha256 && is !== sha256)) throw new Fatal(`l3: ${b.path} is not what its index says`);
  return bytes;
}

// ---- code reached later, kept ----
//
// A hot program's translation made ahead of time is not the whole of it: the code a shell reaches as it starts and as
// each command runs (an applet, a path taken once) is translated as it is reached, about a hundred modules for a shell
// to its first prompt line, each translated, compiled, and copied into every thread that runs it. What a Prompt
// reached is kept, as the kernel made it, for the Prompts after it: in this page, and in what is kept under the
// program's translation (and the translator, and whether memory is shared), so a Prompt opened tomorrow starts from
// all its shell reached today. Kept as l3's other copies are (its digest checked when it is read, within the same
// share of the browser's room, the least recently used going first), and never canonical: lost, it is made again.

/** Of code reached later, at most this many modules are kept for a program: each thread of a Prompt instantiates them all. */
const MORE_MOST = 256;
/** Each hot program's code reached later in this page: the modules in the order made, and how many of them are kept. */
const more = new Map<string, {url: string; list: More[]; saved: number; timer: number}>();
const moreURL = (t: Translation, translator: string, shared: boolean) => `${BASE}more/${t.wasm.sha256}-${translator.slice(0, 16)}-${shared ? 's' : 'u'}.bin`;
const MAGIC = 0x4c334d31;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Kept modules as one copy: 'L3M1', how many, each module's first table slot, length and bytes; then the SHA-256 of all that. */
async function packMore(list: {bytes: Uint8Array; base: number}[]): Promise<Uint8Array> {
  const size = 8 + list.reduce((n, m) => n + 8 + m.bytes.length, 0);
  const body = new Uint8Array(size);
  const v = new DataView(body.buffer);
  v.setUint32(0, MAGIC);
  v.setUint32(4, list.length);
  let at = 8;
  for (const m of list) { v.setUint32(at, m.base); v.setUint32(at + 4, m.bytes.length); body.set(m.bytes, at + 8); at += 8 + m.bytes.length; }
  return sealed(body);
}

/** The modules kept at `url`, compiled; none when nothing is kept there or it is not what was kept (it goes). */
async function keptMore(url: string): Promise<More[]> {
  const c = await open();
  const r = await c?.match(url).catch(() => undefined);
  if (!c || !r) return [];
  const all = new Uint8Array(await r.arrayBuffer());
  try {
    if (all.length < 40) throw new Error('not what was kept');
    const body = all.subarray(0, all.length - 32);
    const {sha256} = await checked(body.slice(), false, true);
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (sha256 !== hex(all.subarray(all.length - 32)) || v.getUint32(0) !== MAGIC) throw new Error('not what was kept');
    const parts: {base: number; bytes: Uint8Array}[] = [];
    for (let at = 8, k = v.getUint32(4); k > 0; k--) {
      const len = v.getUint32(at + 4);
      parts.push({base: v.getUint32(at), bytes: body.slice(at + 8, at + 8 + len)});
      at += 8 + len;
    }
    const modules = await Promise.all(parts.map((p) => WebAssembly.compile(p.bytes as BufferSource)));
    used(url);
    return parts.map((p, k) => ({module: modules[k], bytes: p.bytes, base: p.base}));
  } catch {
    await c.delete(url).catch(() => false);
    gone(c, url);
    return [];
  }
}

/** What a hot program's Prompt reached later (the kernel's modules from the `from`th on): kept for the Prompts after it. */
export function keepMore(path: string, from: number, list: More[]) {
  const m = more.get(path);
  // Made from a start this page no longer holds (another Prompt kept more meanwhile): its own, not followed.
  if (!m || from > m.list.length || from >= MORE_MOST) return;
  m.list = [...m.list.slice(0, from), ...list].slice(0, MORE_MOST);
  if (from < m.saved) m.saved = -1;
  save(m);
}

// ---- every other program's translation, kept ----
//
// A program of the root that is not one of the hot ones is translated when a Prompt first runs it: gcc building a
// file translates the driver, cc1 (39 MB), the assembler and the linker, eight seconds in all, and the next Prompt,
// in this page or after it, translated them all again. What a Prompt translates of the root is kept, by where its
// file is in the root (its pack, named by its digest, and its place there: xlat/runtime/pack.mjs origin), with the
// code it reached later, and the next Prompt's kernel reads it from here when the program is first run
// (xlat/runtime/keeper.mjs), not even reading the program itself unless it reaches code it never reached before.

/** Where the root's programs' translations are kept, under l3's own copies. */
const TRANSLATED = `${BASE}tr/`;
/** What a kept translation was made by: this translator, for memory shared or not. */
const keptTag = (index: Index) => `${index.translator.sha256.slice(0, 16)}-${threadsApart() ? 's' : 'u'}`;
const translatedURL = (origin: string, tag: string, part: 'wasm' | 'more') => `${TRANSLATED}${origin}-${tag}.${part}`;
/** The origin a kept translation's path is of, when it was made with `tag`; null otherwise. */
const keptOrigin = (path: string, tag: string): string | null => {
  const m = /^(.+)-([^-]+-[su])\.(wasm|more)$/.exec(path.slice(TRANSLATED.length));
  return m && m[2] === tag ? m[1] : null;
};

/** What a Prompt's kernel is told is kept ({cache, at: {[origin]: {main, more}}}, xlat/runtime/keeper.mjs). */
export async function keptNow(l3: L3): Promise<{cache: string; at: Record<string, {main: string; more: string | null}>} | null> {
  const c = await open();
  if (!c) return null;
  const tag = keptTag(l3.index), at: Record<string, {main: string; more: string | null}> = {};
  const paths = new Set((await c.keys()).map((r) => new URL(r.url).pathname).filter((p) => p.startsWith(TRANSLATED)));
  for (const p of paths) {
    const origin = keptOrigin(p, tag);
    if (origin === null || !p.endsWith('.wasm')) continue;
    const more = translatedURL(origin, tag, 'more');
    at[origin] = {main: whole(p), more: paths.has(more) ? whole(more) : null};
  }
  return {cache: CACHE, at};
}

/** A kept copy's SHA-256 after it. */
async function sealed(body: Uint8Array): Promise<Uint8Array> {
  const {sha256} = await checked(body.slice(), false, true);
  const out = new Uint8Array(body.length + 32);
  out.set(body);
  out.set(Uint8Array.from(sha256.match(/../g)!.map((x) => parseInt(x, 16))), body.length);
  return out;
}

/**
 * The code each program translated or read here reached later, as its Prompts said it, and how many of its modules
 * are kept; for one read from what is kept, what was kept of it is read first (`ready`), to go on from.
 */
type Reached = {list: {bytes: Uint8Array; base: number}[]; saved: number; timer: number; url: string; ready: Promise<void>};
const reached = new Map<string, Reached>();

/**
 * A program a Prompt translated (its module as the kernel runs it, and its data segments, or null when they are in
 * it): kept for the Prompts after it, 'L3T1' (keeper.mjs).
 */
export function keepTranslation(l3: L3, origin: string, wasm: Uint8Array, segments: Segment[] | null) {
  const tag = keptTag(l3.index);
  reached.set(origin, {list: [], saved: 0, timer: 0, url: translatedURL(origin, tag, 'more'), ready: Promise.resolve()});
  void (async () => {
    await idle();
    const n = segments?.length ?? 0;
    const body = new Uint8Array(8 + (segments ?? []).reduce((k, s) => k + 8 + s.bytes.length, 0) + 4 + wasm.length);
    const v = new DataView(body.buffer);
    v.setUint32(0, 0x4c335431);
    v.setUint32(4, segments ? n : 0xffffffff);
    let at = 8;
    for (const s of segments ?? []) { v.setUint32(at, s.offset); v.setUint32(at + 4, s.bytes.length); body.set(s.bytes, at + 8); at += 8 + s.bytes.length; }
    v.setUint32(at, wasm.length);
    body.set(wasm, at + 4);
    await keep(translatedURL(origin, tag, 'wasm'), await sealed(body));
    // The code an earlier translation of it reached later went with that one (a program translated again as one
    // module: xlat's Kernel.consolidate): a Prompt after would read it all, to take none of it.
    const c = await open();
    const more = translatedURL(origin, tag, 'more');
    if (c && reached.get(origin)?.saved === 0 && await c.delete(more).catch(() => false)) gone(c, more);
  })().catch(() => {});
}

/** The code a translated program reached later (the kernel's modules from the `from`th on): kept with it. */
export function keepReached(l3: L3, origin: string, from: number, list: {bytes: Uint8Array; base: number}[]) {
  let r = reached.get(origin);
  if (!r) {
    // A program read from what was kept, reaching code it never reached before: on from what was kept of it.
    const url = translatedURL(origin, keptTag(l3.index), 'more');
    const entry: Reached = {list: [], saved: 0, timer: 0, url, ready: Promise.resolve()};
    entry.ready = (async () => {
      const c = await open();
      const kept = await c?.match(url).catch(() => undefined);
      if (!kept) return;
      const all = new Uint8Array(await kept.arrayBuffer());
      const body = all.subarray(0, Math.max(0, all.length - 32));
      if (all.length < 40 || (await checked(body.slice(), false, true)).sha256 !== hex(all.subarray(all.length - 32))) return;
      entry.list = unpackMore(body);
      entry.saved = entry.list.length;
    })().catch(() => {});
    reached.set(origin, r = entry);
  }
  const at = r;
  void at.ready.then(() => {
    if (from > at.list.length) return;
    at.list = [...at.list.slice(0, from), ...list];
    if (from < at.saved) at.saved = -1;
    // Kept, it is let go here (a compiler's is tens of megabytes): more reached after is put on what is kept, read again.
    save(at, () => { if (reached.get(origin) === at) reached.delete(origin); });
  });
}

/** What a program reached later, kept a moment after it last grew, when nothing else is being done: a run reaches its code a module at a time. */
function save(r: {list: {bytes: Uint8Array; base: number}[]; saved: number; timer: number; url: string}, then = () => {}) {
  clearTimeout(r.timer);
  r.timer = window.setTimeout(() => void (async () => {
    await idle();
    const n = r.list.length;
    if (n === r.saved) return;
    if (await keep(r.url, await packMore(r.list))) { r.saved = n; then(); }
  })().catch(() => {}), 2000);
}

/** Kept copies a Prompt's kernel read: used now, so they are not the first to go. */
export const usedKept = (urls: string[]) => { for (const u of urls) used(new URL(u).pathname); };

/**
 * What a Prompt is given for a hot program: its bytes and its compiled
 * translation, and the code it reached later in Prompts before. A translation the engine will not compile is
 * made again by the translator when its program runs.
 */
async function hot(t: Translation, mode: number, translator: string, progress?: Parameters<typeof download>[2], step = atOnce, keptOnly = false) {
  // As the kernel runs it (xlat/runtime/share.mjs): its data kept beside it, its memory shared where the page may share memory.
  const shared = threadsApart();
  const url = moreURL(t, translator, shared);
  // What was reached later before: read as the program is, and given with it (taken).
  const reached = more.has(t.path) ? Promise.resolve([]) : keptMore(url).catch(() => []);
  // Waited for (a Prompt starting), both at once; readied quietly (`step` is idle), one after the other.
  const [bytes, p] = step === atOnce ? await Promise.all([unblob(t.elf, progress, t.sha256, atOnce, keptOnly), translation(t.wasm, shared, progress, atOnce, keptOnly)])
    : [await unblob(t.elf, progress, t.sha256, step), await translation(t.wasm, shared, progress, step)];
  await step();
  const module = await WebAssembly.compile(p.wasm as BufferSource).catch(() => null);
  return {path: t.path, bytes, module, mode, segments: module ? p.segments : null, shared, reached: module ? await reached : [], moreURL: url};
}
type Hot = Awaited<ReturnType<typeof hot>>;

/** A hot program's code reached later in Prompts before, taken up for this page's Prompts (once per program). */
function taken(f: Hot): L3['files'][number] {
  if (!more.has(f.path)) more.set(f.path, {url: f.moreURL, list: f.reached, saved: f.reached.length, timer: 0});
  const {reached: _r, moreURL: _u, ...file} = f;
  return file;
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
      const f = await hot(t, index.files.find((x) => x.path === t.path)?.mode ?? 0o755, index.translator.sha256, undefined, idle).catch(() => null);
      if (f?.module) later.set(t.path, taken(f));
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

/**
 * What a Prompt starting needed of l3, as the last start found it (which l3, its index, its translator, the hot
 * programs it waits for): read from what is kept at once next time, while l3.json is asked whether it is still that.
 */
interface Plan { sha256: string; index: About['index']; translator: Index['translator']; first: {t: Translation; mode: number}[] }
const PLAN = 'length3.l3.start';
const planned = (): Plan | null => { try { return JSON.parse(localStorage.getItem(PLAN) ?? 'null') as Plan | null; } catch { return null; } };

let loading: Promise<L3> | null = null;
/**
 * l3 for a Prompt: its index, the translator and the hot programs (once per page; again after a failure). What the
 * last start needed is read ahead from what is kept (only that: nothing is fetched on its word), the translator
 * compiled and the hot programs readied, all at once and while l3.json is asked for; it is used only when l3.json
 * names the same l3 and index, and otherwise everything is read as l3.json says, one after another as before.
 */
export const loadL3 = (): Promise<L3> => (loading ??= (async () => {
  // The worker that checks what is read, started now rather than at the first check.
  worker();
  const plan = planned();
  const ahead = plan ? Promise.all([
    bytesOf(plan.index.path, plan.index, undefined, true),
    unblob(plan.translator, undefined, undefined, atOnce, true).then((w) => WebAssembly.compile(w as BufferSource)),
    ...plan.first.map(({t: p, mode}) => hot(p, mode, plan.translator.sha256, undefined, atOnce, true)),
  ]).catch(() => null) : null;
  const a = await download(`${BASE}l3.json`, {}, undefined, {attempts: 4}).then((b) => {
    // Not JSON is a build without l3 (the host answered with the page): said so, never the parser's words.
    try { return JSON.parse(new TextDecoder().decode(b)) as About; } catch { throw new Fatal(t('l3 missing (run: npm run l3)')); }
  });
  const read = plan && plan.sha256 === a.sha256 && plan.index.sha256 === a.index.sha256 ? await ahead : null;
  const index0 = read ? read[0] as Uint8Array : await bytesOf(a.index.path, a.index);
  const index = JSON.parse(new TextDecoder().decode(index0)) as Index;
  if (index.sha256 !== a.sha256 || index.version !== a.version) throw new Fatal(`l3: its index is of another root (${index.version})`);
  const modeOf = (path: string) => index.files.find((f) => f.path === path)?.mode ?? 0o755;
  const first = index.translations.filter((t) => FIRST.includes(t.path));
  const live = new Set([`${BASE}${a.index.path}`, `${BASE}${index.translator.path}`,
    ...index.translations.flatMap((t) => [`${BASE}${t.elf.path}`, `${BASE}${t.wasm.path}`, moreURL(t, index.translator.sha256, threadsApart())])]);
  // And the translations Prompts made of the root's programs, by this translator, of files in this root's packs.
  const packs = new Set(index.packs.map((p) => p.name.replace(/\.pack$/, '')));
  const tag = keptTag(index);
  void forgetOthers((path) => live.has(path) || (path.startsWith(TRANSLATED) && keptOrigin(path, tag) !== null && packs.has(keptOrigin(path, tag)!.split('_')[0])));
  // Progress over everything this start waits for: the translator and each program it is given now.
  const parts = [index.translator, ...first.flatMap((t) => [t.elf, t.wasm])];
  const of = parts.reduce((n, p) => n + p.size, 0);
  const got = new Map<string, number>();
  const progress = (p: Blob) => ({
    bytes(n: number) { got.set(p.path, n); tell({at: 'fetch', got: [...got.values()].reduce((x, y) => x + y, 0), of}); },
    retry(attempt: number, why: string) { tell({at: 'retry', attempt, why, got: [...got.values()].reduce((x, y) => x + y, 0), of}); },
    waiting(quiet: number) { tell({at: 'fetch', got: [...got.values()].reduce((x, y) => x + y, 0), of, quiet}); },
  });
  let translator: WebAssembly.Module, files: Hot[];
  if (read) [translator, ...files] = read.slice(1) as [WebAssembly.Module, ...Hot[]];
  else {
    tell({at: 'fetch', got: 0, of});
    const [translatorWasm, ...hots] = await Promise.all([
      unblob(index.translator, progress(index.translator)),
      ...first.map((t) => hot(t, modeOf(t.path), index.translator.sha256, progress(t.wasm))),
    ]);
    tell({at: 'prepare'});
    translator = await WebAssembly.compile(translatorWasm as BufferSource);
    files = hots as Hot[];
  }
  try {
    const next: Plan = {sha256: a.sha256, index: a.index, translator: index.translator, first: first.map((x) => ({t: x, mode: modeOf(x.path)}))};
    localStorage.setItem(PLAN, JSON.stringify(next));
  } catch { /* not remembered: the next start reads as l3.json says */ }
  tell({at: 'ready'});
  return {about: a, index, translator, files: files.map(taken), url: new URL(BASE, location.href).href};
})().catch((e) => {
  loading = null;
  tell({at: 'failed', message: errorText(e)});
  throw e;
}));

/** Once a Prompt is up: what the next one is given ahead of time comes now, quietly. */
export const warmL3 = (l3: L3) => warm(l3.index);

/**
 * What a Prompt starting now is given beside the packs: BusyBox, and each other hot program once it is ready, each
 * with the code it reached later in the Prompts before.
 */
export const filesNow = (l3: L3): L3['files'] => [...l3.files, ...later.values()].map((f) => ({...f, more: more.get(f.path)?.list ?? []}));

/** The Prompt's Worker: xlat running l3's root (pages/bench/terminal.ts gives it l3 and the repo). */
export const promptWorker = (): Worker => new Worker(new URL('../../../xlat/runtime/worker.mjs', import.meta.url), {type: 'module'});
