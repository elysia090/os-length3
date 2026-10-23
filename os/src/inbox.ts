// Inbox: typed messages between people, found by address (name@domain),
// on the Remote (service/inbox.ts). A message is about something (a change
// to review, an issue, a run) and says it in words; it is kept on the Remote
// until read and a while after. When both people are accepted contacts and
// online, a WebRTC data channel opens between their devices and messages
// arrive at once over it (and are kept as usual); the Remote carries only
// the signalling, and offers no relay: without a direct path, messages
// simply go through the Remote as text.

import {api, json, RemoteError} from './remote.ts';
import {t} from './i18n.ts';
import {day} from './dom.ts';
import {every} from './runs.ts';

export type Kind = 'message' | 'review' | 'question' | 'run';
/** What a message is about; `server`: asking its reader into that server (service/inbox.ts). */
export interface Target { repo?: string; issue?: string; change?: string; version?: number; server?: string }
export interface Thread { address: string; name: string; state: 'contact' | 'request' | 'blocked'; unread: number; last: {type: Kind; body: string; mine: boolean; time: number} }
export interface Message { id: string; mine: boolean; type: Kind; target: Target; body: string; time: number; read: boolean; live?: boolean }
/**
 * `code`: six digits to be found by. An address on this Remote (`domain`) is
 * a name held `until`, renewed by its owner (`ended`: its term ran out; it is
 * held for them a while). `lapsed`: on a domain whose DNS no longer names
 * this Remote; it answers no one until it does again.
 */
export interface Me { domain: string; account: string; code: string; addresses: {address: string; until?: number; ended?: boolean; lapsed?: boolean}[] }

const enc = (a: string) => encodeURIComponent(a);

const KINDS: readonly Kind[] = ['message', 'review', 'question', 'run'];
/** As the Remote holds a message to (service/inbox.ts): its words, and what it may say it is about. */
const BODY = 4000;
const TARGET_KEYS = ['repo', 'issue', 'change', 'version', 'server'];

/** What a message may say it is about, as the Remote keeps it: those keys, each a short string or a number. */
function targetOf(raw: unknown): Target {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => TARGET_KEYS.includes(k)
    && (typeof v === 'string' ? v.length <= 200 : typeof v === 'number' && Number.isFinite(v)))) as Target;
}

/**
 * The place here a message points to, if it names one a repo here could be:
 * a repo by a name a repo can have (repos.ts validName), and an issue by a plain
 * file name in its issue/ (no folder, not hidden). Anyone may write anything there (the Remote keeps any
 * short string), so a target that names no such place is shown as words only.
 */
export function placeOf(target: Target): {repo: string; issue?: string} | null {
  const {repo, issue} = target;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(repo)) return null;
  if (issue === undefined) return {repo};
  return typeof issue === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(issue) ? {repo, issue} : null;
}

/**
 * A message come over the direct line, as the Remote would have taken it, or
 * null. The peer's device sends what it likes: nothing it says is used before
 * it is checked as the Remote checks a message sent to it, and it is never one's own.
 */
export function liveMessage(data: unknown): Message | null {
  if (typeof data !== 'string' || data.length > 4 * BODY + 2048) return null;
  let m: Record<string, unknown>;
  try { m = JSON.parse(data) as Record<string, unknown>; } catch { return null; }
  if (typeof m !== 'object' || m === null) return null;
  const body = typeof m.body === 'string' ? m.body.trim() : '';
  if (typeof m.id !== 'string' || !m.id || m.id.length > 64 || !body || body.length > BODY) return null;
  const type = KINDS.includes(m.type as Kind) ? m.type as Kind : 'message';
  // Its clock is the peer's: never later than now here.
  const time = typeof m.time === 'number' && Number.isFinite(m.time) ? Math.min(m.time, Date.now()) : Date.now();
  return {id: m.id, mine: false, type, target: targetOf(m.target), body, time, read: false, live: true};
}

export const me = () => json<Me>('/v1/inbox/me').then((m) => { home = m.domain; return m; });

/** This Remote's own domain, once known: a name on it is shown alone. */
let home = '';
/** Learn it before anything is shown, signed in or not. */
export async function learnHome() {
  if (home) return;
  try { home = ((await (await api('/v1/about', {}, null)).json()) as {domain?: string}).domain ?? ''; } catch { /* shown in full meanwhile */ }
}
/** An address as it is shown: a name on this Remote alone (`ren`), any other in full (`ren@ren.dev`). */
export const shown = (address: string) => (home && address.endsWith(`@${home}`) ? address.slice(0, -home.length - 1) : address);
/** A repo's public name the same way: `trip:hello`, `ren@ren.dev:hello`. */
export const shownAs = (as: string) => { const i = as.lastIndexOf(':'); return i < 0 ? as : `${shown(as.slice(0, i))}${as.slice(i)}`; };
export const threads = () => json<Thread[]>('/v1/inbox/threads');
export const thread = (address: string) => json<{address: string; state: Thread['state']; mutual: boolean; messages: Message[]}>(`/v1/inbox/threads/${enc(address)}`);
export const markRead = (address: string) => json(`/v1/inbox/threads/${enc(address)}/read`, {method: 'POST', body: '{}'});
export const lookup = (address: string) => json<{address?: string; reachable: boolean; why?: string}>(`/v1/inbox/lookup?address=${enc(address)}`);
export const setContact = (address: string, state: 'accepted' | 'blocked' | 'none') => json('/v1/inbox/contacts', {method: 'POST', body: JSON.stringify({address, state})});

/** Claim an address; for another domain, what the domain must publish first comes back in the error. */
export async function claim(name: string, domain?: string): Promise<string> {
  const r = await api('/v1/inbox/addresses', {method: 'POST', body: JSON.stringify({name, domain})});
  const body = await r.json() as {address?: string; error?: string; publish?: unknown};
  if (r.ok) return body.address!;
  if (body.publish) throw new Published(body.publish);
  const until = (body as {until?: number}).until;
  throw new RemoteError(r.status, until ? t('That name was let go; it is held for its owner until {date}', {date: day(until)}) : t(String(body.error ?? r.status)));
}

/** Hold a name on this Remote for another term from now (and take it back, if its term ran out a little while ago). */
export const renew = (address: string) => json<{address: string; until: number}>(`/v1/inbox/addresses/${enc(address)}/renew`, {method: 'POST', body: '{}'});

/** Let an address go: it answers no one from now, and is held for you a while (claim it again to take it back). */
export const release = (address: string) => json<{address: string; until: number}>(`/v1/inbox/addresses/${enc(address)}`, {method: 'DELETE'});

/** What a domain's DNS must say for this account to hold addresses on it here, and whether it says so now. */
export const domainRecord = (domain: string) => json<{name: string; type: string; value: string; found: boolean}>(`/v1/inbox/domains/${enc(domain.trim().toLowerCase())}`);

/** A domain must publish this before an address on it can be claimed. */
export class Published extends Error {
  readonly doc: unknown;
  constructor(doc: unknown) { super(t('The domain does not name this account yet')); this.doc = doc; }
}

export async function send(to: string, body: string, type: Kind = 'message', target: Target = {}): Promise<{id: string; request: boolean}> {
  const r = await api('/v1/inbox/messages', {method: 'POST', body: JSON.stringify({to, body, type, target})});
  const out = await r.json() as {id?: string; request?: boolean; error?: string};
  if (r.ok) return {id: out.id!, request: Boolean(out.request)};
  throw new RemoteError(r.status, t(String(out.error ?? r.status)));
}

/**
 * What an open conversation has on screen, so what comes later is put at its
 * foot once and only once: messages as the Remote gave them (whose times are
 * the Remote's own clock), and those added here (sent from here, or come over
 * the direct line), which are not taken in again when the Remote gives them.
 */
export class Conversation {
  private ids = new Set<string>();
  private newest = 0;
  /** Added here: true if it was not here yet. */
  have(m: Message): boolean {
    if (this.ids.has(m.id)) return false;
    this.ids.add(m.id);
    return true;
  }
  /** The conversation as the Remote has it: those not here yet, in its order. */
  took(list: readonly Message[]): Message[] {
    for (const m of list) this.newest = Math.max(this.newest, m.time);
    return list.filter((m) => this.have(m));
  }
  /** Whether its row in the list says something came after the newest the Remote gave here. */
  behind(row: Thread): boolean { return row.last.time > this.newest; }
}

// ---- live: a data channel between two devices, signalled through the Remote ----

/** STUN only: a device learns its own address; no relay is offered or used. */
const ICE = [{urls: 'stun:stun.cloudflare.com:3478'}];

type Signal = {from: string; session: string; kind: 'offer' | 'answer' | 'candidate' | 'bye'; data: string};
/** A signal not delivered leaves the line unopened, and messages go through the Remote as they do without one: nothing to say. */
const signal = (to: string, session: string, kind: Signal['kind'], data: string) =>
  api('/v1/inbox/signals', {method: 'POST', body: JSON.stringify({to, session, kind, data})}).then(() => {}, () => {});

/**
 * A live line to one contact while their thread is open on both sides. The
 * one whose address sorts first offers; the other answers. Messages still
 * go to the Remote as well, so the history is whole either way.
 */
export class Live {
  readonly peer: string;
  private me: string;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private session = '';
  private looking: {stop(): void} | null = null;
  /** Stopped: a look still out when it was makes no connection after it. */
  private ended = false;
  private hear: (m: Message) => void;
  private state: (open: boolean) => void;
  constructor(me: string, peer: string, hear: (m: Message) => void, state: (open: boolean) => void) {
    this.me = me; this.peer = peer; this.hear = hear; this.state = state;
  }
  get open() { return this.channel?.readyState === 'open'; }

  /** Until when signals are looked for every moment: a line being opened (begun, offered, or a signal just came). */
  private busyUntil = 0;
  private busy() { this.busyUntil = Date.now() + 30_000; }
  /**
   * How soon signals are looked for again: every moment while a line is being opened; once it is open, or
   * nothing came for half a minute, now and then (an offer from the other side still finds it, a little later).
   * Each look is a request to the Remote that takes rows from its database: not every second and a half for as
   * long as a conversation is left open, which was 40 a minute.
   */
  private pace(): number { return this.open ? 60_000 : Date.now() < this.busyUntil ? 1500 : 20_000; }

  /**
   * Begin: signals are looked for while the page is in view (not while it is hidden), one look at a time, as
   * often as pace() says, until it is stopped or `alive` says the conversation is gone.
   */
  start(alive: () => boolean) {
    if (typeof RTCPeerConnection === 'undefined') return;
    this.busy();
    this.looking = every(() => this.pace(), () => this.poll(), {alive, ended: () => this.stop(), paced: true});
    // Not offered (no media stack, refused): messages go through the Remote, as without a line.
    if (this.me < this.peer) void this.offer().catch(() => this.state(false));
  }

  private connection(session: string): RTCPeerConnection {
    this.busy();
    this.pc?.close();
    this.session = session;
    const pc = new RTCPeerConnection({iceServers: ICE});
    pc.onicecandidate = (e) => { if (e.candidate) void signal(this.peer, session, 'candidate', JSON.stringify(e.candidate)); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.state(false); };
    pc.ondatachannel = (e) => this.use(e.channel);
    this.pc = pc;
    return pc;
  }

  private use(ch: RTCDataChannel) {
    this.channel = ch;
    ch.onopen = () => this.state(true);
    ch.onclose = () => this.state(false);
    ch.onmessage = (e) => { const m = liveMessage(e.data); if (m) this.hear(m); };
  }

  private async offer() {
    const pc = this.connection(crypto.randomUUID());
    this.use(pc.createDataChannel('inbox'));
    await pc.setLocalDescription(await pc.createOffer());
    await signal(this.peer, this.session, 'offer', JSON.stringify(pc.localDescription));
  }

  /** What came from this peer: its offers, and the rest of this line's session; another chat's or device's stays for it. */
  private async poll() {
    // Looked for every moment: one that is not answered is asked again at the next.
    // Taken with a POST: taking deletes them on the Remote, and no GET changes anything there.
    const got = await json<Signal[]>('/v1/inbox/signals/take', {method: 'POST', body: JSON.stringify({from: this.peer, ...(this.session ? {session: this.session} : {})})})
      .catch(() => [] as Signal[]);
    if (got.length) this.busy();
    for (const s of got) {
      if (this.ended) return;
      // One the line cannot use (not JSON, a late answer, a candidate the connection has moved past) is
      // refused by it and passed over: the line goes on as it was, and the signals after it are still taken.
      try { await this.take(s); } catch { /* passed over, as said */ }
    }
  }

  private async take(s: Signal) {
    if (s.kind === 'bye') { this.channel?.close(); this.state(false); return; }
    if (s.kind === 'offer') {
      const pc = this.connection(s.session);
      await pc.setRemoteDescription(JSON.parse(s.data));
      await pc.setLocalDescription(await pc.createAnswer());
      await signal(this.peer, s.session, 'answer', JSON.stringify(pc.localDescription));
    } else if (s.session === this.session && this.pc) {
      if (s.kind === 'answer') await this.pc.setRemoteDescription(JSON.parse(s.data));
      else await this.pc.addIceCandidate(JSON.parse(s.data));
    }
  }

  /** Send over the live line when it is open; returns whether it went. */
  say(m: Message): boolean {
    if (!this.open) return false;
    this.channel!.send(JSON.stringify(m));
    return true;
  }

  stop() {
    if (this.ended) return;
    this.ended = true;
    this.looking?.stop();
    if (this.pc) void signal(this.peer, this.session, 'bye', '');
    this.channel?.close();
    this.pc?.close();
    this.pc = null;
  }
}
