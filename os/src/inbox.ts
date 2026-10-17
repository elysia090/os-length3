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

export type Kind = 'message' | 'review' | 'question' | 'run';
export interface Target { repo?: string; issue?: string; change?: string; version?: number }
export interface Thread { address: string; name: string; state: 'contact' | 'request' | 'blocked'; unread: number; last: {type: Kind; body: string; mine: boolean; time: number} }
export interface Message { id: string; mine: boolean; type: Kind; target: Target; body: string; time: number; read: boolean; live?: boolean }
/**
 * `code`: six digits to be found by. An address on this Remote (`domain`) is
 * a name held `until`, renewed by its owner (`ended`: its term ran out; it is
 * held for them a while). `lapsed`: on a domain whose DNS no longer names
 * this Remote; it answers no one until it does again.
 */
export interface Me { domain: string; account: string; code: string; addresses: {address: string; ssh: boolean; until?: number; ended?: boolean; lapsed?: boolean}[] }

const enc = (a: string) => encodeURIComponent(a);

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
export const setSsh = (address: string, on: boolean) => json(`/v1/inbox/addresses/${enc(address)}/ssh`, {method: 'POST', body: JSON.stringify({on})});

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

// ---- live: a data channel between two devices, signalled through the Remote ----

/** STUN only: a device learns its own address; no relay is offered or used. */
const ICE = [{urls: 'stun:stun.cloudflare.com:3478'}];

type Signal = {from: string; session: string; kind: 'offer' | 'answer' | 'candidate' | 'bye'; data: string};
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
  private timer = 0;
  private hear: (m: Message) => void;
  private state: (open: boolean) => void;
  constructor(me: string, peer: string, hear: (m: Message) => void, state: (open: boolean) => void) {
    this.me = me; this.peer = peer; this.hear = hear; this.state = state;
  }
  get open() { return this.channel?.readyState === 'open'; }

  start() {
    if (typeof RTCPeerConnection === 'undefined') return;
    this.timer = window.setInterval(() => void this.poll(), 1500);
    if (this.me < this.peer) void this.offer();
  }

  private connection(session: string): RTCPeerConnection {
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
    ch.onmessage = (e) => { try { this.hear({...(JSON.parse(String(e.data)) as Message), mine: false, live: true}); } catch { /* not ours */ } };
  }

  private async offer() {
    const pc = this.connection(crypto.randomUUID());
    this.use(pc.createDataChannel('inbox'));
    await pc.setLocalDescription(await pc.createOffer());
    await signal(this.peer, this.session, 'offer', JSON.stringify(pc.localDescription));
  }

  /** What came from this peer: its offers, and the rest of this line's session; another chat's or device's stays for it. */
  private async poll() {
    // Polled every moment: one that is not answered is asked again at the next.
    const got = await json<Signal[]>(`/v1/inbox/signals?from=${enc(this.peer)}${this.session ? `&session=${enc(this.session)}` : ''}`).catch(() => [] as Signal[]);
    for (const s of got) {
      if (s.kind === 'bye') { this.channel?.close(); this.state(false); continue; }
      if (s.kind === 'offer') {
        const pc = this.connection(s.session);
        await pc.setRemoteDescription(JSON.parse(s.data));
        await pc.setLocalDescription(await pc.createAnswer());
        await signal(this.peer, s.session, 'answer', JSON.stringify(pc.localDescription));
      } else if (s.session === this.session && this.pc) {
        // A late answer or a candidate the connection has moved past is refused by it, and the line goes on as it was.
        if (s.kind === 'answer') await this.pc.setRemoteDescription(JSON.parse(s.data)).catch(() => {});
        else await this.pc.addIceCandidate(JSON.parse(s.data)).catch(() => {});
      }
    }
  }

  /** Send over the live line when it is open; returns whether it went. */
  say(m: Message): boolean {
    if (!this.open) return false;
    this.channel!.send(JSON.stringify(m));
    return true;
  }

  stop() {
    clearInterval(this.timer);
    if (this.pc) void signal(this.peer, this.session, 'bye', '');
    this.channel?.close();
    this.pc?.close();
    this.pc = null;
  }
}
