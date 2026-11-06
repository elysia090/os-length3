// Home's settings that are the person's, agreed with the Remote (core/src/home/), and what moved there since this
// device last asked: the two looks lifecycle.ts takes to know what to agree and what to fetch.

import {core} from '../app/host.ts';
import {reading} from './connection.ts';
import {lookAt} from './looks.ts';
import {getState, reloadState} from '../home/state.ts';

/**
 * What moved on the Remote, in one small read: a stamp of its repos (the list changes when it does) and each setting's
 * version. Asked with its last answer's tag: nothing written on the Remote since, it is answered without its database.
 */
export interface Moved { repos: string; home: Record<string, number> }
export const moved = async () => reading<Moved>(await lookAt('/v1/moved'));

// The band is the device's: these are the person's.
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

/** Agree a setting with the Remote (core/src/home/agree.rs agree_with): what changed here is sent, what changed there taken. */
export async function syncHome(key: HomeKey): Promise<void> {
  await core('home_sync', {key});
  await reloadState([key, 'sync']);
}
