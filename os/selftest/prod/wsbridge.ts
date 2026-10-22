// What stands between the Worker on workerd and the Postgres on this machine
// in the production-like selftest (README.md here): the Worker's own driver
// (@neondatabase/serverless) speaks Postgres inside a WebSocket, as Neon's
// proxy takes it; this hands each WebSocket's bytes to a TCP connection to
// the Postgres it names (?address=host:port), and back. A process of its
// own, so what it costs is never counted as the Worker's.
//
//   node selftest/prod/wsbridge.ts [--delay MS]
//
// It prints `wsbridge PORT` once it listens (127.0.0.1 only). Besides the
// bridging, it counts and can be told things, on the same port over plain
// HTTP (from this machine):
//
//   GET  /stats          {opened, open, queries, roundTrips, toDb, fromDb, setupMs: [...]}: since the last reset
//   POST /reset          the counts start again
//   POST /delay?ms=N     each chunk, either way, is handed on N ms later: a network between Worker and
//                        database, as Cloudflare to Neon is (a round trip is then 2N ms)
//   POST /drop           every connection open now is cut (the database went away mid-request)
//   POST /refuse?on=1    new connections are refused at once (the database out of reach); on=0 undoes it
//
// A query is a Sync or a simple Query the client sent (one statement of the
// driver's, extended or simple); a round trip is a ReadyForQuery the server
// sent back; setupMs is how long from the WebSocket's upgrade to the first
// ReadyForQuery (the connection's cost before its first statement).

import {createHash} from 'node:crypto';
import {createServer, type IncomingMessage} from 'node:http';
import {connect, type Socket} from 'node:net';

const args = process.argv.slice(2);
let delay = Number(args[args.indexOf('--delay') + 1] ?? 0) || 0;
if (!args.includes('--delay')) delay = 0;
let refusing = false;
const open = new Set<() => void>();
const fresh = () => ({opened: 0, queries: 0, roundTrips: 0, toDb: 0, fromDb: 0, setupMs: [] as number[]});
let stats = fresh();

function frame(payload: Uint8Array, opcode = 2): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => {
    const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b;
  })();
  return Buffer.concat([head, payload]);
}

/** `send` later by the delay, in order. */
function later(send: (b: Buffer) => void) {
  return (b: Buffer) => { if (delay) setTimeout(() => send(b), delay); else send(b); };
}

/** Postgres messages in a stream: `typed` once the first (untyped startup) is past when `startup`, each type byte seen. */
function scan(startup: boolean, each: (type: number) => void) {
  let buf = Buffer.alloc(0), started = !startup;
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let at = 0;
    for (;;) {
      if (!started) {
        if (buf.length - at < 8) break;
        const len = buf.readInt32BE(at);
        if (buf.length - at < len) break;
        at += len; started = true; continue;
      }
      if (buf.length - at < 5) break;
      const type = buf[at], len = buf.readInt32BE(at + 1);
      if (buf.length - at < 1 + len) break;
      each(type);
      at += 1 + len;
    }
    buf = buf.subarray(at);
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://bridge');
  const say = (o: unknown) => { res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(o)); };
  if (req.method === 'GET' && url.pathname === '/stats') return say({...stats, open: open.size, delay, refusing});
  if (req.method === 'POST' && url.pathname === '/reset') { stats = fresh(); return say({ok: true}); }
  if (req.method === 'POST' && url.pathname === '/delay') { delay = Math.max(0, Number(url.searchParams.get('ms')) || 0); return say({delay}); }
  if (req.method === 'POST' && url.pathname === '/drop') { const n = open.size; for (const end of [...open]) end(); return say({dropped: n}); }
  if (req.method === 'POST' && url.pathname === '/refuse') { refusing = url.searchParams.get('on') !== '0'; return say({refusing}); }
  res.writeHead(426).end();
});

server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || refusing) { socket.destroy(); return; }
  const address = new URL(req.url ?? '/', 'http://bridge').searchParams.get('address') ?? '';
  const at = address.lastIndexOf(':');
  const host = address.slice(0, at), port = Number(address.slice(at + 1));
  // Only a Postgres on this machine: the bridge never reaches anywhere else.
  if (!/^(127(\.\d{1,3}){3}|localhost)$/.test(host) || !port) { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const began = performance.now();
  let ready = false, done = false;
  stats.opened++;
  const db = connect({host, port});
  db.setNoDelay(true);
  const end = () => { if (done) return; done = true; open.delete(end); socket.destroy(); db.destroy(); };
  open.add(end);
  const toClient = later((b) => { if (!done) socket.write(frame(b)); });
  const toDb = later((b) => { if (!done) db.write(b); });
  const fromDbScan = scan(false, (t) => {
    if (t !== 0x5a) return;
    stats.roundTrips++;
    if (!ready) { ready = true; stats.setupMs.push(Math.round((performance.now() - began) * 10) / 10); }
  });
  const toDbScan = scan(true, (t) => { if (t === 0x53 || t === 0x51) stats.queries++; });
  db.on('data', (b: Buffer) => { stats.fromDb += b.length; fromDbScan(b); toClient(b); });
  db.on('close', () => later(() => end())(Buffer.alloc(0)));
  db.on('error', end);
  // The client's frames: whole messages to the database; a ping answered, a close closes.
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
      const mask = masked ? buf.subarray(o, o + 4) : null;
      if (masked) o += 4;
      if (buf.length < o + len) return;
      const payload = Buffer.from(buf.subarray(o, o + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(o + len);
      if (opcode === 8) { end(); return; }
      if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
      if (opcode === 10) continue;
      stats.toDb += payload.length;
      toDbScan(payload);
      toDb(payload);
    }
  });
  socket.on('close', end);
  socket.on('error', end);
});

server.listen(0, '127.0.0.1', () => console.log(`wsbridge ${(server.address() as {port: number}).port}`));
process.on('SIGTERM', () => { for (const end of [...open]) end(); server.close(); process.exit(0); });
