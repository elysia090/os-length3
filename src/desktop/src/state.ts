// Home's state: the profile, the TODO list and Forge's band. In the app these
// are files in the OS's data directory (<data>/home/<key>.json), the same
// files `l3 todo` reads and writes; in a plain browser they stay in its
// storage. Reads are served from memory, filled at start and again whenever
// the window comes back, so a change made with l3 shows up.

import {isNative} from './host.ts';

// `remote` is which Remote this device talks to and as whom; `sync` is,
// for each repo and setting, the version on the Remote this copy came from.
export type Key = 'profile' | 'todo' | 'band' | 'remote' | 'sync';
export const KEYS: readonly Key[] = ['profile', 'todo', 'band', 'remote', 'sync'];
/** Where a browser keeps each, and where the app kept them before. */
const STORAGE: Record<Key, string> = {profile: 'length3.os.profile', todo: 'length3.os.todo', band: 'length3.os.band',
  remote: 'length3.os.remote', sync: 'length3.os.sync'};

const cache = new Map<Key, string | null>();

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function local(key: Key): string | null {
  try { return localStorage.getItem(STORAGE[key]); } catch { return null; }
}

/** Read every key into memory. Natively, a value only the webview had is moved to its file once. */
export async function loadState(): Promise<void> {
  for (const key of KEYS) {
    if (!isNative) { cache.set(key, local(key)); continue; }
    let value = await call<string | null>('state_get', {key}).catch(() => null);
    const old = local(key);
    if (value === null && old !== null) {
      await call('state_set', {key, json: old}).then(() => { value = old; }, () => {});
    }
    cache.set(key, value);
  }
}

export function getState(key: Key): string | null {
  return cache.has(key) ? cache.get(key)! : local(key);
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
  cache.set(key, json);
  for (const fn of listeners) fn(key);
  if (isNative) { await call('state_set', {key, json}); return; }
  try { localStorage.setItem(STORAGE[key], json); } catch (e) { throw new Error(String(e)); }
}
