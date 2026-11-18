import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {answerTime, clocks} from '../../runtime/linux/clock.ts';
import {RemoteKernel} from '../../runtime/linux/remote.ts';

// What a call says to an address that is not the process's memory: EFAULT, as Linux's copy to or from a bad address
// is, never the host's RangeError and never a span quietly cut short. Each as a guest's own call on a kernel and a
// page of memory (no program translated). What Linux says to each was asked of Linux (6.18: a page mapped, the next
// not, raw system calls). The numbers in the names are the issues'.

const READ = 0, WRITE = 1, OPEN = 2, STAT = 4, FSTAT = 5, POLL = 7, LSEEK = 8, SIGACTION = 13, SIGPROCMASK = 14, IOCTL = 16, PREAD = 17,
  PWRITE = 18, READV = 19, WRITEV = 20, PIPE = 22, NANOSLEEP = 35, SOCKETPAIR = 53, SENDTO = 44, RECVFROM = 45, WAIT4 = 61, UNAME = 63, FCNTL = 72,
  GETCWD = 79, SYMLINK = 88, READLINK = 89, GETTIMEOFDAY = 96, GETRLIMIT = 97, GETRUSAGE = 98, SYSINFO = 99, TIMES = 100, TIME = 201, FUTEX = 202,
  GETDENTS64 = 217, CLOCK_GETTIME = 228, GETRANDOM = 318;
const EFAULT = -14n, EINVAL = -22n, EAGAIN = -11n, ECHILD = -10n;
/** Where the memory ends: the first address that is not the process's. */
const END = 65536;
const enc = new TextEncoder(), dec = new TextDecoder();

function guest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  p.pid = p.pgid = p.sid = 1;
  kernel.procs.set(1, p);
  // (A thread, for the calls that ask how long it ran.)
  const t = kernel.newTask(p);
  p.tasks.add(t);
  p.task = t;
  kernel.tasks.set(t.tid, t);
  kernel.vfs.writeFile('/f', enc.encode('0123456789'.repeat(10)));
  return p;
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
/** `text` and its NUL put at `where`: where it is. */
function put(p: Process, where: number, text: string): number { p.bytes.set(enc.encode(text + '\0'), where); return where; }
const text = (p: Process, where: number, n: number): string => dec.decode(p.bytes.subarray(where, where + n));
const open = (p: Process, path = '/f'): number => Number(call(p, OPEN, put(p, 4096, path), 2));
const offset = (p: Process, fd: number): bigint => call(p, LSEEK, fd, 0, 1);
const descriptors = (p: Process): number => p.fds.slots.size;
/** A pipe: [its reading end, its writing end], neither waiting. */
function pipe(p: Process): [number, number] {
  assert.equal(call(p, 293, 8192, 0x800), 0n);
  return [p.view.getInt32(8192, true), p.view.getInt32(8196, true)];
}
/** An iovec array at 1024 of these [base, length] parts: where it is. */
function vector(p: Process, parts: [number, number | bigint][], where = 1024): number {
  parts.forEach(([base, length], k) => { p.view.setBigUint64(where + 16 * k, BigInt(base), true); p.view.setBigInt64(where + 16 * k + 8, BigInt(length), true); });
  return where;
}

test('#114: a structure a call is to fill, or to read, outside the memory or across its end is EFAULT', () => {
  const p = guest(), fd = open(p), f = put(p, 4096, '/f');
  const [r] = pipe(p);
  // (Before: the host's RangeError for each, thrown out of the call.)
  const rows: [string, () => bigint][] = [
    ['stat, outside', () => call(p, STAT, f, END)], ['stat, across the end', () => call(p, STAT, f, END - 8)],
    ['fstat, outside', () => call(p, FSTAT, fd, END)], ['fstat, across the end', () => call(p, FSTAT, fd, END - 8)],
    ['clock_gettime, outside', () => call(p, CLOCK_GETTIME, 0, END)], ['clock_gettime, across the end', () => call(p, CLOCK_GETTIME, 0, END - 8)],
    ['gettimeofday', () => call(p, GETTIMEOFDAY, END, 0)], ['time', () => call(p, TIME, END)],
    ['uname', () => call(p, UNAME, END)], ['nanosleep', () => call(p, NANOSLEEP, END, 0)],
    ['getrusage', () => call(p, GETRUSAGE, 0, END)], ['sysinfo', () => call(p, SYSINFO, END)], ['times', () => call(p, TIMES, END)],
    ['getrlimit', () => call(p, GETRLIMIT, 7, END)],
    ['rt_sigprocmask, the set', () => call(p, SIGPROCMASK, 0, END, 0, 8)], ['rt_sigprocmask, the old set', () => call(p, SIGPROCMASK, 0, 0, END, 8)],
    ['rt_sigaction, the action', () => call(p, SIGACTION, 10, END, 0, 8)], ['rt_sigaction, the old action', () => call(p, SIGACTION, 10, 0, END, 8)],
    ['poll', () => call(p, POLL, END, 1, 0)], ['fcntl F_GETLK', () => call(p, FCNTL, fd, 5, END)], ['ioctl FIONREAD', () => call(p, IOCTL, r, 0x541b, END)],
    ['futex', () => call(p, FUTEX, END, 0, 0, 0)],
    ['getcwd, outside', () => call(p, GETCWD, END, 100)], ['getcwd, across the end', () => call(p, GETCWD, END - 1, 100)],
    ['readv, its array outside', () => call(p, READV, fd, END, 1)], ['readv, its array across the end', () => call(p, READV, fd, END - 8, 1)],
    ['writev, its array outside', () => call(p, WRITEV, fd, END, 1)],
  ];
  const said = rows.map(([what, ask]) => [what, ask()] as const).filter(([, r]) => r !== EFAULT).map(([what, r]) => `${what}: ${r}`);
  assert.deepEqual(said, []);
  // An array of no parts asks nothing of where it is.
  assert.equal(call(p, READV, fd, END, 0), 0n);
  assert.equal(p.state, 'live');
  // The clocks answered without the kernel (clock.ts, and the translated code's own: integer.rs clock_gettime) leave
  // an address outside the memory to the kernel, which says the same.
  const clock = clocks(0);
  assert.deepEqual([228n, 96n, 201n].map((nr) => answerTime(p.memory!, clock, nr, nr === 228n ? 0n : BigInt(END), BigInt(END))), [null, null, null]);
  assert.equal(answerTime(p.memory!, clock, 228n, 0n, BigInt(END - 16)), 0n);
});

test('#114: a path that begins outside the memory, or runs off its end with no NUL, is EFAULT', () => {
  const p = guest();
  p.bytes.set(enc.encode('/f'), END - 2);
  for (const [what, ask] of [
    ['stat, a path outside', () => call(p, STAT, END, 8192)], ['stat, a path off the end', () => call(p, STAT, END - 2, 8192)],
    ['open, a path off the end', () => call(p, OPEN, END - 2, 0)], ['open, a path far outside', () => call(p, OPEN, 2 ** 40, 0)],
    ['readlink, a path outside', () => call(p, READLINK, END, 8192, 10)],
  ] as [string, () => bigint][]) assert.equal(ask(), EFAULT, what);
  // (Before: the name was taken as far as the memory went, and the file opened.)
  assert.equal(descriptors(p), 0);
  // A link read into a place outside, or across the end, is EFAULT (none of it is put).
  assert.equal(call(p, SYMLINK, put(p, 4096, 'target-of-link'), put(p, 4200, '/l')), 0n);
  assert.equal(call(p, READLINK, 4200, END, 10), EFAULT);
  assert.equal(call(p, READLINK, 4200, END - 4, 10), EFAULT);
  assert.equal(call(p, READLINK, 4200, END - 14, 14), 14n);
});

test('#114: a file reads into, and writes from, as much of a span as is the memory (a short count); one that begins outside is EFAULT', () => {
  const p = guest(), fd = open(p);
  // Outside: nothing read, and the place in the file not moved.
  assert.deepEqual([call(p, READ, fd, END, 10), offset(p, fd)], [EFAULT, 0n]);
  // Ten bytes of memory left, ninety asked: ten read.
  assert.deepEqual([call(p, READ, fd, END - 10, 90), offset(p, fd), text(p, END - 10, 10)], [10n, 10n, '0123456789']);
  // Nothing asked asks nothing of the address.
  assert.deepEqual([call(p, READ, fd, END, 0), call(p, READ, fd, 0, 0), call(p, WRITE, fd, END, 0)], [0n, 0n, 0n]);
  assert.deepEqual([call(p, PREAD, fd, END - 10, 90, 0), call(p, PREAD, fd, END, 10, 0)], [10n, EFAULT]);
  // A write: outside, nothing written (before: 0, as if it had been); across the end, the part inside.
  call(p, LSEEK, fd, 0, 0);
  p.bytes.set(enc.encode('ABCDEFGHIJ'), END - 10);
  assert.deepEqual([call(p, WRITE, fd, END, 10), offset(p, fd)], [EFAULT, 0n]);
  assert.deepEqual([call(p, WRITE, fd, END - 10, 50), offset(p, fd)], [10n, 10n]);
  assert.equal(dec.decode(p.kernel.vfs.readFile('/f')).slice(0, 12), 'ABCDEFGHIJ01');
  assert.deepEqual([call(p, PWRITE, fd, END - 10, 50, 20), call(p, PWRITE, fd, END, 10, 0)], [10n, EFAULT]);
  // A count past the address space itself is no span (Linux's access_ok), whatever is at its start.
  assert.deepEqual([call(p, READ, fd, END - 10, -1), call(p, READ, fd, END - 10, 2n ** 47n)], [EFAULT, EFAULT]);
  // The parts of a readv or writev in turn: what went before a part outside is the call's; with none gone, EFAULT.
  call(p, LSEEK, fd, 0, 0);
  assert.deepEqual([call(p, READV, fd, vector(p, [[2048, 5], [END, 5]]), 2), offset(p, fd)], [5n, 5n]);
  call(p, LSEEK, fd, 0, 0);
  assert.deepEqual([call(p, READV, fd, vector(p, [[END, 5], [2048, 5]]), 2), offset(p, fd)], [EFAULT, 0n]);
  assert.deepEqual([call(p, WRITEV, fd, vector(p, [[2048, 5], [END, 5]]), 2), offset(p, fd)], [5n, 5n]);
  assert.equal(call(p, WRITEV, fd, vector(p, [[END, 5], [2048, 5]]), 2), EFAULT);
  // A part's length that is negative is EINVAL, read or written.
  assert.deepEqual([call(p, READV, fd, vector(p, [[2048, -1], [2048, 5]]), 2), call(p, WRITEV, fd, vector(p, [[2048, -1], [2048, 5]]), 2)], [EINVAL, EINVAL]);
  // A device as a file: /dev/zero fills the part inside.
  const zero = open(p, '/dev/zero');
  assert.deepEqual([call(p, READ, zero, END - 10, 50), call(p, READ, zero, END, 10)], [10n, EFAULT]);
});

test('#114: a pipe gives up nothing it cannot put, and takes nothing it cannot read whole', () => {
  const p = guest(), [r, w] = pipe(p), held = () => call(p, IOCTL, r, 0x541b, 12000) === 0n ? p.view.getInt32(12000, true) : -1;
  p.bytes.fill(120, 2048, 2048 + 30);
  assert.equal(call(p, WRITE, w, 2048, 30), 30n);
  // Thirty in the pipe: a read outside, or across the end, is EFAULT and the thirty are still there.
  assert.deepEqual([call(p, READ, r, END, 10), held()], [EFAULT, 30]);
  assert.deepEqual([call(p, READ, r, END - 10, 30), held()], [EFAULT, 30]);
  assert.deepEqual([call(p, READV, r, vector(p, [[2048, 5], [END, 5]]), 2), held()], [EFAULT, 30]);
  assert.deepEqual([call(p, READV, r, vector(p, [[2048, 5], [END - 3, 5]]), 2), held()], [EFAULT, 30]);
  assert.equal(call(p, READ, r, 2048, 27), 27n);
  // Three in the pipe: what it holds fits in the part inside, and is read (the rest of the span is not touched).
  assert.deepEqual([call(p, READV, r, vector(p, [[2048, 5], [END, 5]]), 2), held()], [3n, 0]);
  assert.equal(call(p, WRITE, w, 2048, 3), 3n);
  assert.deepEqual([call(p, READ, r, END - 10, 30), held()], [3n, 0]);
  // Empty, it says so whatever the address (nothing is put anywhere).
  assert.equal(call(p, READ, r, END, 10), EAGAIN);
  // A write from outside, or across the end, puts nothing in.
  assert.deepEqual([call(p, WRITE, w, END, 10), call(p, WRITE, w, END - 10, 30), call(p, WRITEV, w, vector(p, [[2048, 5], [END, 5]]), 2), held()], [EFAULT, EFAULT, EFAULT, 0]);
  // A pipe is not made where its descriptors cannot be told.
  const before = descriptors(p);
  assert.deepEqual([call(p, PIPE, END), call(p, PIPE, END - 4), descriptors(p)], [EFAULT, EFAULT, before]);
  assert.deepEqual([call(p, SOCKETPAIR, 1, 1, 0, END), descriptors(p)], [EFAULT, before]);
});

test('#114: getrandom and getdents64 give what fits in the memory; with none of it there, EFAULT', () => {
  const p = guest();
  assert.deepEqual([call(p, GETRANDOM, END, 8, 0), call(p, GETRANDOM, END - 4, 8, 0), call(p, GETRANDOM, END, 0, 0)], [EFAULT, 4n, 0n]);
  for (const name of ['name0', 'name1', 'name2']) p.kernel.vfs.writeFile(`/d/${name}`, new Uint8Array(0));
  const d = Number(call(p, OPEN, put(p, 4096, '/d'), 0x10000));
  // Room for one entry of 24 bytes ("." and its NUL in 8) before the end: that one; then room for none of the next.
  assert.equal(call(p, GETDENTS64, d, END, 4096), EFAULT);
  assert.equal(call(p, GETDENTS64, d, END - 40, 4096), 24n);
  assert.equal(call(p, GETDENTS64, d, END - 8, 4096), EFAULT);
  // Room too small for one, though in the memory, is EINVAL (before: 0, as at the directory's end).
  assert.deepEqual([call(p, GETDENTS64, d, 8192, 8), call(p, GETDENTS64, d, 8192, 0)], [EINVAL, EINVAL]);
  // The rest, and at the end nothing is put anywhere: 0 whatever the address.
  assert.ok(call(p, GETDENTS64, d, 8192, 4096) > 0n);
  assert.deepEqual([call(p, GETDENTS64, d, END, 4096), call(p, GETDENTS64, d, 8192, 4096)], [0n, 0n]);
});

test('#114: what is sent is read, and what is received is put, in the memory or not at all', () => {
  const p = guest();
  for (const type of [2, 1]) {
    assert.equal(call(p, SOCKETPAIR, 1, type | 0x800, 0, 8192), 0n);
    const a = p.view.getInt32(8192, true), b = p.view.getInt32(8196, true);
    assert.deepEqual([call(p, SENDTO, a, END, 5, 0, 0, 0), call(p, SENDTO, a, END - 2, 5, 0, 0, 0)], [EFAULT, EFAULT], `type ${type}`);
    assert.equal(call(p, RECVFROM, b, 2048, 5, 0, 0, 0), EAGAIN, `type ${type}`);
    assert.equal(call(p, SENDTO, a, 2048, 5, 0, 0, 0), 5n);
    // Received into a place outside, or across the end: EFAULT, and it waits to be received (a stream's does on
    // Linux too; a datagram Linux drops is kept here, as recvmsg's is: #95).
    assert.deepEqual([call(p, RECVFROM, b, END, 5, 0, 0, 0), call(p, RECVFROM, b, END - 2, 5, 0, 0, 0), call(p, READ, b, END - 2, 5)], [EFAULT, EFAULT, EFAULT], `type ${type}`);
    assert.equal(call(p, RECVFROM, b, 2048, 5, 0, 0, 0), 5n, `type ${type}`);
    assert.equal(call(p, WRITE, a, END - 2, 5), EFAULT, `type ${type}`);
    assert.equal(call(p, RECVFROM, b, 2048, 5, 0, 0, 0), EAGAIN, `type ${type}`);
  }
});

test('#114: wait4 told to write its status outside the memory says EFAULT, and the child is waited for all the same', () => {
  // (As Linux: the child is reaped, then its status cannot be put.)
  for (const [status, rusage] of [[END, 0], [0, END]]) {
    const p = guest(), child = new Process(p.kernel, p);
    child.pid = 2;
    p.kernel.procs.set(2, child);
    p.children.add(child);
    p.kernel.exitProcess(child, 3 << 8);
    assert.equal(call(p, WAIT4, 2, status, 0, rusage), EFAULT);
    assert.equal(call(p, WAIT4, 2, 8192, 0, 0), ECHILD);
  }
});

test('#199: fcntl F_GETLK says nothing is in the way (F_UNLCK), and the record locks read what they are asked as Linux does', () => {
  // What Linux says to each was asked of Linux, of a file with no lock on it. (No lock is kept here: each is granted.)
  const p = guest(), fd = open(p), F_GETLK = 5, F_SETLK = 6, F_SETLKW = 7, F_OFD_GETLK = 36, F_OFD_SETLK = 37, RD = 0, WR = 1, UN = 2, EBADF = -9n;
  const lock = (cmd: number, type: number, {whence = 0, pid = 99, on = fd} = {}): [bigint, number, number, bigint, bigint, number] => {
    const v = p.view, at = 8192;
    v.setInt16(at, type, true); v.setInt16(at + 2, whence, true); v.setBigInt64(at + 8, 5n, true); v.setBigInt64(at + 16, 7n, true); v.setInt32(at + 24, pid, true);
    return [call(p, FCNTL, on, cmd, at), v.getInt16(at, true), v.getInt16(at + 2, true), v.getBigInt64(at + 8, true), v.getBigInt64(at + 16, true), v.getInt32(at + 24, true)];
  };
  // Asked about a lock to read or to write: none is in the way, and the rest of what was asked is as it was.
  // (Before: 0 and the type it asked about, which says one is.)
  assert.deepEqual(lock(F_GETLK, RD), [0n, UN, 0, 5n, 7n, 99]);
  assert.deepEqual(lock(F_GETLK, WR), [0n, UN, 0, 5n, 7n, 99]);
  assert.deepEqual([lock(F_GETLK, UN)[0], lock(F_GETLK, 9)[0], lock(F_GETLK, WR, {whence: 9})[0]], [EINVAL, EINVAL, EINVAL]);
  // The open file description's: its pid is 0, and it may ask about F_UNLCK.
  assert.deepEqual([lock(F_OFD_GETLK, WR, {pid: 0}).slice(0, 2), lock(F_OFD_GETLK, UN, {pid: 0})[0], lock(F_OFD_GETLK, WR, {pid: 5})[0], lock(F_OFD_GETLK, 9, {pid: 0})[0]],
    [[0n, UN], 0n, EINVAL, EINVAL]);
  for (const cmd of [F_SETLK, F_SETLKW, F_OFD_SETLK]) {
    const pid = cmd === F_OFD_SETLK ? 0 : 99;
    assert.deepEqual([RD, WR, UN, 9].map((type) => lock(cmd, type, {pid})[0]), [0n, 0n, 0n, EINVAL], `command ${cmd}`);
    assert.equal(call(p, FCNTL, fd, cmd, END), EFAULT, `command ${cmd}`);
    assert.equal(call(p, FCNTL, fd, cmd, END - 8), EFAULT, `command ${cmd}`);
  }
  // A lock to write is asked of a descriptor open to write, one to read of one open to read.
  const [r, w] = pipe(p);
  assert.deepEqual([lock(F_SETLK, WR, {on: r})[0], lock(F_SETLK, RD, {on: r})[0], lock(F_SETLK, RD, {on: w})[0], lock(F_SETLK, WR, {on: w})[0]], [EBADF, 0n, EBADF, 0n]);
  assert.equal(lock(F_GETLK, WR, {on: r})[0], 0n);
});

test('#114: the same of a memory shared with threads that run apart, under the kernel that serves them', () => {
  // (The calls of a thread in a Worker are answered by these handlers, on its shared memory. No Worker is started
  // here: what is checked is the handlers and the views over a shared buffer, not the channel a Worker asks through.)
  const kernel = new RemoteKernel({spares: 0, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}), {users: 1, written: [], keeps: false, imageOf: null});
  p.pid = p.pgid = p.sid = 1;
  kernel.procs.set(1, p);
  kernel.vfs.writeFile('/f', enc.encode('0123456789'.repeat(10)));
  assert.ok(p.memory!.buffer instanceof SharedArrayBuffer);
  const fd = open(p), [r, w] = pipe(p);
  assert.deepEqual([call(p, STAT, put(p, 4096, '/f'), END), call(p, FSTAT, fd, END - 8), call(p, STAT, END, 8192)], [EFAULT, EFAULT, EFAULT]);
  p.bytes.set(enc.encode('/f'), END - 2);
  assert.equal(call(p, OPEN, END - 2, 0), EFAULT);
  assert.deepEqual([call(p, READ, fd, END, 10), call(p, READ, fd, END - 10, 90), text(p, END - 10, 10), call(p, WRITE, fd, END, 10)], [EFAULT, 10n, '0123456789', EFAULT]);
  assert.deepEqual([call(p, WRITE, w, 2048, 30), call(p, READ, r, END - 10, 30), call(p, READ, r, 2048, 30)], [30n, EFAULT, 30n]);
  assert.deepEqual([call(p, GETRANDOM, END - 4, 8, 0), call(p, PIPE, END - 4), call(p, FSTAT, fd, 8192)], [4n, EFAULT, 0n]);
  kernel.close();
});
