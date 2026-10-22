import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.mjs, as the worker does.
import {Kernel, Process} from '../runtime/process.mjs';
import {FILE_CALLS} from '../runtime/sys-file.mjs';
import {PROC_CALLS} from '../runtime/sys-proc.mjs';

// The Prompt's guest has no network: it cannot open a socket, so nothing it
// runs can reach or listen on the host's network, whatever the program is.
// Adding any of these calls is a boundary change to make on purpose, not by
// filling in a table.
const NETWORK = {
  41: 'socket', 42: 'connect', 43: 'accept', 44: 'sendto', 45: 'recvfrom',
  46: 'sendmsg', 47: 'recvmsg', 48: 'shutdown', 49: 'bind', 50: 'listen',
  51: 'getsockname', 52: 'getpeername', 53: 'socketpair', 54: 'setsockopt',
  55: 'getsockopt', 288: 'accept4', 299: 'recvmmsg', 307: 'sendmmsg',
};
const ENOSYS = 38n, EAFNOSUPPORT = 97n;
// Making a socket is answered, only to say no family is here (as a host
// without one says), so a program reports that rather than a missing call.
const REFUSED = {41: 'socket', 53: 'socketpair'};
// AF_UNIX, AF_INET, AF_INET6, AF_NETLINK, AF_PACKET.
const FAMILIES = [1n, 2n, 10n, 16n, 17n];

test('the guest has no system call that reaches a network', () => {
  for (const [nr, name] of Object.entries(NETWORK)) {
    if (nr in REFUSED) continue;
    assert.ok(!(nr in FILE_CALLS) && !(nr in PROC_CALLS), `${name} (${nr}) has a handler`);
  }
});

test('through the real dispatcher, no socket of any family is made, and every other network call is ENOSYS', () => {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  for (const [nr, name] of Object.entries(NETWORK)) {
    if (nr in REFUSED) {
      for (const family of FAMILIES) assert.equal(p.syscall(BigInt(nr), family, 1n, 0n, 0n, 0n, 0n, 0n), -EAFNOSUPPORT, `${name} family ${family}`);
      continue;
    }
    // connect(fd, …) and the like: arguments do not matter.
    assert.equal(p.syscall(BigInt(nr), 2n, 1n, 0n, 0n, 0n, 0n, 0n), -ENOSYS, name);
  }
});
