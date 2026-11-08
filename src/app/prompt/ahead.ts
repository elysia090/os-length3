// The programs a person is likely to run next, translated before they run them, by this browser, while a Prompt waits
// for its next line. A program of the root is translated when a Prompt first runs it: rg a second, lazygit three.
// Translated here ahead, in a worker of its own (sods/runtime/ahead.ts), and kept as a Prompt keeps what it translates
// (userland.ts keepTranslation), the run that wants it reads it instead. Nothing more is downloaded than that run
// would have downloaded, nothing is asked of a server, and it holds offline: the release is not made bigger by
// translations made for every program, which every browser would have to fetch whether it ran them or not.
// Only the light are translated here: the heavy are the release's to translate, as BusyBox, l3 and git are. What
// building C runs (gcc, cc1's 40 MB of code, the assembler, the linker) translated here took a browser's time and
// memory at every Prompt on a repo with C, built in or not, and held Prompts starting after it for minutes.

import {entriesOf} from '../../../module/muk/runtime/table.ts';
import {keepTranslation, originOf, threadsApart, translationKept, type Index, type L3} from './userland.ts';

/**
 * What anyone reaches for at a Prompt and the root has as a program of its own (not BusyBox's, which is hot; nor what
 * the shell runs at every cd, you, whose few pages are translated in a millisecond).
 */
const REACHED = ['/usr/bin/grep', '/usr/bin/rg', '/usr/bin/fd', '/usr/bin/jq', '/usr/bin/make', '/usr/bin/curl', '/usr/bin/tar'];
/**
 * The root's programs to translate ahead for a Prompt, the most worth it first: what anyone reaches for. The hot
 * programs (translated in the release: BusyBox, l3, git) are not among them.
 */
export function aheadFor(index: Index): string[] {
  const hot = new Set(index.translations.map((t) => t.path));
  const programs = new Set(index.files.filter((f) => f.mode & 0o111).map((f) => f.path));
  return REACHED.filter((p) => programs.has(p) && !hot.has(p));
}

/** Each Prompt's ear for a translation kept ahead: the origin it is kept by, and where. */
const ears = new Set<(origin: string, url: string) => void>();
/** Hear of each program translated ahead from now on (a Prompt tells its kernel); the function returned stops it. */
export function hearAhead(ear: (origin: string, url: string) => void): () => void {
  ears.add(ear);
  return () => ears.delete(ear);
}

/** The page has time to give: nothing waits on it, and it is shown (a page in the background gives its time back). */
const idle = () => new Promise<void>((r) => {
  const go = () => ('requestIdleCallback' in globalThis ? requestIdleCallback(() => r(), {timeout: 5000}) : setTimeout(r, 200));
  if (document.visibilityState !== 'hidden') { go(); return; }
  const shown = () => { if (document.visibilityState === 'hidden') return; document.removeEventListener('visibilitychange', shown); go(); };
  document.addEventListener('visibilitychange', shown);
});

/**
 * The person at the keys of a program that reads each key as it comes (vi, less, top: holdAhead): nothing is translated
 * ahead then, and one under way is let go of, to be done again later. A translation takes the threads the page draws
 * with: on a machine of four, vi's screen stood still for seconds at a key while rg was translated. Given back, it
 * goes on a moment after.
 */
let holders = 0;
let quietAt = 0;
let dropping: (() => void) | null = null;
/** A program in front reads each key as it comes (`on`), or has given the terminal back. */
export function holdAhead(on: boolean) {
  holders = Math.max(0, holders + (on ? 1 : -1));
  if (on) dropping?.();
  else quietAt = performance.now() + 3000;
}
/** Until nothing holds what is translated ahead, and a moment after. */
const free = async () => {
  while (holders > 0 || performance.now() < quietAt) await new Promise((r) => setTimeout(r, holders > 0 ? 500 : Math.max(50, quietAt - performance.now())));
};

/** Of each pack of an index, each file it stores by where it is: its line of the pack's table (table.ts). */
const tables = new WeakMap<Index, ReturnType<typeof entriesOf>>();
const entries = (index: Index) => { if (!tables.has(index)) tables.set(index, entriesOf(index)); return tables.get(index)!; };

/** A translation let go of before it was done (held: holdAhead), to be done again. */
const DROPPED = 'dropped';
/** One program translated in a worker of its own, which then ends (its memory goes back with it). */
function translated(l3: L3, f: Index['files'][number]): Promise<{wasm: Uint8Array; segments: {offset: number; bytes: Uint8Array}[] | null} | null | typeof DROPPED> {
  const pack = entries(l3.index)[f.pack];
  return new Promise((resolve) => {
    const w = new Worker(new URL('../../../module/sods/runtime/ahead.ts', import.meta.url), {type: 'module'});
    const done = (v: Awaited<ReturnType<typeof translated>>) => { dropping = null; w.terminate(); resolve(v); };
    dropping = () => done(DROPPED);
    w.onmessage = ({data}) => done(data.error ? null : data);
    w.onerror = () => done(null);
    w.postMessage({translator: l3.translator, url: new URL(l3.url, location.href).href, pack: l3.index.packs[f.pack].name,
      at: f.at, len: f.len, size: f.size, raw: !!f.raw, shared: threadsApart(), lines: pack.size, line: pack.get(f.at)?.line});
  });
}

let going = false;
/**
 * Translate `paths` ahead, one after another, each when the page has time, skipping what is kept already; each kept
 * is told to every Prompt listening (hearAhead). Once at a time in a page: a call while it goes adds nothing.
 */
export async function translateAhead(l3: L3, paths: readonly string[]): Promise<void> {
  if (going || typeof Worker !== 'function') return;
  going = true;
  try {
    for (const path of paths) {
      const f = l3.index.files.find((x) => x.path === path);
      if (!f) continue;
      const origin = originOf(l3.index, f);
      if (await translationKept(l3, origin)) continue;
      let got: Awaited<ReturnType<typeof translated>> = DROPPED;
      while (got === DROPPED) {
        await free();
        await idle();
        got = await translated(l3, f);
      }
      const url = got && await keepTranslation(l3, origin, got.wasm, got.segments);
      if (url) for (const ear of ears) ear(origin, url);
    }
  } finally { going = false; }
}
