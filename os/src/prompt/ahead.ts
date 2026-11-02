// The programs a person is likely to run next, translated before they run them, by this browser, while a Prompt waits
// for its next line. A program of the root is translated when a Prompt first runs it: rg a second, lazygit three, gcc
// building one file eight or more (cc1 alone is 40 MB of code). Translated here ahead, in a worker of its own
// (xlat/runtime/ahead.mjs) so no Prompt waits on it, and kept as a Prompt keeps what it translates
// (userland.ts keepTranslation), the run that wants it reads it instead. Nothing more is downloaded than that run
// would have downloaded, nothing is asked of a server, and it holds offline: the release is not made bigger by
// translations made for every program, which every browser would have to fetch whether it ran them or not.

import {entriesOf} from '../../../xlat/runtime/table.mjs';
import {keepTranslation, originOf, threadsApart, translationKept, type Index, type L3} from './userland.ts';

/** What anyone reaches for at a Prompt and the root has as a program of its own (not BusyBox's, which is hot). */
const REACHED = ['/usr/bin/grep', '/usr/bin/rg', '/usr/bin/fd', '/usr/bin/jq', '/usr/bin/make', '/usr/bin/curl', '/usr/bin/tar'];
/** What building C runs, where a repo has C: the driver, the compiler proper (the longest of all to translate), the
 * linker's driver, the assembler and the linker. */
const BUILDING_C = [/^\/usr\/bin\/gcc$/, /\/cc1$/, /\/collect2$/, /^\/usr\/bin\/as$/, /^\/usr\/bin\/ld(\.bfd)?$/];
/** A repo with C in it (its sources, or a Makefile). */
const HAS_C = /\.[ch]$|(^|\/)(GNU)?[Mm]akefile$/;

/**
 * The root's programs to translate ahead for a Prompt on a repo whose files are `paths`, the most worth it first:
 * what building its C runs, where it has C, then what anyone reaches for. The hot programs (translated in the
 * release: BusyBox, l3, git) are not among them.
 */
export function aheadFor(index: Index, paths: readonly string[]): string[] {
  const hot = new Set(index.translations.map((t) => t.path));
  const programs = index.files.filter((f) => f.mode & 0o111).map((f) => f.path);
  const c = paths.some((p) => HAS_C.test(p)) ? BUILDING_C.flatMap((re) => programs.filter((p) => re.test(p))) : [];
  return [...new Set([...c, ...REACHED.filter((p) => programs.includes(p))])].filter((p) => !hot.has(p));
}

/** Each Prompt's ear for a translation kept ahead: the origin it is kept by, and where. */
const ears = new Set<(origin: string, url: string) => void>();
/** Hear of each program translated ahead from now on (a Prompt tells its kernel); the function returned stops it. */
export function hearAhead(ear: (origin: string, url: string) => void): () => void {
  ears.add(ear);
  return () => ears.delete(ear);
}

/** Whether this browser has room to translate cc1 as well (memory it says it has, where it says it). */
const roomy = () => ((navigator as {deviceMemory?: number}).deviceMemory ?? 8) >= 4;

/** The page has time to give: nothing waits on it, and it is shown (a page in the background gives its time back). */
const idle = () => new Promise<void>((r) => {
  const go = () => ('requestIdleCallback' in globalThis ? requestIdleCallback(() => r(), {timeout: 5000}) : setTimeout(r, 200));
  if (document.visibilityState !== 'hidden') { go(); return; }
  const shown = () => { if (document.visibilityState === 'hidden') return; document.removeEventListener('visibilitychange', shown); go(); };
  document.addEventListener('visibilitychange', shown);
});

/** Of each pack of an index, each file it stores by where it is: its line of the pack's table (table.mjs). */
const tables = new WeakMap<Index, ReturnType<typeof entriesOf>>();
const entries = (index: Index) => { if (!tables.has(index)) tables.set(index, entriesOf(index)); return tables.get(index)!; };

/** One program translated in a worker of its own, which then ends (its memory goes back with it). */
function translated(l3: L3, f: Index['files'][number]): Promise<{wasm: Uint8Array; segments: {offset: number; bytes: Uint8Array}[] | null} | null> {
  const pack = entries(l3.index)[f.pack];
  return new Promise((resolve) => {
    const w = new Worker(new URL('../../../xlat/runtime/ahead.mjs', import.meta.url), {type: 'module'});
    const done = (v: Awaited<ReturnType<typeof translated>>) => { w.terminate(); resolve(v); };
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
      if (/\/cc1$/.test(path) && !roomy()) continue;
      const f = l3.index.files.find((x) => x.path === path);
      if (!f) continue;
      const origin = originOf(l3.index, f);
      if (await translationKept(l3, origin)) continue;
      await idle();
      const got = await translated(l3, f);
      const url = got && await keepTranslation(l3, origin, got.wasm, got.segments);
      if (url) for (const ear of ears) ear(origin, url);
    }
  } finally { going = false; }
}
