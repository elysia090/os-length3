// A link carried on Workers: the WebSocket's two ends are the runtime's, and so is the connection out (its
// `connect`, taken when a link is asked for: nothing but workerd has that module, and the Remote is read by node
// too). The same link as on this machine (relay.ts carries both).
//
// What the runtime does not reach: addresses that are Cloudflare's own, so a host served through Cloudflare is not
// reached by a link from here, and the box is told there is no way there (ENETUNREACH).

import type {Socket} from 'cloudflare:sockets';
import {admit, carry, type Admits, type Carries, type Open} from './relay.ts';
import {ERR, addressOf, blocks} from './where.ts';

type Connect = typeof import('cloudflare:sockets').connect;
/** The two ends of a WebSocket, as Workers makes them: the first is handed to whoever asked, the second is served here. */
declare const WebSocketPair: {new (): {0: WebSocket; 1: WebSocket & {accept(): void}}};

/** Bytes the page sent and the connection has not taken yet: past this the link is let go (nothing holds a page's writes back). */
const WAITING_MOST = 8 << 20;

/**
 * Cloudflare's own addresses (https://www.cloudflare.com/ips-v4, as of 2026-11): the runtime opens no connection to
 * them, and says so in the words it has for a host that refused. So they are told apart here, before it is asked:
 * a host behind Cloudflare is one there is no way to from here, not one that refused. Should the list fall behind,
 * such a host reads as having refused, and nothing else changes.
 */
const cloudflare = blocks(['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']);

/** Why the runtime's connection failed, as Linux numbers it: by what it says, which is all it gives. */
function errnoOf(e: unknown): number {
  const said = String((e as {message?: unknown})?.message ?? e).toLowerCase();
  if (said.includes('loop detected') || said.includes('prohibited')) return ERR.NETUNREACH;
  if (said.includes('timed out') || said.includes('timeout')) return ERR.TIMEDOUT;
  // "proxy request failed, cannot connect to the specified address": its words for a host that refused, too.
  return ERR.REFUSED;
}

/** A connection of the runtime's. */
export const tcp = (connect: Connect): Open => (address, port, heard) => {
  let over = false, waiting = 0;
  const failed = (e: unknown): void => { if (!over) { over = true; heard.failed(errnoOf(e)); } };
  const to = addressOf(address);
  if (to && cloudflare(to)) { queueMicrotask(() => failed(new Error('prohibited'))); return {send() {}, finish() {}, close() { over = true; }}; }
  let s: Socket;
  try {
    s = connect({hostname: address, port}, {secureTransport: 'off', allowHalfOpen: true});
  } catch (e) {
    // Said after this returns, as every other failure is.
    queueMicrotask(() => failed(e));
    return {send() {}, finish() {}, close() { over = true; }};
  }
  const writer = s.writable.getWriter();
  void (async () => {
    await s.opened;
    if (over) return;
    heard.opened();
    const reader = s.readable.getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (over) return;
      if (done) { heard.ended(); return; }
      heard.bytes(value);
    }
  })().catch(failed);
  return {
    send(bytes) {
      waiting += bytes.length;
      if (waiting > WAITING_MOST) { failed(new Error('timed out')); void s.close().catch(() => {}); return; }
      writer.write(bytes).then(() => { waiting -= bytes.length; }, failed);
    },
    finish() { writer.close().catch(() => {}); },
    close() { over = true; void s.close().catch(() => {}); },
  };
};

/**
 * A request for a link answered: the refusal, or the page's end of a WebSocket whose other end is carried here.
 * (`rule` is never given by the Worker itself, serve/worker.ts: only by what runs it on this machine to check it.)
 */
export async function link(req: Request, d: Admits & Omit<Carries, 'open'>): Promise<Response> {
  const who = await admit(req, d);
  if (who instanceof Response) return who;
  const {connect} = await import('cloudflare:sockets');
  const pair = new WebSocketPair(), page = pair[0], here = pair[1];
  here.accept();
  // (A Worker's WebSocket hands bytes over as a Blob unless told, as a page's does.)
  here.binaryType = 'arraybuffer';
  let closed = false;
  const close = (): void => { if (!closed) { closed = true; try { here.close(1000); } catch { /* closed already */ } } };
  const l = carry(who.user, {send: (bytes) => { if (!closed) try { here.send(bytes as Uint8Array<ArrayBuffer>); } catch { close(); } }, close}, {open: tcp(connect), resolve: d.resolve, rule: d.rule});
  here.addEventListener('message', (e: MessageEvent) => l.message(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer)));
  // The page let go, or the WebSocket broke: the handshake's other half is answered, and the connection goes.
  const gone = (): void => { close(); l.closed(); };
  here.addEventListener('close', gone);
  here.addEventListener('error', gone);
  return new Response(null, {status: 101, webSocket: page} as ResponseInit);
}
