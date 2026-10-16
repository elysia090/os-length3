// What comes by itself, what goes by itself, and when. The canonical copy
// is on the Remote; what is here is a copy kept in step with it.
//
//                comes by itself                goes by itself
//   l3 (the OS)  web: fetched each visit        web: with the tab
//   Prompt       when a repo is opened          its processes, when closed
//   repo         the Remote's changes, seen     every change, sent at once as
//                within seconds (and on focus)  a diff; web: the copy, with the
//                                               tab, once the Remote has it all
//   Home         at start and on focus          every change, sent at once
//
// Nothing the Remote does not have yet is let go: it stays, and is shown.

import {forgetExcept} from './fetch.ts';
import * as draft from './draft.ts';
import {isNative} from './host.ts';
import {connection, onConnection} from './remote.ts';
import {kept, onChange} from './repos.ts';
import {dropState, onState} from './state.ts';

/** Where a repo here stands. */
export type Where = 'local' | 'sending' | 'synced' | 'offline';
export interface RepoSync {
  where: Where;
  /** Paths not on the Remote yet. */
  changed: number;
  /** Changed on both sides: this device's kept, the other's beside it (said once). */
  both: string[];
  /** What cannot be sent (links, large files, .git), so the copy is never let go. */
  unsynced: [string, string][];
  error?: string;
}

const states = new Map<string, RepoSync>();
let onlyThere: draft.RemoteRepo[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const retry = new Map<string, number>();

/** Hear whenever where a repo stands may have changed. */
export function onSync(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
let telling: ReturnType<typeof setTimeout> | undefined;
const tell = () => { clearTimeout(telling); telling = setTimeout(() => { for (const fn of [...listeners]) fn(); }, 30); };

export const repoState = (repo: string): RepoSync | undefined => states.get(repo);
/** Repos on the Remote that are not here (opening one brings it). */
export const remoteOnly = (): readonly draft.RemoteRepo[] => onlyThere;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** How soon a change is sent: soon enough to beat closing the tab, late enough to gather keystrokes. */
const SOON = 400;

/** Send `repo` after `ms`, gathering what changes meanwhile into one diff. */
export function schedule(repo: string, ms = SOON) {
  if (!connection()) return;
  clearTimeout(timers.get(repo));
  const s = states.get(repo);
  states.set(repo, {where: 'sending', changed: s?.changed ?? 0, both: [], unsynced: s?.unsynced ?? []});
  tell();
  timers.set(repo, setTimeout(() => void run(repo), ms));
}

async function run(repo: string) {
  timers.delete(repo);
  try {
    const r = await draft.sync(repo);
    retry.delete(repo);
    states.set(repo, {where: 'synced', changed: 0, both: r.both, unsynced: r.unsynced});
  } catch (e) {
    // Offline, or the Remote refused: kept here, tried again later, and said.
    const n = (retry.get(repo) ?? 0) + 1;
    retry.set(repo, n);
    const s = states.get(repo);
    states.set(repo, {where: 'offline', changed: s?.changed ?? 0, both: [], unsynced: s?.unsynced ?? [], error: message(e)});
    if (connection()) timers.set(repo, setTimeout(() => void run(repo), Math.min(60_000, 2000 * 2 ** n)));
  }
  tell();
}

/** Every change made now goes out at once (leaving the page, or before a step that needs it). */
export async function flush(): Promise<void> {
  const waiting = [...timers.keys()];
  for (const r of waiting) clearTimeout(timers.get(r));
  await Promise.all(waiting.map(run));
}

/** See where every repo here stands, and what the Remote has that is not here. */
export async function look(): Promise<void> {
  const here = await draft.status().catch(() => []);
  const c = connection();
  for (const s of here) {
    if (timers.has(s.name)) continue;
    const before = states.get(s.name);
    const where: Where = !c ? 'local' : s.fresh || s.changed ? (before?.where === 'offline' ? 'offline' : 'sending') : 'synced';
    states.set(s.name, {where, changed: s.changed, both: before?.both ?? [], unsynced: s.unsynced, error: before?.error});
    if (c && (s.fresh || s.changed) && before?.where !== 'offline') schedule(s.name, 0);
  }
  for (const k of [...states.keys()]) if (!here.some((s) => s.name === k)) states.delete(k);
  if (c) {
    const there = await draft.remoteRepos().catch(() => null);
    if (there) {
      onlyThere = there.filter((t) => !here.some((h) => h.name === t.name));
      // The Remote moved past what is here: take it in now.
      for (const t of there) {
        const h = here.find((x) => x.name === t.name);
        if (h && !h.fresh && t.version !== h.version) schedule(t.name, 0);
      }
    }
    for (const k of draft.HOME_KEYS) void draft.syncHome(k).catch(() => {});
  } else onlyThere = [];
  tell();
}

/** Open a repo that is only on the Remote: it comes here, then is like any other. */
export async function bring(repo: string): Promise<void> {
  await draft.fetchRepo(repo);
  await look();
}

/**
 * Leaving a web page: every repo the Remote holds all of goes from this
 * browser, started at once so it runs while the page closes, and the
 * settings the Remote has too. What is not on the Remote yet stays.
 */
function leave() {
  if (!kept || !connection()) return;
  const go = [...states].filter(([r, s]) => s.where === 'synced' && !s.unsynced.length && !timers.has(r) && !kept!.waiting(r)).map(([r]) => r);
  if (go.length) {
    void kept.letGo(go);
    for (const r of go) void draft.forget(r);
  }
  for (const k of draft.HOME_KEYS) dropState(k);
}

let begun = false;
let polling: ReturnType<typeof setInterval> | undefined;
export async function begin() {
  if (begun) return;
  begun = true;
  // The web keeps no copy of l3: it is fetched each visit. The app has it beside itself.
  void forgetExcept(new Set());
  // Every change a person (or a Prompt) makes is sent; sync's own writes are not news.
  onChange((c) => { if (c.by !== draft.BY) schedule(c.repo); else tell(); });
  onState((k) => { if ((k === 'profile' || k === 'todo') && connection()) void draft.syncHome(k).catch(() => {}); });
  onConnection(() => void look());
  // The Remote's changes are seen within five seconds while the page is in view.
  polling = setInterval(() => { if (document.visibilityState === 'visible' && connection()) void look(); }, 5000);
  addEventListener('focus', () => void look());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
  if (!isNative) addEventListener('pagehide', leave);
  await look();
}

/** For tests: stop looking. */
export function end() { clearInterval(polling); for (const t of timers.values()) clearTimeout(t); timers.clear(); }
