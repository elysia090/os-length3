// Which of an account's devices listen for SSH, and to whom, as the Remote keeps it (why/shipto/remote/repos/ssh.ts):
// that much and no more, so any page sees it and can turn one off. The listener itself, and where a device is
// reached, are that device's own (why/cowboy/ssh.ts).

import {json} from './connection.ts';
import type {Scope} from '../cowboy/ssh.ts';

/** A device listening: its session, its user agent, to whom, when it was turned on and last heard from. */
export interface Listening { device: string; agent: string | null; scope: Scope; since: number; seen: number; current: boolean }

export const listening = () => json<Listening[]>('/v1/ssh');
/** Turn a device's SSH off: it hears so within seconds, stops taking connections and ends its sessions. */
export const turnOff = (device: string) => json(`/v1/ssh/${encodeURIComponent(device)}/off`, {method: 'POST', body: '{}'});

/** A device asks every 30 s or so whether it still listens (why/cli/src/cmd/ssh.rs BEAT); one not heard from for three of those is said to be quiet. */
export const QUIET = 100_000;

/** Whether a device has not been heard from lately (its listener may have been killed). */
export const quiet = (l: Pick<Listening, 'seen'>, now = Date.now()) => now - l.seen > QUIET;
