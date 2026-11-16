import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Heard} from './relay.ts';
import {tcp} from './relay.worker.ts';
import {ERR} from './where.ts';

type Connect = Parameters<typeof tcp>[0];
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const turn = () => new Promise<void>((go) => setImmediate(go));

/** What a connection told whoever opened it, in order. */
function hearing(): {said: string[]; heard: Heard} {
  const said: string[] = [];
  return {said, heard: {opened: () => said.push('opened'), failed: (errno) => said.push(`failed ${errno}`), bytes: (b) => said.push(`bytes ${text(b)}`), ended: () => said.push('ended')}};
}

/** The runtime's socket, stood in for: what was written to it, and its other side to speak as the host. */
function socket(opened: Promise<unknown> = Promise.resolve()) {
  const written: string[] = [];
  let host!: ReadableStreamDefaultController<Uint8Array>, closed = 0;
  const readable = new ReadableStream<Uint8Array>({start: (c) => { host = c; }});
  const writable = new WritableStream<Uint8Array>({write: (b) => { written.push(text(b)); }, close: () => { written.push('<end>'); }});
  return {written, host: () => host, closes: () => closed,
    s: {readable, writable, opened, closed: new Promise<void>(() => {}), close: async () => { closed++; }}};
}

test('a link\'s connection on Workers: made, its bytes both ways, each side\'s end, and let go', async () => {
  const k = socket(), h = hearing();
  const asked: unknown[] = [];
  const far = tcp(((address, options) => { asked.push([address, options]); return k.s; }) as Connect)('93.184.216.34', 443, h.heard);
  await turn();
  // Asked as it stands: no TLS of the runtime's (what is said over it is sealed by the box), and each way ends by itself.
  assert.deepEqual(asked, [[{hostname: '93.184.216.34', port: 443}, {secureTransport: 'off', allowHalfOpen: true}]]);
  assert.deepEqual(h.said, ['opened']);
  far.send(new TextEncoder().encode('hello'));
  k.host().enqueue(new TextEncoder().encode('world'));
  await turn();
  assert.deepEqual(k.written, ['hello']);
  assert.deepEqual(h.said, ['opened', 'bytes world']);
  far.finish();
  k.host().close();
  await turn();
  assert.deepEqual(k.written, ['hello', '<end>']);
  assert.deepEqual(h.said, ['opened', 'bytes world', 'ended']);
  far.close();
  assert.equal(k.closes(), 1);
});

test('a connection not made is said as Linux numbers it; Cloudflare\'s own addresses are not asked for at all', async () => {
  const failing = async (address: string, connect: Connect) => { const h = hearing(); tcp(connect)(address, 443, h.heard); await turn(); return h.said; };
  // The runtime's words for a host that refused, and for one it will not reach: the same, so it reads as refused.
  const refused = socket(Promise.reject(new Error('proxy request failed, cannot connect to the specified address')));
  assert.deepEqual(await failing('93.184.216.34', (() => refused.s) as Connect), [`failed ${ERR.REFUSED}`]);
  assert.deepEqual(await failing('93.184.216.34', (() => { throw new Error('TCP Loop detected'); }) as Connect), [`failed ${ERR.NETUNREACH}`]);
  assert.deepEqual(await failing('93.184.216.34', (() => socket(Promise.reject(new Error('connection timed out'))).s) as Connect), [`failed ${ERR.TIMEDOUT}`]);
  // An address of Cloudflare's own: no way there from a Worker, said without asking the runtime (to the edge of a block).
  let asked = 0;
  const counting = (() => { asked++; return socket().s; }) as Connect;
  for (const a of ['104.16.0.0', '104.23.255.255', '104.27.255.255', '172.64.0.1', '172.71.255.255', '162.159.255.255', '198.41.128.0', '131.0.75.255']) {
    assert.deepEqual(await failing(a, counting), [`failed ${ERR.NETUNREACH}`], a);
  }
  assert.equal(asked, 0);
  for (const a of ['104.15.255.255', '104.28.0.0', '172.63.255.255', '172.72.0.0', '198.41.127.255']) assert.deepEqual(await failing(a, counting), ['opened'], a);
  assert.equal(asked, 5);
  // A connection that breaks once made is said once, and nothing after it.
  const k = socket(), h = hearing();
  tcp((() => k.s) as Connect)('93.184.216.34', 22, h.heard);
  await turn();
  k.host().error(new Error('Network connection lost.'));
  await turn();
  assert.deepEqual(h.said, ['opened', `failed ${ERR.REFUSED}`]);
});

test('what the page sends and the connection does not take is held so far and no further', async () => {
  // A host that takes nothing: every write waits.
  const h = hearing();
  let closed = 0;
  const stuck = {readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>({write: () => new Promise<void>(() => {})}),
    opened: Promise.resolve(), closed: new Promise<void>(() => {}), close: async () => { closed++; }};
  const far = tcp((() => stuck) as Connect)('93.184.216.34', 443, h.heard);
  await turn();
  const chunk = new Uint8Array(1 << 20);
  for (let i = 0; i < 8; i++) far.send(chunk);
  assert.deepEqual(h.said, ['opened']);
  far.send(chunk);
  assert.deepEqual(h.said, ['opened', `failed ${ERR.TIMEDOUT}`]);
  assert.equal(closed, 1);
});
