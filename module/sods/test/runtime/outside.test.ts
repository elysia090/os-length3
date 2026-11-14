import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/linux/process.ts';
import type {Far, Outside} from '../../runtime/linux/parts.ts';

// What lies past the machine (sys-net.ts Outside): a connection or a datagram to an address that is not the
// machine's own is asked of whoever was given at linux({outside}), each as a guest's own calls on a kernel and a
// page of memory (no program translated). With none given, and in a network namespace of a box's own, there is
// nothing past the loopback, as before.

const READ = 0, WRITE = 1, CLOSE = 3, POLL = 7, SOCKET = 41, CONNECT = 42, SENDTO = 44, RECVFROM = 45, SHUTDOWN = 48, GETSOCKOPT = 55, UNSHARE = 272;
const AF_INET = 2, SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_NONBLOCK = 0x800;
const EAGAIN = -11n, ENETUNREACH = -101n, ECONNREFUSED = -111n, EALREADY = -114n, EINPROGRESS = -115n;
const POLLIN = 1, POLLOUT = 4, POLLERR = 8;

interface Asked { connects: {far: Far; ip: string; port: number}[]; datagrams: {ip: string; port: number; bytes: Uint8Array; reply: (b: Uint8Array) => void}[] }
function guest(given = true): {p: Process; asked: Asked} {
  const asked: Asked = {connects: [], datagrams: []};
  const outside: Outside = {
    connect: (far, to) => { asked.connects.push({far, ip: to.ip.join('.'), port: to.port}); },
    datagram: (to, bytes, reply) => { asked.datagrams.push({ip: to.ip.join('.'), port: to.port, bytes, reply}); },
  };
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}, outside: given ? outside : null});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return {p, asked};
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
/** A sockaddr_in at `at`: the address and the port. */
function address(p: Process, ip: [number, number, number, number], port: number, at = 64): number {
  p.bytes.fill(0, at, at + 16);
  p.view.setUint16(at, AF_INET, true);
  p.view.setUint16(at + 2, port, false);
  p.bytes.set(ip, at + 4);
  return at;
}
const put = (p: Process, text: string, at = 1024): number => { const b = new TextEncoder().encode(text); p.bytes.set(b, at); return b.length; };
const got = (p: Process, n: bigint, at = 2048): string => new TextDecoder().decode(p.bytes.subarray(at, at + Number(n)));
/** poll's answer for one descriptor asked for reading and writing. */
function polled(p: Process, fd: number): number {
  p.view.setInt32(3072, fd, true);
  p.view.setInt16(3076, POLLIN | POLLOUT, true);
  p.view.setInt16(3078, 0, true);
  call(p, POLL, 3072, 1, 0);
  return p.view.getInt16(3078, true);
}

test('a stream to an address that is not the machine\'s is the outside\'s to make: under way, then made, its bytes both ways, its ends', () => {
  const {p, asked} = guest();
  const fd = Number(call(p, SOCKET, AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0));
  assert.equal(call(p, CONNECT, fd, address(p, [198, 18, 0, 5], 443), 16), EINPROGRESS);
  assert.deepEqual(asked.connects.map((c) => [c.ip, c.port]), [['198.18.0.5', 443]]);
  const far = asked.connects[0].far;
  // Being made: ready for nothing, and asked again it is said to be under way already.
  assert.equal(polled(p, fd), 0);
  assert.equal(call(p, CONNECT, fd, address(p, [198, 18, 0, 5], 443), 16), EALREADY);
  far.opened();
  assert.equal(polled(p, fd) & POLLOUT, POLLOUT);
  assert.equal(call(p, CONNECT, fd, address(p, [198, 18, 0, 5], 443), 16), 0n);
  // What the process writes, the far end takes; whoever holds it hears that there is something.
  let heard = 0;
  far.onwrote = () => { heard++; };
  assert.equal(call(p, WRITE, fd, 1024, put(p, 'GET / HTTP/1.1\r\n\r\n')), 18n);
  assert.equal(heard, 1);
  assert.equal(new TextDecoder().decode(far.take()), 'GET / HTTP/1.1\r\n\r\n');
  assert.equal(far.take().length, 0);
  // What the far end gives, the process reads; nothing there yet is not the end.
  assert.equal(call(p, READ, fd, 2048, 100), EAGAIN);
  assert.equal(far.give(new TextEncoder().encode('HTTP/1.1 200 OK\r\n')), 17);
  assert.equal(polled(p, fd) & POLLIN, POLLIN);
  assert.equal(got(p, call(p, READ, fd, 2048, 100)), 'HTTP/1.1 200 OK\r\n');
  // The far side sends no more: the end is read after what was given.
  far.give(new TextEncoder().encode('bye'));
  far.finish();
  assert.equal(got(p, call(p, READ, fd, 2048, 100)), 'bye');
  assert.equal(call(p, READ, fd, 2048, 100), 0n);
  // The process sends no more, then closes: the far end has it once what was written is taken.
  call(p, WRITE, fd, 1024, put(p, 'last'));
  assert.equal(call(p, SHUTDOWN, fd, 1), 0n);
  assert.equal(far.gone, false);
  assert.equal(new TextDecoder().decode(far.take()), 'last');
  assert.equal(far.gone, true);
  assert.equal(far.closed, false);
  assert.equal(call(p, CLOSE, fd), 0n);
  assert.equal(far.closed, true);
});

test('a stream the outside refuses fails as Linux says it, waited for or not', () => {
  const {p, asked} = guest();
  const fd = Number(call(p, SOCKET, AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0));
  assert.equal(call(p, CONNECT, fd, address(p, [203, 0, 113, 9], 22), 16), EINPROGRESS);
  asked.connects[0].far.refused(111);
  assert.equal(polled(p, fd) & POLLERR, POLLERR);
  // SO_ERROR says it once.
  p.view.setInt32(3200, 4, true);
  assert.equal(call(p, GETSOCKOPT, fd, 1, 4, 3204, 3200), 0n);
  assert.equal(p.view.getInt32(3204, true), 111);
  // Answered at once, the connect itself says it.
  const {p: q} = guest();
  const outside = q.kernel.outside!;
  outside.connect = (far) => far.refused(111);
  const again = Number(call(q, SOCKET, AF_INET, SOCK_STREAM, 0));
  assert.equal(call(q, CONNECT, again, address(q, [203, 0, 113, 9], 22), 16), ECONNREFUSED);
  outside.connect = (far) => far.opened();
  const now = Number(call(q, SOCKET, AF_INET, SOCK_STREAM, 0));
  assert.equal(call(q, CONNECT, now, address(q, [203, 0, 113, 9], 22), 16), 0n);
});

test('a datagram past the machine is the outside\'s to answer, and what comes back is from where it was sent', () => {
  const {p, asked} = guest();
  const fd = Number(call(p, SOCKET, AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0));
  assert.equal(call(p, SENDTO, fd, 1024, put(p, 'query'), 0, address(p, [198, 18, 0, 1], 53), 16), 5n);
  assert.deepEqual(asked.datagrams.map((d) => [d.ip, d.port, new TextDecoder().decode(d.bytes)]), [['198.18.0.1', 53, 'query']]);
  assert.equal(call(p, RECVFROM, fd, 2048, 100, 0, 0, 0), EAGAIN);
  asked.datagrams[0].reply(new TextEncoder().encode('answer'));
  p.view.setInt32(3300, 16, true);
  assert.equal(got(p, call(p, RECVFROM, fd, 2048, 100, 0, 3304, 3300)), 'answer');
  assert.equal(p.view.getUint16(3306, false), 53);
  assert.deepEqual([...p.bytes.subarray(3308, 3312)], [198, 18, 0, 1]);
});

test('with no outside given, and in a network of a box\'s own, nothing lies past the loopback', () => {
  const {p} = guest(false);
  const fd = Number(call(p, SOCKET, AF_INET, SOCK_STREAM, 0));
  assert.equal(call(p, CONNECT, fd, address(p, [198, 18, 0, 5], 443), 16), ENETUNREACH);
  // A network namespace of its own (what a box has unless it was lent the machine's): its loopback alone.
  const {p: q, asked} = guest();
  assert.equal(call(q, UNSHARE, 0x40000000), 0n);
  const own = Number(call(q, SOCKET, AF_INET, SOCK_STREAM, 0));
  assert.equal(call(q, CONNECT, own, address(q, [198, 18, 0, 5], 443), 16), ENETUNREACH);
  assert.equal(asked.connects.length, 0);
});
