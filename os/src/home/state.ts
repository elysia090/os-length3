// Home's state: the profile, the TODO list and Forge's band. They are files in the OS's data directory
// (<data>/home/<key>.json), kept by the core: the same files `l3 todo` reads and writes, in the app or in
// a browser's own. Reads are served from memory, filled at start and again whenever the window comes back
// (or another tab of this browser wrote), so a change made with l3 shows up.

import {core} from '../app/host.ts';
import {home, onElsewhere} from '../core/client.ts';
import {t} from '../i18n.ts';
import {errorText} from '../app/errors.ts';

// `remote` is which Remote this device talks to and as whom; `sync` is,
// for each repo and setting, the version on the Remote this copy came from;
// `lang` is the language the OS speaks here (i18n.ts), l3 included.
// `network` is which repos' Prompts may reach the network here (the app only; never sent).
// `trusted` is the dotfiles this device runs, as taken here (never sent, never set: home/dotfiles.ts).
export type Key = 'profile' | 'todo' | 'band' | 'remote' | 'sync' | 'lang' | 'dotfiles' | 'network' | 'trusted';
const KEYS: readonly Key[] = ['profile', 'todo', 'band', 'remote', 'sync', 'lang', 'dotfiles', 'network', 'trusted'];
/** Where a browser (and the app's webview) kept each before they were the core's files. */
const STORAGE: Record<Key, string> = {profile: 'length3.os.profile', todo: 'length3.os.todo', band: 'length3.os.band',
  remote: 'length3.os.remote', sync: 'length3.os.sync', lang: 'length3.os.lang.setting', dotfiles: 'length3.os.dotfiles', network: 'length3.os.network',
  trusted: 'length3.os.trusted'};

const cache = new Map<Key, string | null>();

/** What the browser kept for `key`; storage it refuses (a private window) kept nothing. */
function local(key: Key): string | null {
  try { return localStorage.getItem(STORAGE[key]); } catch { return null; }
}

// A file that could not be read is not one that is absent: it is not
// written over (by a person, the Remote or the move below) until a later
// read succeeds, so nothing in it is lost to a passing failure.
const unread = new Map<Key, string>();
/** Each setting that could not be read here, and why. */
export const unreadable = (): ReadonlyMap<Key, string> => unread;
/** A setting as a person knows it. */
export const settingName = (key: Key): string => ({profile: t('Profile'), todo: 'TODO', band: t('The band'), remote: t('Sign-in'),
  sync: t('Where each repo stands'), lang: t('Language'), dotfiles: t('Dotfiles'), network: t('Network'), trusted: t('Dotfiles run here')})[key];

/** Read every key (or these) into memory; a value only the page's storage had is moved to its file once. */
export async function loadState(keys: readonly Key[] = KEYS): Promise<void> {
  for (const key of keys) {
    let value: string | null;
    try { value = await core<string | null>('state_get', {key}); } catch (e) {
      unread.set(key, errorText(e));
      continue;
    }
    unread.delete(key);
    // What this device runs was never kept by a page, and is never taken from one.
    const old = key === 'trusted' ? null : local(key);
    if (value === null && old !== null) {
      await core('state_set', {key, json: old});
      value = old;
      try { localStorage.removeItem(STORAGE[key]); } catch { /* moved; the leftover is never read again natively */ }
    }
    // None yet (a device from before it was kept): what this device ran until now is what it trusts, so the core
    // is asked to keep that first (core/src/home.rs keep_trust), and it is read as it kept it.
    if (key === 'trusted' && value === null) {
      try { await core('dotfiles_in_effect', {}); value = await core<string | null>('state_get', {key}); } catch { /* none run, then */ }
    }
    cache.set(key, value);
  }
}

/** `key` as last read (the page's old copy is never read in place of its file). */
export const getState = (key: Key): string | null => cache.get(key) ?? null;

/** Each listener hears the key, and whether another writer set it (`outside`): l3, the core syncing, another tab. */
const listeners = new Set<(key: Key, outside: boolean) => void>();
/** Hear each key set here (or by another tab of this browser); returns how to stop. */
export function onState(fn: (key: Key, outside: boolean) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * Read these keys again, as another writer left them, and tell each listener of a key that moved: nothing
 * here is decided from (or written back over) a value that has moved.
 */
export async function reloadState(keys: readonly Key[] = KEYS): Promise<void> {
  const was = new Map(keys.map((k) => [k, cache.get(k)]));
  await loadState(keys);
  for (const key of keys) if (cache.get(key) !== was.get(key)) for (const fn of [...listeners]) fn(key, true);
}
// Another tab of this browser wrote Home's state through its core.
onElsewhere((paths) => { if (paths.some((p) => p.startsWith(`${home()}/home/`))) void reloadState(); });

/** Store `json` for `key`; rejects with the reason when it could not be kept. */
export async function setState(key: Key, json: string): Promise<void> {
  const why = unread.get(key);
  if (why !== undefined) throw new Error(t('{what} could not be read, so it is not written over ({why})', {what: settingName(key), why}));
  cache.set(key, json);
  for (const fn of [...listeners]) fn(key, false);
  await core('state_set', {key, json});
}
