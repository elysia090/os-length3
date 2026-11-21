// SSH into a repo's Prompt, on this device: SSH is the desktop app's, and a device turns it on itself (`why
// address`, or the app's switch, which runs the same why there). Where a device is reached (its addresses, port,
// repos) is worked out on that device and shown there alone; which of an account's devices listen is the Remote's
// to keep (why/shipto/ssh.ts).

import {isNative, native} from '../api/host.ts';

import type {Scope} from '../api/ssh-scope.ts';

/** An address listened on besides loopback, and the interface it is on (`wlan0`, `tailscale0`). */
export interface Taken { addr: string; interface: string }

/**
 * This device's own, in the app (core ssh::Here), never sent: whether it listens, to whom (the scope kept, when
 * off), the addresses it listens on (and besides loopback, each one's interface), where each repo is reached, its
 * host key, and how many keys are let in.
 */
export interface Here { on: boolean; scope: Scope; port?: number | null; bound: string[]; interfaces?: Taken[]; destinations: string[]; fingerprint?: string | null; keys: number; started?: number | null }
export const here = (): Promise<Here | null> => (isNative ? native<Here>('ssh_here') : Promise.resolve(null));
/** Turn this device's SSH on, to `scope`, or off (the app only): why address ssh on SCOPE | off. */
export const setHere = (on: boolean, scope?: Scope) => native<Here>('ssh_set', {on, scope: scope ?? null});

/**
 * The addresses of this device it listens on besides loopback (with `network`: its LAN ones, and a VPN interface's),
 * each after its interface, as why address says them: `wlan0 192.168.1.5`. An why from before names the addresses alone.
 */
export const lan = (h: Pick<Here, 'bound' | 'interfaces'>) => (h.interfaces?.length
  ? h.interfaces.map((i) => `${i.interface} ${i.addr}`)
  : h.bound.filter((a) => a !== '127.0.0.1' && a !== '::1'));
