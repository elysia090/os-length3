// Home's state: the profile, the TODO list and Forge's band. In the app these
// are files in the OS's data directory (<data>/home/<key>.json), the same
// files `l3 todo` reads and writes; in a plain browser they stay in its
// storage. Reads are served from memory, filled at start and again whenever
// the window comes back, so a change made with l3 shows up.

import {isNative, native} from './host.ts';
import {t} from './i18n.ts';
import {errorText} from './errors.ts';

// `remote` is which Remote this device talks to and as whom; `sync` is,
// for each repo and setting, the version on the Remote this copy came from;
// `lang` is the language the OS speaks here (i18n.ts), l3 included.
// `network` is which repos' Prompts may reach the network here (the app only; never sent).
export type Key = 'profile' | 'todo' | 'band' | 'remote' | 'sync' | 'lang' | 'dotfiles' | 'network';
const KEYS: readonly Key[] = ['profile', 'todo', 'band', 'remote', 'sync', 'lang', 'dotfiles', 'network'];
/** Where a browser keeps each, and where the app kept them before. */
const STORAGE: Record<Key, string> = {profile: 'length3.os.profile', todo: 'length3.os.todo', band: 'length3.os.band',
  remote: 'length3.os.remote', sync: 'length3.os.sync', lang: 'length3.os.lang.setting', dotfiles: 'length3.os.dotfiles', network: 'length3.os.network'};

const cache = new Map<Key, string | null>();

/** What the browser keeps for `key`; storage it refuses (a private window) keeps nothing. */
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
  sync: t('Where each repo stands'), lang: t('Language'), dotfiles: t('Dotfiles'), network: t('Network')})[key];

/** Read every key into memory. Natively, a value only the webview had is moved to its file once. */
export async function loadState(): Promise<void> {
  for (const key of KEYS) {
    if (!isNative) { cache.set(key, local(key)); continue; }
    let value: string | null;
    try { value = await native<string | null>('state_get', {key}); } catch (e) {
      unread.set(key, errorText(e));
      continue;
    }
    unread.delete(key);
    const old = local(key);
    if (value === null && old !== null) {
      await native('state_set', {key, json: old});
      value = old;
      try { localStorage.removeItem(STORAGE[key]); } catch { /* moved; the leftover is never read again natively */ }
    }
    cache.set(key, value);
  }
}

export function getState(key: Key): string | null {
  if (cache.has(key)) return cache.get(key)!;
  // The app's settings are its files: the webview's old copy is never read in their place.
  return isNative ? null : local(key);
}

const listeners = new Set<(key: Key) => void>();
/** Hear each key set here; returns how to stop. */
export function onState(fn: (key: Key) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/** Let `key` go from this browser (the app keeps its files). */
export function dropState(key: Key) {
  cache.delete(key);
  if (!isNative) try { localStorage.removeItem(STORAGE[key]); } catch { /* nothing kept */ }
}

/** Store `json` for `key`; rejects with the reason when it could not be kept. */
export async function setState(key: Key, json: string): Promise<void> {
  const why = unread.get(key);
  if (why !== undefined) throw new Error(t('{what} could not be read, so it is not written over ({why})', {what: settingName(key), why}));
  cache.set(key, json);
  for (const fn of [...listeners]) fn(key);
  if (isNative) { await native('state_set', {key, json}); return; }
  try { localStorage.setItem(STORAGE[key], json); } catch (e) { throw new Error(String(e)); }
}
