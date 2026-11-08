import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/process.ts';
import {FILE_CALLS} from '../../runtime/sys-file.ts';
import {NET_CALLS} from '../../runtime/sys-net.ts';
import {PROC_CALLS} from '../../runtime/sys-proc.ts';

// The Prompt's guest has a network as a machine with only its loopback has one: nothing it runs can reach or listen
// on the host's network, whatever the program is. Its sockets are channels between its own processes in this kernel
// (sys-net.ts): the local family's (AF_UNIX), TCP, UDP and ICMP to this machine's own addresses (127.0.0.0/8, ::1),
// and netlink, which tells of that machine (net-view.ts). Every other address is no one's (EADDRNOTAVAIL to bind)
// and unreachable (ENETUNREACH), and every other family is refused as a host without it refuses it. Widening this (a
// route out, another family, a way out of the kernel) is a boundary change to make on purpose, here first, not by
// filling in a table.
const NETWORK: Record<string, string> = {
  41: 'socket', 42: 'connect', 43: 'accept', 44: 'sendto', 45: 'recvfrom',
  46: 'sendmsg', 47: 'recvmsg', 48: 'shutdown', 49: 'bind', 50: 'listen',
  51: 'getsockname', 52: 'getpeername', 53: 'socketpair', 54: 'setsockopt',
  55: 'getsockopt', 288: 'accept4', 299: 'recvmmsg', 307: 'sendmmsg',
};
const ENOSYS = 38n, EINVAL = 22n, EAFNOSUPPORT = 97n, EADDRNOTAVAIL = 99n, ENETUNREACH = 101n,
  ECONNREFUSED = 111n, EADDRINUSE = 98n, EPROTONOSUPPORT = 93n;
const AF_UNIX = 1n, AF_INET = 2n, AF_INET6 = 10n, AF_NETLINK = 16n, SOCK_STREAM = 1n, SOCK_DGRAM = 2n, SOCK_RAW = 3n;
// AF_PACKET, AF_BLUETOOTH, AF_VSOCK, AF_CAN.
const ELSEWHERE = [17n, 31n, 40n, 29n];

function guest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}

/** sockaddr_in for `ip` (four numbers) and `port`, written at `at`: its length. */
function sin(p: Process, at: number, ip: number[], port: number): bigint {
  p.bytes.fill(0, at, at + 16);
  p.view.setUint16(at, 2, true);
  p.view.setUint16(at + 2, port, false);
  p.bytes.set(ip, at + 4);
  return 16n;
}
/** sockaddr_in6 for `ip` (sixteen numbers) and `port`, written at `at`: its length. */
function sin6(p: Process, at: number, ip: number[], port: number): bigint {
  p.bytes.fill(0, at, at + 28);
  p.view.setUint16(at, 10, true);
  p.view.setUint16(at + 2, port, false);
  p.bytes.set(ip, at + 8);
  return 28n;
}
const v6 = (...tail: number[]): number[] => [...Array(16 - tail.length).fill(0), ...tail];
const mapped = (a: number, b: number, c: number, d: number): number[] => [...Array(10).fill(0), 0xff, 0xff, a, b, c, d];
/** The port a socket was given (getsockname). */
function portOf(p: Process, fd: bigint): number {
  p.view.setUint32(900, 28, true);
  assert.equal(p.syscall(51n, fd, 800n, 900n, 0n, 0n, 0n), 0n);
  return p.view.getUint16(802, false);
}

test('the socket calls are sys-net.ts\'s alone, and nothing in it reaches out of the kernel', () => {
  for (const [nr, name] of Object.entries(NETWORK)) assert.ok(!(nr in FILE_CALLS) && !(nr in PROC_CALLS), `${name} (${nr}) has a handler outside sys-net.ts`);
  // What makes them, and what tells of the network, has no way to the host: no fetch, no WebSocket, no node module
  // that opens one.
  for (const file of ['sys-net.ts', 'net-view.ts']) {
    const source = readFileSync(new URL(`../../runtime/${file}`, import.meta.url), 'utf8');
    for (const way of ['fetch(', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'node:net', 'node:dgram', 'node:http', 'node:tls', 'import(']) {
      assert.ok(!source.includes(way), `${file} uses ${way}`);
    }
  }
  assert.ok(!('299' in NET_CALLS) && !('307' in NET_CALLS));
});

test('no socket of another family is made, nor a raw one but ICMP\'s, and a local one names nothing outside', () => {
  const p = guest();
  for (const family of ELSEWHERE) {
    assert.equal(p.syscall(41n, family, SOCK_DGRAM, 0n, 0n, 0n, 0n), -EAFNOSUPPORT, `socket family ${family}`);
    assert.equal(p.syscall(53n, family, SOCK_DGRAM, 0n, 64n, 0n, 0n), -EAFNOSUPPORT, `socketpair family ${family}`);
  }
  // Raw sockets are ICMP's (ping's) alone: none for TCP, UDP or whole IP packets; netlink's, ROUTE's and SOCK_DIAG's.
  for (const protocol of [6n, 17n, 255n]) assert.equal(p.syscall(41n, AF_INET, SOCK_RAW, protocol, 0n, 0n, 0n), -EPROTONOSUPPORT);
  assert.equal(p.syscall(41n, AF_INET6, SOCK_RAW, 1n, 0n, 0n, 0n), -EPROTONOSUPPORT);
  for (const protocol of [9n, 15n, 16n]) assert.equal(p.syscall(41n, AF_NETLINK, SOCK_RAW, protocol, 0n, 0n, 0n), -EPROTONOSUPPORT);
  // A local socket given an internet address (127.0.0.1:80) reaches nothing and sends nothing.
  const fd = p.syscall(41n, AF_UNIX, SOCK_STREAM, 0n, 0n, 0n, 0n);
  const len = sin(p, 256, [127, 0, 0, 1], 80);
  assert.equal(p.syscall(42n, fd, 256n, len, 0n, 0n, 0n), -EINVAL, 'connect to an internet address');
  const dgram = p.syscall(41n, AF_UNIX, SOCK_DGRAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(44n, dgram, 512n, 4n, 0n, 256n, len), -EINVAL, 'sendto an internet address');
  for (const nr of [299n, 307n]) assert.equal(p.syscall(nr, fd, 0n, 0n, 0n, 0n, 0n), -ENOSYS, NETWORK[`${nr}`]);
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
    const icmp = p.syscall(41n, AF_INET, SOCK_RAW, 1n, 0n, 0n, 0n);
    p.bytes.set([8, 0, 0xf7, 0xff, 0, 0, 0, 0], 512);
    assert.equal(p.syscall(44n, icmp, 512n, 8n, 0n, 256n, len), -ENETUNREACH, `ping ${ip}`);
    for (const fd of [tcp, udp, icmp]) p.syscall(3n, fd, 0n, 0n, 0n, 0n, 0n);
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

test('ICMPv6 over ::1: an echo request is answered, its checksum the kernel\'s', () => {
  const p = guest();
  const s = p.syscall(41n, AF_INET6, SOCK_RAW, 58n, 0n, 0n, 0n);
  // Echo replies only (ICMP6_FILTER: a set bit keeps a type out).
  p.bytes.fill(0xff, 600, 632);
  p.bytes[600 + (129 >> 3)] &= ~(1 << (129 & 7));
  assert.equal(p.syscall(54n, s, 58n, 1n, 600n, 32n, 0n), 0n);
  p.bytes.set([128, 0, 0, 0, 0x12, 0x34, 0, 1, 104, 105], 512);
  assert.equal(p.syscall(44n, s, 512n, 10n, 0n, 256n, sin6(p, 256, v6(1), 0)), 10n);
  p.view.setUint32(900, 28, true);
  assert.equal(p.syscall(45n, s, 1100n, 64n, 0n, 800n, 900n), 10n);
  assert.deepEqual([...p.bytes.subarray(1100, 1102)], [129, 0]);
  assert.deepEqual([...p.bytes.subarray(1104, 1110)], [0x12, 0x34, 0, 1, 104, 105]);
  assert.deepEqual([...p.bytes.subarray(808, 824)], v6(1));
  // Nothing else came (the request itself was filtered out).
  assert.equal(p.syscall(45n, s, 1100n, 64n, 0x40n, 0n, 0n), -11n);
});

test('netlink tells of lo alone, makes no change, and talks to the kernel only', () => {
  const p = guest();
  const s = p.syscall(41n, AF_NETLINK, SOCK_RAW, 0n, 0n, 0n, 0n);
  /** A request: nlmsghdr (type, flags, seq) and a body, at 512; what came back, at 2048. */
  const ask = (type: number, flags: number, body: Uint8Array): Uint8Array => {
    p.bytes.fill(0, 512, 512 + 16 + body.length);
    p.view.setUint32(512, 16 + body.length, true);
    p.view.setUint16(516, type, true);
    p.view.setUint16(518, flags, true);
    p.view.setUint32(520, 7, true);
    p.bytes.set(body, 528);
    assert.equal(p.syscall(44n, s, 512n, BigInt(16 + body.length), 0n, 0n, 0n), BigInt(16 + body.length));
    const n = Number(p.syscall(45n, s, 2048n, 8192n, 0x40n, 0n, 0n));
    return p.bytes.slice(2048, 2048 + n);
  };
  // RTM_GETLINK, a dump: one link, lo, then NLMSG_DONE.
  const links = ask(18, 0x301, new Uint8Array(16));
  const v = new DataView(links.buffer);
  assert.equal(v.getUint16(4, true), 16, 'RTM_NEWLINK');
  assert.equal(v.getInt32(20, true), 1, 'index 1');
  assert.ok(new TextDecoder().decode(links).includes('lo\0'));
  assert.equal(v.getUint16(v.getUint32(0, true) + 4, true), 3, 'then NLMSG_DONE');
  // RTM_NEWADDR (an address added): not made; the error says so.
  const added = ask(20, 0x605, new Uint8Array([2, 24, 0, 0, 1, 0, 0, 0]));
  assert.equal(new DataView(added.buffer).getUint16(4, true), 2, 'NLMSG_ERROR');
  assert.equal(new DataView(added.buffer).getInt32(16, true), -95, 'EOPNOTSUPP');
  // To another socket rather than the kernel: no one.
  p.bytes.fill(0, 256, 268);
  p.view.setUint16(256, 16, true);
  p.view.setUint32(260, 4242, true);
  assert.equal(p.syscall(44n, s, 512n, 16n, 0n, 256n, 12n), -ECONNREFUSED);
});
