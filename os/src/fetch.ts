// Fetching l3's files (its index, the translator, the hot programs) through
// whatever lies between the page and its server: a proxy may cut a transfer midway, stall it, or
// answer with an error for a moment. A download here keeps what it has,
// notices a stall instead of waiting forever, continues from the byte it
// reached (a Range request, guarded so two versions are never spliced), and
// accepts the result only when it is exactly the file the manifest names.

import {t} from './i18n.ts';

export interface Expect { size?: number; sha256?: string }

export interface Progress {
  /** Bytes received so far; may go back to 0 when a server cannot continue. */
  bytes(got: number): void;
  /** The transfer broke and will be taken up again: which attempt is next, and why. */
  retry(attempt: number, why: string): void;
  /** No byte has come for this many seconds (said each second, from the second). */
  waiting?(seconds: number): void;
}

export interface Options {
  /** No byte for this long counts as broken. */
  stallMs?: number;
  /** Tries in all, the first included. */
  attempts?: number;
  /** Wait before the n-th retry (n from 1). */
  backoff?: (n: number) => number;
  fetch?: typeof fetch;
  /** How the bytes are checked against their sha256 (userland.ts does it off the page's thread). */
  check?: Check;
}

/** `bytes`' SHA-256, and the bytes (another view of them when they were lent away to be checked). */
export type Check = (bytes: Uint8Array) => Promise<{sha256: string; bytes: Uint8Array}>;
const here: Check = async (bytes) => ({sha256: await digest(bytes), bytes});

/** A failure that another try would not change (the file is missing, refused…). */
export class Fatal extends Error {}

/** What a broken download had, kept for the next try in this page. */
interface Partial { parts: Uint8Array[]; got: number; validator: string | null }
const partials = new Map<string, Partial>();

const join = (parts: Uint8Array[], got: number) => {
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

export async function digest(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transient = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * `url`'s bytes, taken up again after a cut or stall from where they
 * stopped, and checked against `expect` when it is given.
 */
export async function download(url: string, expect: Expect = {}, progress?: Progress, options: Options = {}): Promise<Uint8Array> {
  const {stallMs = 10_000, attempts = 6, backoff = (n) => Math.min(8000, 500 * 2 ** (n - 1)), fetch: get = fetch, check = here} = options;
  const state = partials.get(url) ?? {parts: [], got: 0, validator: null};
  partials.set(url, state);
  const reset = () => { state.parts = []; state.got = 0; state.validator = null; progress?.bytes(0); };
  let why = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) { progress?.retry(attempt, why); await sleep(backoff(attempt - 1)); }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastByte = Date.now();
    const arm = () => { clearTimeout(timer); lastByte = Date.now(); timer = setTimeout(() => abort.abort(), stallMs); };
    // A quiet line is said while it is quiet, before it counts as broken:
    // each second once, even when a late tick and the next land in the same one.
    let said = 0;
    const quiet = setInterval(() => {
      const s = Math.floor((Date.now() - lastByte) / 1000);
      if (s < 2) { said = 0; return; }
      if (s > said) { said = s; progress?.waiting?.(s); }
    }, 1000);
    try {
      const headers: Record<string, string> = {};
      // Continue only against the same version: If-Range makes a server that
      // changed the file send all of it again instead of the rest.
      if (state.got && state.validator) { headers.Range = `bytes=${state.got}-`; headers['If-Range'] = state.validator; }
      else if (state.got) reset();
      arm();
      const r = await get(url, {headers, signal: abort.signal, cache: 'no-store'});
      if (r.status === 206) {
        const start = Number(/bytes (\d+)-/.exec(r.headers.get('Content-Range') ?? '')?.[1]);
        if (start !== state.got) { reset(); why = t('Could not receive the rest'); await r.body?.cancel(); continue; }
      } else if (r.ok) {
        if (state.got) reset();
      } else if (transient(r.status)) {
        why = `${r.status}`; await r.body?.cancel(); continue;
      } else {
        throw new Fatal(`${url}: ${r.status}`);
      }
      // A strong ETag or a date names this version; a weak one cannot guard a splice.
      // Bytes counted after a proxy's own compression are not the file's
      // offsets, so such a transfer starts over rather than continuing.
      const etag = r.headers.get('ETag');
      const encoded = (r.headers.get('Content-Encoding') ?? 'identity') !== 'identity';
      state.validator = encoded ? null : etag && !etag.startsWith('W/') ? etag : r.headers.get('Last-Modified');
      const reader = r.body!.getReader();
      for (;;) {
        arm();
        const {done, value} = await reader.read();
        if (done) break;
        state.parts.push(value);
        state.got += value.length;
        progress?.bytes(state.got);
      }
      clearTimeout(timer);
      let bytes: Uint8Array = join(state.parts, state.got);
      if (expect.size !== undefined && bytes.length !== expect.size) { reset(); why = t('The size does not match'); continue; }
      if (expect.sha256) {
        const c = await check(bytes);
        bytes = c.bytes;
        if (c.sha256 !== expect.sha256) { reset(); why = t('The contents do not match'); continue; }
      }
      partials.delete(url);
      return bytes;
    } catch (e) {
      if (e instanceof Fatal) { partials.delete(url); throw e; }
      why = abort.signal.aborted ? t('The connection stalled') : t('The connection broke');
    } finally {
      // Every way out of a try (done, continue, broken) stops its clocks.
      clearTimeout(timer);
      clearInterval(quiet);
    }
  }
  // What came is kept: the next try in this page continues from it.
  throw new Error(why || t('Could not load'));
}

/** Where an earlier build kept copies of l3; nothing is kept there now. */
const STORE = 'length3-userland';

/** Give back every copy an earlier build kept in Cache Storage except those named in `live`. */
export async function forgetExcept(live: Set<string>) {
  try {
    if (!('caches' in globalThis)) return;
    const c = await caches.open(STORE);
    for (const req of await c.keys()) {
      const sha = new URL(req.url).pathname.split('/').at(-1)!;
      if (!live.has(sha)) await c.delete(req);
    }
    if (!live.size) await caches.delete(STORE);
  } catch { /* nothing to give back */ }
}
