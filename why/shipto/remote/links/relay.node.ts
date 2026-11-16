// A link carried on this machine (serve/dev.ts): the WebSocket's server side by hand (serve/ws.ts), the connection
// node's own. The same link as on Workers (relay.ts carries both); what differs is only whose socket it is.

import type {IncomingMessage, Server} from 'node:http';
import {connect, type Socket} from 'node:net';
import {accepted, frame, frames} from '../serve/ws.ts';
import {PATH, admit, carry, type Admits, type Carries, type Open} from './relay.ts';
import {ERR} from './where.ts';

/** Why node's connection failed, as Linux numbers it. */
const errnoOf = (code: string | undefined): number =>
  (code === 'ETIMEDOUT' ? ERR.TIMEDOUT : code === 'ENETUNREACH' ? ERR.NETUNREACH : code === 'EHOSTUNREACH' ? ERR.HOSTUNREACH : ERR.REFUSED);

/** A connection of node's. */
export const tcp: Open = (address, port, heard) => {
  const s = connect({host: address, port, allowHalfOpen: true});
  s.setNoDelay(true);
  s.on('connect', () => heard.opened());
  s.on('data', (b: Buffer) => heard.bytes(new Uint8Array(b)));
  s.on('end', () => heard.ended());
  s.on('error', (e: NodeJS.ErrnoException) => heard.failed(errnoOf(e.code)));
  return {send: (bytes) => { s.write(bytes); }, finish: () => { s.end(); }, close: () => { s.destroy(); }};
};

/**
 * Links carried by `server`, which answers at `base`: an upgrade asked at PATH is admitted and carried; one that is
 * not admitted is answered as a request is, and one asked anywhere else is let go.
 */
export function links(server: Server, base: string, d: Admits & Carries): void {
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      if (url.pathname !== PATH) { socket.destroy(); return; }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const who = await admit(new Request(url, {headers}), d);
      if (who instanceof Response) {
        socket.end(`HTTP/1.1 ${who.status} Refused\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${await who.text()}`);
        return;
      }
      if (!accepted(req, socket)) return;
      let closed = false;
      const link = carry(who.user, {
        send: (bytes) => { if (!closed) socket.write(frame(bytes)); },
        close: () => { if (!closed) { closed = true; socket.end(frame(new Uint8Array(0), 8)); } },
      }, d);
      frames(socket, (m) => link.message(new Uint8Array(m)), () => { closed = true; link.closed(); });
    })().catch(() => socket.destroy());
  });
}
