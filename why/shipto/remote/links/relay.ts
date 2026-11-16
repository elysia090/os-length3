// A link carried: one WebSocket from a box in a page (module/cowboy/host/relay.ts) to one TCP connection from here.
// The page's first message is where to, as cowboy writes it (`name:port\n`); the first back is one byte: 0, the link
// is made, else why not, as Linux numbers it. Then nothing but the bytes each way, a message whatever came at a
// time; an empty message says no more will be sent that way. What is said over it is sealed between the box and the
// host it reaches (TLS, SSH): nothing here reads it, and nothing of it is kept.
//
//   who        admit: a session, from one of the app's own pages or a device's token; counted at the edge by address
//   to where   where.ts
//   how much   MOST links of an account at once (in this process), a first line within FIRST_MS, an answer from
//              the host within OPEN_MS, and a link on which nothing moved for QUIET_MS is let go
//
// What opens the connection is the host's own, handed in (`open`): on Workers a socket of the runtime's
// (relay.worker.ts), on this machine node's (relay.node.ts). No row is written for a link, and none is read but
// the session's, which is kept a few seconds: a link costs the Remote next to nothing, and when it is over,
// nothing of it is left.

import {credentialOf, sessionBy, type Auth} from '../people/auth.ts';
import {clientOf} from '../serve/request.ts';
import {ERR, asked, where, type Resolve, type Rule} from './where.ts';

/** Where a link is asked for. */
export const PATH = '/v1/link';

/** The page's side: messages to it, and letting go of it. */
export interface Near { send(bytes: Uint8Array): void; close(): void }
/** What the connection tells whoever opened it. */
export interface Heard { opened(): void; failed(errno: number): void; bytes(bytes: Uint8Array): void; ended(): void }
/** The host's side: bytes to it, no more to it, and letting go of it. */
export interface Far { send(bytes: Uint8Array): void; finish(): void; close(): void }
/** Open a TCP connection to `address` (IPv4, in dots) at `port`. */
export type Open = (address: string, port: number, heard: Heard) => Far;

export interface Carries { open: Open; resolve: Resolve; rule?: Rule }

/** How many links one account has at once, in this process. */
export const MOST = 16;
/** A first line comes within this; the host answers within this; a link on which nothing moves this long is let go. */
export const FIRST_MS = 10_000, OPEN_MS = 15_000, QUIET_MS = 300_000;

/** The links each account has open here. */
const open = new Map<string, number>();
/** How many links `user` has open in this process. */
export const held = (user: string): number => open.get(user) ?? 0;

/**
 * A link of `user`'s over `near`: hand it each message as it comes and say when it closed. Everything it does is in
 * answer to one of those or to the connection it opened.
 */
export function carry(user: string, near: Near, d: Carries): {message(bytes: Uint8Array | string): void; closed(): void} {
  let state: 'line' | 'opening' | 'open' | 'over' = 'line';
  let far: Far | null = null, counted = false, nearDone = false, farDone = false;
  const end = (): void => {
    if (state === 'over') return;
    state = 'over';
    clearTimeout(timer);
    far?.close();
    if (counted) { const n = held(user) - 1; if (n > 0) open.set(user, n); else open.delete(user); }
    near.close();
  };
  const refuse = (errno: number): void => { if (state !== 'over') { near.send(Uint8Array.of(errno)); end(); } };
  let timer = setTimeout(end, FIRST_MS);
  const moved = (): void => { clearTimeout(timer); timer = setTimeout(end, QUIET_MS); };
  const heard: Heard = {
    opened: () => { if (state === 'opening') { state = 'open'; near.send(Uint8Array.of(0)); moved(); } },
    failed: (errno) => { if (state === 'opening') refuse(errno); else end(); },
    bytes: (bytes) => { if (state === 'open' && bytes.length) { near.send(bytes); moved(); } },
    ended: () => { if (state !== 'open' || farDone) return; farDone = true; near.send(new Uint8Array(0)); if (nearDone) end(); },
  };
  return {
    message(bytes) {
      if (state === 'over') return;
      // A message of text is not this protocol's, nor are bytes before the link is made, nor any after the last.
      if (typeof bytes === 'string' || state === 'opening' || nearDone) { end(); return; }
      if (state === 'open') {
        if (bytes.length) { far!.send(bytes); moved(); return; }
        nearDone = true;
        far!.finish();
        if (farDone) end();
        return;
      }
      const a = asked(bytes);
      if (!a) { end(); return; }
      state = 'opening';
      if (held(user) >= MOST) { refuse(ERR.NOBUFS); return; }
      open.set(user, held(user) + 1);
      counted = true;
      clearTimeout(timer);
      timer = setTimeout(() => refuse(ERR.TIMEDOUT), OPEN_MS);
      void where(a, d.resolve, d.rule).then((w) => {
        if (state !== 'opening') return;
        if ('errno' in w) { refuse(w.errno); return; }
        const made = d.open(w.address, a.port, heard);
        // (Refused as it was asked: over already, and what was made is let go.)
        if ((state as string) === 'over') made.close(); else far = made;
      });
    },
    closed: end,
  };
}

export interface Admits {
  auth: Auth;
  /** The app's own pages. */
  origins: string[];
  /** How often one address may ask, counted at the edge (app.ts counts every other request by the same). */
  limiter?: {limit(o: {key: string}): Promise<{success: boolean}>};
  /** How long a session looked up is taken as still there by this process (ms). */
  sessionKept?: number;
}

/**
 * Who asks for a link, or the refusal. A WebSocket's handshake is a GET a page elsewhere can make a browser send,
 * the session's cookie with it, and what follows it is no read: so one that names an Origin names one of the app's
 * own, and the cookie alone, with none, is no one's (a browser always names one; a device's token comes with none).
 */
export async function admit(req: Request, d: Admits): Promise<{user: string} | Response> {
  const no = (status: number, error: string, headers?: Record<string, string>) => Response.json({error}, {status, headers});
  if ((req.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') return no(426, 'a WebSocket', {Upgrade: 'websocket'});
  const cred = credentialOf(req.headers);
  if (!cred) return no(401, 'not signed in');
  const origin = req.headers.get('Origin');
  if (origin === null ? cred.kind === 'cookie' : !d.origins.includes(origin)) return no(403, 'not from the app');
  if (d.limiter && !(await d.limiter.limit({key: clientOf(req.headers.get('CF-Connecting-IP') ?? '') || 'here'})).success) {
    return no(429, 'too many', {'Retry-After': '60'});
  }
  const s = await sessionBy(d.auth, cred, d.sessionKept);
  return s ? {user: s.user} : no(401, 'not signed in');
}
