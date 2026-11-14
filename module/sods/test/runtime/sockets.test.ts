import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/linux/process.ts';
import type {Kern} from '../../runtime/linux/parts.ts';

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

const SHUTDOWN = 48, BIND = 49;
const SOCK_SEQPACKET = 5, AF_NETLINK = 16, SOCK_RAW = 3, MSG_PEEK = 2, MSG_CTRUNC = 8, SHUT_RD = 0, SHUT_WR = 1, SHUT_RDWR = 2;
const EPIPE = -32n, ECONNREFUSED = -111n, ENOTCONN = -107n, EADDRINUSE = -98n;

/** A msghdr at 128 over one byte at 512, its control at 224: sending, SCM_RIGHTS carrying `rights`; receiving, `room` bytes for what comes. */
function carrying(p: Process, rights: number[], room = (16 + 4 * rights.length + 7) & ~7): number {
  p.bytes.fill(0, 128, 320);
  p.view.setBigUint64(144, 192n, true);
  p.view.setBigUint64(152, 1n, true);
  p.view.setBigUint64(160, room ? 224n : 0n, true);
  p.view.setBigUint64(168, BigInt(room), true);
  p.view.setBigUint64(192, 512n, true);
  p.view.setBigUint64(200, 1n, true);
  if (rights.length) {
    p.view.setBigUint64(224, BigInt(16 + 4 * rights.length), true);
    p.view.setInt32(232, 1, true);
    p.view.setInt32(236, 1, true);
    rights.forEach((fd, k) => p.view.setInt32(240 + 4 * k, fd, true));
  }
  return 128;
}
/** What a recvmsg into the msghdr at 128 handed over: the descriptors, whether it said some were cut (MSG_CTRUNC), how much control it wrote. */
function handed(p: Process): {fds: number[]; cut: boolean; control: number} {
  const control = Number(p.view.getBigUint64(168, true)), cut = !!(p.view.getInt32(176, true) & MSG_CTRUNC);
  const n = control >= 16 ? (Number(p.view.getBigUint64(224, true)) - 16) / 4 : 0;
  return {fds: Array.from({length: n}, (_, k) => p.view.getInt32(240 + 4 * k, true)), cut, control};
}
/** Three sockets to pass, and what holds each. */
function three(p: Process): {fds: number[]; held: () => number[]; closed: () => boolean[]} {
  const fds = [0, 1, 2].map(() => Number(call(p, SOCKET, AF_INET, SOCK_DGRAM, 0))), ds = fds.map((fd) => p.fds.get(fd)!);
  return {fds, held: () => ds.map((d) => d.refs), closed: () => ds.map((d) => d.closed)};
}

for (const [type, name] of [[SOCK_DGRAM, 'a datagram'], [SOCK_STREAM, 'a stream']] as [number, string][]) {
  test(`#110: of the descriptors that came with ${name}, as many are handed over as there is room to say and descriptors left; the rest are let go, and it says so`, () => {
    // What Linux hands over with room for 3, 2, 1, 0 and with 2, 1, 0 descriptors left was asked of Linux.
    const cases: [string, number, number][] = [['room for 3', 3, 9], ['room for 2', 2, 9], ['room for 1', 1, 9], ['room for none', 0, 9],
      ['2 descriptors left', 3, 2], ['1 descriptor left', 3, 1], ['no descriptor left', 3, 0]];
    for (const [what, room, left] of cases) {
      const p = guest(), [a, b] = pair(p, type), sent = three(p), fit = Math.min(room, left, 3);
      p.bytes[512] = 120;
      assert.equal(call(p, SENDMSG, a, carrying(p, sent.fds), 0), 1n, what);
      for (const fd of sent.fds) assert.equal(call(p, CLOSE, fd), 0n);
      assert.deepEqual(sent.held(), [1, 1, 1], what);
      const limit = p.fds.limit;
      p.fds.limit = Math.max(...p.fds.slots.keys()) + 1 + left;
      const bytes = room ? 16 + 4 * room : 0;
      assert.equal(call(p, RECVMSG, b, carrying(p, [], bytes), 0), 1n, what);
      p.fds.limit = limit;
      const got = handed(p);
      // The first of them, in order, each a descriptor of this process; never a number that is none.
      assert.equal(got.fds.length, fit, what);
      assert.ok(got.fds.every((fd) => fd >= 0 && p.fds.get(fd) !== null), `${what}: ${got.fds}`);
      assert.equal(got.cut, fit < 3, what);
      // (What it says it wrote is rounded up to the next piece's place, where the room goes that far.)
      assert.equal(got.control, fit ? Math.min((16 + 4 * fit + 7) & ~7, bytes) : 0, what);
      assert.deepEqual(sent.held(), [0, 1, 2].map((k) => (k < fit ? 1 : 0)), what);
      // Each is held once: closed, it is gone, and those not handed over are gone already.
      for (const fd of got.fds) assert.equal(call(p, CLOSE, fd), 0n);
      assert.deepEqual(sent.closed(), [true, true, true], what);
      // The message itself was taken whole.
      assert.equal(call(p, RECVMSG, b, carrying(p, [], 32), 0), EAGAIN, what);
    }
  });

  test(`#112: ${name} looked at without being taken (MSG_PEEK) hands its descriptors over each time, and stays to be taken`, () => {
    const p = guest(), [a, b] = pair(p, type), sent = three(p);
    p.bytes[512] = 120;
    assert.equal(call(p, SENDMSG, a, carrying(p, [sent.fds[0]]), 0), 1n);
    const d = p.fds.get(sent.fds[0])!;
    const took: number[] = [];
    // Looked at twice, then taken: a descriptor of the same socket each time, a new one each (asked of Linux).
    for (const flags of [MSG_PEEK, MSG_PEEK, 0]) {
      p.bytes[512] = 0;
      assert.equal(call(p, RECVMSG, b, carrying(p, [], 24), flags), 1n);
      assert.equal(p.bytes[512], 120);
      const got = handed(p);
      assert.deepEqual([got.fds.length, got.cut], [1, false]);
      assert.equal(p.fds.get(got.fds[0]), d);
      took.push(got.fds[0]);
    }
    assert.equal(new Set(took).size, 3);
    assert.equal(call(p, RECVMSG, b, carrying(p, [], 24), 0), EAGAIN);
    // Held by the one that sent it and the three handed over, and by nothing else: the message's own hold went with it.
    assert.equal(d.refs, 4);
    // Looked at with no descriptor left: none handed over, said so, and the message keeps its own for the one who takes it.
    assert.equal(call(p, SENDMSG, a, carrying(p, [sent.fds[1]]), 0), 1n);
    const e = p.fds.get(sent.fds[1])!, limit = p.fds.limit;
    p.fds.limit = Math.max(...p.fds.slots.keys()) + 1;
    assert.equal(call(p, RECVMSG, b, carrying(p, [], 24), MSG_PEEK), 1n);
    p.fds.limit = limit;
    assert.deepEqual([handed(p).fds.length, handed(p).cut, e.refs], [0, true, 2]);
    assert.equal(call(p, RECVMSG, b, carrying(p, [], 24), 0), 1n);
    assert.deepEqual([handed(p).fds.length, handed(p).cut, e.refs], [1, false, 2]);
  });
}

test('#111: a local datagram or packet socket shut for writing sends nothing more (EPIPE, and no SIGPIPE); shut for reading, nothing reaches it', () => {
  // What Linux says to each was asked of Linux (socketpair, shutdown, send, recv; SIGPIPE counted).
  const send = (p: Process, fd: number) => call(p, SENDTO, fd, 512, 1, 0, 0, 0);
  const recv = (p: Process, fd: number) => call(p, RECVFROM, fd, 600, 8, 0, 0, 0);
  for (const [type, name, end] of [[SOCK_DGRAM, 'datagram', EAGAIN], [SOCK_SEQPACKET, 'packet', 0n]] as [number, string, bigint][]) {
    // Shut for writing: its own sends are refused, with no signal (a stream's alone raises SIGPIPE); nothing reaches
    // the other, which may still send back. (Before: a datagram went on being sent.)
    let p = guest(), [a, b] = pair(p, type);
    assert.equal(call(p, SHUTDOWN, a, SHUT_WR), 0n, name);
    assert.equal(send(p, a), EPIPE, name);
    assert.equal(p.state, 'live', name);
    assert.equal(sock(p, b).rx instanceof Object && recv(p, b), end, name);
    assert.equal(send(p, b), 1n, name);
    assert.equal(recv(p, a), 1n, name);
    // The other shut for reading: a send to it is refused, and it reads nothing.
    p = guest(), [a, b] = pair(p, type);
    assert.equal(call(p, SHUTDOWN, b, SHUT_RD), 0n, name);
    assert.equal(send(p, a), EPIPE, name);
    assert.equal(p.state, 'live', name);
    assert.equal(recv(p, b), end, name);
    // Shut both ways: its own sends refused, and the other's to it.
    p = guest(), [a, b] = pair(p, type);
    assert.equal(call(p, SHUTDOWN, a, SHUT_RDWR), 0n, name);
    assert.equal(send(p, a), EPIPE, name);
    assert.equal(send(p, b), EPIPE, name);
    assert.equal(recv(p, a), end, name);
    assert.equal(p.state, 'live', name);
  }
  // What came before it was shut for reading is still read; then it is at its end. A datagram socket that waits
  // has nothing more to wait for (0); one that does not is told so as ever (EAGAIN).
  for (const [type, end, waiting] of [[SOCK_DGRAM, EAGAIN, 0n], [SOCK_SEQPACKET, 0n, 0n], [SOCK_STREAM, 0n, 0n]] as [number, bigint, bigint][]) {
    const p = guest(), [a, b] = pair(p, type);
    assert.equal(send(p, a), 1n);
    assert.equal(call(p, SHUTDOWN, b, SHUT_RD), 0n);
    assert.deepEqual([recv(p, b), recv(p, b)], [1n, end], `type ${type}`);
    assert.equal(call(p, SOCKETPAIR, AF_UNIX, type, 0, 64), 0n);
    const c = p.view.getInt32(64, true), e = p.view.getInt32(68, true);
    assert.equal(send(p, c), 1n);
    assert.equal(call(p, SHUTDOWN, e, SHUT_RD), 0n);
    assert.deepEqual([recv(p, e), recv(p, e)], [1n, waiting], `type ${type}, waiting`);
  }
  // The other end closed: a packet socket's send is EPIPE with no signal; a datagram's is refused once
  // (ECONNREFUSED) and it is connected to nothing after (ENOTCONN).
  let p = guest(), [a, b] = pair(p, SOCK_SEQPACKET);
  assert.equal(call(p, CLOSE, b), 0n);
  assert.deepEqual([send(p, a), send(p, a), p.state], [EPIPE, EPIPE, 'live']);
  p = guest(), [a, b] = pair(p, SOCK_DGRAM);
  assert.equal(call(p, CLOSE, b), 0n);
  assert.deepEqual([send(p, a), send(p, a), p.state], [ECONNREFUSED, ENOTCONN, 'live']);
});

test('#113: a netlink port is its protocol\'s own: the same number bound under two protocols, refused twice under one, let go by its own socket alone', () => {
  const p = guest();
  // (The one process there is, so that a port chosen for it is its pid.)
  p.pid = 7;
  const NETLINK_ROUTE = 0, NETLINK_SOCK_DIAG = 4;
  const bind = (fd: number, portid: number) => { p.bytes.fill(0, 512, 524); p.view.setUint16(512, AF_NETLINK, true); p.view.setUint32(516, portid, true); return call(p, BIND, fd, 512, 12); };
  const socket = (protocol: number) => Number(call(p, SOCKET, AF_NETLINK, SOCK_RAW, protocol));
  const route = socket(NETLINK_ROUTE), diag = socket(NETLINK_SOCK_DIAG), route2 = socket(NETLINK_ROUTE), diag2 = socket(NETLINK_SOCK_DIAG);
  assert.equal(bind(route, 123), 0n);
  assert.equal(bind(diag, 123), 0n);
  assert.equal(bind(route2, 123), EADDRINUSE);
  assert.equal(bind(diag2, 123), EADDRINUSE);
  // One closed: its own protocol's port is free again, the other protocol's still taken.
  assert.equal(call(p, CLOSE, diag), 0n);
  assert.equal(bind(route2, 123), EADDRINUSE);
  assert.equal(bind(diag2, 123), 0n);
  assert.equal(call(p, CLOSE, route), 0n);
  assert.equal(bind(route2, 123), 0n);
  // A port chosen for a socket (bound to 0) is the process's pid, in each protocol alike; the next under one protocol another.
  const r3 = socket(NETLINK_ROUTE), d3 = socket(NETLINK_SOCK_DIAG), r4 = socket(NETLINK_ROUTE);
  assert.deepEqual([bind(r3, 0), bind(d3, 0), bind(r4, 0)], [0n, 0n, 0n]);
  const port = (fd: number) => (sock(p, fd).local as {portid: number}).portid;
  assert.deepEqual([port(r3), port(d3)], [7, 7]);
  assert.notEqual(port(r4), 7);
});

const SETSOCKOPT = 54, SOL_SOCKET = 1, SO_PASSCRED = 16, SCM_RIGHTS = 1, SCM_CREDENTIALS = 2;
/** The pieces of control data a recvmsg into the msghdr at 128 wrote: each [its type, the length it says]. */
function said(p: Process): [number, number][] {
  const end = 224 + Number(p.view.getBigUint64(168, true)), out: [number, number][] = [];
  for (let at = 224; at + 16 <= end;) {
    const len = Number(p.view.getBigUint64(at, true));
    out.push([p.view.getInt32(at + 12, true), len]);
    if (len < 16) break;
    at += (len + 7) & ~7;
  }
  return out;
}

for (const [type, name] of [[SOCK_DGRAM, 'a datagram'], [SOCK_STREAM, 'a stream']] as [number, string][]) {
  test(`#198: the control data of ${name} is the sender's credentials, then its descriptors; what has no room is cut short where the room ends`, () => {
    // Each row was asked of Linux (SO_PASSCRED, one descriptor sent): the room, what it says it wrote, the pieces, whether the descriptor came.
    const rows: [number, number, [number, number][], boolean][] = [
      [12, 0, [], false], [16, 16, [[SCM_CREDENTIALS, 16]], false], [20, 20, [[SCM_CREDENTIALS, 20]], false], [24, 24, [[SCM_CREDENTIALS, 24]], false],
      [28, 28, [[SCM_CREDENTIALS, 28]], false], [32, 32, [[SCM_CREDENTIALS, 28]], false], [36, 32, [[SCM_CREDENTIALS, 28]], false],
      [48, 32, [[SCM_CREDENTIALS, 28]], false], [52, 52, [[SCM_CREDENTIALS, 28], [SCM_RIGHTS, 20]], true]];
    for (const [room, wrote, pieces, came] of rows) {
      const p = guest(), [a, b] = pair(p, type), sent = three(p);
      p.view.setInt32(600, 1, true);
      assert.equal(call(p, SETSOCKOPT, b, SOL_SOCKET, SO_PASSCRED, 600, 4), 0n);
      p.bytes[512] = 120;
      assert.equal(call(p, SENDMSG, a, carrying(p, [sent.fds[0]]), 0), 1n);
      const passed = p.fds.get(sent.fds[0]);
      assert.equal(call(p, CLOSE, sent.fds[0]), 0n);
      assert.equal(call(p, RECVMSG, b, carrying(p, [], room), 0), 1n, `room ${room}`);
      const flags = p.view.getInt32(176, true);
      assert.equal(Number(p.view.getBigUint64(168, true)), wrote, `room ${room}`);
      assert.deepEqual(said(p), pieces, `room ${room}`);
      assert.equal(!!(flags & MSG_CTRUNC), !came, `room ${room}`);
      // Whose they are, as far as there was room to say: the sender's pid.
      if (room >= 20) assert.equal(p.view.getInt32(240, true), sock(p, a).creds.pid, `room ${room}`);
      // Past what it says it wrote, nothing is touched.
      assert.ok(p.bytes.subarray(224 + wrote, 320).every((x) => x === 0), `room ${room}`);
      // The descriptor: this process's where it came, let go with the message where it did not.
      assert.deepEqual([sent.held()[0], sent.closed()[0]], came ? [1, false] : [0, true], `room ${room}`);
      if (came) assert.equal(p.fds.get(p.view.getInt32(224 + 32 + 16, true)), passed, `room ${room}`);
    }
  });
}

const LISTEN = 50, CONNECT = 42, ACCEPT4 = 288, GETSOCKNAME = 51, MSG_NOSIGNAL = 0x4000, EINVAL = -22n, EISCONN = -106n;
/** A local name in the abstract namespace, written at 700: [where, how long]. */
function named(p: Process, name: string): [number, number] {
  p.bytes.fill(0, 700, 740);
  p.view.setUint16(700, AF_UNIX, true);
  p.bytes.set(new TextEncoder().encode(name), 703);
  return [700, 3 + name.length];
}

test('#198: a local socket is shut whatever it is connected to, and stays so once it connects; a listener shut for reading takes no more', () => {
  // What Linux says to each was asked of Linux.
  const send = (p: Process, fd: number) => call(p, SENDTO, fd, 512, 1, MSG_NOSIGNAL, 0, 0);
  const recv = (p: Process, fd: number) => call(p, RECVFROM, fd, 600, 8, 0, 0, 0);
  const socket = (p: Process, type: number, waits = false) => Number(call(p, SOCKET, AF_UNIX, type | (waits ? 0 : SOCK_NONBLOCK), 0));
  const listener = (p: Process, type: number, name: string, waits = false) => {
    const l = socket(p, type, waits);
    assert.equal(call(p, BIND, l, ...named(p, name)), 0n);
    assert.equal(call(p, LISTEN, l, 4), 0n);
    return l;
  };
  const accept = (p: Process, l: number) => call(p, ACCEPT4, l, 0, 0, SOCK_NONBLOCK);
  for (const [type, name, unconnected] of [[SOCK_STREAM, 'stream', EINVAL], [SOCK_SEQPACKET, 'packet', ENOTCONN]] as [number, string, bigint][]) {
    const p = guest();
    // Not connected, a stream's receive is EINVAL (a packet socket's ENOTCONN); listening, the same.
    const s = socket(p, type), l = listener(p, type, 'l');
    assert.deepEqual([recv(p, s), send(p, s), recv(p, l), send(p, l)], [unconnected, ENOTCONN, unconnected, ENOTCONN], name);
    // A listener shut for reading: the connection that waited is accepted, no more is taken, and an accept that
    // would wait is told none will come (EINVAL: what wakes a thread waiting in accept).
    const c = socket(p, type);
    assert.equal(call(p, CONNECT, c, ...named(p, 'l')), 0n, name);
    assert.equal(call(p, SHUTDOWN, l, SHUT_RD), 0n, name);
    assert.ok(accept(p, l) >= 0n, name);
    assert.equal(accept(p, l), EAGAIN, name);
    assert.equal(call(p, CONNECT, socket(p, type), ...named(p, 'l')), ECONNREFUSED, name);
    const l2 = listener(p, type, 'l2', true);
    assert.equal(call(p, SHUTDOWN, l2, SHUT_RD), 0n, name);
    assert.equal(accept(p, l2), EINVAL, name);
    // Shut both ways before it connects: it connects, sends nothing and reads its end; the other end is not told
    // (it waits on) until this one closes, and what it sends is refused.
    const l3 = listener(p, type, 'l3'), c3 = socket(p, type);
    assert.equal(call(p, SHUTDOWN, c3, SHUT_RDWR), 0n, name);
    assert.equal(call(p, CONNECT, c3, ...named(p, 'l3')), 0n, name);
    assert.deepEqual([send(p, c3), recv(p, c3)], [EPIPE, 0n], name);
    const s3 = Number(accept(p, l3));
    assert.deepEqual([recv(p, s3), send(p, s3)], [EAGAIN, EPIPE], name);
    assert.equal(call(p, CLOSE, c3), 0n);
    assert.equal(recv(p, s3), 0n, name);
    // Shut for writing alone before it connects: what is sent to it arrives.
    const l4 = listener(p, type, 'l4'), c4 = socket(p, type);
    assert.equal(call(p, SHUTDOWN, c4, SHUT_WR), 0n, name);
    assert.equal(call(p, CONNECT, c4, ...named(p, 'l4')), 0n, name);
    const s4 = Number(accept(p, l4));
    assert.deepEqual([send(p, s4), recv(p, c4), send(p, c4), recv(p, s4)], [1n, 1n, EPIPE, EAGAIN], name);
    assert.equal(p.state, 'live', name);
  }
  // A datagram socket with a name and no peer, shut for reading: nothing reaches it (EPIPE, no signal), and it reads
  // nothing (0 where it would wait, EAGAIN where it does not). One with no peer shut for writing sends nothing.
  const p = guest(), u = socket(p, SOCK_DGRAM), w = socket(p, SOCK_DGRAM, true), c = socket(p, SOCK_DGRAM);
  assert.equal(call(p, BIND, u, ...named(p, 'u')), 0n);
  assert.equal(call(p, BIND, w, ...named(p, 'w')), 0n);
  assert.equal(call(p, SENDTO, c, 512, 1, 0, ...named(p, 'u')), 1n);
  assert.deepEqual([call(p, SHUTDOWN, u, SHUT_RD), call(p, SHUTDOWN, w, SHUT_RD)], [0n, 0n]);
  assert.deepEqual([call(p, SENDTO, c, 512, 1, 0, ...named(p, 'u')), call(p, SENDTO, c, 512, 1, 0, ...named(p, 'w'))], [EPIPE, EPIPE]);
  assert.deepEqual([recv(p, u), recv(p, u), recv(p, w)], [1n, EAGAIN, 0n]);
  assert.equal(call(p, SHUTDOWN, c, SHUT_WR), 0n);
  assert.equal(call(p, SENDTO, c, 512, 1, 0, ...named(p, 'u')), EPIPE);
  assert.equal(p.state, 'live');
  // A packet socket connected is not asked where to (the name is not looked at); a stream is (EISCONN).
  const [a, b] = pair(p, SOCK_SEQPACKET), [x] = pair(p, SOCK_STREAM);
  assert.deepEqual([call(p, SENDTO, a, 512, 1, 0, ...named(p, 'u')), recv(p, b)], [1n, 1n]);
  assert.equal(call(p, SENDTO, x, 512, 1, MSG_NOSIGNAL, ...named(p, 'u')), EISCONN);
  // One end of a datagram pair closed: the other was never counted among its writers, and is not uncounted.
  const [d, e] = pair(p, SOCK_DGRAM);
  assert.equal(call(p, CLOSE, e), 0n);
  assert.equal(sock(p, d).rx.writers, 0);
});

test('#198: a UDP socket shut for reading still takes what is sent to it, and reads what came', () => {
  // Asked of Linux: bound and connected to itself, a datagram queued, shut for reading, another sent after.
  const p = guest(), u = Number(call(p, SOCKET, AF_INET, SOCK_DGRAM | SOCK_NONBLOCK, 0));
  const recv = () => call(p, RECVFROM, u, 600, 8, 0, 0, 0), send = () => call(p, SENDTO, u, 512, 1, 0, 0, 0);
  p.bytes.fill(0, 700, 716);
  p.view.setUint16(700, AF_INET, true);
  p.bytes.set([127, 0, 0, 1], 704);
  assert.equal(call(p, BIND, u, 700, 16), 0n);
  p.view.setUint32(760, 16, true);
  assert.equal(call(p, GETSOCKNAME, u, 700, 760), 0n);
  assert.equal(call(p, CONNECT, u, 700, 16), 0n);
  assert.equal(send(), 1n);
  assert.equal(call(p, SHUTDOWN, u, SHUT_RD), 0n);
  assert.deepEqual([recv(), recv(), send(), recv(), recv()], [1n, EAGAIN, 1n, 1n, EAGAIN]);
});
