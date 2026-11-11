// Each repo here kept in step with its draft on the Remote (root3/remote/serve/app.ts), a diff at a time: the core does it
// (root3/core/src/remote), the app's or the same built for the web, so a browser and the app are one kind of device to the
// Remote. What a repo's copy is told of it goes through the store (repos.ts), as any change to a repo does; Home's
// settings are agreed with the Remote in remote/settings.ts.

import {core} from '../host/host.ts';
import {store} from './repos.ts';

export type Tree = Record<string, string | null>;

/** `paths`: every path this copy changed by taking in (each told to what shows it). */
interface Synced { version: number; sent: number; taken: number; both: string[]; unsynced: [string, string][]; paths?: string[] }
/** Where a copy stands. */
export interface Status { name: string; changed: number; fresh: boolean; unsynced: [string, string][]; bytes: number; head: string | null; version: number; elsewhere?: number }
/** A repo on the Remote; one turned off says when it went and until when it can come back. */
export interface RemoteRepo { name: string; head: string | null; version: number; bytes: number; updatedAt: string; offAt?: number | null; until?: number | null }

/** Whoever writes on sync's behalf, so listeners can tell its writes from a person's. */
export const BY = 'sync';

/** Send what changed here and take in what changed there, until both are the same. */
export async function sync(repo: string): Promise<Synced> {
  const s = await core<Synced>('sync_repo', {repo});
  if (s.paths?.length) await store.changedPaths(repo, s.paths, BY);
  return s;
}

/** Bring a repo that is only on the Remote here (opening it does this). */
export async function fetchRepo(repo: string): Promise<Synced> {
  const s = await core<Synced>('repo_fetch', {repo});
  store.changedOutside(repo, BY);
  return s;
}

export const remoteRepos = (): Promise<RemoteRepo[]> => core<RemoteRepo[]>('remote_repos');

/** Where each repo here stands, from what is here alone. */
export const status = (): Promise<Status[]> => core<Status[]>('remote_status');

/** Show `line`'s work as `repo` here; its copy comes from the Remote when it is not here yet. */
export async function showLine(repo: string, line: string): Promise<void> {
  await core('work_switch', {repo, line});
  store.changedOutside(repo, 'work');
}
