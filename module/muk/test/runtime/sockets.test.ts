import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/process.ts';
import type {Kern} from '../../runtime/parts.ts';

// The local sockets' edges, each as a guest's own calls on a kernel and a page of memory (no program translated):
// what is sent with descriptors (SCM_RIGHTS) and what becomes of them when a call takes nothing, fails, or is asked
// again. Each test is one finding closed; the numbers in the names are the issues'.

const SOCKETPAIR = 53, SOCKET = 41, SENDTO = 44, SENDMSG = 46;
const AF_UNIX = 1, SOCK_STREAM = 1, SOCK_NONBLOCK = 0x800, AF_INET = 2, SOCK_DGRAM = 2;
const EAGAIN = -11n;

function guest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
/** A pair of connected local sockets of `type` (never waiting): their descriptors. */
function pair(p: Process, type = SOCK_STREAM): [number, number] {
  assert.equal(call(p, SOCKETPAIR, AF_UNIX, type | SOCK_NONBLOCK, 0, 64), 0n);
  return [p.view.getInt32(64, true), p.view.getInt32(68, true)];
}
/** A msghdr at 128: `length` bytes at `base` and, as its control, SCM_RIGHTS carrying the descriptor `right`. */
function header(p: Process, right: number, length = 1, base = 512): number {
  p.bytes.fill(0, 128, 280);
  p.view.setBigUint64(144, 192n, true);            // msg_iov
  p.view.setBigUint64(152, 1n, true);              // msg_iovlen
  p.view.setBigUint64(160, 224n, true);            // msg_control
  p.view.setBigUint64(168, 24n, true);             // msg_controllen
  p.view.setBigUint64(192, BigInt(base), true);    // iov_base
  p.view.setBigUint64(200, BigInt(length), true);  // iov_len
  p.view.setBigUint64(224, 20n, true);             // cmsg_len
  p.view.setInt32(232, 1, true);                   // SOL_SOCKET
  p.view.setInt32(236, 1, true);                   // SCM_RIGHTS
  p.view.setInt32(240, right, true);
  return 128;
}
const sock = (p: Process, fd: number) => p.fds.get(fd)!.sock!;
/** How many sockets the kernel has still. */
const sockets = (p: Process): number => (p.kernel as Kern).sockets?.size ?? 0;

test('#94: a stream send that takes no byte passes no descriptor: asked again while full, or empty, nothing is kept', () => {
  const p = guest(), [a, b] = pair(p);
  const passed = Number(call(p, SOCKET, AF_INET, SOCK_DGRAM, 0)), d = p.fds.get(passed)!;
  const refs = d.refs;
  // Filled until it takes no more.
  while (call(p, SENDTO, a, 1024, 32768, 0) > 0n) { /* more */ }
  assert.equal(call(p, SENDMSG, a, header(p, passed), 0), EAGAIN);
  assert.equal(call(p, SENDMSG, a, header(p, passed), 0), EAGAIN);
  assert.equal(sock(p, b).rights.length, 0);
  assert.equal(d.refs, refs);

  // Nothing to send: nothing goes, the descriptor neither.
  const q = guest(), [c, e] = pair(q);
  assert.equal(call(q, SENDMSG, c, header(q, e, 0), 0), 0n);
  assert.equal(sock(q, e).rights.length, 0);
});

test('#94: a stream send that takes a byte passes its descriptors once, where its bytes begin', () => {
  const p = guest(), [a, b] = pair(p);
  const passed = Number(call(p, SOCKET, AF_INET, SOCK_DGRAM, 0)), d = p.fds.get(passed)!;
  const refs = d.refs;
  assert.equal(call(p, SENDTO, a, 1024, 3, 0), 3n);
  assert.equal(call(p, SENDMSG, a, header(p, passed, 2), 0), 2n);
  const rights = sock(p, b).rights;
  assert.equal(rights.length, 1);
  assert.equal(rights[0].at, 3);
  assert.equal(rights[0].descs.length, 1);
  assert.equal(d.refs, refs + 1);
});

const RECVMSG = 47, CLOSE = 3, SOCK_DGRAM_LOCAL = 2, EFAULT = -14n;

test('#95: recvmsg told to write outside the guest\'s memory says EFAULT and takes nothing: the message waits, its descriptor is not lost', () => {
  const p = guest(), [a, b] = pair(p, SOCK_DGRAM_LOCAL);
  const passed = Number(call(p, SOCKET, AF_UNIX, SOCK_DGRAM, 0)), d = p.fds.get(passed)!;
  assert.equal(call(p, SENDMSG, a, header(p, passed), 0), 1n);
  const refs = d.refs, queued = () => (sock(p, b).rx as {list: unknown[]}).list.length;
  assert.equal(queued(), 1);
  // Its bytes, who sent it, its control data, the header itself: each outside the one page the guest has.
  const bad: [string, () => bigint][] = [
    ['bytes', () => call(p, RECVMSG, b, header(p, passed, 1, 65536), 0)],
    ['name', () => { const at = header(p, passed); p.view.setBigUint64(at, 65536n, true); p.view.setUint32(at + 8, 16, true); return call(p, RECVMSG, b, at, 0); }],
    ['control', () => { const at = header(p, passed); p.view.setBigUint64(at + 32, 65530n, true); return call(p, RECVMSG, b, at, 0); }],
    ['vector', () => { const at = header(p, passed); p.view.setBigUint64(at + 16, 65530n, true); return call(p, RECVMSG, b, at, 0); }],
    ['header', () => call(p, RECVMSG, b, 65500, 0)],
  ];
  for (const [what, ask] of bad) {
    assert.equal(ask(), EFAULT, what);
    assert.equal(queued(), 1, what);
    assert.equal(d.refs, refs, what);
  }
  // Asked rightly, it comes: one byte, and the descriptor as one of this process's.
  const at = header(p, passed);
  assert.equal(call(p, RECVMSG, b, at, 0), 1n);
  const got = p.view.getInt32(at + 96 + 16, true);
  assert.ok(got > passed);
  assert.equal(p.fds.get(got), d);
  // Everything closed, nothing of it is left: no reference kept by a queue, no socket in the kernel.
  for (const fd of [got, passed, a, b]) assert.equal(call(p, CLOSE, fd), 0n);
  assert.equal(d.refs, 0);
  assert.equal(sockets(p), 0);
});

const DUP = 32;

test('#96: a socket passed over itself, or round a ring of sockets, is let go once no descriptor of it is left', () => {
  // Over itself: b's own descriptor in b's queue.
  const p = guest(), [a, b] = pair(p, SOCK_DGRAM_LOCAL);
  assert.equal(call(p, SENDMSG, a, header(p, b), 0), 1n);
  assert.equal(call(p, CLOSE, a), 0n);
  assert.equal(call(p, CLOSE, b), 0n);
  assert.equal(sockets(p), 0);

  // A ring of two pairs: c2 lies in d2's queue and d2 in c2's; streams as well as datagrams.
  for (const type of [SOCK_DGRAM_LOCAL, SOCK_STREAM]) {
    const q = guest(), [c1, c2] = pair(q, type), [d1, d2] = pair(q, type);
    assert.equal(call(q, SENDMSG, d1, header(q, c2), 0), 1n);
    assert.equal(call(q, SENDMSG, c1, header(q, d2), 0), 1n);
    for (const fd of [c1, d1, c2]) assert.equal(call(q, CLOSE, fd), 0n);
    // One descriptor left (d2): through it c2 can still be received, so nothing is let go.
    assert.equal(sockets(q), 2, `type ${type}`);
    assert.equal(call(q, CLOSE, d2), 0n);
    assert.equal(sockets(q), 0, `type ${type}`);
  }
});

test('#96: a socket in flight that someone can still receive is kept: another descriptor of it, or of the socket it waits in', () => {
  // b lies in its own queue, and a second descriptor of b is left: b is b's still, and what waits in it is received.
  const p = guest(), [a, b] = pair(p, SOCK_DGRAM_LOCAL);
  assert.equal(call(p, SENDMSG, a, header(p, b), 0), 1n);
  const again = Number(call(p, DUP, b));
  assert.equal(call(p, CLOSE, b), 0n);
  assert.equal(sockets(p), 2);
  const at = header(p, 0);
  assert.equal(call(p, RECVMSG, again, at, 0), 1n);
  const got = p.view.getInt32(at + 96 + 16, true);
  assert.equal(p.fds.get(got), p.fds.get(again));
  for (const fd of [got, again, a]) assert.equal(call(p, CLOSE, fd), 0n);
  assert.equal(sockets(p), 0);

  // A socket no process holds, waiting in the queue of one a process does hold: kept until that one goes.
  const q = guest(), [c1, c2] = pair(q, SOCK_DGRAM_LOCAL), [d1, d2] = pair(q, SOCK_DGRAM_LOCAL);
  assert.equal(call(q, SENDMSG, d1, header(q, c2), 0), 1n);
  assert.equal(call(q, SENDMSG, c1, header(q, c1), 0), 1n);
  for (const fd of [c1, c2, d1]) assert.equal(call(q, CLOSE, fd), 0n);
  // c1 lies in c2's queue, c2 in d2's, and d2 is held: all three are kept.
  assert.equal(sockets(q), 3);
  assert.equal(call(q, CLOSE, d2), 0n);
  assert.equal(sockets(q), 0);
});

const EMFILE = -24n, RECVFROM = 45, FCNTL = 72, F_GETFD = 1, F_GETFL = 3, SOCK_CLOEXEC = 0x80000, O_NONBLOCK = 0x800;

test('#97: socketpair refused for want of descriptors, or of a place to tell them, leaves nothing: no descriptor, no socket', () => {
  for (const [limit, sv, said] of [[1, 64, EMFILE], [0, 64, EMFILE], [1024, 65536, EFAULT], [1024, 65532, EFAULT]] as const) {
    const p = guest();
    p.fds.limit = limit;
    assert.equal(call(p, SOCKETPAIR, AF_UNIX, SOCK_STREAM, 0, sv), said, `limit ${limit}, sv ${sv}`);
    assert.equal(p.fds.slots.size, 0, `limit ${limit}, sv ${sv}`);
    assert.equal(sockets(p), 0, `limit ${limit}, sv ${sv}`);
  }
  // With room for exactly two it is made, each end as asked and each the other's.
  const p = guest();
  p.fds.limit = 2;
  assert.equal(call(p, SOCKETPAIR, AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0, 64), 0n);
  const a = p.view.getInt32(64, true), b = p.view.getInt32(68, true);
  assert.deepEqual([a, b], [0, 1]);
  for (const fd of [a, b]) {
    assert.equal(call(p, FCNTL, fd, F_GETFD), 1n);
    assert.equal(call(p, FCNTL, fd, F_GETFL) & BigInt(O_NONBLOCK), BigInt(O_NONBLOCK));
  }
  p.bytes.set([7], 1024);
  assert.equal(call(p, SENDTO, a, 1024, 1, 0), 1n);
  assert.equal(call(p, RECVFROM, b, 2048, 1, 0), 1n);
  assert.equal(p.bytes[2048], 7);
});
