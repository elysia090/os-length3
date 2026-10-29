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

import {forgetExcept} from '../prompt/l3-files.ts';
import * as draft from './sync.ts';
import {core, isNative} from '../app/host.ts';
import {connection, mayAsk, onConnection, onReach, remoteAway, RemoteError, retryAfter} from './connection.ts';
import {ELSEWHERE, onChange} from '../repos/repos.ts';
import {coalesced, every, jitter, shared} from '../app/runs.ts';
import {onState} from '../home/state.ts';
import {othersOpen, prune} from './tabs.ts';
import {errorText} from '../app/errors.ts';

/**
 * Where a repo here stands; 'off': turned off on the Remote (kept there 30 days), nothing is sent until it is on
 * again; 'waits': the Remote keeps no more for this account's plan (service/plan.ts), so it stays here and waits.
 */
export type Where = 'local' | 'sending' | 'synced' | 'offline' | 'off' | 'waits';
export interface RepoSync {
  where: Where;
  /** Paths not on the Remote yet. */
  changed: number;
  /** Changed on both sides: the Remote's kept at its name, this device's beside it (said once). */
  both: string[];
  /** What cannot be sent (links, large files, .git), so the copy is never let go. */
  unsynced: [string, string][];
  /** Changes in its other works' copies here, sent when each is shown again (so it is not let go meanwhile). */
  elsewhere?: number;
  /** Why it is not in step, in the person's words (what the Remote or this browser said). */
  error?: string;
  /** The Remote has agreed it with this device once: it is on the Remote, which knows it by its name. */
  agreed?: boolean;
}

const states = new Map<string, RepoSync>();
let onlyThere: draft.RemoteRepo[] = [];
let everyThere: draft.RemoteRepo[] = [];
/** The Remote's repos stamp when everyThere was read (null: not read yet, for this connection). */
let reposSeen: string | null = null;
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
/** Every repo the Remote holds, those turned off among them. */
export const remoteAll = (): readonly draft.RemoteRepo[] => everyThere;

/**
 * The Remote could not be asked just now (offline, or it refused): null, so
 * what was read last stands and the next look asks again. Anything else is a
 * fault here, and is thrown. The core's refusals are RemoteErrors too (host.ts core).
 */
const away = (e: unknown): null => { if (e instanceof RemoteError) return null; throw e; };
/** How long a repo the plan holds back waits before it is asked again. */
const WAIT = 5 * 60_000;
/** The longest any try again waits (a timer cannot wait a month, which is when a Remote out of R2's budget says). */
const LONGEST = 6 * 3600_000;
/**
 * What another try at once could not get past: too large, not taken as it is, the Remote or the account full.
 * Each is asked again after WAIT (or when the Remote says), not every few seconds, sending the same bytes each time.
 */
const LASTING = new Set([400, 413, 422, 507]);
/**
 * When to try `e`'s send again, the n-th time: when the Remote said (Retry-After), a refusal that stays after
 * WAIT, anything else (offline, busy) sooner each time from 2 s to 5 minutes; give or take a fifth.
 */
export const againIn = (e: unknown, n: number): number =>
  jitter(Math.min(LONGEST, retryAfter(e) ?? (e instanceof RemoteError && LASTING.has(e.status) ? WAIT : Math.min(WAIT, 2000 * 2 ** n))));
/** How soon a change is sent: soon enough to beat closing the tab, late enough to gather keystrokes. */
const SOON = 400;

/** Send `repo` after `ms`, gathering what changes meanwhile into one diff. */
function schedule(repo: string, ms = SOON) {
  if (!connection() || states.get(repo)?.where === 'off') return;
  clearTimeout(timers.get(repo));
  const s = states.get(repo);
  states.set(repo, {where: 'sending', changed: s?.changed ?? 0, both: [], unsynced: s?.unsynced ?? [], elsewhere: s?.elsewhere, agreed: s?.agreed});
  tell();
  timers.set(repo, setTimeout(() => void run(repo), ms));
}

async function run(repo: string) {
  timers.delete(repo);
  try {
    const r = await draft.sync(repo);
    retry.delete(repo);
    states.set(repo, {where: 'synced', changed: 0, both: r.both, unsynced: r.unsynced, elsewhere: states.get(repo)?.elsewhere, agreed: true});
  } catch (e) {
    // Turned off on the Remote: nothing more is sent until it is on again.
    if ((e as {status?: number}).status === 410) {
      const s = states.get(repo);
      states.set(repo, {where: 'off', changed: s?.changed ?? 0, both: [], unsynced: s?.unsynced ?? [], agreed: true});
      tell();
      return;
    }
    // The plan keeps no more on the Remote: kept here, and asked again now and then (paying, or making room, lets it go).
    if (e instanceof RemoteError && e.status === 402) {
      const s = states.get(repo);
      states.set(repo, {where: 'waits', changed: s?.changed ?? 0, both: [], unsynced: s?.unsynced ?? [], error: errorText(e), agreed: s?.agreed});
      if (connection()) {
        const later = setTimeout(() => void run(repo), jitter(WAIT));
        // Long enough that nothing else should wait on it: a process with nothing else to do (a test) is not held open by it.
        (later as unknown as {unref?: () => void}).unref?.();
        timers.set(repo, later);
      }
      tell();
      return;
    }
    // Offline, or the Remote refused: kept here, tried again later, and said.
    const n = (retry.get(repo) ?? 0) + 1;
    retry.set(repo, n);
    const s = states.get(repo);
    states.set(repo, {where: 'offline', changed: s?.changed ?? 0, both: [], unsynced: s?.unsynced ?? [], elsewhere: s?.elsewhere, error: errorText(e), agreed: s?.agreed});
    if (connection()) timers.set(repo, setTimeout(() => void run(repo), againIn(e, n)));
  }
  tell();
}

/** What a look began and does not wait for (a setting being agreed); `settled` waits for it. A fault in it is still thrown, unheard, as before. */
const agreeing = new Set<Promise<unknown>>();
const track = (p: Promise<unknown>) => { agreeing.add(p); void p.then(() => { agreeing.delete(p); }, (e: unknown) => { agreeing.delete(p); throw e; }); };

/** Once every send scheduled so far, and every setting a look began agreeing, is done (a test waits so, not by the clock). */
export async function settled(): Promise<void> {
  await flush();
  await Promise.allSettled([...agreeing]);
}

/** `repo` is gone from here (deleted, or renamed away): nothing of it waits to be sent, and nothing is said of it. */
export function forget(repo: string) {
  clearTimeout(timers.get(repo));
  timers.delete(repo);
  retry.delete(repo);
  states.delete(repo);
  tell();
}

/** Every change made now goes out at once (leaving the page, or before a step that needs it). */
export async function flush(): Promise<void> {
  const waiting = [...timers.keys()];
  for (const r of waiting) clearTimeout(timers.get(r));
  const settings = [...homeTimers.keys()];
  for (const k of settings) { clearTimeout(homeTimers.get(k)); homeTimers.delete(k); }
  await Promise.all([...waiting.map(run), ...settings.map((k) => agreeHome(k).catch(away))]);
}

// ---- Home's settings: each agreed with the Remote one at a time ----
//
// Each keystroke in Home's TODO sets the setting. Agreeing it is a read and a
// write on the Remote (draft.syncHome), so it waits for a pause (SOON), runs
// one at a time per setting, and a change while it runs is agreed once more
// after it. (Before: every keystroke began its own, side by side, and each one
// that lost the race was refused and tried again: 30 keystrokes, 146 requests.)

const homeTimers = new Map<draft.HomeKey, ReturnType<typeof setTimeout>>();
const homeRuns = new Map<draft.HomeKey, () => Promise<void>>();
/** Changes made here to each setting, and how many of them the last agreement took in: more made than taken, not on the Remote yet. */
const homeMade = new Map<draft.HomeKey, number>(), homeTaken = new Map<draft.HomeKey, number>();

function agreeHome(k: draft.HomeKey): Promise<void> {
  let f = homeRuns.get(k);
  if (!f) {
    f = coalesced(async () => {
      const made = homeMade.get(k) ?? 0;
      await draft.syncHome(k);
      homeTaken.set(k, Math.max(homeTaken.get(k) ?? 0, made));
    });
    homeRuns.set(k, f);
  }
  return f();
}

/** A Home setting changed here (a keystroke in the TODO, a profile saved): agreed with the Remote after a pause. */
export function homeChanged(k: draft.HomeKey) {
  homeMade.set(k, (homeMade.get(k) ?? 0) + 1);
  if (!connection()) return;
  clearTimeout(homeTimers.get(k));
  homeTimers.set(k, setTimeout(() => { homeTimers.delete(k); track(agreeHome(k).catch(away)); }, SOON));
}

/** Whether a change to `k` made here is not on the Remote yet. */
export const homeUnsent = (k: draft.HomeKey): boolean => homeTimers.has(k) || (homeMade.get(k) ?? 0) > (homeTaken.get(k) ?? 0);

/**
 * See where every repo here stands, and what the Remote has that is not here.
 * The Remote is asked what moved (one small read); its repos and each setting
 * are read again only when they did.
 */
export const look: () => Promise<void> = coalesced(lookOnce);
async function lookOnce(): Promise<void> {
  // What moved on the Remote is asked while what is here is read (as the app opens, while the core starts): neither
  // waits for the other, and the page waited for both, one after the other, before it was drawn from them.
  const asked = connection();
  const moving = asked ? draft.moved().catch(away) : null;
  // Not waited for when nothing is decided from it (below): what it threw is thrown where it is waited for.
  moving?.catch(() => {});
  // What is here could not be read: nothing is decided from nothing (no state is dropped), and it is said.
  const here = await draft.status().catch((e: unknown) => { console.error('look: the repos here could not be read', e); return null; });
  if (!here) return;
  void prune();
  const c = connection();
  for (const s of here) {
    if (timers.has(s.name)) continue;
    const before = states.get(s.name);
    if (before?.where === 'off') continue;
    const where: Where = !c ? 'local' : s.fresh || s.changed ? (before?.where === 'offline' ? 'offline' : 'sending') : 'synced';
    states.set(s.name, {where, changed: s.changed, both: before?.both ?? [], unsynced: s.unsynced, elsewhere: s.elsewhere, error: where === 'synced' ? undefined : before?.error, agreed: !s.fresh});
    if (c && (s.fresh || s.changed) && before?.where !== 'offline') schedule(s.name, 0);
  }
  for (const k of [...states.keys()]) if (!here.some((s) => s.name === k)) states.delete(k);
  if (c) {
    // Asked again when the session changed meanwhile: what moved is the session's.
    const now = moving && asked?.token === c.token ? await moving : await draft.moved().catch(away);
    if (now && now.repos !== reposSeen) {
      const list = await draft.remoteRepos().catch(away);
      if (list) { everyThere = list; reposSeen = now.repos; }
    }
    const all = reposSeen === null ? null : everyThere;
    const off = new Set((all ?? []).filter((t) => t.offAt).map((t) => t.name));
    for (const name of off) {
      const s = states.get(name);
      if (s) { clearTimeout(timers.get(name)); timers.delete(name); states.set(name, {...s, where: 'off'}); }
    }
    // On again (here or on another device): in step from where it was.
    for (const [name, s] of states) if (s.where === 'off' && all && !off.has(name)) { states.set(name, {...s, where: 'sending'}); schedule(name, 0); }
    const there = all?.filter((t) => !t.offAt) ?? null;
    if (there) {
      onlyThere = there.filter((t) => !here.some((h) => h.name === t.name));
      // The Remote moved past what is here: take it in now.
      for (const t of there) {
        const h = here.find((x) => x.name === t.name);
        if (h && !h.fresh && t.version !== h.version) schedule(t.name, 0);
      }
    }
    // A setting not agreed now still differs at the next look, which agrees it then.
    if (now) for (const k of draft.HOME_KEYS) if (draft.homeMoved(k, now.home[k] ?? 0)) track(agreeHome(k).catch(away));
  } else { onlyThere = []; everyThere = []; reposSeen = null; }
  tell();
}

/**
 * Open a repo that is only on the Remote: it comes here, then is like any
 * other. Asked again while it comes (a double click, File and Home at once),
 * it is the same bringing (before, the second made the repo again and failed:
 * "repo trip already exists").
 */
export const bring: (repo: string) => Promise<void> = shared(async (repo: string) => {
  await draft.fetchRepo(repo);
  await look();
});

/**
 * Leaving a web page: every repo the Remote holds all of goes from this browser, started at once so it runs
 * while the page closes (the core's 空ける: one with changes not sent yet sends them first, or stays). What
 * is not on the Remote yet stays, and is sent at the next visit.
 */
function leave() {
  if (!connection()) return;
  // Another tab of this browser still holds the same copy: it stays for it, and goes with the last tab.
  if (othersOpen()) return;
  const go = [...states].filter(([r, s]) => s.where === 'synced' && !s.unsynced.length && !s.elsewhere && !timers.has(r)).map(([r]) => `repo:${r}`);
  if (go.length) void core('free', {ids: go}).catch(() => {});
}

let begun = false;
let polling: {stop(): void} | undefined;
export async function begin() {
  if (begun) return;
  begun = true;
  // What an earlier build kept of l3 goes; l3 now keeps its own copies, by digest, and lets them go itself (userland.ts).
  void forgetExcept(new Set());
  // Every change a person (or a Prompt) makes is sent; sync's own writes are not news, nor another tab's (it sends its own).
  onChange((c) => { if (c.by !== draft.BY && c.by !== ELSEWHERE) schedule(c.repo); else tell(); });
  // A setting changed here is agreed after a pause; one another tab changed, that tab sends.
  onState((k, outside) => { if (!outside && (k === 'profile' || k === 'todo' || k === 'dotfiles')) homeChanged(k); });
  // The Remote answers again: what waited for it goes now, not at its next try (up to a minute away).
  onReach(() => { if (remoteAway() || !connection()) return; for (const [r, s] of states) if (s.where === 'offline' && timers.has(r)) schedule(r, 0); });
  // Another account, or none: nothing read for the last one holds.
  onConnection(() => { reposSeen = null; void look(); });
  // The Remote's changes are seen within five seconds while the page is in view and someone is at it; nobody for a
  // while, a minute, then ten (runs.ts paced); back at it, at once. While the Remote is away, less often each time.
  polling = every(5000, async () => { if (connection() && mayAsk()) await look(); }, {paced: true});
  // The window taken up again: what moved meanwhile is looked for at once (one small request), not at the next look.
  addEventListener('focus', () => { if (connection() && mayAsk()) void look(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
  if (!isNative) addEventListener('pagehide', leave);
  await look();
}

/** For tests: stop looking. */
export function end() {
  polling?.stop();
  for (const t of [...timers.values(), ...homeTimers.values()]) clearTimeout(t);
  timers.clear();
  homeTimers.clear();
}
