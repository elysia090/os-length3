// The Worker's database driver (@neondatabase/serverless) speaks Postgres
// over a WebSocket, which Neon's hosts answer and an ordinary Postgres does
// not. This is the small WebSocket server that stands between, in the same
// process, so the Worker's own pool code runs against a Postgres on this
// machine (verify.ts) or a PGlite (worker.test.ts): each connection's bytes
// are handed to a TCP connection to the address it names, or to a PGlite,
// one connection's messages at a time. For tests and verification only; on
// Workers the driver reaches Neon directly.

import {createHash} from 'node:crypto';
import {createServer, type IncomingMessage} from 'node:http';
import {connect, type Socket} from 'node:net';
import type {PGlite} from '@electric-sql/pglite';
import {neonConfig} from '@neondatabase/serverless';

type Target = {tcp: true} | {pglite: PGlite};

/** A WebSocket frame, unmasked, binary unless said. */
function frame(payload: Uint8Array, opcode = 2): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => {
    const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b;
  })();
  return Buffer.concat([head, payload]);
}

/** Reads a client's frames as they come: whole messages out, pings answered, a close closes. */
function frames(socket: Socket, message: (data: Buffer) => void, closed: () => void) {
  let buf = Buffer.alloc(0), parts: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const mask = masked ? buf.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(at + len);
      if (opcode === 8) { socket.end(frame(new Uint8Array(0), 8)); closed(); return; }
      if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
      if (opcode === 10) continue;
      parts.push(payload);
      if (fin) { const whole = Buffer.concat(parts); parts = []; message(whole); }
    }
  });
  socket.on('close', closed);
  socket.on('error', closed);
}

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
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
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
