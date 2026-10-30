// SSH into a repo's Prompt, as Runtime shows it. SSH is the desktop app's:
// a device turns it on itself (`l3 address`, or the app's switch, which runs
// the same l3 there). What the Remote keeps (service/ssh.ts) is only which
// of the account's devices listen and to whom, so any page sees that and can
// turn one off; where a device is reached (its addresses, port, repos) is
// worked out on that device and shown there alone.

import {isNative, native} from '../app/host.ts';
import {json} from '../remote/connection.ts';

/** To whom a device listens: from itself only, or from its network's PCs too. */
export type Scope = 'device' | 'network';

/** A device listening: its session, its user agent, to whom, when it was turned on and last heard from. */
export interface Listening { device: string; agent: string | null; scope: Scope; since: number; seen: number; current: boolean }

export const listening = () => json<Listening[]>('/v1/ssh');
/** Turn a device's SSH off: it hears so within seconds, stops taking connections and ends its sessions. */
export const turnOff = (device: string) => json(`/v1/ssh/${encodeURIComponent(device)}/off`, {method: 'POST', body: '{}'});

/** An address listened on besides loopback, and the interface it is on (`wlan0`, `tailscale0`). */
export interface Taken { addr: string; interface: string }

/**
 * This device's own, in the app (core ssh::Here), never sent: whether it listens, to whom (the scope kept, when
 * off), the addresses it listens on (and besides loopback, each one's interface), where each repo is reached, its
 * host key, and how many keys are let in.
 */
export interface Here { on: boolean; scope: Scope; port?: number | null; bound: string[]; interfaces?: Taken[]; destinations: string[]; fingerprint?: string | null; keys: number; started?: number | null }
export const here = (): Promise<Here | null> => (isNative ? native<Here>('ssh_here') : Promise.resolve(null));
/** Turn this device's SSH on, to `scope`, or off (the app only): l3 address ssh on SCOPE | off. */
export const setHere = (on: boolean, scope?: Scope) => native<Here>('ssh_set', {on, scope: scope ?? null});

/**
 * The addresses of this device it listens on besides loopback (with `network`: its LAN ones, and a VPN interface's),
 * each after its interface, as l3 address says them: `wlan0 192.168.1.5`. An l3 from before names the addresses alone.
 */
export const lan = (h: Pick<Here, 'bound' | 'interfaces'>) => (h.interfaces?.length
  ? h.interfaces.map((i) => `${i.interface} ${i.addr}`)
  : h.bound.filter((a) => a !== '127.0.0.1' && a !== '::1'));

/** A device asks every 30 s or so whether it still listens (cli/src/ssh.rs BEAT); one not heard from for three of those is said to be quiet. */
export const QUIET = 100_000;

/** Whether a device has not been heard from lately (its listener may have been killed). */
export const quiet = (l: Pick<Listening, 'seen'>, now = Date.now()) => now - l.seen > QUIET;
