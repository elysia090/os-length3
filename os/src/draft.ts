// Each repo here kept in step with its draft on the Remote (service/app.ts), a diff at a time, and Home's
// settings agreed with it: the core does both (core/src/remote, core/src/home.rs), the app's or the same
// built for the web, so a browser and the app are one kind of device to the Remote.

import {core} from './host.ts';
import {json} from './remote.ts';
import {store} from './repos.ts';
import {getState, reloadState} from './state.ts';

export type Tree = Record<string, string | null>;

export interface Synced { version: number; sent: number; taken: number; both: string[]; unsynced: [string, string][] }
/** Where a copy stands. */
export interface Status { name: string; changed: number; fresh: boolean; unsynced: [string, string][]; bytes: number; head: string | null; version: number; elsewhere?: number }
/** A repo on the Remote; one turned off says when it went and until when it can come back. */
export interface RemoteRepo { name: string; head: string | null; version: number; bytes: number; updatedAt: string; offAt?: number | null; until?: number | null }

/** Whoever writes on sync's behalf, so listeners can tell its writes from a person's. */
export const BY = 'sync';

/** Send what changed here and take in what changed there, until both are the same. */
export async function sync(repo: string): Promise<Synced> {
  const s = await core<Synced>('sync_repo', {repo});
  if (s.taken) store.changedOutside(repo, BY);
  return s;
}

/** Bring a repo that is only on the Remote here (opening it does this). */
export async function fetchRepo(repo: string): Promise<Synced> {
  const s = await core<Synced>('repo_fetch', {repo});
  store.changedOutside(repo, BY);
  return s;
}

export const remoteRepos = (): Promise<RemoteRepo[]> => core<RemoteRepo[]>('remote_repos');

/** What moved on the Remote, in one small read: a stamp of its repos (the list changes when it does) and each setting's version. */
export interface Moved { repos: string; home: Record<string, number> }
export const moved = () => json<Moved>('/v1/moved');

/** Where each repo here stands, from what is here alone. */
export const status = (): Promise<Status[]> => core<Status[]>('remote_status');

/** Show `line`'s work as `repo` here; its copy comes from the Remote when it is not here yet. */
export async function showLine(repo: string, line: string): Promise<void> {
  await core('work_switch', {repo, line});
  store.changedOutside(repo, 'work');
}

// ---- Home's settings that are the person's (the band is the device's) ----

export const HOME_KEYS = ['profile', 'todo', 'dotfiles'] as const;
export type HomeKey = typeof HOME_KEYS[number];

/** A setting as last agreed with the Remote (the `sync` setting's `home`, as the core keeps it). */
function agreed(key: HomeKey): {version: number; value: string} | undefined {
  try { return (JSON.parse(getState('sync') ?? '') as {home?: Record<string, {version: number; value: string}>}).home?.[key]; } catch { return undefined; }
}

/** Whether a setting needs agreeing: its version on the Remote moved, or its value here is not the one agreed. */
export function homeMoved(key: HomeKey, version: number): boolean {
  const b = agreed(key);
  return version !== (b?.version ?? 0) || (getState(key) ?? '') !== (b?.value ?? '');
}

/** Agree a setting with the Remote (core/src/home.rs agree_with): what changed here is sent, what changed there taken. */
export async function syncHome(key: HomeKey): Promise<void> {
  await core('home_sync', {key});
  await reloadState([key, 'sync']);
}
