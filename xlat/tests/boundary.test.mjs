import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
// The runtime loads its call tables through process.mjs, as the worker does.
import {Kernel, Process} from '../runtime/process.mjs';
import {FILE_CALLS} from '../runtime/sys-file.mjs';
import {NET_CALLS} from '../runtime/sys-net.mjs';
import {PROC_CALLS} from '../runtime/sys-proc.mjs';

// The Prompt's guest has a network as a machine with only its loopback has one: nothing it runs can reach or listen
// on the host's network, whatever the program is. Its sockets are channels between its own processes in this kernel
// (sys-net.mjs): the local family's (AF_UNIX), and TCP and UDP to this machine's own addresses (127.0.0.0/8, ::1).
// Every other address is no one's (EADDRNOTAVAIL to bind) and unreachable (ENETUNREACH), and every other family is
// refused as a host without it refuses it. Widening this (a route out, another family, a way out of the kernel) is a
// boundary change to make on purpose, here first, not by filling in a table.
const NETWORK = {
  41: 'socket', 42: 'connect', 43: 'accept', 44: 'sendto', 45: 'recvfrom',
  46: 'sendmsg', 47: 'recvmsg', 48: 'shutdown', 49: 'bind', 50: 'listen',
  51: 'getsockname', 52: 'getpeername', 53: 'socketpair', 54: 'setsockopt',
  55: 'getsockopt', 288: 'accept4', 299: 'recvmmsg', 307: 'sendmmsg',
};
const ENOSYS = 38n, EINVAL = 22n, EPERM = 1n, EAFNOSUPPORT = 97n, EADDRNOTAVAIL = 99n, ENETUNREACH = 101n,
  ECONNREFUSED = 111n, EADDRINUSE = 98n;
const AF_UNIX = 1n, AF_INET = 2n, AF_INET6 = 10n, SOCK_STREAM = 1n, SOCK_DGRAM = 2n, SOCK_RAW = 3n;
// AF_NETLINK, AF_PACKET, AF_BLUETOOTH, AF_VSOCK.
const ELSEWHERE = [16n, 17n, 31n, 40n];

function guest() {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = new WebAssembly.Memory({initial: 1});
  return p;
}

/** sockaddr_in for `ip` (four numbers) and `port`, written at `at`: its length. */
function sin(p, at, ip, port) {
  p.bytes.fill(0, at, at + 16);
  p.view.setUint16(at, 2, true);
  p.view.setUint16(at + 2, port, false);
  p.bytes.set(ip, at + 4);
  return 16n;
}
/** sockaddr_in6 for `ip` (sixteen numbers) and `port`, written at `at`: its length. */
function sin6(p, at, ip, port) {
  p.bytes.fill(0, at, at + 28);
  p.view.setUint16(at, 10, true);
  p.view.setUint16(at + 2, port, false);
  p.bytes.set(ip, at + 8);
  return 28n;
}
const v6 = (...tail) => [...Array(16 - tail.length).fill(0), ...tail];
const mapped = (a, b, c, d) => [...Array(10).fill(0), 0xff, 0xff, a, b, c, d];
/** The port a socket was given (getsockname). */
function portOf(p, fd) {
  p.view.setUint32(900, 28, true);
  assert.equal(p.syscall(51n, fd, 800n, 900n, 0n, 0n, 0n), 0n);
  return p.view.getUint16(802, false);
}

test('the socket calls are sys-net.mjs\'s alone, and nothing in it reaches out of the kernel', () => {
  for (const [nr, name] of Object.entries(NETWORK)) assert.ok(!(nr in FILE_CALLS) && !(nr in PROC_CALLS), `${name} (${nr}) has a handler outside sys-net.mjs`);
  // What makes them has no way to the host: no fetch, no WebSocket, no node module that opens one.
  const source = readFileSync(new URL('../runtime/sys-net.mjs', import.meta.url), 'utf8');
  for (const way of ['fetch(', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'node:net', 'node:dgram', 'node:http', 'node:tls', 'import(']) {
    assert.ok(!source.includes(way), `sys-net.mjs uses ${way}`);
  }
  assert.ok(!('299' in NET_CALLS) && !('307' in NET_CALLS));
});

test('no socket of another family is made, nor a raw one, and a local one names nothing outside', () => {
  const p = guest();
  for (const family of ELSEWHERE) {
    assert.equal(p.syscall(41n, family, SOCK_DGRAM, 0n, 0n, 0n, 0n), -EAFNOSUPPORT, `socket family ${family}`);
    assert.equal(p.syscall(53n, family, SOCK_DGRAM, 0n, 64n, 0n, 0n), -EAFNOSUPPORT, `socketpair family ${family}`);
  }
  // Raw sockets (ping's, a packet tool's) want a capability the guest has not.
  assert.equal(p.syscall(41n, AF_INET, SOCK_RAW, 1n, 0n, 0n, 0n), -EPERM);
  assert.equal(p.syscall(41n, AF_INET6, SOCK_RAW, 58n, 0n, 0n, 0n), -EPERM);
  // A local socket given an internet address (127.0.0.1:80) reaches nothing and sends nothing.
  const fd = p.syscall(41n, AF_UNIX, SOCK_STREAM, 0n, 0n, 0n, 0n);
  const len = sin(p, 256, [127, 0, 0, 1], 80);
  assert.equal(p.syscall(42n, fd, 256n, len, 0n, 0n, 0n), -EINVAL, 'connect to an internet address');
  const dgram = p.syscall(41n, AF_UNIX, SOCK_DGRAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(44n, dgram, 512n, 4n, 0n, 256n, len), -EINVAL, 'sendto an internet address');
  for (const nr of [299n, 307n]) assert.equal(p.syscall(nr, fd, 0n, 0n, 0n, 0n, 0n), -ENOSYS, NETWORK[nr]);
});

test('an internet socket reaches this machine alone: other addresses are no one\'s and unreachable', () => {
  const p = guest();
  const outside = [[1, 1, 1, 1], [8, 8, 8, 8], [10, 0, 0, 1], [192, 168, 1, 1], [169, 254, 169, 254], [100, 64, 0, 1]];
  for (const ip of outside) {
    const tcp = p.syscall(41n, AF_INET, SOCK_STREAM, 0n, 0n, 0n, 0n), udp = p.syscall(41n, AF_INET, SOCK_DGRAM, 0n, 0n, 0n, 0n);
    const len = sin(p, 256, ip, 80);
    assert.equal(p.syscall(42n, tcp, 256n, len, 0n, 0n, 0n), -ENETUNREACH, `connect ${ip}`);
    assert.equal(p.syscall(42n, udp, 256n, len, 0n, 0n, 0n), -ENETUNREACH, `UDP connect ${ip}`);
    assert.equal(p.syscall(44n, udp, 512n, 4n, 0n, 256n, len), -ENETUNREACH, `sendto ${ip}`);
    assert.equal(p.syscall(49n, tcp, 256n, len, 0n, 0n, 0n), -EADDRNOTAVAIL, `bind ${ip}`);
    p.syscall(3n, tcp, 0n, 0n, 0n, 0n, 0n);
    p.syscall(3n, udp, 0n, 0n, 0n, 0n, 0n);
  }
  for (const ip of [v6(0x20, 0x01, 0x48, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x88, 0x88), mapped(1, 1, 1, 1), [0xfe, 0x80, ...Array(13).fill(0), 1]]) {
    const tcp = p.syscall(41n, AF_INET6, SOCK_STREAM, 0n, 0n, 0n, 0n), udp = p.syscall(41n, AF_INET6, SOCK_DGRAM, 0n, 0n, 0n, 0n);
    const len = sin6(p, 256, ip, 443);
    assert.equal(p.syscall(42n, tcp, 256n, len, 0n, 0n, 0n), -ENETUNREACH, `connect ${ip}`);
    assert.equal(p.syscall(44n, udp, 512n, 4n, 0n, 256n, len), -ENETUNREACH, `sendto ${ip}`);
    assert.equal(p.syscall(49n, tcp, 256n, len, 0n, 0n, 0n), -EADDRNOTAVAIL, `bind ${ip}`);
  }
  // A socket of one family given the other's address: refused.
  const four = p.syscall(41n, AF_INET, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(42n, four, 256n, sin6(p, 256, v6(1), 80), 0n, 0n, 0n), -EAFNOSUPPORT);
});

test('IPv6 on loopback: ::1, a listener on :: takes IPv4 too unless IPV6_V6ONLY, as Linux\'s', () => {
  const p = guest();
  const O_NONBLOCK = 0x800n;
  // A listener on :: at a port of its own.
  const l = p.syscall(41n, AF_INET6, SOCK_STREAM | O_NONBLOCK, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(49n, l, 256n, sin6(p, 256, v6(), 0), 0n, 0n, 0n), 0n);
  assert.equal(p.syscall(50n, l, 8n, 0n, 0n, 0n, 0n), 0n);
  const port = portOf(p, l);
  assert.ok(port >= 32768 && port <= 60999, `an ephemeral port: ${port}`);
  // An IPv4 client reaches it; the server's end is told it as ::ffff:127.0.0.1.
  const c4 = p.syscall(41n, AF_INET, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(42n, c4, 256n, sin(p, 256, [127, 0, 0, 1], port), 0n, 0n, 0n), 0n);
  p.view.setUint32(900, 28, true);
  const s4 = p.syscall(43n, l, 800n, 900n, 0n, 0n, 0n);
  assert.ok(s4 >= 0n);
  assert.equal(p.view.getUint32(900, true), 28);
  assert.deepEqual([...p.bytes.subarray(808, 824)], mapped(127, 0, 0, 1));
  // So does an IPv6 one, at ::1.
  const c6 = p.syscall(41n, AF_INET6, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(42n, c6, 256n, sin6(p, 256, v6(1), port), 0n, 0n, 0n), 0n);
  p.view.setUint32(900, 28, true);
  const s6 = p.syscall(43n, l, 800n, 900n, 0n, 0n, 0n);
  assert.deepEqual([...p.bytes.subarray(808, 824)], v6(1));
  // Bytes both ways.
  p.bytes.set([104, 105], 1000);
  assert.equal(p.syscall(1n, c6, 1000n, 2n, 0n, 0n, 0n), 2n);
  assert.equal(p.syscall(0n, s6, 1100n, 16n, 0n, 0n, 0n), 2n);
  assert.deepEqual([...p.bytes.subarray(1100, 1102)], [104, 105]);
  // An IPv4 listener on the same port's wildcard: the dual-stack one holds it.
  const four = p.syscall(41n, AF_INET, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(49n, four, 256n, sin(p, 256, [0, 0, 0, 0], port), 0n, 0n, 0n), -EADDRINUSE);
  for (const fd of [l, c4, s4, c6, s6, four]) p.syscall(3n, fd, 0n, 0n, 0n, 0n, 0n);

  // IPV6_V6ONLY: IPv6 alone; an IPv4 client is refused, and an IPv4 listener may share the port.
  const only = p.syscall(41n, AF_INET6, SOCK_STREAM, 0n, 0n, 0n, 0n);
  p.view.setInt32(700, 1, true);
  assert.equal(p.syscall(54n, only, 41n, 26n, 700n, 4n, 0n), 0n);
  assert.equal(p.syscall(49n, only, 256n, sin6(p, 256, v6(), 0), 0n, 0n, 0n), 0n);
  assert.equal(p.syscall(50n, only, 8n, 0n, 0n, 0n, 0n), 0n);
  const p6 = portOf(p, only);
  const refused = p.syscall(41n, AF_INET, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(42n, refused, 256n, sin(p, 256, [127, 0, 0, 1], p6), 0n, 0n, 0n), -ECONNREFUSED);
  const beside = p.syscall(41n, AF_INET, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(49n, beside, 256n, sin(p, 256, [0, 0, 0, 0], p6), 0n, 0n, 0n), 0n);
  // Once bound, it is too late to say.
  assert.equal(p.syscall(54n, only, 41n, 26n, 700n, 4n, 0n), -EINVAL);
  // Nor may it take an IPv4 address.
  const v6only = p.syscall(41n, AF_INET6, SOCK_DGRAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(54n, v6only, 41n, 26n, 700n, 4n, 0n), 0n);
  assert.equal(p.syscall(49n, v6only, 256n, sin6(p, 256, mapped(127, 0, 0, 1), 0), 0n, 0n, 0n), -EADDRNOTAVAIL);
});

test('UDP over ::1: a datagram, and who sent it', () => {
  const p = guest();
  const a = p.syscall(41n, AF_INET6, SOCK_DGRAM, 0n, 0n, 0n, 0n), b = p.syscall(41n, AF_INET6, SOCK_DGRAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(49n, a, 256n, sin6(p, 256, v6(1), 0), 0n, 0n, 0n), 0n);
  const port = portOf(p, a);
  p.bytes.set([1, 2, 3], 1000);
  assert.equal(p.syscall(44n, b, 1000n, 3n, 0n, 256n, sin6(p, 256, v6(1), port)), 3n);
  p.view.setUint32(900, 28, true);
  assert.equal(p.syscall(45n, a, 1100n, 16n, 0n, 800n, 900n), 3n);
  assert.deepEqual([...p.bytes.subarray(808, 824)], v6(1));
  assert.equal(p.view.getUint16(802, false), portOf(p, b));
});
