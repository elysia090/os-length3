// Process, thread, memory, time and identity system calls. Handlers run
// with `this` bound to the calling Process, `this.task` the calling
// thread and `this.call` the call ({nr, args, next, state}: state lasts
// while the call waits and is made again).

import {CAP, CAP_LAST, MAY, UserNs, asUser, capable, idIn, idOf, inNew, may, shownIn, within, type Cred} from './cred.ts';
import {cgroupOf, room, type Cgroup} from './cgroup.ts';
import {copySpace} from './mount.ts';
import {down} from './fs.ts';
import {CgroupNs, Ipc, NS, Net, PidNs, Uts, byNr, nrIn, spaceOf, withSpaces, type Spaces} from './space.ts';
import {move, zero} from './bulk.ts';
import {answerTime, clocks, cpuClock, cpuOf} from './clock.ts';
import {E, File, FsError} from './fs.ts';
import {Exec, Exit, Wait, randomBytes, utf8} from './flow.ts';
import type {Calls, Cpu, Proc} from './parts.ts';
import {ACTIONS, read as readFilter} from './seccomp.ts';
import {CLD, SIG, send, writeInfo} from './signal.ts';
import {processors, steady} from '../host.ts';

const N = (x: bigint): number => Number(BigInt.asIntN(64, x));
const fail = (errno: number): never => { throw new FsError(errno); };
const enc = new TextEncoder();

const CLONE = {VM: 0x100, FS: 0x200, FILES: 0x400, SIGHAND: 0x800, PIDFD: 0x1000, VFORK: 0x4000, PARENT: 0x8000,
  THREAD: 0x10000, SETTLS: 0x80000, PARENT_SETTID: 0x100000, CHILD_CLEARTID: 0x200000, CHILD_SETTID: 0x1000000};
/** Every kind of namespace a clone or an unshare can make (a time namespace is not made here: asked for, EINVAL). */
const NEW = NS.mnt | NS.cgroup | NS.uts | NS.ipc | NS.user | NS.pid | NS.net;

/** What `p` calls the process, thread, group or session the kernel numbers `id` (0: it does not see it); and the kernel's number for what `p` calls `nr`. */
const nr = (p: Proc, id: number): number => nrIn(p.kernel.numbers, p.pidns, id);
const idBy = (p: Proc, n: number): number => byNr(p.pidns, n);

/**
 * The namespaces, and who it is, of what `p` makes or becomes with `flags` (clone's CLONE_NEW*, as clone, clone3
 * and unshare take them): each asked for made new, owned by the user namespace it is then in. A user namespace is
 * made by one whose ids its own namespace has numbers for and whose root is its namespace's own, 32 deep at most;
 * any other by one that may administer the user namespace it is in (the new one, where one is made: whoever makes
 * a user namespace has every capability in it).
 */
function spaces(p: Proc, flags: number): {ns: Spaces; cred: Cred; made: Map<object, object> | null} {
  let c = p.cred, ns = p.ns, made: Map<object, object> | null = null;
  if (flags & NS.user) {
    if (c.ns.level >= 32) fail(E.USERS);
    if (idIn(c.ns, c.euid) < 0 || idIn(c.ns, c.egid, true) < 0) fail(E.PERM);
    // (one whose root is not its namespace's own could make of itself, in a new one, more than it is)
    const top = down(p.ns.mnt.top, p.ns.mnt.top.root), root = p.fs.root;
    if (root.mnt !== top.mnt || root.node !== top.node) fail(E.PERM);
    c = inNew(c, new UserNs(c.ns, c.euid, c.egid));
  }
  if (flags & NEW & ~NS.user && !capable(c, CAP.SYS_ADMIN, c.ns)) fail(E.PERM);
  const owner = c.ns;
  if (flags & NS.mnt) { const copied = copySpace(ns.mnt, owner); ns = withSpaces(ns, {mnt: copied.space}); made = copied.made; }
  if (flags & NS.uts) ns = withSpaces(ns, {uts: new Uts(owner, ns.uts.hostname, ns.uts.domainname)});
  if (flags & NS.ipc) ns = withSpaces(ns, {ipc: new Ipc(owner)});
  if (flags & NS.net) ns = withSpaces(ns, {net: new Net(owner)});
  if (flags & NS.cgroup) ns = withSpaces(ns, {cgroup: new CgroupNs(owner, p.cgroup)});
  if (flags & NS.pid) ns = withSpaces(ns, {children: new PidNs(ns.children, owner)});
  return {ns, cred: c, made};
}
/** `q`'s root and where it works, found in the copy of the mounts its namespace was made of (`made`: each copy by what it is a copy of). */
function inCopy(q: Proc, made: Map<object, object> | null): void {
  if (!made) return;
  const root = q.fs.root, pwd = q.fs.pwd, to = (m: object) => (made.get(m) ?? m) as typeof root.mnt;
  q.fs.turn({mnt: to(root.mnt), node: root.node});
  q.fs.go({mnt: to(pwd.mnt), node: pwd.node});
}

const W = {NOHANG: 1, UNTRACED: 2, EXITED: 4, CONTINUED: 8, NOWAIT: 0x01000000};

function exitStatus(code: number): number { return (code & 0xff) << 8; }

function writeTime(p: Proc, address: number, ns: bigint): void {
  p.view.setBigInt64(address, ns / 1000000000n, true);
  p.view.setBigInt64(address + 8, ns % 1000000000n, true);
}

// The kernel's clocks (clock.ts): what a thread reads without a call is what these say.
const CLOCK = clocks(), wall = CLOCK.wall, monotonic = CLOCK.monotonic;
/** A timespec in guest memory, in nanoseconds. */
const readTime = (p: Proc, at: number): bigint => p.view.getBigInt64(at, true) * 1000000000n + p.view.getBigInt64(at + 8, true);
const ms = (ns: bigint): number => Number(ns) / 1e6;

/**
 * Sleep until `deadline` (steady() ms) for real: the call waits
 * and is made again once the time has come, so the host waits on a timer
 * instead of running anything. A handler that interrupts it has `rem`
 * (when given) say how long was left.
 */
function sleepUntil(p: Proc, deadline: number, rem = 0): number {
  const s = p.call!.state;
  const until = s.deadline ??= deadline;
  if (steady() >= until) return 0;
  if (rem) s.interrupted = () => writeTime(p, rem, BigInt(Math.max(0, Math.round((until - steady()) * 1e6))));
  throw new Wait();
}

/** The child `p` waits for, as wait4 and waitid choose: {child, status, code, kind} or null. */
/** What a wait found: the child, its wait status, its siginfo code and value, and whether it ended or was stopped or continued. */
interface Found { child: Proc; status: number; code: number; value: number; kind: 'exit' | 'report' }

function waitable(p: Proc, pick: (c: Proc) => boolean, options: number): Found | null {
  const children = [...p.children].filter(pick);
  if (!children.length) fail(E.CHILD);
  for (const c of children) {
    if (c.state === 'zombie' && options & W.EXITED) {
      const status = c.exitStatus ?? 0, sig = status & 0x7f;
      return {child: c, status, code: sig ? CLD.KILLED : CLD.EXITED, value: sig ? sig : status >> 8, kind: 'exit'};
    }
    if (c.state === 'live' && c.report && !c.report.seen) {
      const sig = c.report.sig ?? 0;
      if (c.report.kind === 'stopped' && options & W.UNTRACED) return {child: c, status: 0x7f | (sig << 8), code: CLD.STOPPED, value: sig, kind: 'report'};
      if (c.report.kind === 'continued' && options & W.CONTINUED) return {child: c, status: 0xffff, code: CLD.CONTINUED, value: SIG.CONT, kind: 'report'};
    }
  }
  return null;
}

/** What was found is taken: a zombie is gone, a stop or continue said once (unless WNOWAIT). */
function taken(p: Proc, found: Found, options: number): void {
  if (options & W.NOWAIT) return;
  const c = found.child;
  if (found.kind === 'exit') {
    p.children.delete(c);
    p.kernel.procs.delete(c.pid);
    // Its time on the processor, and what it waited for, is its parent's to count now (getrusage's children, times).
    const had = cpuOf(c);
    p.waited.user += had.user + c.waited.user;
    p.waited.sys += had.sys + c.waited.sys;
  } else if (c.report) c.report.seen = true;
}

/** A struct rusage of time on the processor `c` (ms), and of the largest resident set (`kb`); the rest is not kept. */
function putUsage(p: Proc, at: number, c: Cpu, kb = 0): void {
  p.bytes.fill(0, at, at + 144);
  const v = p.view, put = (o: number, ms: number): void => {
    const us = Math.floor(ms * 1000);
    v.setBigInt64(at + o, BigInt(Math.floor(us / 1e6)), true);
    v.setBigInt64(at + o + 8, BigInt(us % 1e6), true);
  };
  put(0, c.user);
  put(16, c.sys);
  v.setBigInt64(at + 32, BigInt(kb), true);
}

function wait4(p: Proc, pid: bigint, statusAddress: bigint, options: bigint, rusage: bigint): number {
  const want = N(pid), o = N(options) | W.EXITED;
  // (a child, or a group, by the number the caller calls it: one it has no number for is no child of its)
  const one = want > 0 ? idBy(p, want) || -1 : want < -1 ? idBy(p, -want) || -1 : 0;
  const pick = want > 0 ? (c: Proc) => c.pid === one : want === -1 ? () => true : want === 0 ? (c: Proc) => c.pgid === p.pgid : (c: Proc) => c.pgid === one;
  const found = waitable(p, pick, o);
  if (!found) {
    if (o & W.NOHANG) return 0;
    throw new Wait();
  }
  taken(p, found, o);
  if (N(statusAddress)) p.view.setInt32(N(statusAddress), found.status, true);
  // The child's time, with its own children's that it waited for (taken: before it went, if it went).
  if (N(rusage)) {
    const c = found.child, had = cpuOf(c);
    putUsage(p, N(rusage), {user: had.user + c.waited.user, sys: had.sys + c.waited.sys});
  }
  return nr(p, found.child.pid);
}

function waitid(p: Proc, idtype: bigint, id: bigint, infop: bigint, options: bigint): number {
  const o = N(options), which = N(idtype), n = N(id), one = n ? idBy(p, n) || -1 : 0;
  if (!(o & (W.EXITED | W.UNTRACED | W.CONTINUED))) fail(E.INVAL);
  const pick = which === 0 ? () => true : which === 1 ? (c: Proc) => c.pid === one : which === 2 ? (c: Proc) => c.pgid === (one || p.pgid) : fail(E.INVAL);
  const found = waitable(p, pick, o);
  if (!found) {
    if (o & W.NOHANG) { if (N(infop)) p.bytes.fill(0, N(infop), N(infop) + 128); return 0; }
    throw new Wait();
  }
  taken(p, found, o);
  if (N(infop)) writeInfo(p, N(infop), {signo: SIG.CHLD, code: found.code, pid: found.child.pid, uid: found.child.cred.uid, status: found.value});
  return 0;
}

function execve(p: Proc, nameAddress: bigint, argvAddress: bigint, envAddress: bigint): never {
  const name = p.cstring(N(nameAddress));
  const argv = p.strings(N(argvAddress)), env = p.strings(N(envAddress));
  p.execve(name, argv, env); // throws FsError before replacing anything
  throw new Exec();
}

/** clone(2), fork(2) and vfork(2): a thread of this process, or a new process. */
/**
 * clone, and clone3 by it: a thread, or a process, as `flags` say (clone's own, its signal at the child's end in
 * their low byte), in new namespaces where they ask (CLONE_NEW*), and in the cgroup `into` (clone3's
 * CLONE_INTO_CGROUP) where one is given. A cgroup with no room for one more refuses it (EAGAIN), as does a pid
 * namespace whose first process is gone (ENOMEM).
 */
function clone(p: Proc, flags: number, stack: bigint, ptid: number, ctid: number, tls: bigint, into: Cgroup | null = null): number {
  const t = p.task, s = p.call!.state;
  // (A place for the new thread's id that is not the memory is not written, and the clone goes on: Linux's put_user
  // there is not looked at either.)
  const writeTid = (memory: WebAssembly.Memory, at: number, tid: number): void => {
    if (at > 0 && at + 4 <= memory.buffer.byteLength) new DataView(memory.buffer).setInt32(at, tid, true);
  };
  if (flags & CLONE.THREAD) {
    if (!(flags & CLONE.VM) || !(flags & CLONE.SIGHAND)) fail(E.INVAL);
    if (flags & (NS.user | NS.pid) || p.ns.children !== p.pidns) fail(E.INVAL);
    if (flags & NS.mnt && flags & CLONE.FS) fail(E.INVAL);
    // (a thread may be made in namespaces of its own, but for the users' and the processes')
    const how = flags & NEW ? spaces(p, flags) : null;
    if (!room(p.cgroup)) fail(E.AGAIN);
    const nt = p.newThread(t.resumeAt, stack, flags & CLONE.SETTLS ? tls : null);
    if (!(flags & CLONE.FS)) { const own = nt.fs.copy(); nt.fs.drop(); nt.fs = own; }
    if (how) { nt.ns = how.ns; if (how.made) { const made = how.made, to = (m: object) => (made.get(m) ?? m) as typeof nt.fs.root.mnt; nt.fs.turn({mnt: to(nt.fs.root.mnt), node: nt.fs.root.node}); nt.fs.go({mnt: to(nt.fs.pwd.mnt), node: nt.fs.pwd.node}); } }
    if (flags & CLONE.PARENT_SETTID) writeTid(p.memory!, ptid, nr(p, nt.tid));
    if (flags & CLONE.CHILD_SETTID) writeTid(p.memory!, ctid, nr(p, nt.tid));
    if (flags & CLONE.CHILD_CLEARTID) nt.clearTid = ctid;
    p.kernel.go(nt);
    return nr(p, nt.tid);
  }
  if (!s.child) {
    if (flags & CLONE.PIDFD) fail(E.INVAL);
    // What cannot be: a user or mount namespace of its own for one that shares where it is in the tree; a pid or
    // user namespace of its own for a sibling (CLONE_PARENT).
    if (flags & (NS.user | NS.mnt) && flags & CLONE.FS) fail(E.INVAL);
    if (flags & CLONE.PARENT && (flags & (NS.user | NS.pid) || p.ns.children !== p.pidns)) fail(E.INVAL);
    const how = flags & NEW ? spaces(p, flags) : null;
    if ((how?.ns ?? p.ns).children.ended) fail(E.NOMEM);
    if (!room(into ?? p.cgroup)) fail(E.AGAIN);
    const child = p.forkProcess(t.resumeAt, {stack, vm: !!(flags & CLONE.VM), files: !!(flags & CLONE.FILES), fs: !!(flags & CLONE.FS), exitSignal: flags & 0xff,
      tls: flags & CLONE.SETTLS ? tls : null, clearTid: flags & CLONE.CHILD_CLEARTID ? ctid : 0, parent: !!(flags & CLONE.PARENT), ns: how?.ns ?? null, cred: how?.cred ?? null, cgroup: into});
    if (how) inCopy(child, how.made);
    if (flags & CLONE.PARENT_SETTID) writeTid(p.memory!, ptid, nr(p, child.pid));
    if (flags & CLONE.CHILD_SETTID) writeTid(child.memory!, ctid, nr(child, child.pid));
    s.child = child;
    // A vfork parent waits until its child has exec'd or ended: they share one memory until then.
    if (flags & CLONE.VFORK) s.vfork = child.vfork = {released: false};
    if (!s.vfork) return nr(p, child.pid);
  }
  if (s.vfork && !s.vfork.released) throw new Wait();
  return s.child ? nr(p, s.child.pid) : fail(E.AGAIN);
}

/**
 * clone3: clone, told by a struct (what it does not know of must be nothing: E2BIG), its signal apart from its
 * flags, its stack by where it begins and how long it is, and, with CLONE_INTO_CGROUP, the cgroup (a descriptor of
 * its directory) the child is made in, which the caller may put processes in. A number chosen for the child
 * (set_tid) is not given here.
 */
function clone3(p: Proc, at: number, size: number): number {
  if (size < 64) fail(E.INVAL);
  if (size > 4096) fail(E.TOOBIG);
  if (p.bytes.subarray(at + Math.min(size, 88), at + size).some((b) => b !== 0)) fail(E.TOOBIG);
  const v = p.view, word = (k: number): bigint => (8 * k + 8 <= size ? v.getBigUint64(at + 8 * k, true) : 0n);
  const flags = word(0), signal = word(4), INTO_CGROUP = 0x200000000n;
  if (flags & 0xffn || flags & 0x400000n /* CLONE_DETACHED */ || flags >> 34n) fail(E.INVAL);
  if (signal > 64n) fail(E.INVAL);
  if (word(9)) fail(E.INVAL); // set_tid_size
  let into: Cgroup | null = null;
  if (flags & INTO_CGROUP) {
    if (flags & BigInt(CLONE.THREAD)) fail(E.INVAL);
    const d = p.fds.get(Number(BigInt.asIntN(32, word(10)))) ?? fail(E.BADF);
    into = cgroupOf(d.node) ?? fail(E.BADF);
    // (one who may write to its list of processes may put one in it)
    const list = into.dir.entries.get('cgroup.procs');
    if (!list || !may(p.cred, list, MAY.WRITE)) fail(E.ACCES);
    if (into.parent && into.gives.size) fail(E.BUSY);
  }
  const stack = word(5), length = word(6);
  return clone(p, Number(flags & 0xffffffffn & ~0xffn) | Number(signal), stack ? stack + length : 0n, N(word(3)), N(word(2)), word(7), into);
}

/**
 * unshare: the caller put in namespaces of its own (CLONE_NEW*), or given its own of what it shared (CLONE_FS,
 * CLONE_FILES). A user namespace, and a mount namespace, by one that shares where it is in the tree with no one; a
 * user namespace by one with one thread. A pid namespace is for what it starts from here on: itself it stays.
 */
function unshare(p: Proc, flags: number): number {
  if (flags & ~(NEW | NS.time | CLONE.FS | CLONE.FILES | CLONE.THREAD | CLONE.SIGHAND | CLONE.VM | 0x40000 /* CLONE_SYSVSEM */)) fail(E.INVAL);
  if (flags & NS.time) fail(E.INVAL);
  if (flags & (NS.user | CLONE.THREAD | CLONE.SIGHAND | CLONE.VM) && p.tasks.size > 1) fail(E.INVAL);
  if (flags & NS.user && p.fs.users > 1) fail(E.INVAL);
  const how = flags & NEW ? spaces(p, flags) : null;
  if (flags & (CLONE.FS | NS.mnt | NS.user) && p.fs.users > 1) { const own = p.fs.copy(); p.fs.drop(); p.fs = own; }
  if (flags & CLONE.FILES) {
    const shared = p.fds;
    p.fds = shared.own();
  }
  if (how) {
    p.cred = how.cred;
    p.ns = how.ns;
    inCopy(p, how.made);
  }
  return 0;
}

/**
 * setns: the caller put in a namespace that is there, by a descriptor of its file (/proc/PID/ns/NAME). By one that
 * may administer the user namespace that owns it, and its own. A user namespace: not the one it is in, and by one
 * with one thread that shares where it is in the tree with no one; it then has every capability there. The mounts':
 * its root and where it works are that namespace's root. A pid namespace: for what it starts from here on, and only
 * the one it is in or one below it.
 */
function setns(p: Proc, fd: number, kind: number): number {
  const d = p.fds.get(fd) ?? fail(E.BADF), it = spaceOf(d.node) ?? fail(E.INVAL), c = p.cred;
  if (kind && kind !== NS[it.kind]) fail(E.INVAL);
  if (it.kind === 'user') {
    const to = it.ns as UserNs;
    if (to === c.ns) fail(E.INVAL);
    if (p.tasks.size > 1 || p.fs.users > 1) fail(E.INVAL);
    if (!capable(c, CAP.SYS_ADMIN, to)) fail(E.PERM);
    p.cred = inNew(c, to);
    return 0;
  }
  const owner = (it.ns as unknown as {owner: UserNs}).owner;
  if (!capable(c, CAP.SYS_ADMIN, owner) || !capable(c, CAP.SYS_ADMIN, c.ns)) fail(E.PERM);
  switch (it.kind) {
    case 'mnt': {
      const to = it.ns as Spaces['mnt'];
      if (p.fs.users > 1) fail(E.INVAL);
      if (!capable(c, CAP.SYS_CHROOT, c.ns)) fail(E.PERM);
      const root = down(to.top, to.top.root);
      p.ns = withSpaces(p.ns, {mnt: to});
      p.fs.turn(root);
      p.fs.go(root);
      return 0;
    }
    case 'pid': {
      const to = it.ns as PidNs;
      let under = false;
      for (let ns: PidNs | null = to; ns; ns = ns.parent) under ||= ns === p.pidns;
      if (!under) fail(E.INVAL);
      p.ns = withSpaces(p.ns, {children: to});
      return 0;
    }
    case 'uts': p.ns = withSpaces(p.ns, {uts: it.ns as Uts}); return 0;
    case 'ipc': p.ns = withSpaces(p.ns, {ipc: it.ns as Ipc}); return 0;
    case 'net': p.ns = withSpaces(p.ns, {net: it.ns as Net}); return 0;
    case 'cgroup': p.ns = withSpaces(p.ns, {cgroup: it.ns as CgroupNs}); return 0;
  }
  return fail(E.INVAL);
}
void within;

/**
 * seccomp(2): strict mode, a filter over this thread's calls, or whether an action is answered here. A filter is set
 * by one that can gain nothing by what it runs (no_new_privs) or may administer its namespace; it is read and
 * checked as the kernel reads one, and from then on every call of this thread, and of all it starts, is asked of it.
 * With TSYNC every thread of the process has it, where each has the same filters before it or fewer of the same;
 * else the thread that differs is named (or ESRCH), and nothing is set. No one listens for what a filter would have
 * asked of another process (NEW_LISTENER, and the sizes for it): as on a kernel before that was.
 */
function seccomp(p: Proc, op: number, flags: number, uargs: number): number {
  const t = p.task;
  if (op === 0) { // SECCOMP_SET_MODE_STRICT
    if (flags || uargs) fail(E.INVAL);
    if (t.filters) fail(E.INVAL);
    t.screen(t.filters, true);
    return 0;
  }
  if (op === 1) { // SECCOMP_SET_MODE_FILTER
    const TSYNC = 1, LOG = 2, SPEC_ALLOW = 4, TSYNC_ESRCH = 16;
    if (flags & ~(TSYNC | LOG | SPEC_ALLOW | TSYNC_ESRCH)) fail(E.INVAL);
    if (t.strict) fail(E.INVAL);
    if (!p.noNewPrivs && !capable(p.cred, CAP.SYS_ADMIN, p.cred.ns)) fail(E.ACCES);
    if (!uargs) fail(E.FAULT);
    const filter = readFilter(p, uargs), mine = t.filters ?? [];
    if (flags & TSYNC) {
      for (const other of p.tasks) {
        const theirs = other.filters ?? [];
        if (other === t || (!other.strict && theirs.length <= mine.length && theirs.every((f, i) => f === mine[i]))) continue;
        return flags & TSYNC_ESRCH ? fail(E.SRCH) : nr(p, other.tid);
      }
    }
    const filters = [...mine, filter];
    for (const each of flags & TSYNC ? p.tasks : [t]) each.screen(filters);
    return 0;
  }
  if (op === 2) { // SECCOMP_GET_ACTION_AVAIL
    if (flags) fail(E.INVAL);
    return ACTIONS.includes(p.view.getUint32(uargs, true)) ? 0 : fail(E.OPNOTSUPP);
  }
  return fail(E.INVAL);
}

/** futex(2): wait while a word holds a value, and wake those waiting on it. */
function futex(p: Proc, uaddr: bigint, op: bigint, val: bigint, timeout: bigint, uaddr2: bigint, val3: bigint): number {
  const k = p.kernel, s = p.call!.state, address = N(uaddr), cmd = N(op) & 0x7f, realtime = N(op) & 256;
  if (address & 3) fail(E.INVAL);
  const word = (at: number): number => p.view.getInt32(at, true);
  switch (cmd) {
    case 0: case 9: { // WAIT, WAIT_BITSET
      if (!s.waiter) {
        const bitset = cmd === 9 ? Number(BigInt.asIntN(32, val3)) : -1;
        if (!bitset) fail(E.INVAL);
        // Changed already: given back, not thrown (a lock taken and let go meanwhile, as often as not).
        if (word(address) !== Number(BigInt.asIntN(32, val))) return -E.AGAIN;
        const w = s.waiter = {task: p.task, bitset, woken: false, key: p.futexKey(address)};
        k.futexQueue(w.key).add(w);
        s.cancel = () => { k.futexes.get(w.key[0])?.get(w.key[1])?.delete(w); };
        if (N(timeout)) {
          const t = readTime(p, N(timeout));
          // WAIT: an interval; WAIT_BITSET: a time on its clock.
          const left = cmd === 0 ? t : t - (realtime ? wall() : monotonic());
          s.deadline = steady() + Math.max(0, ms(left));
          s.timed = true;
        }
      }
      if (s.waiter?.woken) return 0;
      if (s.deadline !== undefined && steady() >= s.deadline) { s.cancel?.(); fail(E.TIMEDOUT); }
      throw new Wait();
    }
    case 1: return k.futexWake(p.futexKey(address), N(val), -1); // WAKE
    case 10: { // WAKE_BITSET
      const bitset = Number(BigInt.asIntN(32, val3));
      if (!bitset) fail(E.INVAL);
      return k.futexWake(p.futexKey(address), N(val), bitset);
    }
    case 3: case 4: { // REQUEUE, CMP_REQUEUE
      if (cmd === 4 && word(address) !== Number(BigInt.asIntN(32, val3))) fail(E.AGAIN);
      const woken = k.futexWake(p.futexKey(address), N(val), -1);
      return woken + k.futexRequeue(p.futexKey(address), p.futexKey(N(uaddr2)), Number(BigInt.asUintN(32, timeout)));
    }
    case 5: { // WAKE_OP
      const at2 = N(uaddr2), code = Number(BigInt.asUintN(32, val3));
      const opcode = (code >>> 28) & 7, cmp = (code >>> 24) & 15;
      let oparg = (code << 8) >> 20, cmparg = (code << 20) >> 20;
      if ((code >>> 28) & 8) oparg = 1 << (oparg & 31);
      const old = word(at2);
      const next = [oparg, old + oparg, old | oparg, old & ~oparg, old ^ oparg][opcode] ?? fail(E.NOSYS);
      p.view.setInt32(at2, next, true);
      let woken = k.futexWake(p.futexKey(address), N(val), -1);
      const hit = [old === cmparg, old !== cmparg, old < cmparg, old <= cmparg, old > cmparg, old >= cmparg][cmp];
      if (hit) woken += k.futexWake(p.futexKey(at2), Number(BigInt.asUintN(32, timeout)), -1);
      return woken;
    }
    default: return fail(E.NOSYS); // the priority-inheriting kinds
  }
}

/** The process `pid` names for a call about it: the caller for 0. */
function proc(p: Proc, pid: number): Proc {
  if (pid === 0) return p;
  return p.kernel.procs.get(idBy(p, pid)) ?? fail(E.SRCH);
}

/** alarm and setitimer's ITIMER_REAL: SIGALRM at a time, again each interval. */
function setAlarm(p: Proc, ms: number, interval = 0): {left: number; interval: number} {
  const k = p.kernel, was = p.alarm;
  if (was) k.removeTimer(was.timer);
  p.alarm = null;
  const left = was ? Math.max(0, was.at - steady()) : 0;
  if (ms > 0) {
    const at = steady() + ms;
    const fire = () => {
      send(k, p, SIG.ALRM, {code: 0x80});
      if (p.alarm?.interval && p.state === 'live') setAlarm(p, p.alarm.interval, p.alarm.interval); else p.alarm = null;
    };
    p.alarm = {at, interval, timer: k.addTimer(at, fire)};
  }
  return {left, interval: was?.interval ?? 0};
}

const readTimeval = (p: Proc, at: number): number => Number(p.view.getBigInt64(at, true)) * 1e3 + Number(p.view.getBigInt64(at + 8, true)) / 1e3;
const writeTimeval = (p: Proc, at: number, ms: number): void => { p.view.setBigInt64(at, BigInt(Math.floor(ms / 1e3)), true); p.view.setBigInt64(at + 8, BigInt(Math.round((ms % 1e3) * 1e3)), true); };

/** CPUs a program is told it has: as many as the host gives this kernel's workers (one, where threads take turns here). */
const cpus = processors;

/**
 * `target`'s limit of `resource`: the old one written to `old`, a new one taken from `next` (each a struct rlimit, or
 * 0). A soft limit above its hard is EINVAL; a hard one raised, EPERM (the Prompt's root is root in its own user
 * namespace, without CAP_SYS_RESOURCE where that counts). The descriptor limit holds: a table gives none at or past it.
 */
/** The processes getpriority and setpriority speak of: `who` (0: the caller's own) of a process, a group or a user. */
function priorityOf(p: Proc, which: number, who: number): Proc[] {
  const live = p.kernel.live();
  const id = who ? idBy(p, who) || -1 : 0;
  const procs = which === 0 ? live.filter((q) => q.pid === (id || p.pid)) // PRIO_PROCESS
    : which === 1 ? live.filter((q) => q.pgid === (id || p.pgid)) // PRIO_PGRP
    : which === 2 ? (who === 0 ? live : []) // PRIO_USER: every process here is root's
    : fail(E.INVAL);
  if (!procs.length) fail(E.SRCH);
  return procs;
}

function rlimit(p: Proc, target: Proc, resource: bigint, next: bigint, old: bigint): number {
  const r = N(resource);
  if (r < 0 || r >= target.limits.length) fail(E.INVAL);
  const v = p.view, was = target.limits[r];
  // What is asked is read, looked at and set before the limits as they were are written where they are wanted, as
  // Linux does: the two may be one place (prlimit64(pid, r, &l, &l)) or lie over each other. (Before: the old limits
  // were written first, read back as the new ones and "set": the call said 0 and nothing changed.) Refused, nothing
  // is set and nothing written.
  if (N(next)) {
    const soft = v.getBigUint64(N(next), true), hard = v.getBigUint64(N(next) + 8, true);
    if (soft > hard) fail(E.INVAL);
    if (hard > was[1]) fail(E.PERM);
    target.limits[r] = [soft, hard];
    if (r === 7) target.fds.limit = Number(soft);
  }
  if (N(old)) { v.setBigUint64(N(old), was[0], true); v.setBigUint64(N(old) + 8, was[1], true); }
  return 0;
}

// ---- who a process is ----
//
// ---- who a thread is (cred.ts). An id a call is given is the caller's user namespace's: one that namespace has no
// number for is EINVAL; 0xffffffff, where a call allows it, leaves that id as it is.

const u32 = (x: bigint): number => Number(BigInt.asUintN(32, x));
/** The kernel's own id for `id` as `p` gives it (a group's with `group`); -1 for "as it is", where `keep` allows that. */
function wanted(p: Proc, id: bigint, group: boolean, keep = true): number {
  const n = u32(id);
  if (n === 0xffffffff) return keep ? -1 : fail(E.INVAL);
  const k = idOf(p.cred.ns, n, group);
  return k < 0 ? fail(E.INVAL) : k;
}
/** One id of three: r, e, s (real, effective, saved; -1 each: as it is). */
interface Three { r: number; e: number; s: number }
/**
 * `p` becomes the user (or, with `group`, the group) `next` says, as setuid, setreuid and setresuid differ only in
 * what they ask for: each id asked for is one it already is (its real, effective or saved one) or it has the
 * capability to be anyone (CAP_SETUID, CAP_SETGID, in its own namespace). The id files are asked by follows the
 * effective one. `saves`: setreuid's rule, its saved id made its new effective one where its real one was set, or
 * its effective one set to another than its real one was.
 */
function become(p: Proc, next: Three, group: boolean, saves = false): number {
  const c = p.cred, was: Three = group ? {r: c.gid, e: c.egid, s: c.sgid} : {r: c.uid, e: c.euid, s: c.suid};
  const any = capable(c, group ? CAP.SETGID : CAP.SETUID, c.ns), one = (id: number): boolean => id === was.r || id === was.e || id === was.s;
  for (const id of [next.r, next.e, next.s]) if (id >= 0 && !any && !one(id)) fail(E.PERM);
  const r = next.r >= 0 ? next.r : was.r, e = next.e >= 0 ? next.e : was.e;
  const s = next.s >= 0 ? next.s : saves && (next.r >= 0 || (next.e >= 0 && next.e !== was.r)) ? e : was.s;
  p.cred = group ? c.with({gid: r, egid: e, sgid: s, fsgid: e}) : asUser(c, {uid: r, euid: e, suid: s, fsuid: e});
  return 0;
}
/** setuid, setgid: all three where it may be anyone; else its effective one alone, to its real or saved one. */
function becomeOne(p: Proc, id: bigint, group: boolean): number {
  const c = p.cred, k = wanted(p, id, group, false);
  if (capable(c, group ? CAP.SETGID : CAP.SETUID, c.ns)) return become(p, {r: k, e: k, s: k}, group);
  return become(p, {r: -1, e: k, s: -1}, group);
}
/** setfsuid, setfsgid: the id files are asked by, set where it is one of the caller's or it may be anyone; what it was, either way. */
function becomeForFiles(p: Proc, id: bigint, group: boolean): number {
  const c = p.cred, was = group ? c.fsgid : c.fsuid, k = idOf(c.ns, u32(id), group);
  const mine = group ? [c.gid, c.egid, c.sgid, c.fsgid] : [c.uid, c.euid, c.suid, c.fsuid];
  if (k >= 0 && k !== was && (mine.includes(k) || capable(c, group ? CAP.SETGID : CAP.SETUID, c.ns))) {
    p.cred = group ? c.with({fsgid: k}) : asUser(c, {uid: c.uid, euid: c.euid, suid: c.suid, fsuid: k});
  }
  return shownIn(c.ns, was, group);
}

/** capget and capset's header (version, pid): the version known (v3), or EINVAL with the one it should have been. */
function capHeader(p: Proc, header: bigint): {target: Proc; words: number} {
  const v = p.view, at = N(header), version = v.getUint32(at, true);
  if (version !== 0x20080522 && version !== 0x20071026 && version !== 0x19980330) { v.setUint32(at, 0x20080522, true); fail(E.INVAL); }
  const pid = v.getInt32(at + 4, true);
  const target = (pid === 0 ? p : p.kernel.procs.get(idBy(p, pid))) ?? fail(E.SRCH);
  if (target.state !== 'live') fail(E.SRCH);
  return {target, words: version === 0x19980330 ? 1 : 2};
}

/** prctl's options a program asks of itself, as Linux answers them (an option it does not know: EINVAL). */
function prctl(p: Proc, option: number, arg2: bigint, arg3: bigint, arg4: bigint, arg5: bigint): number {
  const v = p.view, a = N(arg2);
  switch (option) {
    case 1: if (a < 0 || a > 64) fail(E.INVAL); p.deathSignal = a; return 0; // PR_SET_PDEATHSIG
    case 2: v.setInt32(a, p.deathSignal ?? 0, true); return 0; // PR_GET_PDEATHSIG
    case 3: return p.dumpable ? 1 : 0; // PR_GET_DUMPABLE
    case 4: if (a !== 0 && a !== 1) fail(E.INVAL); p.dumpable = a === 1; return 0; // PR_SET_DUMPABLE
    case 7: return p.cred.keep ? 1 : 0; // PR_GET_KEEPCAPS
    case 8: if (a !== 0 && a !== 1) fail(E.INVAL); p.cred = p.cred.with({keep: a === 1}); return 0; // PR_SET_KEEPCAPS
    case 15: { // PR_SET_NAME: its name, as /proc says it (15 bytes at most)
      const b = p.bytes, end = b.subarray(a, a + 16).indexOf(0);
      p.comm = utf8(b.subarray(a, a + (end < 0 ? 15 : Math.min(end, 15))));
      return 0;
    }
    case 16: { // PR_GET_NAME
      const name = new TextEncoder().encode(p.comm ?? (p.argv?.[0] ?? '').split('/').at(-1) ?? '').subarray(0, 15);
      p.bytes.fill(0, a, a + 16);
      p.bytes.set(name, a);
      return 0;
    }
    case 21: return p.task?.strict ? 1 : p.task?.filters ? 2 : 0; // PR_GET_SECCOMP (a process with no thread yet has none)
    case 22: return a === 1 ? seccomp(p, 0, 0, 0) : a === 2 ? seccomp(p, 1, 0, N(arg3)) : fail(E.INVAL); // PR_SET_SECCOMP
    case 23: if (a < 0 || a > CAP_LAST) fail(E.INVAL); return p.cred.bounding >> BigInt(a) & 1n ? 1 : 0; // PR_CAPBSET_READ
    case 24: // PR_CAPBSET_DROP: by one that may change what it can come to have (CAP_SETPCAP)
      if (!capable(p.cred, CAP.SETPCAP, p.cred.ns)) fail(E.PERM);
      if (a < 0 || a > CAP_LAST) fail(E.INVAL);
      p.cred = p.cred.with({bounding: p.cred.bounding & ~(1n << BigInt(a))});
      return 0;
    case 27: return 0; // PR_GET_SECUREBITS
    case 28: return a === 0 ? 0 : fail(E.INVAL); // PR_SET_SECUREBITS: no nonzero mode implemented
    case 29: return 0; // PR_SET_TIMERSLACK
    case 30: return 50000; // PR_GET_TIMERSLACK: Linux's default, 50 µs
    case 35: return fail(E.PERM); // PR_SET_MM: wants CAP_SYS_RESOURCE where the namespace has it not
    case 36: p.subreaper = a !== 0; return 0; // PR_SET_CHILD_SUBREAPER
    case 37: v.setInt32(a, p.subreaper ? 1 : 0, true); return 0; // PR_GET_CHILD_SUBREAPER
    case 38: if (a !== 1 || N(arg3) || N(arg4) || N(arg5)) fail(E.INVAL); p.noNewPrivs = true; return 0; // PR_SET_NO_NEW_PRIVS
    case 39: return p.noNewPrivs ? 1 : 0; // PR_GET_NO_NEW_PRIVS
    case 41: case 42: return 0; // PR_SET_THP_DISABLE, PR_GET_THP_DISABLE
    case 47: { // PR_CAP_AMBIENT: a capability must remain permitted and inheritable.
      if (arg4 || arg5) fail(E.INVAL);
      const c = p.cred;
      if (a === 4) { if (arg3) fail(E.INVAL); p.cred = c.with({ambient: 0n}); return 0; }
      const cap = N(arg3);
      if (cap < 0 || cap > CAP_LAST || a < 1 || a > 3) fail(E.INVAL);
      const bit = 1n << BigInt(cap);
      if (a === 1) return c.ambient & bit ? 1 : 0;
      if (a === 2) { if (!(c.permitted & c.inheritable & bit)) fail(E.PERM); p.cred = c.with({ambient: c.ambient | bit}); }
      else p.cred = c.with({ambient: c.ambient & ~bit});
      return 0;
    }
    case 0x59616d61: return 0; // PR_SET_PTRACER
    case 0x53564d41: return 0; // PR_SET_VMA: a name for a mapping
  }
  return fail(E.INVAL);
}

/** A host or domain name of at most 64 bytes, as sethostname takes it. */
function names(p: Proc, address: bigint, length: bigint): string {
  const n = N(length);
  if (n < 0 || n > 64) fail(E.INVAL);
  return utf8(p.bytes.subarray(N(address), N(address) + n));
}

export const PROC_CALLS: Calls = {
  9(addr, len, _prot, flags, fd, off) {
    const length = N(len), fixed = N(flags) & 0x10, anonymous = N(flags) & 0x20, shared = (N(flags) & 3) !== 2;
    if (length <= 0) fail(E.INVAL);
    const d = anonymous ? null : this.fds.get(N(fd));
    const node = d?.node instanceof File ? d.node : null;
    if (!anonymous && (!d || d.kind !== 'file' || !node)) fail(E.BADF);
    const start = fixed ? N(addr) : this.reserve(length);
    if (fixed) {
      this.unmapShared(start, length);
      if (start >= this.mapBase) this.cover(start + length);
      zero(this.memory!, start, start + length);
      if (start < this.mapBase) this.fixed.push({start, length});
    }
    if (node) {
      this.bytes.set(node.read(N(off), N(off) + length), start);
      if (shared) this.mapShared(node, start, length, N(off));
    } else if (shared) {
      // Shared anonymous memory (what fork leaves shared): a file of its own, in no directory.
      const node = new File();
      node.truncate(length);
      this.mapShared(node, start, length, 0);
    }
    return start;
  },
  // mprotect is not enforced. A program's read-only bytes made writable may change, so its memory is not given to the
  // next run of it as holding them (Kernel.takeMemory).
  10(addr, len, prot) {
    const a = N(addr), b = a + N(len);
    if (N(prot) & 2 && this.image?.facts.readOnly?.some(([x, y]) => a < y && x < b)) this.memory!.imageOf = null;
    return 0;
  },
  11(addr, len) { this.unmapShared(N(addr), N(len)); this.release(N(addr), N(len)); return 0; },
  12() { return this.mapBase; }, // brk never grows; libc then uses mmap
  24() { return 0; }, // sched_yield: the kernel gives another its turn first (process.ts YIELDS)
  25(old, oldLength, newLength) {
    const start = this.reserve(N(newLength));
    move(this.memory!, start, N(old), Math.min(N(oldLength), N(newLength)));
    // A shared file mapping moves with what it maps, and grows into more of the file.
    const moved = this.maps.filter((m) => m.start === N(old));
    this.unmapShared(N(old), N(oldLength));
    for (const m of moved) {
      if (N(newLength) > N(oldLength)) this.bytes.set(m.node.read(m.off + N(oldLength), m.off + N(newLength)), start + N(oldLength));
      this.mapShared(m.node, start, N(newLength), m.off);
    }
    this.release(N(old), N(oldLength));
    return start;
  },
  26(addr, len) { for (const m of this.sharedIn(N(addr), N(len))) m.node.settle(m.off, m.off + m.length, m); return 0; }, // msync
  27() { return 0; },
  28(addr, len, advice) {
    // madvise: MADV_DONTNEED and MADV_FREE give back pages. Private anonymous ones read as zero after; a shared file
    // mapping's read as the file is (what was written through it is the file's already).
    const a = N(addr), b = a + N(len);
    if (N(advice) !== 4 && N(advice) !== 8) return 0;
    const maps = this.sharedIn(a, N(len));
    for (const m of maps) m.node.settle(m.off, m.off + m.length, m);
    zero(this.memory!, a, b);
    for (const m of maps) {
      const from = Math.max(a, m.start), to = Math.min(b, m.start + m.length);
      this.bytes.set(m.node.read(m.off + from - m.start, m.off + to - m.start), from);
    }
    return 0;
  },
  35(req, rem) { return sleepUntil(this, steady() + ms(readTime(this, N(req))), N(rem)); }, // nanosleep
  36(which, value) { // getitimer
    if (N(which) !== 0) { this.bytes.fill(0, N(value), N(value) + 32); return 0; }
    writeTimeval(this, N(value), this.alarm?.interval ?? 0);
    writeTimeval(this, N(value) + 16, this.alarm ? Math.max(0, this.alarm.at - steady()) : 0);
    return 0;
  },
  37(seconds) { return Math.ceil(setAlarm(this, N(seconds) * 1000).left / 1000); }, // alarm
  38(which, value, old) { // setitimer: ITIMER_REAL rings; the CPU-time ones are kept and never ring
    if (N(which) !== 0) { if (N(old)) this.bytes.fill(0, N(old), N(old) + 32); return 0; }
    const interval = N(value) ? readTimeval(this, N(value)) : 0, first = N(value) ? readTimeval(this, N(value) + 16) : 0;
    const was = setAlarm(this, first, interval);
    if (N(old)) { writeTimeval(this, N(old), was.interval); writeTimeval(this, N(old) + 16, was.left); }
    return 0;
  },
  39() { return nr(this, this.pid); },
  56(flags, stack, ptid, ctid, tls) { return clone(this, N(flags), BigInt.asUintN(64, stack), N(ptid), N(ctid), tls); },
  57() { return clone(this, SIG.CHLD, 0n, 0, 0, 0n); }, // fork
  58() { return clone(this, CLONE.VM | CLONE.VFORK | SIG.CHLD, 0n, 0, 0, 0n); }, // vfork
  59(name, argv, env) { return execve(this, name, argv, env); },
  60(code) { this.kernel.exitThread(this.task, exitStatus(N(code))); throw new Exit(exitStatus(N(code))); },
  61(pid, status, options, rusage) { return wait4(this, pid, status, options, rusage); },
  63(buf) {
    const fields = ['Linux', this.ns.uts.hostname, '6.1.0', '#1 muk', 'x86_64', this.ns.uts.domainname];
    this.bytes.fill(0, N(buf), N(buf) + 390);
    fields.forEach((s, k) => this.bytes.set(enc.encode(s), N(buf) + k * 65));
    return 0;
  },
  96(tv, tz) { return answerTime(this.memory!, CLOCK, 96n, tv, tz) ?? fail(E.FAULT); }, // gettimeofday
  97(resource, limit) { return rlimit(this, this, resource, 0n, limit); }, // getrlimit
  98(who, usage) { // getrusage: itself (its threads, ended and running), the children it waited for, or this thread
    const w = Number(BigInt.asIntN(32, who));
    this.kernel.lap(this.task, steady());
    const c = w === 0 ? cpuOf(this) : w === -1 ? this.waited : w === 1 ? this.task.cpu : fail(E.INVAL);
    putUsage(this, N(usage), c, w === -1 ? 0 : Math.ceil((this.memory?.buffer.byteLength ?? 0) / 1024));
    return 0;
  },
  99(info) { // sysinfo: the machine's memory (machine.ts), what the kernel's processes hold of it, how many there are
    const at = N(info), v = this.view, total = BigInt(this.kernel.machine.memory), used = BigInt(this.kernel.memoryBytes());
    this.bytes.fill(0, at, at + 112);
    v.setBigInt64(at, BigInt(Math.floor(steady() / 1000)), true); // uptime
    v.setBigUint64(at + 32, total, true); // totalram
    v.setBigUint64(at + 40, total > used ? total - used : 0n, true); // freeram
    v.setUint16(at + 80, this.kernel.live().length, true); // procs
    v.setUint32(at + 104, 1, true); // mem_unit
    return 0;
  },
  100(buf) { // times: its time on the processor and its waited-for children's, in clock ticks (100 a second)
    if (N(buf)) {
      this.kernel.lap(this.task, steady());
      const c = cpuOf(this), w = this.waited, at = N(buf);
      [c.user, c.sys, w.user, w.sys].forEach((ms, k) => this.view.setBigInt64(at + 8 * k, BigInt(Math.floor(ms / 10)), true));
    }
    return Number(monotonic() / 10000000n);
  },
  102() { const c = this.cred; return shownIn(c.ns, c.uid); }, // getuid
  104() { const c = this.cred; return shownIn(c.ns, c.gid, true); }, // getgid
  107() { const c = this.cred; return shownIn(c.ns, c.euid); }, // geteuid
  108() { const c = this.cred; return shownIn(c.ns, c.egid, true); }, // getegid
  105(uid) { return becomeOne(this, uid, false); }, // setuid
  106(gid) { return becomeOne(this, gid, true); }, // setgid
  113(r, e) { return become(this, {r: wanted(this, r, false), e: wanted(this, e, false), s: -1}, false, true); }, // setreuid
  114(r, e) { return become(this, {r: wanted(this, r, true), e: wanted(this, e, true), s: -1}, true, true); }, // setregid
  109(pid, pgid) { // setpgid: itself or a child of its own, into a group of its session
    const target = proc(this, N(pid));
    if (target !== this && target.ppid !== this.pid) fail(E.SRCH);
    if (target.sid !== this.sid || target.pid === target.sid) fail(E.PERM);
    if (N(pgid) < 0) fail(E.INVAL);
    const group = N(pgid) ? idBy(this, N(pgid)) || fail(E.PERM) : target.pid;
    if (group !== target.pid && !this.kernel.hasGroup(group, this.sid)) fail(E.PERM);
    target.pgid = group;
    return 0;
  },
  110() { return nr(this, this.ppid); },
  111() { return nr(this, this.pgid); },
  112() { // setsid
    if (this.pgid === this.pid || [...this.kernel.procs.values()].some((q) => q.pgid === this.pid)) fail(E.PERM);
    this.sid = this.pgid = this.pid;
    return nr(this, this.pid);
  },
  115(size, list) { // getgroups: its other groups, as its namespace numbers them
    const c = this.cred, n = N(size);
    if (n < 0) fail(E.INVAL);
    if (n === 0) return c.groups.length;
    if (n < c.groups.length) fail(E.INVAL);
    c.groups.forEach((g, k) => this.view.setUint32(N(list) + 4 * k, shownIn(c.ns, g, true), true));
    return c.groups.length;
  },
  116(size, list) { // setgroups: by one that may be any group, in a namespace whose groups are mapped and that has not denied it
    const c = this.cred, n = N(size);
    if (!capable(c, CAP.SETGID, c.ns) || !c.ns.setgroups || (c.ns.parent && !c.ns.gids)) fail(E.PERM);
    if (n < 0 || n > 65536) fail(E.INVAL);
    const groups: number[] = [];
    for (let k = 0; k < n; k++) { const g = idOf(c.ns, this.view.getUint32(N(list) + 4 * k, true), true); groups.push(g < 0 ? fail(E.INVAL) : g); }
    this.cred = c.with({groups});
    return 0;
  },
  117(r, e, s) { return become(this, {r: wanted(this, r, false), e: wanted(this, e, false), s: wanted(this, s, false)}, false); }, // setresuid
  119(r, e, s) { return become(this, {r: wanted(this, r, true), e: wanted(this, e, true), s: wanted(this, s, true)}, true); }, // setresgid
  122(id) { return becomeForFiles(this, id, false); }, 123(id) { return becomeForFiles(this, id, true); }, // setfsuid, setfsgid
  125(header, data) { // capget
    const {target, words} = capHeader(this, header);
    if (!N(data)) return 0;
    const v = this.view, c = target.cred;
    for (let k = 0; k < words; k++) {
      const word = (x: bigint): number => Number((x >> BigInt(32 * k)) & 0xffffffffn);
      v.setUint32(N(data) + 12 * k, word(c.effective), true);
      v.setUint32(N(data) + 12 * k + 4, word(c.permitted), true);
      v.setUint32(N(data) + 12 * k + 8, word(c.inheritable), true);
    }
    return 0;
  },
  126(header, data) { // capset: its own, none it does not have
    const {target, words} = capHeader(this, header);
    if (target !== this) fail(E.PERM);
    const v = this.view, read = (off: number): bigint => { let x = 0n; for (let k = 0; k < words; k++) x |= BigInt(v.getUint32(N(data) + 12 * k + off, true)) << BigInt(32 * k); return x; };
    const effective = read(0), permitted = read(4), inheritable = read(8);
    // As Linux takes them: none permitted that was not; none in effect that is not permitted; none to be inherited
    // past what it could inherit or is permitted (or, by one that may set them, what its bounding set allows).
    const c = this.cred, most = c.inheritable | (capable(c, CAP.SETPCAP, c.ns) ? c.bounding | c.permitted : c.permitted);
    if (permitted & ~c.permitted || effective & ~permitted || inheritable & ~most || inheritable & ~(c.inheritable | c.bounding)) fail(E.PERM);
    this.cred = c.with({effective, permitted, inheritable, ambient: c.ambient & permitted & inheritable});
    return 0;
  },
  118(r, e, s) { const c = this.cred; [c.uid, c.euid, c.suid].forEach((id, k) => this.view.setUint32(N([r, e, s][k]), shownIn(c.ns, id), true)); return 0; }, // getresuid
  120(r, e, s) { const c = this.cred; [c.gid, c.egid, c.sgid].forEach((id, k) => this.view.setUint32(N([r, e, s][k]), shownIn(c.ns, id, true), true)); return 0; }, // getresgid
  121(pid) { return nr(this, proc(this, N(pid)).pgid); },
  124(pid) { return nr(this, proc(this, N(pid)).sid); },
  157(option, arg2, arg3, arg4, arg5) { return prctl(this, N(option), arg2, arg3, arg4, arg5); },
  158(code, addr) {
    if (N(code) === 0x1002) { this.task.setReg(16, addr); return 0; } // ARCH_SET_FS
    if (N(code) === 0x1003) { this.view.setBigUint64(N(addr), BigInt.asUintN(64, this.task.reg(16)), true); return 0; }
    return fail(E.INVAL);
  },
  // getpriority, setpriority: of a process, a group or a user's (all are root's here), as Linux answers them: the raw
  // call gives 20 less the niceness (so never below 1), the C library turns it back; a nice past -20..19 is taken to it.
  140(which, who) {
    const procs = priorityOf(this, N(which), N(who));
    return 20 - Math.min(...procs.map((q) => q.nice));
  },
  141(which, who, prio) {
    const nice = Math.max(-20, Math.min(19, Number(BigInt.asIntN(32, prio))));
    for (const q of priorityOf(this, N(which), N(who))) q.nice = nice;
    return 0;
  },
  160(resource, limit) { return rlimit(this, this, resource, limit, 0n); }, // setrlimit
  186() { return nr(this, this.task.tid); },
  201(t) { return answerTime(this.memory!, CLOCK, 201n, t, 0n) ?? fail(E.FAULT); }, // time
  202(uaddr, op, val, timeout, uaddr2, val3) { return futex(this, uaddr, op, val, timeout, uaddr2, val3); },
  203() { return 0; }, // sched_setaffinity
  204(_pid, size, mask) { // sched_getaffinity
    const n = cpus(), bytes = 8;
    if (N(size) < bytes) fail(E.INVAL);
    this.bytes.fill(0, N(mask), N(mask) + bytes);
    this.view.setBigUint64(N(mask), (1n << BigInt(n)) - 1n, true);
    return bytes;
  },
  218(tidptr) { this.task.clearTid = N(tidptr); return nr(this, this.task.tid); }, // set_tid_address
  228(clock, ts) { // clock_gettime: a CPU-time clock is the kernel's (clock.ts cpuClock)
    const id = Number(BigInt.asIntN(32, clock)), at = CLOCK.read(id);
    if (at === null) this.kernel.lap(this.task, steady());
    const ns = at === null ? cpuClock(this, id) : at;
    if (ns === undefined) return fail(E.INVAL);
    writeTime(this, N(ts), ns);
    return 0;
  },
  229(clock, ts) { // clock_getres
    const id = Number(BigInt.asIntN(32, clock)), at = CLOCK.read(id);
    if ((at === null ? cpuClock(this, id) : at) === undefined) fail(E.INVAL);
    if (N(ts)) writeTime(this, N(ts), 1n);
    return 0;
  },
  230(clock, flags, req, rem) { // clock_nanosleep: by an interval, or until a time on that clock (TIMER_ABSTIME)
    const t = readTime(this, N(req));
    if (!(N(flags) & 1)) return sleepUntil(this, steady() + ms(t), N(rem));
    const now = N(clock) === 0 ? wall() : monotonic();
    return sleepUntil(this, steady() + ms(t > now ? t - now : 0n));
  },
  231(code) { this.kernel.exitProcess(this, exitStatus(N(code))); throw new Exit(exitStatus(N(code))); },
  247(idtype, id, infop, options) { return waitid(this, idtype, id, infop, options); },
  273(head, len) { if (N(len) !== 24) fail(E.INVAL); this.task.robust = N(head); return 0; }, // set_robust_list
  274(pid, head, len) { // get_robust_list
    const t = (N(pid) ? this.kernel.tasks.get(idBy(this, N(pid))) : this.task) ?? fail(E.SRCH);
    this.view.setBigUint64(N(head), BigInt(t.robust), true);
    this.view.setBigUint64(N(len), 24n, true);
    return 0;
  },
  302(pid, resource, next, old) { // prlimit64
    const target = (N(pid) === 0 ? this : this.kernel.procs.get(idBy(this, N(pid)))) ?? fail(E.SRCH);
    if (target.state !== 'live') fail(E.SRCH);
    return rlimit(this, target, resource, next, old);
  },
  318(buf, len) { // getrandom
    // As much as is asked for and is the guest's memory: of a span that runs off its end, the part inside (Linux's
    // short count); one that begins outside it is EFAULT.
    const at = N(buf), asked = N(len) < 0 ? 65536 : Math.min(N(len), 65536);
    if (!asked) return 0;
    if (!(at >= 0 && at < this.bytes.length)) fail(E.FAULT);
    const n = Math.min(asked, this.bytes.length - at);
    // (Copied in: a browser draws none into a shared memory's view.)
    this.bytes.set(randomBytes(n), at);
    return n;
  },
  // sethostname, setdomainname: its UTS namespace's, by one that may administer that
  170(name, len) { if (!capable(this.cred, CAP.SYS_ADMIN, this.ns.uts.owner)) fail(E.PERM); this.ns.uts.hostname = names(this, name, len); return 0; },
  171(name, len) { if (!capable(this.cred, CAP.SYS_ADMIN, this.ns.uts.owner)) fail(E.PERM); this.ns.uts.domainname = names(this, name, len); return 0; },
  135() { return 0; }, // personality: Linux's own (PER_LINUX); asked, or set, it stays that
  309(cpu, node) { // getcpu: one machine of one node, as it is to its guests
    if (N(cpu)) this.view.setUint32(N(cpu), 0, true);
    if (N(node)) this.view.setUint32(N(node), 0, true);
    return 0;
  },
  324(cmd) { return N(cmd) === 0 ? 0 : fail(E.INVAL); }, // membarrier: asked, it offers none (a program then fences itself)
  // What a container's root without its capabilities is refused: the machine's mounts, clock, log and modules are
  // the host's, not a Prompt's.
  169() { return fail(E.PERM); }, 227() { return fail(E.PERM); }, 103() { return fail(E.PERM); }, // reboot, clock_settime, syslog
  272(flags) { return unshare(this, N(flags)); },
  308(fd, kind) { return setns(this, Number(BigInt.asIntN(32, fd)), N(kind)); },
  167() { return fail(E.PERM); }, 168() { return fail(E.PERM); }, 175() { return fail(E.PERM); }, 176() { return fail(E.PERM); }, 313() { return fail(E.PERM); }, // swapon, swapoff, modules
  101() { return fail(E.PERM); }, // ptrace: no process here can be traced
  334() { return fail(E.NOSYS); }, // rseq
  317(op, flags, uargs) { return seccomp(this, N(op), N(flags), N(uargs)); },
  435(args, size) { return clone3(this, N(args), N(size)); },
};
