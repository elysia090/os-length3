// The other tabs of this app in this browser. They share one copy of the
// repos (repos.ts, IndexedDB) and one set of settings (state.ts,
// localStorage), so each tab hears what the others keep, a repo is kept in
// step by one tab at a time (draft.ts), and nothing is let go while another
// tab still holds it (lifecycle.ts). In the app there is one window and none
// of this is needed: every call here is a no-op there.

import {isNative} from './host.ts';

export type Message =
  /** `key`'s copy was kept: these paths of it changed (none: the whole copy). */
  | {kind: 'kept'; key: string; paths?: string[]}
  /** These copies were let go from this browser. */
  | {kind: 'gone'; keys: string[]}
  /** A tab says it is here (`hello` asks the others to say so too) or going. */
  | {kind: 'hello' | 'here' | 'bye'; tab: string};

/** What tabs speak through (a BroadcastChannel): what one posts, every other hears. */
export interface Channel { postMessage(m: Message): void; onmessage: ((e: {data: Message}) => void) | null }
/** Web Locks, as far as they are used here. */
export interface Locks { request(name: string, ...a: unknown[]): Promise<unknown>; query?(): Promise<{held?: {name?: string}[]}> }

/** This tab among the others: what it tells them, what it hears, and which are open. */
export class Tabs {
  readonly me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private others = new Set<string>();
  private hearers = new Set<(m: Message) => void>();
  private channel: Channel | null;
  private locks: Locks | undefined;
  constructor(channel: Channel | null, locks?: Locks) {
    this.channel = channel;
    this.locks = locks;
    if (!channel) return;
    channel.onmessage = (e) => {
      const m = e.data;
      if (m.kind === 'hello' || m.kind === 'here') this.others.add(m.tab);
      if (m.kind === 'hello') this.post({kind: 'here', tab: this.me});
      if (m.kind === 'bye') this.others.delete(m.tab);
      for (const fn of [...this.hearers]) fn(m);
    };
    // Each tab holds a lock named after it while it lives: one that ended without saying so (it crashed,
    // or was killed) is known gone by its lock, which the browser lets go with it.
    void locks?.request(`length3:tab:${this.me}`, () => new Promise(() => {}))?.catch(() => {});
    this.post({kind: 'hello', tab: this.me});
  }
  /** Tell every other tab of this browser. */
  post(m: Message) {
    try { this.channel?.postMessage(m); } catch { /* a tab alone hears nothing */ }
  }
  /** Hear what other tabs tell; returns how to stop. */
  hear(fn: (m: Message) => void): () => void { this.hearers.add(fn); return () => this.hearers.delete(fn); }
  /** Whether another tab of this app is open in this browser, as last heard. */
  othersOpen(): boolean { return this.others.size > 0; }
  /** This tab is going (its page is left). */
  bye() { this.post({kind: 'bye', tab: this.me}); }
  /** This tab is back (from the back-forward cache): the others are asked again. */
  again() { this.others.clear(); this.post({kind: 'hello', tab: this.me}); }
  /** Forget the tabs that are gone without a word (their locks are let go); called now and then. */
  async prune(): Promise<void> {
    const q = await this.locks?.query?.().catch(() => null);
    if (!q?.held) return;
    const alive = new Set(q.held.map((h) => h.name ?? '').filter((n) => n.startsWith('length3:tab:')).map((n) => n.slice('length3:tab:'.length)));
    for (const id of [...this.others]) if (!alive.has(id)) this.others.delete(id);
  }
  /**
   * Run `f` holding `name` across every tab of this browser, so two tabs never
   * do it at once (Web Locks); a browser without them runs it as it comes.
   */
  exclusive<T>(name: string, f: () => Promise<T>): Promise<T> {
    return this.locks ? this.locks.request(`length3:${name}`, f) as Promise<T> : f();
  }
}

// Only in a page: a worker, or the tests' Node, has no tabs.
const channel = !isNative && typeof document !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('length3') as unknown as Channel : null;
const tabs = new Tabs(channel, isNative ? undefined : (globalThis.navigator as {locks?: Locks} | undefined)?.locks);
export const post = (m: Message) => tabs.post(m);
export const hear = (fn: (m: Message) => void) => tabs.hear(fn);
export const othersOpen = () => tabs.othersOpen();
export const prune = () => tabs.prune();
export const exclusive = <T>(name: string, f: () => Promise<T>) => tabs.exclusive(name, f);
if (channel) {
  addEventListener('pagehide', () => tabs.bye());
  addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) tabs.again(); });
}
