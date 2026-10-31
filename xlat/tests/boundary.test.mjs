import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
// The runtime loads its call tables through process.mjs, as the worker does.
import {Kernel, Process} from '../runtime/process.mjs';
import {FILE_CALLS} from '../runtime/sys-file.mjs';
import {NET_CALLS} from '../runtime/sys-net.mjs';
import {PROC_CALLS} from '../runtime/sys-proc.mjs';

// The Prompt's guest has no network: nothing it runs can reach or listen on the host's network, whatever the
// program is. Its sockets are the local family's (AF_UNIX) alone, channels between its own processes in this kernel
// (sys-net.mjs), named in its own files or its own abstract namespace; every other family is refused as a host
// without it refuses it. Widening this (another family, a way out of the kernel) is a boundary change to make on
// purpose, here first, not by filling in a table.
const NETWORK = {
  41: 'socket', 42: 'connect', 43: 'accept', 44: 'sendto', 45: 'recvfrom',
  46: 'sendmsg', 47: 'recvmsg', 48: 'shutdown', 49: 'bind', 50: 'listen',
  51: 'getsockname', 52: 'getpeername', 53: 'socketpair', 54: 'setsockopt',
  55: 'getsockopt', 288: 'accept4', 299: 'recvmmsg', 307: 'sendmmsg',
};
const ENOSYS = 38n, EINVAL = 22n, EAFNOSUPPORT = 97n;
const AF_UNIX = 1n, SOCK_STREAM = 1n, SOCK_DGRAM = 2n;
// AF_INET, AF_INET6, AF_NETLINK, AF_PACKET.
const ELSEWHERE = [2n, 10n, 16n, 17n];

function guest() {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = new WebAssembly.Memory({initial: 1});
  return p;
}

test('the socket calls are the local family\'s alone: none in the file or process tables, and none reaches out', () => {
  for (const [nr, name] of Object.entries(NETWORK)) assert.ok(!(nr in FILE_CALLS) && !(nr in PROC_CALLS), `${name} (${nr}) has a handler outside sys-net.mjs`);
  // What makes them has no way to the host: no fetch, no WebSocket, no node module that opens one.
  const source = readFileSync(new URL('../runtime/sys-net.mjs', import.meta.url), 'utf8');
  for (const way of ['fetch(', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'RTCPeerConnection', 'node:net', 'node:dgram', 'node:http', 'node:tls', 'import(']) {
    assert.ok(!source.includes(way), `sys-net.mjs uses ${way}`);
  }
  assert.ok(!('299' in NET_CALLS) && !('307' in NET_CALLS));
});

test('through the real dispatcher, no socket of another family is made, and a local one names nothing outside', () => {
  const p = guest();
  for (const family of ELSEWHERE) {
    assert.equal(p.syscall(41n, family, SOCK_STREAM, 0n, 0n, 0n, 0n), -EAFNOSUPPORT, `socket family ${family}`);
    assert.equal(p.syscall(53n, family, SOCK_STREAM, 0n, 64n, 0n, 0n), -EAFNOSUPPORT, `socketpair family ${family}`);
  }
  // A local socket is made; given another family's address (127.0.0.1:80), it reaches nothing and sends nothing.
  const fd = p.syscall(41n, AF_UNIX, SOCK_STREAM, 0n, 0n, 0n, 0n);
  assert.ok(fd >= 0n);
  const inet = new Uint8Array([2, 0, 0, 80, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  p.bytes.set(inet, 256);
  assert.equal(p.syscall(42n, fd, 256n, 16n, 0n, 0n, 0n), -EINVAL, 'connect to an internet address');
  const dgram = p.syscall(41n, AF_UNIX, SOCK_DGRAM, 0n, 0n, 0n, 0n);
  assert.equal(p.syscall(44n, dgram, 512n, 4n, 0n, 256n, 16n), -EINVAL, 'sendto an internet address');
  // Many messages at once: not here.
  for (const nr of [299n, 307n]) assert.equal(p.syscall(nr, fd, 0n, 0n, 0n, 0n, 0n), -ENOSYS, NETWORK[nr]);
});
