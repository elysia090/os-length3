// Browser Cache Storage, quota policy and off-thread integrity checks for a
// distribution's derived bytes. The loader owns which release assets are live.
import {digest} from './download.ts';
import {prepare, type Segment} from '../../sods/runtime/translate.ts';

export function createAssetCache({base, usedKey, oldKeys = [], oldCaches = []}: {
  base: string;
  usedKey: string;
  oldKeys?: readonly string[];
  oldCaches?: readonly string[];
}) {
  /** Resolve the cache name lazily so importing the package does not require a browser. */
  let cacheName: string | undefined;
  const cache = (): string => (cacheName ??= `ricebox:${new URL(base, location.href).href}`);
  /** Maximum share of the browser origin's estimated quota for this cache. */
  const SHARE = 0.25;

  // ---- what is kept: Cache Storage, by digest ----

  /** When each kept copy was last used (this browser's; lost, the oldest is simply unknown). */
  const whole = (url: string) => new URL(url, location.href).href;
  const uses = (): Record<string, number> => {
    try {
      const entries: Record<string, number> = JSON.parse(localStorage.getItem(usedKey) ?? '{}');
      // Older pages wrote both pathnames and absolute URLs. Resolve those
      // pathnames against the distribution's origin, not the embedding page.
      const baseURL = whole(base);
      return Object.fromEntries(Object.entries(entries).map(([url, at]) =>
        [url.startsWith('/') ? new URL(url, baseURL).href : whole(url), at]));
    } catch { return {}; }
  };
  const used = (url: string, at = Date.now()) => {
    try { const u = uses(); u[whole(url)] = at; localStorage.setItem(usedKey, JSON.stringify(u)); } catch { /* not remembered: it goes first */ }
  };
  /** What earlier builds kept under the names before (two caches and two notes) is let go, once a page: nothing reads it now. */
  let before: Promise<unknown> | null = null;
  const forgetBefore = () => (before ??= (async () => {
    try { for (const key of oldKeys) localStorage.removeItem(key); } catch { /* none to let go */ }
    for (const name of oldCaches) try { await caches.delete(name); } catch { /* none to let go */ }
  })());
  const open = async (): Promise<Cache | null> => {
    try { if (!('caches' in globalThis)) return null; await forgetBefore(); return await caches.open(cache()); } catch { return null; }
  };
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

  /** Start the byte-check Worker on demand; the main thread is the fallback. */
  let checker: Worker | null | undefined;
  let asking = 0;
  type Reply = {bytes?: ArrayBuffer; sha256?: string; size?: number; segments?: Segment[] | null; error?: string};
  const answers = new Map<number, (reply: Reply) => void>();
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
   * Hash the bytes, optionally after decompression. A caller that lends its
   * buffer must use the returned bytes. If the Worker stops while holding that
   * buffer the check fails; without a Worker, the same check runs locally.
   */
  async function checked(bytes: Uint8Array, unpack: boolean, lend: boolean): Promise<{bytes: Uint8Array; sha256: string}>;
  /** The same for a translation, given back as the kernel runs it (`as`: sods' share.ts prepare), with its size before. */
  async function checked(bytes: Uint8Array, unpack: boolean, lend: boolean, as: {shared: boolean}): Promise<{bytes: Uint8Array; sha256: string; size: number; segments: Segment[] | null}>;
  async function checked(bytes: Uint8Array, unpack: boolean, lend: boolean, as?: {shared: boolean}): Promise<{bytes: Uint8Array; sha256: string; size?: number; segments?: Segment[] | null}> {
    const w = worker();
    if (w) {
      const own = lend && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buf = (own ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
      const id = ++asking;
      const r = await new Promise<Reply>((resolve) => {
        answers.set(id, resolve);
        w.postMessage({id, bytes: buf, unpack, ...(as ? {prepare: as} : {})}, [buf]);
      });
      if (r.bytes && r.sha256) return {bytes: new Uint8Array(r.bytes), sha256: r.sha256, ...(as ? {size: r.size, segments: r.segments ?? null} : {})};
      // Not worked out there: here, with what was lent back (or the caller's own, when it was a copy that went).
      if (own) bytes = r.bytes ? new Uint8Array(r.bytes) : bytes;
      if (own && !r.bytes) throw new Error('root: a file could not be checked');
    }
    const b = unpack ? await gunzip(bytes) : bytes;
    const sha256 = await digest(b);
    if (!as) return {bytes: b, sha256};
    const p = prepare(b, as);
    return {bytes: p.wasm, sha256, size: b.length, segments: p.segments};
  }
  const gunzip = async (bytes: Uint8Array) =>
    new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

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
  const keep = (url: string, bytes: Uint8Array): Promise<boolean> => keepParts(url, [bytes], false, false);

  /**
   * Store the joined parts, optionally followed by their digest. The Worker
   * owns this work when available. Transfer buffers only when the caller has
   * no further use for them; otherwise structured clone keeps the originals.
   */
  async function keepParts(url: string, parts: Uint8Array[], seal: boolean, lend: boolean): Promise<boolean> {
    const c = await open();
    if (!c) return false;
    const size = parts.reduce((n, p) => n + p.byteLength, 0) + (seal ? 32 : 0);
    try {
      if (!await roomFor(c, url, size)) return false;
      const w = worker();
      if (w) {
        const id = ++asking;
        const r = await new Promise<Reply>((resolve) => {
          answers.set(id, resolve);
          // (A shared buffer is not moved: it goes as itself, as shared memory does.)
          const moved = lend ? [...new Set(parts.map((p) => p.buffer))].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer) : [];
          w.postMessage({id, keep: {url: whole(url), cache: cache(), parts, seal}}, moved);
        });
        if (r.size === undefined) return false;
      } else {
        const body = joined(parts);
        await c.put(url, new Response((seal ? await sealed(body) : body) as BlobPart, {headers: {'content-type': 'application/octet-stream', 'content-length': String(size)}}));
      }
      void sizesOf(c).then((m) => m.set(whole(url), size));
      used(url);
      return true;
    } catch { return false; }
  }

  /** Room made for `size` more bytes at `url` (the least recently used going first); whether there is. */
  async function roomFor(c: Cache, url: string, size: number): Promise<boolean> {
    const e = await navigator.storage?.estimate?.();
    if (!e?.quota) return true;
    const budget = e.quota * SHARE;
    let mine = await keptBytes(c);
    if (size > budget) return false;
    const u = uses();
    const key = whole(url);
    const oldest = (await c.keys()).map((r) => r.url).filter(k => k !== key)
      .sort((a, b) => (u[a] ?? 0) - (u[b] ?? 0));
    // Room is the share left, and what the origin as a whole may still take.
    const room = () => Math.min(budget - mine, e.quota! - (e.usage ?? 0));
    while (room() < size && oldest.length) {
      const k = oldest.shift()!;
      const r = await c.match(k);
      mine -= Number(r?.headers.get('content-length') ?? 0);
      await c.delete(k);
      gone(c, k);
    }
    return room() >= size;
  }

  /** `parts` one after another, as one. */
  function joined(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out;
  }

  async function keptBytes(c: Cache): Promise<number> {
    let n = 0;
    for (const v of (await sizesOf(c)).values()) n += v;
    return n;
  }

  /** The cached byte and entry counts for the embedding host. */
  async function keptWebroot(): Promise<{bytes: number; files: number}> {
    const c = await open();
    if (!c) return {bytes: 0, files: 0};
    return {bytes: await keptBytes(c), files: (await sizesOf(c)).size};
  }

  /** Drop cached assets the current release does not use. */
  async function forgetOthers(live: (url: string) => boolean) {
    const c = await open();
    if (!c) return;
    for (const r of await c.keys()) if (!live(r.url)) { await c.delete(r).catch(() => false); gone(c, r.url); }
    try {
      const u = uses();
      for (const k of Object.keys(u)) if (!live(k)) delete u[k];
      localStorage.setItem(usedKey, JSON.stringify(u));
    } catch { /* nothing remembered */ }
  }

  /** A kept copy's SHA-256 after it. */
  async function sealed(body: Uint8Array): Promise<Uint8Array> {
    const {sha256} = await checked(body.slice(), false, true);
    const out = new Uint8Array(body.length + 32);
    out.set(body);
    out.set(Uint8Array.from(sha256.match(/../g)!.map((x) => parseInt(x, 16))), body.length);
    return out;
  }

  return {cache, whole, used, open, gone, worker, checked, kept, keep, keepParts, keptWebroot, forgetOthers};
}
