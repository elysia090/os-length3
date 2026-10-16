// What comes by itself, what closing ends, and what goes up and down.
// The canonical copy is on the Remote; this device has a checkout.
//
//                 comes by itself        closing ends          Remote
//   l3 (the OS)   web: fetched each      web: its copy goes    the release it is
//                 visit; app: with app   app: stays with app   pinned to
//   Prompt        when a repo opens      its processes         nothing
//   repo          pulled at open (and    web: the copy goes    pushed at each 区切る,
//                 on focus in the app)   if pushed; app: stays pulled at open
//   Home          pulled at open         web: goes if pushed   pushed on change
//
// Unpushed work is never let go: it stays until it is pushed, and is shown.

import {forgetExcept} from './fetch.ts';
import {isNative} from './host.ts';
import {kept, onChange} from './repos.ts';
import {dropState, onState} from './state.ts';
import * as sync from './sync.ts';

/** Repos whose copy here was last seen to hold nothing the Remote lacks. */
let pushed = new Set<string>();
/** Repos changed since that was seen. */
const touched = new Set<string>();
let homeClean = new Set<(typeof sync.HOME_KEYS)[number]>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let pulling: Promise<void> | null = null;

/** Hear when what is pushed and what is not may have changed. */
export function onSync(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const tell = () => { for (const fn of [...listeners]) fn(); };

/** See again which repos and settings hold nothing the Remote lacks. */
export function recheck() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const seen = new Set(touched);
    pushed = new Set(await sync.pushedRepos().catch(() => []));
    for (const r of seen) touched.delete(r);
    homeClean = new Set(sync.connection() ? sync.HOME_KEYS.filter((k) => sync.homeState(k) === 'pushed') : []);
    tell();
  }, 300);
}

/** Take in what the Remote has (repos that are not ahead, and settings). */
export function takeIn(): Promise<void> {
  if (!sync.connection()) return Promise.resolve();
  return (pulling ??= (async () => {
    try {
      await sync.pullAll();
      for (const k of sync.HOME_KEYS) await sync.syncHome(k).catch(() => {});
    } catch { /* offline: what is here stays as it is */ } finally {
      pulling = null;
      recheck();
    }
  })());
}

/**
 * Leaving a web page: everything here that the Remote already holds goes,
 * started at once so it runs while the page closes. Unpushed work stays.
 */
function leave() {
  if (!kept || !sync.connection()) return;
  const go = [...pushed].filter((r) => !touched.has(r) && !kept!.waiting(r));
  if (go.length) {
    void kept.letGo(go);
    for (const r of go) void sync.forget(r);
  }
  for (const k of homeClean) dropState(k);
}

let begun = false;
export async function begin() {
  if (begun) return;
  begun = true;
  // The web keeps no copy of l3: it is fetched each visit. The app has it beside itself.
  void forgetExcept(new Set());
  onChange((c) => { if (c.by !== 'sync') touched.add(c.repo); recheck(); });
  onState((k) => {
    // A push or a pull moves a base without touching a file.
    if (k === 'sync') recheck();
    // Newly joined: what the Remote has comes, and what is here goes up.
    if (k === 'remote') { if (sync.connection()) void takeIn(); else recheck(); }
    if (k === 'profile' || k === 'todo') {
      homeClean.delete(k);
      if (sync.connection()) void sync.syncHome(k).catch(() => {}).finally(recheck);
    }
  });
  if (isNative) {
    // In the app the checkout is the repo's own git: what is taken in is cut there too, under the Remote's words.
    sync.afterTake(async (repo, cut) => {
      const git = await import('./git.ts');
      const c = await git.changes(repo).catch(() => null);
      if (c?.files) await git.cut(repo, null, cut.kind ? `${cut.kind}：${cut.title}` : cut.title, cut.note, false).catch(() => {});
    });
    addEventListener('focus', () => void takeIn());
  } else addEventListener('pagehide', leave);
  await takeIn();
  recheck();
}

export const isPushed = (repo: string) => pushed.has(repo) && !touched.has(repo);
