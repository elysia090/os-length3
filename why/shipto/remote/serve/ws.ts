// A WebSocket's server side on this machine, by hand (node has a client of its own and no server): the handshake
// answered, frames written and read. For what stands in here for what Workers has of its own: the bridge to a
// Postgres (bridge.ts) and a link carried in development (../links/relay.node.ts).

import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {Socket} from 'node:net';

/** The handshake answered (RFC 6455 §4.2.2), or the socket let go where none was asked: whether it is a WebSocket now. */
export function accepted(req: IncomingMessage, socket: Socket): boolean {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') { socket.destroy(); return false; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  return true;
}

/** A WebSocket frame, unmasked, binary unless said. */
export function frame(payload: Uint8Array, opcode = 2): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => {
    const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b;
  })();
  return Buffer.concat([head, payload]);
}

/** Reads a client's frames as they come: whole messages out, pings answered, a close closes. */
export function frames(socket: Socket, message: (data: Buffer) => void, closed: () => void) {
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
