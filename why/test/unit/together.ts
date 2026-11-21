// Run Why unit suites in shared workers. Page modules have a fresh module
// realm per suite; hosted Remote fixtures can reuse their database between
// suites. Workspace and Ricebox checks do not use this harness.
//
// A claimed unit is a test file or a part of it (`file#k/n`). Each unit runs
// its own hooks, returns any borrowed databases, lets its page timers finish,
// and restores process globals and environment before the next unit.

import {mkdirSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {describe, test} from 'node:test';

/** The repository's root, which a file is named from. */
const OS = new URL('../../../', import.meta.url).href;
/** Why's application modules are per-suite; the hosted service is shared. */
const WHY = new URL('../../', import.meta.url).href;
const REMOTE = new URL('shipto/remote/', WHY).href;
/** Whether a module is the page's: read anew for each file that is (its realm), where the Remote's are read once. */
const isPage = (url: string) => url.startsWith(WHY) && !url.startsWith(REMOTE);
/** node:test as a part of a file sees it. */
const PART = new URL('./part.ts', import.meta.url).href;

/** The realm a module was read in (the file of the page's it is for), if any. */
const realmOf = (url: string | undefined) => (url?.includes('?realm=') ? new URL(url).searchParams.get('realm') : null);
/** The part of its file a test file was read as (`k/n`), if one. */
const partOf = (url: string | undefined) => (url?.includes('part=') && !url.includes('/node_modules/') ? new URL(url).searchParams.get('part') : null);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const part = partOf(context.parentURL);
    if (part && specifier === 'node:test' && !context.parentURL!.startsWith(PART)) {
      return {url: `${PART}?part=${part}&of=${encodeURIComponent(new URL(context.parentURL!).pathname)}`, shortCircuit: true};
    }
    const found = nextResolve(specifier, context);
    const realm = realmOf(context.parentURL);
    return realm && isPage(found.url) && !found.url.includes('?') ? {...found, url: `${found.url}?realm=${encodeURIComponent(realm)}`} : found;
  },
});

/** Everything on globalThis as it is now, for `restore`. */
const globals = () => new Map(Reflect.ownKeys(globalThis).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)!]));
const same = (a: PropertyDescriptor, b: PropertyDescriptor) =>
  (['value', 'get', 'set', 'writable', 'enumerable', 'configurable'] as const).every((p) => Object.is(a[p], b[p]));
/**
 * globalThis as `before` had it: what was changed as it was, and what a file added by name (the page's stand-ins:
 * localStorage, location) gone. What a package added under a symbol of its own (Better Auth's, signal-exit's) is
 * the process's, as the package is, and stays.
 */
function restore(before: Map<string | symbol, PropertyDescriptor>) {
  const g = globalThis as Record<string | symbol, unknown>;
  for (const k of Reflect.ownKeys(g)) if (typeof k === 'string' && !before.has(k)) delete g[k];
  for (const [k, was] of before) {
    const now = Object.getOwnPropertyDescriptor(g, k);
    if (!now || !same(now, was)) Object.defineProperty(g, k, was);
  }
}

type Timer = ReturnType<typeof setTimeout> & {_destroyed?: boolean};
/**
 * Runs `f` with setTimeout keeping each timer a module of the page's sets (by where it was called from); then,
 * once `f` is done, waits for those of them that would keep a process up (not unref'd) to have run or been cleared.
 */
async function timersRun(f: () => Promise<void>) {
  const set = globalThis.setTimeout, left = new Set<Timer>();
  const keeping = ((...a: Parameters<typeof setTimeout>) => {
    const t = set(...a) as Timer;
    if (new Error().stack?.includes('?realm=')) left.add(t);
    return t;
  }) as typeof setTimeout;
  Object.defineProperties(keeping, Object.getOwnPropertyDescriptors(set));
  globalThis.setTimeout = keeping;
  try {
    await f();
  } finally {
    if (globalThis.setTimeout === keeping) globalThis.setTimeout = set;
  }
  // At most a minute: the longest a file's own would have kept its process up is what the timer says.
  for (const until = Date.now() + 60_000; Date.now() < until && [...left].some((t) => !t._destroyed && t.hasRef());) {
    await new Promise((r) => set(r, 10));
  }
}

/**
 * Runs those of `units` (files, or parts of them, as paths from os/: the longest first) that no other process has
 * taken yet, each in turn in this process, as a suite named by it. A unit is taken by making its folder in
 * `taken`, which only one process can do; the processes sharing `units` end about together, however long each is.
 */
export async function together(units: string[], taken: string) {
  // First, at the root: the hook that takes back each test's database, for the tests of every file.
  const {fileByFile} = await import('../../shipto/remote/tests/testing.ts');
  const {fileDone, lastDone} = fileByFile();
  try {
    for (const unit of units) {
      try {
        mkdirSync(`${taken}/${unit.replaceAll('/', '_')}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      const env = {...process.env}, before = globals();
      const [file, part] = unit.split('#');
      const url = new URL(file!, OS), page = isPage(url.href);
      if (page) url.searchParams.set('realm', unit);
      if (part) url.searchParams.set('part', part);
      // Resolved when the suite is done, its hooks run.
      const run = () => describe(part ? `${file} [${part}]` : file, async () => {
        try {
          await import(url.href);
          if (part) (await import(`${PART}?part=${part}&of=${encodeURIComponent(url.pathname)}`) as typeof import('./part.ts')).loaded();
        } catch (e) {
          // Counted as a failed test, as node --test counts a file that cannot be loaded.
          test('loads', () => { throw e; });
        }
      });
      if (page) {
        await import(`${WHY}app/testing/core.ts?realm=${encodeURIComponent(unit)}`);
        await timersRun(run);
      } else {
        await run();
      }
      await fileDone();
      restore(before);
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
    }
  } finally {
    await lastDone();
  }
}
