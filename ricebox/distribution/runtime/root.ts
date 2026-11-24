export {retireRootWorker, type RootRetirement} from './retire-worker.ts';
import {createExecutionProfile} from './execution-profile.ts';
import {executableKey, canonicalHotSources} from './prepared-executable.ts';
import {canonicalExecutableSource} from '../format/executable-source.ts';
import {createAhead} from './pretranslate.ts';
import {blobAsset, readReleaseIndex, releaseIndexAsset, requireStandardFileOwner, type ExecutableArtifact} from '../format/manifest.ts';
import {download as fetchFile, Fatal, type Check} from './download.ts';
import {createAssetCache} from './asset-cache.ts';
import {compileFramedAot} from './framed-aot.ts';
import {shardedAotResponse} from './aot-shards.ts';
import {aotObjects} from '../format/aot-frames.ts';
import {FIRST} from './startup-programs.ts';
import {trackTransfers, type AssetProgress, type Stage} from './load-progress.ts';
export type {Stage} from './load-progress.ts';
import {canRunApart} from '../../sods/runtime/host.ts';
import {MORE, madeBy, packMain, packMore, unpackMore, type Segment} from '../../sods/runtime/translate.ts';
export type {Segment, Blob, About, Translation, Index, Webroot, RootContext, PreparedRoot, PreparedExecutable, More} from './root-types.ts';
import type {About, Blob, Index, More, Translation, Webroot, RootContext, PreparedExecutable} from './root-types.ts';
interface Plan { sha256: string; index: About['index']; translator: Index['translator']; first: {t: Translation; mode: number}[] }
export interface RootConfig {
  base: string;
  /** Programs to prepare before the first guest starts. Defaults to startup-programs.ts. */
  first?: readonly string[];
  usedKey: string;
  planKey: string;
  oldKeys?: readonly string[];
  oldCaches?: readonly string[];
  /** Close this loader’s asset-check admission with its host, not its guest Workers. */
  checkSignal?: AbortSignal;
  /** Let the drained asset-check Worker rest after the prepared root has loaded. */
  restCheckerAfterLoad?: boolean;
  message: NonNullable<import('./download.ts').Options['message']>;
  missing(): string;
  errorText(error: unknown): string;
}

/** A box as it is written for muk (../src/bundle.rs): config.json, and the words muk is run with. */
export interface Box { config: string; words: string[] }
/** Where a page's bundle is, in the tree its Worker's kernel is given: under the tmpfs the box has at /run. */
export const BOX = '/run/box';

/** Load and run a distribution using the embedding host's release and startup choices. */
export function createRoot(config: RootConfig) {
  requireStandardFileOwner(config);
  const download: typeof fetchFile = (url, expect, progress, options) =>
    fetchFile(url, expect, progress, {message: config.message, ...options});
  const startupPrograms = config.first ?? FIRST;
  const threadsApart = canRunApart;
  const BASE = config.base;
  const {cache, whole, used, open, gone, worker, checked, kept, keep, keepParts, keptWebroot, forgetOthers, restChecker} =
    createAssetCache(config);

  const watchers = new Set<(s: Stage) => void>();
  let last: Stage = {at: 'prepare'};
  const tell = (s: Stage) => { last = s; for (const w of [...watchers]) w(s); };

  /** Hear where loading is (at once, then as it moves); returns how to stop. */
  function watchLoad(fn: (s: Stage) => void): () => void {
    watchers.add(fn);
    fn(last);
    return () => watchers.delete(fn);
  }

  /** Release metadata for views that also support an application with no installed root. */
  const about = async (): Promise<About | null> => {
    const r = await fetch(`${BASE}webroot.json`, {cache: 'no-cache'});
    // This build carries none (a server without it answers 404, or with the page itself).
    if (r.status === 404 || !r.headers.get('content-type')?.includes('json')) { await r.body?.cancel(); return null; }
    if (!r.ok) throw new Fatal(`webroot.json: ${r.status}`);
    return await r.json() as About;
  };

  /** Yield between background preparation steps. */
  const idle = () => new Promise<void>((r) => ('requestIdleCallback' in globalThis ? requestIdleCallback(() => r(), {timeout: 3000}) : setTimeout(r, 100)));
  /** A download's check, off the page's thread: the bytes joined are the download's own, lent. */
  const offThread: Check = (bytes) => checked(bytes, false, true);

  /** No waiting: what a Prompt starting needs, waited for. */
  const atOnce = async () => {};

  /** Read a verified asset from the cache or network. Speculation may use the cache only. */
  async function bytesOf(path: string, expect: {sha256: string; size: number}, progress?: AssetProgress, keptOnly = false): Promise<Uint8Array> {
    const url = `${BASE}${path}`;
    const have = await kept(url, expect.sha256);
    if (have) {
      if (have.byteLength !== expect.size) throw new Fatal(`webroot: ${path} has the wrong size`);
      progress?.verified();
      return have;
    }
    if (keptOnly) throw new Error(`webroot: ${path} is not kept`);
    const bytes = await download(url, expect, progress, {check: offThread});
    progress?.verified();
    void keep(url, bytes);
    return bytes;
  }

  /** A translation's blob, unpacked, checked against what it says it is, and given back as the kernel runs it (prepare), off the page's thread. */
  async function translation(b: Blob, shared: boolean, progress?: AssetProgress, step = atOnce, keptOnly = false): Promise<{wasm: Uint8Array; segments: Segment[] | null}> {
    await step();
    const asset = blobAsset(b);
    const {bytes, size, segments} = await checked(await bytesOf(asset.path, asset, progress, keptOnly), true, false, {shared});
    await step();
    if (size !== b.bytes) throw new Fatal(`webroot: ${b.path} is not what its index says`);
    return {wasm: bytes, segments};
  }

  /** A blob's bytes, unpacked and checked against what it says it is (a program's against its sha256). */
  async function unblob(b: Blob, progress?: AssetProgress, sha256?: string, step = atOnce, keptOnly = false): Promise<Uint8Array> {
    await step();
    // Unpacked and checked off the page's thread; a copy goes, as what was fetched may be on its way to be kept.
    const asset = blobAsset(b);
    const {bytes, sha256: is} = await checked(await bytesOf(asset.path, asset, progress, keptOnly), true, false);
    await step();
    if (bytes.length !== b.bytes || (sha256 && is !== sha256)) throw new Fatal(`webroot: ${b.path} is not what its index says`);
    return bytes;
  }

  // Incremental modules reached by programs with ahead-of-time translations.
  /** Of code reached later, at most this many modules are kept for a program: each thread of a Prompt instantiates them all. */
  const MORE_MOST = 256;
  /** Each hot program's code reached later in this page: the modules in the order made, and how many of them are kept. */
  const more = new Map<string, {url: string; list: More[]; saved: number; timer: number}>();
  const moreURL = (t: ExecutableArtifact, translator: string, shared: boolean) => `${BASE}more/${t.wasm.sha256}-${madeBy(translator, shared)}.bin`;
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

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
      if (sha256 !== hex(all.subarray(all.length - 32)) || new DataView(body.buffer, body.byteOffset).getUint32(0) !== MORE) throw new Error('not what was kept');
      const parts = unpackMore(body);
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
  function keepMore(path: string, from: number, list: More[]) {
    const m = more.get(path);
    // Made from a start this page no longer holds (another Prompt kept more meanwhile): its own, not followed.
    if (!m || from > m.list.length || from >= MORE_MOST) return;
    m.list = [...m.list.slice(0, from), ...list].slice(0, MORE_MOST);
    if (from < m.saved) m.saved = -1;
    save(m);
  }

  // Demand translations are keyed by the source's pack origin, translator and memory mode.
  /** Directory used for demand translations in this distribution's cache. */
  const TRANSLATED = `${BASE}tr/`;
  /** What a kept translation was made by: this translator, for memory shared or not. */
  const keptTag = (index: Index) => madeBy(index.translator.sha256, threadsApart());
  const translatedURL = (origin: string, tag: string, part: 'wasm' | 'more') => `${TRANSLATED}${origin}-${tag}.${part}`;
  /** The origin of a cached translation produced with this translator and memory mode. */
  const keptOrigin = (url: string, tag: string): string | null => {
    const prefix = whole(TRANSLATED);
    if (!url.startsWith(prefix)) return null;
    const m = /^(.+)-([^-]+-[su])\.(wasm|more)$/.exec(url.slice(prefix.length));
    return m && m[2] === tag ? m[1] : null;
  };

  /** Keep only this release's inputs and translations for its current packs. */
  function keepReleaseFiles(about: About, index: Index, mukPath?: string): void {
    // Prepared execution still ships the ELF blobs used by the legacy profile.
    const live = new Set([
      `${BASE}${about.index.path}`, `${BASE}${index.translator.path}`, ...(mukPath ? [`${BASE}${mukPath}`] : []),
      ...index.translations.flatMap(t => [`${BASE}${t.elf.path}`, `${BASE}${t.wasm.path}`, moreURL(t, index.translator.sha256, threadsApart())]),
      ...(index.execution?.programs.flatMap(t => aotObjects(t.wasm).map(asset => `${BASE}${asset.path}`)) ?? []),
    ].map(whole));
    const packs = new Set(index.packs.map(p => p.name.replace(/\.pack$/, ''))), tag = keptTag(index);
    void forgetOthers(url => {
      if (live.has(url)) return true;
      const origin = keptOrigin(url, tag);
      return origin !== null && packs.has(origin.split('_')[0]!);
    });
  }

  /** What a Prompt's kernel is told is kept ({cache, at: {[origin]: {main, more}}}, sods' keeper). */
  async function keptNow(webroot: RootContext): Promise<{cache: string; at: Record<string, {main: string; more: string | null}>} | null> {
    const c = await open();
    if (!c) return null;
    const tag = keptTag(webroot.index), at: Record<string, {main: string; more: string | null}> = {};
    const urls = new Set((await c.keys()).map(r => r.url));
    for (const main of urls) {
      const origin = keptOrigin(main, tag);
      if (origin === null || !main.endsWith('.wasm')) continue;
      const more = whole(translatedURL(origin, tag, 'more'));
      at[origin] = {main, more: urls.has(more) ? more : null};
    }
    return {cache: cache(), at};
  }

  /** Incremental translated modules and the cache entry they extend. */
  type Reached = {list: {bytes: Uint8Array; base: number}[]; saved: number; timer: number; url: string; ready: Promise<void>};
  const reached = new Map<string, Reached>();

  /** Where a file of the root is in its pack, as a translation of it is kept by (mount.ts origin). */
  const originOf = (index: Index, f: Index['files'][number]) => `${index.packs[f.pack].name.replace(/\.pack$/, '')}_${f.at}_${f.len}`;

  /** Whether a translation of the file at `origin`, by this translator, is kept here. */
  async function translationKept(webroot: RootContext, origin: string): Promise<boolean> {
    const c = await open();
    return !!(await c?.match(translatedURL(origin, keptTag(webroot.index), 'wasm')).catch(() => undefined));
  }

  /**
   * A program a Prompt translated, or one translated ahead of its first run (pretranslate.ts) (its module as the kernel runs
   * it, and its data segments, or null when they are in it): kept for the Prompts after it, 'L3T1' (sods/runtime/kept.ts). Once
   * kept, the URL it is kept at; null when it is not (no room, no Cache Storage).
   */
  function keepTranslation(webroot: RootContext, origin: string, wasm: Uint8Array, segments: Segment[] | null): Promise<string | null> {
    const tag = keptTag(webroot.index);
    reached.set(origin, {list: [], saved: 0, timer: 0, url: translatedURL(origin, tag, 'more'), ready: Promise.resolve()});
    return (async () => {
      await idle();
      // 'L3T1' (sods/runtime/kept.ts), joined and sealed off the page's thread, the parts its own (lent): the module and
      // segments are kept, not used here after.
      const parts = packMain(wasm, segments);
      const main = translatedURL(origin, tag, 'wasm');
      const kept = await keepParts(main, parts, true, true);
      // The code an earlier translation of it reached later went with that one (a program translated again as one
      // module: muk's Kernel.consolidate): a Prompt after would read it all, to take none of it.
      const c = await open();
      const more = translatedURL(origin, tag, 'more');
      if (c && reached.get(origin)?.saved === 0 && await c.delete(more).catch(() => false)) gone(c, more);
      return kept ? whole(main) : null;
    })().catch(() => null);
  }

  /** The code a translated program reached later (the kernel's modules from the `from`th on): kept with it. */
  function keepReached(webroot: RootContext, origin: string, from: number, list: {bytes: Uint8Array; base: number}[]) {
    let r = reached.get(origin);
    if (!r) {
      // A program read from what was kept, reaching code it never reached before: on from what was kept of it.
      const url = translatedURL(origin, keptTag(webroot.index), 'more');
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
  function save(r: {list: {bytes: Uint8Array; base: number}[]; saved: number; timer: number; url: string}, then?: () => void) {
    clearTimeout(r.timer);
    r.timer = window.setTimeout(() => void (async () => {
      await idle();
      const n = r.list.length;
      if (n === r.saved) return;
      // Let go once kept (`then`), the modules go to be kept as they are (lent), kept or not; followed on (a hot
      // program's, given to the Prompts after), a copy of them goes.
      if (await keepParts(r.url, packMore(r.list), true, !!then)) r.saved = n;
      else if (then) r.saved = -1;
      then?.();
    })().catch(() => {}), 2000);
  }

  /** Kept copies a Prompt's kernel read: used now, so they are not the first to go. */
  const usedKept = (urls: string[]) => { for (const url of urls) used(url); };

  /**
   * What a Prompt is given for a hot program: its bytes and its compiled
   * translation, and the code it reached later in Prompts before. A translation the engine will not compile is
   * made again by the translator when its program runs.
   */
  async function hot(t: Translation, mode: number, translator: string, progress?: (blob: Blob) => AssetProgress, step = atOnce, keptOnly = false) {
    // As the kernel runs it (sods/runtime/share.ts): its data kept beside it, its memory shared where the page may share memory.
    const shared = threadsApart();
    const url = moreURL(t, translator, shared);
    // What was reached later before: read as the program is, and given with it (taken).
    const reached = more.has(t.path) ? Promise.resolve([]) : keptMore(url).catch(() => []);
    // Waited for (a Prompt starting), both at once; readied quietly (`step` is idle), one after the other.
    const [bytes, p] = step === atOnce ? await Promise.all([unblob(t.elf, progress?.(t.elf), t.sha256, atOnce, keptOnly), translation(t.wasm, shared, progress?.(t.wasm), atOnce, keptOnly)])
      : [await unblob(t.elf, progress?.(t.elf), t.sha256, step, keptOnly), await translation(t.wasm, shared, progress?.(t.wasm), step, keptOnly)];
    await step();
    const module = await WebAssembly.compile(p.wasm as BufferSource).catch(() => null);
    return {path: t.path, bytes, module, mode, segments: module ? p.segments : null, shared, reached: module ? await reached : [], moreURL: url};
  }
  type Hot = Awaited<ReturnType<typeof hot>>;

  /** A hot program's code reached later in Prompts before, taken up for this page's Prompts (once per program). */
  function taken(f: Hot): Webroot['files'][number] {
    if (!more.has(f.path)) more.set(f.path, {url: f.moreURL, list: f.reached, saved: f.reached.length, timer: 0});
    const {reached: _r, moreURL: _u, ...file} = f;
    return {...file, root: true};
  }

  /**
   * The rest of the hot programs (why, git), after a Prompt is up: fetched (or
   * read from what is kept) and compiled quietly, then given to every Prompt
   * started after. Never waited for: compiling their translations takes seconds,
   * and until one is ready its program is translated as it runs, as every other.
   */
  const later = new Map<string, Webroot['files'][number]>();
  let warming: Promise<void> | null = null;
  function warm(index: Index) {
    warming ??= (async () => {
      for (const t of index.translations) {
        if (startupPrograms.includes(t.path) || later.has(t.path)) continue;
        const f = await hot(t, index.files.find((x) => x.path === t.path)?.mode ?? 0o755, index.translator.sha256, undefined, idle).catch(() => null);
        if (!f?.module) continue;
        const file = taken(f);
        later.set(t.path, file);
        for (const h of hearing) h(withMore(file));
      }
    })();
  }

  /** Each Prompt up, told of each hot program as it is ready (hearLater). */
  const hearing = new Set<(f: Webroot['files'][number]) => void>();
  /**
   * `hear` each hot program ready after a Prompt started (warm): those ready already at once, the rest as they come, until
   * the function returned is called. A Prompt up gives each to its Worker, so the next run of git or why in it runs its
   * translation, not one made as it runs (the page's first Prompt is up before they are ready).
   */
  function hearLater(hear: (f: Webroot['files'][number]) => void): () => void {
    for (const f of later.values()) hear(withMore(f));
    hearing.add(hear);
    return () => { hearing.delete(hear); };
  }

  /** The release metadata required by either execution profile. */
  async function loadAbout(): Promise<About> {
    const bytes = await download(`${BASE}webroot.json`, {}, undefined, {attempts: 4});
    try { return JSON.parse(new TextDecoder().decode(bytes)) as About; }
    catch { throw new Fatal(config.missing()); }
  }

  /** A release may not provide Muk. If its listed blob fails verification, loading fails. */
  function loadMaker(): Promise<{bytes: Uint8Array; path: string} | null> {
    const maker = download(`${BASE}muk.json`, {}, undefined, {attempts: 2})
      .then(bytes => JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      .then(async value => {
        const asset = blobAsset(value);
        return {bytes: await bytesOf(asset.path, asset), path: asset.path};
      }, () => null);
    // The other release inputs load in parallel. An integrity failure still
    // propagates when awaited, even if another input has already failed.
    void maker.catch(() => {});
    return maker;
  }

  function checkMaker(index: Index, maker: Awaited<ReturnType<typeof loadMaker>>) {
    const deployed = index.execution?.maker;
    if (deployed && (maker?.path !== deployed.path || maker.bytes.byteLength !== deployed.size)) {
      throw new Fatal('webroot: the box maker disagrees with the deployed Wasm index');
    }
  }

  // Share demand reads of exactly the same stored index while pending. Each
  // consumer still parses it and binds it to the release it saw; cache-only
  // speculation and later reads keep their existing policies.
  const indexReads = new Map<string, Promise<Uint8Array>>();
  function verifiedIndexBytes(asset: About['index']): Promise<Uint8Array> {
    const key = `${asset.path}:${asset.sha256}:${asset.size}`;
    const pending = indexReads.get(key);
    if (pending) return pending;
    const reading = Promise.resolve().then(() => bytesOf(asset.path, asset));
    indexReads.set(key, reading);
    const clear = () => { indexReads.delete(key); };
    void reading.then(clear, clear);
    return reading;
  }

  /** The authenticated index for consumers that do not start a guest. */
  let indexing: Promise<Index | null> | null = null;
  const rootIndex = (): Promise<Index | null> => (indexing ??= (async () => {
    const a = await about();
    if (!a) return null;
    const asset = releaseIndexAsset(a);
    return readReleaseIndex(await verifiedIndexBytes(asset), a);
  })().catch((e) => { indexing = null; throw e; }));

  /**
   * What a Prompt starting needed of why, as the last start found it (which why, its index, its translator, the hot
   * programs it waits for): read from what is kept at once next time, while webroot.json is asked whether it is still that.
   */

  const PLAN = config.planKey;
  const planned = (): Plan | null => {
    try {
      const plan: Plan | null = JSON.parse(localStorage.getItem(PLAN) ?? 'null');
      if (!plan || !plan.translator || !Array.isArray(plan.first) || plan.first.some(part => !part?.t)) return null;
      releaseIndexAsset(plan);
      return plan;
    } catch { return null; }
  };

  let loading: Promise<Webroot> | null = null;
  /**
   * why for a Prompt: its index, the translator and the hot programs (once per page; again after a failure). What the
   * last start needed is read ahead from what is kept (only that: nothing is fetched on its word), the translator
   * compiled and the hot programs readied, all at once and while webroot.json is asked for; it is used only when webroot.json
   * names the same why and index, and otherwise everything is read as webroot.json says, one after another as before.
   */
  const loadWebroot = (): Promise<Webroot> => (loading ??= (async () => {
    // The worker that checks what is read, started now rather than at the first check.
    worker();
    const plan = planned();
    const ahead = plan ? (async () => Promise.all([
      bytesOf(plan.index.path, plan.index, undefined, true),
      unblob(plan.translator, undefined, undefined, atOnce, true).then(w => WebAssembly.compile(w as BufferSource)),
      ...plan.first.map(({t: p, mode}) => hot(p, mode, plan.translator.sha256, undefined, atOnce, true)),
    ]))().catch(() => null) : null;
    const a = await loadAbout(), asset = releaseIndexAsset(a);
    const maker = loadMaker();
    const read = plan && plan.sha256 === a.sha256 && plan.index.sha256 === asset.sha256 && plan.index.size === asset.size
      ? await ahead : null;
    const index = readReleaseIndex(read ? read[0] as Uint8Array : await bytesOf(asset.path, asset), a);
    const modeOf = (path: string) => index.files.find((f) => f.path === path)?.mode ?? 0o755;
    const first = index.translations.filter(t => startupPrograms.includes(t.path));
    const current: Plan = {
      sha256: a.sha256, index: asset, translator: index.translator,
      first: first.map(t => ({t, mode: modeOf(t.path)})),
    };
    const muk = await maker;
    checkMaker(index, muk);
    keepReleaseFiles(a, index, muk?.path);
    let translator: WebAssembly.Module, files: Hot[];
    // The plan can accelerate reads but is not a source of release identity.
    if (read && JSON.stringify(plan) === JSON.stringify(current)) {
      [translator, ...files] = read.slice(1) as [WebAssembly.Module, ...Hot[]];
    }
    else {
      const progress = trackTransfers([index.translator, ...first.flatMap(t => [t.elf, t.wasm])], tell);
      try {
        const [translatorWasm, ...hots] = await Promise.all([
          unblob(index.translator, progress.forBlob(index.translator)),
          ...first.map(t => hot(t, modeOf(t.path), index.translator.sha256, progress.forBlob)),
        ]);
        translator = await WebAssembly.compile(translatorWasm as BufferSource);
        files = hots;
      } finally { progress.stop(); }
    }
    try {
      localStorage.setItem(PLAN, JSON.stringify(current));
    } catch { /* not remembered: the next start reads as webroot.json says */ }
    tell({at: 'ready'});
    return {about: a, index, translator, files: files.map(taken), url: new URL(BASE, location.href).href, muk: muk?.bytes ?? null};
  })().catch((e) => {
    loading = null;
    tell({at: 'failed', message: config.errorText(e)});
    throw e;
  }));

  /** Once a Prompt is up: what the next one is given ahead of time comes now, quietly. */
  const warmWebroot = (webroot: Webroot) => warm(webroot.index);

  /**
   * What a Prompt starting now is given beside the packs: BusyBox, and each other hot program once it is ready, each
   * with the code it reached later in the Prompts before.
   */
  const filesNow = (webroot: Webroot): Webroot['files'] => [...webroot.files, ...later.values()].map(withMore);
  /** A hot program with the code it reached later in the Prompts before. */
  const withMore = (f: Webroot['files'][number]): Webroot['files'][number] => ({...f, more: more.get(f.path)?.list ?? []});

  /** A Worker that runs the root (worker.ts): given the root and its maker, and the box to make. */
  const rootWorker = (): Worker => new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
  /**
   * A Worker readied ahead of the start that will take it: the translator loaded, the root and its maker in place,
   * and a start rehearsed in the box `rehearse` (the same shell in the same box, so what a start runs is compiled
   * when it comes). One at a time; `takeReady` gives it to the start, with the programs it was given.
   */
  let spare: {worker: Worker; given: Set<string>} | null = null;
  function readyWorker(webroot: Webroot, rehearse: Box): void {
    if (spare) return;
    const worker = rootWorker(), files = filesNow(webroot);
    worker.postMessage({type: 'warm'});
    worker.postMessage({type: 'ready', translator: webroot.translator, files, root: {index: webroot.index, url: webroot.url}, muk: webroot.muk, rehearse});
    spare = {worker, given: new Set(files.map((f) => f.path))};
  }
  function takeReady(): {worker: Worker; given: Set<string>} | null {
    const value = spare; spare = null; return value;
  }

  // A sibling profile: no call to hot/loadWebroot/filesNow may materialize its sources.
  const preparedJobs = new Map<string, Promise<{value: PreparedExecutable; moreURL: string; reached: More[]} | null>>();
  function preparedHot(index: Index, generation: string, t: ExecutableArtifact, quiet: boolean, progress?: AssetProgress) {
    const source = canonicalExecutableSource(index, t), shared = threadsApart();
    const key = executableKey(generation, source, t, index.translator.sha256, shared);
    const existing = preparedJobs.get(key);
    if (existing) {
      if (progress) void existing.then(() => progress.verified(), () => {});
      return existing;
    }
    const job = (async () => {
      const step = quiet ? idle : atOnce;
      // Integrity and decode errors propagate. Only engine compilation has the
      // established fallback to ordinary execution of the lazy canonical file.
      const p = 'framing' in t.wasm ? await (async () => {
        if (!index.execution) throw new Fatal('Framed AOT requires a deployed executable');
        await step();
        const limit = AbortSignal.timeout(60_000);
        const signal = config.checkSignal ? AbortSignal.any([config.checkSignal, limit]) : limit;
        const sharded = !!t.wasm.framing?.shards;
        const made = await compileFramedAot(t.wasm, shared, async signal => sharded
          ? shardedAotResponse(t.wasm, new URL(BASE, location.href).href, {open, keep, gone, used}, signal, progress,
              {message: config.message, check: offThread})
          : fetch(`${BASE}${t.wasm.path}`, {signal}), signal, sharded ? undefined : progress?.bytes);
        progress?.verified();
        return made;
      })() : await (async () => {
        const p = await translation(t.wasm, shared, progress, step);
        await step();
        const compiling = WebAssembly.compile(p.wasm as BufferSource);
        return {...p, module: index.execution ? await compiling : await compiling.catch(() => null)};
      })();
      const {module, segments} = p;
      if (!module) return null;
      const url = moreURL(t, index.translator.sha256, shared);
      return {value: {generation, key, path: source.path,
        source: {origin: source.origin, sha256: source.sha256, size: source.size, binding: source.binding},
        artifact: {sha256: t.wasm.sha256, translator: index.translator.sha256, mode: 'whole' as const},
        module, segments, shared}, moreURL: url, reached: index.execution ? [] : await keptMore(url).catch(() => [])};
    })();
    preparedJobs.set(key, job);
    void job.catch(() => { if (preparedJobs.get(key) === job) preparedJobs.delete(key); });
    return job;
  }
  const execution = createExecutionProfile({first: startupPrograms, worker: rootWorker, save,
    ready: () => {
      if (config.restCheckerAfterLoad) restChecker();
      tell({at: 'ready'});
    }, failed: error => tell({at: 'failed', message: config.errorText(error)}),
    executable: (root, t) => preparedHot(root.index, root.generation, t, true),
    async load() {
      worker();
      const a = await loadAbout(), asset = releaseIndexAsset(a);
      const maker = loadMaker();
      const index = readReleaseIndex(await verifiedIndexBytes(asset), a);
      // Check every hot association before source capture or asynchronous image work.
      canonicalHotSources(index);
      const first = (index.execution?.programs ?? index.translations).filter(t => startupPrograms.includes(t.path));
      const progress = trackTransfers([index.translator, ...first.map(t => t.wasm)], tell);
      try {
        const [translator, muk, ...initial] = await Promise.all([
          unblob(index.translator, progress.forBlob(index.translator)).then(bytes => WebAssembly.compile(bytes as BufferSource)),
          maker,
          ...first.map(t => preparedHot(index, a.index.sha256, t, false, progress.forBlob(t.wasm))),
        ]);
        checkMaker(index, muk);
        keepReleaseFiles(a, index, muk?.path);
        return {base: {profile: 'canonical-aot-v1' as const, generation: a.index.sha256, about: a, index,
          translator, url: new URL(BASE, location.href).href, muk: muk?.bytes ?? null}, initial};
      } finally { progress.stop(); }
    },
  });

  return {execution, threadsApart, watchLoad, about, keptWebroot, keepMore, keptNow, originOf, translationKept, keepTranslation, keepReached, usedKept, hearLater, rootIndex, loadWebroot, warmWebroot, filesNow,
    rootWorker, readyWorker, takeReady, ...createAhead({keepTranslation, originOf, threadsApart, translationKept})};
}
