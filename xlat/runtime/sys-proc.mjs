// Process, thread, memory, time and identity system calls. Handlers run
// with `this` bound to the calling Process, `this.task` the calling
// thread and `this.call` the call ({nr, args, next, state}: state lasts
// while the call waits and is made again).

import {E, File, FsError} from './fs.mjs';
import {Exec, Exit, Wait} from './process.mjs';
import {CLD, SIG, send, writeInfo} from './signal.mjs';

const N = (x) => Number(BigInt.asIntN(64, x));
const fail = (errno) => { throw new FsError(errno); };
const enc = new TextEncoder();

const CLONE = {VM: 0x100, FS: 0x200, FILES: 0x400, SIGHAND: 0x800, PIDFD: 0x1000, VFORK: 0x4000, PARENT: 0x8000,
  THREAD: 0x10000, SETTLS: 0x80000, PARENT_SETTID: 0x100000, CHILD_CLEARTID: 0x200000, CHILD_SETTID: 0x1000000};
const W = {NOHANG: 1, UNTRACED: 2, EXITED: 4, CONTINUED: 8, NOWAIT: 0x01000000};

function exitStatus(code) { return (code & 0xff) << 8; }

function writeTime(p, address, ns) {
  p.view.setBigInt64(address, ns / 1000000000n, true);
  p.view.setBigInt64(address + 8, ns % 1000000000n, true);
}

const wall = () => BigInt(Date.now()) * 1000000n;
const monotonic = () => BigInt(Math.round(performance.now() * 1e6));
/** A timespec in guest memory, in nanoseconds. */
const readTime = (p, at) => p.view.getBigInt64(at, true) * 1000000000n + p.view.getBigInt64(at + 8, true);
const ms = (ns) => Number(ns) / 1e6;

/**
 * Sleep until `deadline` (performance.now() ms) for real: the call waits
 * and is made again once the time has come, so the host waits on a timer
 * instead of running anything. A handler that interrupts it has `rem`
 * (when given) say how long was left.
 */
function sleepUntil(p, deadline, rem = 0) {
  const s = p.call.state;
  s.deadline ??= deadline;
  if (performance.now() >= s.deadline) return 0;
  if (rem) s.interrupted = () => writeTime(p, rem, BigInt(Math.max(0, Math.round((s.deadline - performance.now()) * 1e6))));
  throw new Wait();
}

/** The child `p` waits for, as wait4 and waitid choose: {child, status, code, kind} or null. */
function waitable(p, pick, options) {
  const children = [...p.children].filter(pick);
  if (!children.length) fail(E.CHILD);
  for (const c of children) {
    if (c.state === 'zombie' && options & W.EXITED) {
      const sig = c.exitStatus & 0x7f;
      return {child: c, status: c.exitStatus, code: sig ? CLD.KILLED : CLD.EXITED, value: sig ? sig : c.exitStatus >> 8, kind: 'exit'};
    }
    if (c.state === 'live' && c.report && !c.report.seen) {
      if (c.report.kind === 'stopped' && options & W.UNTRACED) return {child: c, status: 0x7f | (c.report.sig << 8), code: CLD.STOPPED, value: c.report.sig, kind: 'report'};
      if (c.report.kind === 'continued' && options & W.CONTINUED) return {child: c, status: 0xffff, code: CLD.CONTINUED, value: SIG.CONT, kind: 'report'};
    }
  }
  return null;
}

/** What was found is taken: a zombie is gone, a stop or continue said once (unless WNOWAIT). */
function taken(p, found, options) {
  if (options & W.NOWAIT) return;
  if (found.kind === 'exit') { p.children.delete(found.child); p.kernel.procs.delete(found.child.pid); }
  else found.child.report.seen = true;
}

function wait4(p, pid, statusAddress, options, rusage) {
  const want = N(pid), o = N(options) | W.EXITED;
  const pick = want > 0 ? (c) => c.pid === want : want === -1 ? () => true : want === 0 ? (c) => c.pgid === p.pgid : (c) => c.pgid === -want;
  const found = waitable(p, pick, o);
  if (!found) {
    if (o & W.NOHANG) return 0;
    throw new Wait();
  }
  taken(p, found, o);
  if (N(statusAddress)) p.view.setInt32(N(statusAddress), found.status, true);
  if (N(rusage)) p.bytes.fill(0, N(rusage), N(rusage) + 144);
  return found.child.pid;
}

function waitid(p, idtype, id, infop, options) {
  const o = N(options), which = N(idtype), n = N(id);
  if (!(o & (W.EXITED | W.UNTRACED | W.CONTINUED))) fail(E.INVAL);
  const pick = which === 0 ? () => true : which === 1 ? (c) => c.pid === n : which === 2 ? (c) => c.pgid === (n || p.pgid) : null;
  if (!pick) fail(E.INVAL);
  const found = waitable(p, pick, o);
  if (!found) {
    if (o & W.NOHANG) { if (N(infop)) p.bytes.fill(0, N(infop), N(infop) + 128); return 0; }
    throw new Wait();
  }
  taken(p, found, o);
  if (N(infop)) writeInfo(p, N(infop), {signo: SIG.CHLD, code: found.code, pid: found.child.pid, uid: 0, status: found.value});
  return 0;
}

function execve(p, nameAddress, argvAddress, envAddress) {
  const name = p.cstring(N(nameAddress));
  const argv = p.strings(N(argvAddress)), env = p.strings(N(envAddress));
  p.execve(name, argv, env); // throws FsError before replacing anything
  throw new Exec();
}

/** clone(2), fork(2) and vfork(2): a thread of this process, or a new process. */
function clone(p, flags, stack, ptid, ctid, tls) {
  const t = p.task, s = p.call.state;
  const writeTid = (memory, at, tid) => { if (at) new DataView(memory.buffer).setInt32(at, tid, true); };
  if (flags & CLONE.THREAD) {
    if (!(flags & CLONE.VM) || !(flags & CLONE.SIGHAND)) fail(E.INVAL);
    const nt = p.newThread(t.resumeAt, stack, flags & CLONE.SETTLS ? tls : null);
    if (flags & CLONE.PARENT_SETTID) writeTid(p.memory, ptid, nt.tid);
    if (flags & CLONE.CHILD_SETTID) writeTid(p.memory, ctid, nt.tid);
    if (flags & CLONE.CHILD_CLEARTID) nt.clearTid = ctid;
    p.kernel.go(nt);
    return nt.tid;
  }
  if (!s.child) {
    if (flags & CLONE.PIDFD) fail(E.INVAL);
    const child = p.forkProcess(t.resumeAt, {stack, vm: !!(flags & CLONE.VM), files: !!(flags & CLONE.FILES), exitSignal: flags & 0xff,
      tls: flags & CLONE.SETTLS ? tls : null, clearTid: flags & CLONE.CHILD_CLEARTID ? ctid : 0, parent: !!(flags & CLONE.PARENT)});
    if (flags & CLONE.PARENT_SETTID) writeTid(p.memory, ptid, child.pid);
    if (flags & CLONE.CHILD_SETTID) writeTid(child.memory, ctid, child.pid);
    s.child = child;
    // A vfork parent waits until its child has exec'd or ended: they share one memory until then.
    if (flags & CLONE.VFORK) s.vfork = child.vfork = {released: false};
  }
  if (s.vfork && !s.vfork.released) throw new Wait();
  return s.child.pid;
}

/** futex(2): wait while a word holds a value, and wake those waiting on it. */
function futex(p, uaddr, op, val, timeout, uaddr2, val3) {
  const k = p.kernel, s = p.call.state, address = N(uaddr), cmd = N(op) & 0x7f, realtime = N(op) & 256;
  if (address & 3) fail(E.INVAL);
  const word = (at) => p.view.getInt32(at, true);
  switch (cmd) {
    case 0: case 9: { // WAIT, WAIT_BITSET
      if (!s.waiter) {
        const bitset = cmd === 9 ? Number(BigInt.asIntN(32, val3)) : -1;
        if (!bitset) fail(E.INVAL);
        if (word(address) !== Number(BigInt.asIntN(32, val))) fail(E.AGAIN);
        const w = s.waiter = {task: p.task, bitset, woken: false, key: p.futexKey(address)};
        k.futexQueue(w.key).add(w);
        s.cancel = () => { k.futexes.get(w.key[0])?.get(w.key[1])?.delete(w); };
        if (N(timeout)) {
          const t = readTime(p, N(timeout));
          // WAIT: an interval; WAIT_BITSET: a time on its clock.
          const left = cmd === 0 ? t : t - (realtime ? wall() : monotonic());
          s.deadline = performance.now() + Math.max(0, ms(left));
          s.timed = true;
        }
      }
      if (s.waiter.woken) return 0;
      if (s.deadline !== undefined && performance.now() >= s.deadline) { s.cancel(); fail(E.TIMEDOUT); }
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
      const next = [oparg, old + oparg, old | oparg, old & ~oparg, old ^ oparg][opcode];
      if (next === undefined) fail(E.NOSYS);
      p.view.setInt32(at2, next, true);
      let woken = k.futexWake(p.futexKey(address), N(val), -1);
      const hit = [old === cmparg, old !== cmparg, old < cmparg, old <= cmparg, old > cmparg, old >= cmparg][cmp];
      if (hit) woken += k.futexWake(p.futexKey(at2), Number(BigInt.asUintN(32, timeout)), -1);
      return woken;
    }
    default: fail(E.NOSYS); // the priority-inheriting kinds
  }
}

/** The process `pid` names for a call about it: the caller for 0. */
function proc(p, pid) {
  if (pid === 0) return p;
  const q = p.kernel.procs.get(pid);
  if (!q) fail(E.SRCH);
  return q;
}

/** alarm and setitimer's ITIMER_REAL: SIGALRM at a time, again each interval. */
function setAlarm(p, ms, interval = 0) {
  const k = p.kernel, was = p.alarm;
  if (was) k.removeTimer(was.timer);
  p.alarm = null;
  const left = was ? Math.max(0, was.at - performance.now()) : 0;
  if (ms > 0) {
    const at = performance.now() + ms;
    const fire = () => {
      send(k, p, SIG.ALRM, {code: 0x80});
      if (p.alarm?.interval && p.state === 'live') setAlarm(p, p.alarm.interval, p.alarm.interval); else p.alarm = null;
    };
    p.alarm = {at, interval, timer: k.addTimer(at, fire)};
  }
  return {left, interval: was?.interval ?? 0};
}

const readTimeval = (p, at) => Number(p.view.getBigInt64(at, true)) * 1e3 + Number(p.view.getBigInt64(at + 8, true)) / 1e3;
const writeTimeval = (p, at, ms) => { p.view.setBigInt64(at, BigInt(Math.floor(ms / 1e3)), true); p.view.setBigInt64(at + 8, BigInt(Math.round((ms % 1e3) * 1e3)), true); };

/** CPUs a program is told it has: as many as the host gives this kernel's workers (one, where threads take turns here). */
const cpus = () => Math.max(1, Math.min(64, globalThis.navigator?.hardwareConcurrency ?? 1));

export const PROC_CALLS = {
  9(addr, len, prot, flags, fd, off) {
    const length = N(len), fixed = N(flags) & 0x10, anonymous = N(flags) & 0x20, shared = (N(flags) & 3) !== 2;
    if (length <= 0) fail(E.INVAL);
    const d = anonymous ? null : this.fds.get(N(fd));
    if (!anonymous && (!d || d.kind !== 'file')) fail(E.BADF);
    const start = fixed ? N(addr) : this.reserve(length);
    if (fixed) {
      this.unmapShared(start, length);
      if (start >= this.mapBase) this.cover(start + length);
      this.bytes.fill(0, start, start + length);
      if (start < this.mapBase) this.fixed.push({start, length});
    }
    if (d) {
      this.bytes.set(d.node.read(N(off), N(off) + length), start);
      if (shared) this.mapShared(d.node, start, length, N(off));
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
    if (N(prot) & 2 && this.image?.facts.readOnly?.some(([x, y]) => a < y && x < b)) this.memory.imageOf = null;
    return 0;
  },
  11(addr, len) { this.unmapShared(N(addr), N(len)); this.release(N(addr), N(len)); return 0; },
  12() { return this.mapBase; }, // brk never grows; libc then uses mmap
  24() { return 0; }, // sched_yield: the kernel gives another its turn first (process.mjs YIELDS)
  25(old, oldLength, newLength, flags) {
    const start = this.reserve(N(newLength));
    this.bytes.copyWithin(start, N(old), N(old) + Math.min(N(oldLength), N(newLength)));
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
    this.bytes.fill(0, a, b);
    for (const m of maps) {
      const from = Math.max(a, m.start), to = Math.min(b, m.start + m.length);
      this.bytes.set(m.node.read(m.off + from - m.start, m.off + to - m.start), from);
    }
    return 0;
  },
  35(req, rem) { return sleepUntil(this, performance.now() + ms(readTime(this, N(req))), N(rem)); }, // nanosleep
  36(which, value) { // getitimer
    if (N(which) !== 0) { this.bytes.fill(0, N(value), N(value) + 32); return 0; }
    writeTimeval(this, N(value), this.alarm?.interval ?? 0);
    writeTimeval(this, N(value) + 16, this.alarm ? Math.max(0, this.alarm.at - performance.now()) : 0);
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
  39() { return this.pid; },
  56(flags, stack, ptid, ctid, tls) { return clone(this, N(flags), BigInt.asUintN(64, stack), N(ptid), N(ctid), tls); },
  57() { return clone(this, SIG.CHLD, 0n, 0, 0, 0n); }, // fork
  58() { return clone(this, CLONE.VM | CLONE.VFORK | SIG.CHLD, 0n, 0, 0, 0n); }, // vfork
  59(name, argv, env) { return execve(this, name, argv, env); },
  60(code) { this.kernel.exitThread(this.task, exitStatus(N(code))); throw new Exit(exitStatus(N(code))); },
  61(pid, status, options, rusage) { return wait4(this, pid, status, options, rusage); },
  63(buf) {
    const fields = ['Linux', 'length3', '6.1.0', '#1 xlat', 'x86_64', '(none)'];
    this.bytes.fill(0, N(buf), N(buf) + 390);
    fields.forEach((s, k) => this.bytes.set(enc.encode(s), N(buf) + k * 65));
    return 0;
  },
  96(tv) {
    const ns = wall();
    this.view.setBigInt64(N(tv), ns / 1000000000n, true);
    this.view.setBigInt64(N(tv) + 8, (ns % 1000000000n) / 1000n, true);
    return 0;
  },
  97(resource, limit) { this.view.setBigInt64(N(limit), -1n, true); this.view.setBigInt64(N(limit) + 8, -1n, true); return 0; },
  98(who, usage) { this.bytes.fill(0, N(usage), N(usage) + 144); return 0; },
  99(info) { // sysinfo: the machine's memory (machine.mjs), what the kernel's processes hold of it, how many there are
    const at = N(info), v = this.view, total = BigInt(this.kernel.machine.memory), used = BigInt(this.kernel.memoryBytes());
    this.bytes.fill(0, at, at + 112);
    v.setBigInt64(at, BigInt(Math.floor(performance.now() / 1000)), true); // uptime
    v.setBigUint64(at + 32, total, true); // totalram
    v.setBigUint64(at + 40, total > used ? total - used : 0n, true); // freeram
    v.setUint16(at + 80, this.kernel.live().length, true); // procs
    v.setUint32(at + 104, 1, true); // mem_unit
    return 0;
  },
  100(buf) { if (N(buf)) this.bytes.fill(0, N(buf), N(buf) + 32); return Number(monotonic() / 10000000n); },
  102() { return 0; }, 104() { return 0; }, 105() { return 0; }, 106() { return 0; },
  107() { return 0; }, 108() { return 0; },
  109(pid, pgid) { // setpgid: itself or a child of its own, into a group of its session
    const target = proc(this, N(pid));
    if (target !== this && target.ppid !== this.pid) fail(E.SRCH);
    if (target.sid !== this.sid || target.pid === target.sid) fail(E.PERM);
    const group = N(pgid) || target.pid;
    if (group < 0) fail(E.INVAL);
    if (group !== target.pid && !this.kernel.live().some((q) => q.pgid === group && q.sid === this.sid)) fail(E.PERM);
    target.pgid = group;
    return 0;
  },
  110() { return this.ppid; },
  111() { return this.pgid; },
  112() { // setsid
    if (this.pgid === this.pid || this.kernel.live().some((q) => q.pgid === this.pid)) fail(E.PERM);
    this.sid = this.pgid = this.pid;
    return this.pid;
  },
  115() { return 0; }, 116() { return 0; },
  117() { return 0; }, 119() { return 0; },
  118(r, e, s) { for (const a of [r, e, s]) if (N(a)) this.view.setUint32(N(a), 0, true); return 0; },
  120(r, e, s) { for (const a of [r, e, s]) if (N(a)) this.view.setUint32(N(a), 0, true); return 0; },
  121(pid) { return proc(this, N(pid)).pgid; },
  124(pid) { return proc(this, N(pid)).sid; },
  157() { return 0; },
  158(code, addr) {
    if (N(code) === 0x1002) { this.task.setReg(16, addr); return 0; } // ARCH_SET_FS
    if (N(code) === 0x1003) { this.view.setBigUint64(N(addr), BigInt.asUintN(64, this.task.reg(16)), true); return 0; }
    fail(E.INVAL);
  },
  160() { return 0; },
  186() { return this.task.tid; },
  201(t) { const s = wall() / 1000000000n; if (N(t)) this.view.setBigInt64(N(t), s, true); return s; },
  202(uaddr, op, val, timeout, uaddr2, val3) { return futex(this, uaddr, op, val, timeout, uaddr2, val3); },
  203() { return 0; }, // sched_setaffinity
  204(pid, size, mask) { // sched_getaffinity
    const n = cpus(), bytes = 8;
    if (N(size) < bytes) fail(E.INVAL);
    this.bytes.fill(0, N(mask), N(mask) + bytes);
    this.view.setBigUint64(N(mask), (1n << BigInt(n)) - 1n, true);
    return bytes;
  },
  218(tidptr) { this.task.clearTid = N(tidptr); return this.task.tid; }, // set_tid_address
  228(clock, ts) { writeTime(this, N(ts), N(clock) === 0 ? wall() : monotonic()); return 0; },
  229(clock, ts) { if (N(ts)) writeTime(this, N(ts), 1n); return 0; },
  230(clock, flags, req, rem) { // clock_nanosleep: by an interval, or until a time on that clock (TIMER_ABSTIME)
    const t = readTime(this, N(req));
    if (!(N(flags) & 1)) return sleepUntil(this, performance.now() + ms(t), N(rem));
    const now = N(clock) === 0 ? wall() : monotonic();
    return sleepUntil(this, performance.now() + ms(t > now ? t - now : 0n));
  },
  231(code) { this.kernel.exitProcess(this, exitStatus(N(code))); throw new Exit(exitStatus(N(code))); },
  247(idtype, id, infop, options) { return waitid(this, idtype, id, infop, options); },
  273(head, len) { if (N(len) !== 24) fail(E.INVAL); this.task.robust = N(head); return 0; }, // set_robust_list
  274(pid, head, len) { // get_robust_list
    const t = N(pid) ? this.kernel.tasks.get(N(pid)) : this.task;
    if (!t) fail(E.SRCH);
    this.view.setBigUint64(N(head), BigInt(t.robust), true);
    this.view.setBigUint64(N(len), 24n, true);
    return 0;
  },
  302(pid, resource, next, old) {
    if (N(old)) { this.view.setBigInt64(N(old), -1n, true); this.view.setBigInt64(N(old) + 8, -1n, true); }
    return 0;
  },
  318(buf, len) {
    const n = Math.min(N(len), 65536);
    crypto.getRandomValues(this.bytes.subarray(N(buf), N(buf) + n));
    return n;
  },
  // The network boundary: a Prompt in a browser has no network and no sockets of
  // any family (internet, netlink, local), so a program is told the family is not
  // there, as a host without it says, not that the call does not exist.
  41() { fail(E.AFNOSUPPORT); }, // socket
  53() { fail(E.AFNOSUPPORT); }, // socketpair
  334() { fail(E.NOSYS); }, // rseq
  435() { fail(E.NOSYS); }, // clone3: libc falls back to clone
};
