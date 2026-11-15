// The Worker's database driver (@neondatabase/serverless) speaks Postgres
// over a WebSocket, which Neon's hosts answer and an ordinary Postgres does
// not. This is the small WebSocket server that stands between, in the same
// process, so the Worker's own pool code runs against a Postgres on this
// machine (verify.ts) or a PGlite (worker.test.ts): each connection's bytes
// are handed to a TCP connection to the address it names, or to a PGlite,
// one connection's messages at a time. For tests and verification only; on
// Workers the driver reaches Neon directly.

import {createServer, type IncomingMessage} from 'node:http';
import {connect, type Socket} from 'node:net';
import type {PGlite} from '@electric-sql/pglite';
import {neonConfig} from '@neondatabase/serverless';
import {accepted, frame, frames} from './ws.ts';

type Target = {tcp: true} | {pglite: PGlite};

/**
 * Postgres messages as they come over one connection, cut into whole ones:
 * the first is the startup (its length first, no type), every other a type
 * and a length. A Terminate ends the connection here, never the PGlite.
 */
function messages(each: (batch: Buffer, terminate: boolean) => void) {
  let buf = Buffer.alloc(0), started = false;
  return (data: Buffer) => {
    buf = Buffer.concat([buf, data]);
    let end = 0, terminate = false;
    for (;;) {
      if (!started) {
        if (buf.length - end < 4) break;
        const len = buf.readInt32BE(end);
        if (buf.length - end < len) break;
        end += len; started = true; continue;
      }
      if (buf.length - end < 5) break;
      const type = buf[end], len = buf.readInt32BE(end + 1);
      if (buf.length - end < 1 + len) break;
      if (type === 0x58) { terminate = true; break; }
      end += 1 + len;
    }
    if (end > 0 || terminate) {
      const batch = buf.subarray(0, end);
      buf = buf.subarray(end);
      each(batch, terminate);
    }
  };
}

/** A bridge on a free port of this machine's loopback, until closed. */
export async function bridge(target: Target): Promise<{port: number; close(): Promise<void>}> {
  let turn: Promise<unknown> = Promise.resolve();
  const open = new Set<Socket>();
  const server = createServer((_req, res) => { res.writeHead(426).end(); });
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    if (!accepted(req, socket)) return;
    open.add(socket);
    let done = false;
    const end = () => { if (!done) { done = true; open.delete(socket); socket.destroy(); } };
    if ('tcp' in target) {
      const address = new URL(req.url ?? '/', 'http://bridge').searchParams.get('address') ?? '';
      const at = address.lastIndexOf(':');
      const db = connect({host: address.slice(0, at), port: Number(address.slice(at + 1))});
      db.setNoDelay(true);
      db.on('data', (b: Buffer) => { if (!done) socket.write(frame(b)); });
      db.on('close', end);
      db.on('error', end);
      frames(socket, (m) => db.write(m), () => { db.destroy(); end(); });
      return;
    }
    const pg = target.pglite;
    frames(socket, messages((batch, terminate) => {
      // One connection's messages at a time: a PGlite is one session, whoever is asking.
      turn = turn.then(async () => {
        if (batch.length && !done) {
          const out = await pg.execProtocolRaw(new Uint8Array(batch));
          if (!done && out.length) socket.write(frame(out));
        }
        if (terminate) end();
      }).catch(end);
    }), end);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as {port: number}).port;
  return {port, close: () => new Promise<void>((done) => { for (const s of open) s.destroy(); server.close(() => done()); })};
}

/** This process's Neon driver goes through the bridge on `port` (plain Postgres, no TLS: this machine only). */
export function throughBridge(port: number) {
  neonConfig.wsProxy = (host, p) => `127.0.0.1:${port}/v1?address=${host}:${p}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
  neonConfig.forceDisablePgSSL = true;
}
