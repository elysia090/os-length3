// SSH into a repo's Prompt, as Runtime shows it. Which of the account's
// devices listen is kept on the Remote (service/ssh.ts), so any page sees
// them and can turn one off; turning one on is done at the device itself
// (`l3 address`, or the app's switch, which runs the same l3 here).

import {isNative, native} from './host.ts';
import {json} from './remote.ts';

/** A device listening: its session, its user agent, where each repo is reached, when it was turned on and last heard from. */
export interface Listening { device: string; agent: string | null; port: number; destinations: string[]; since: number; seen: number; current: boolean }

export const listening = () => json<Listening[]>('/v1/ssh');
/** Turn a device's SSH off: it hears so within seconds, stops taking connections and ends its sessions. */
export const turnOff = (device: string) => json(`/v1/ssh/${encodeURIComponent(device)}/off`, {method: 'POST', body: '{}'});

/** This device's own, in the app: whether it listens, where, and its host key. */
export interface Here { on: boolean; port?: number; destinations?: string[]; fingerprint?: string }
export const here = (): Promise<Here | null> => (isNative ? native<Here>('ssh_here') : Promise.resolve(null));
/** Turn this device's SSH on or off (the app only): l3 address ssh on|off. */
export const setHere = (on: boolean) => native<Here>('ssh_set', {on});

/** A device asks every few seconds whether it still listens; one not heard from for this long is said to be quiet. */
export const QUIET = 30_000;

/** Whether a device has not been heard from lately (its listener may have been killed). */
export const quiet = (l: Pick<Listening, 'seen'>, now = Date.now()) => now - l.seen > QUIET;
