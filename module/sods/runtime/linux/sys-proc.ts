// Process, thread, memory, time and identity system calls. Handlers run
// with `this` bound to the calling Process, `this.task` the calling
// thread and `this.call` the call ({nr, args, next, state}: state lasts
// while the call waits and is made again).

import {move, zero} from './bulk.ts';
import {answerTime, clocks, cpuClock, cpuOf} from './clock.ts';
import {E, File, FsError} from './fs.ts';
import {Exec, Exit, Wait, randomBytes, utf8} from './flow.ts';
import type {Calls, Cpu, Proc} from './parts.ts';
import {CLD, SIG, send, writeInfo} from './signal.ts';
import {processors, steady} from '../host.ts';

const N = (x: bigint): number => Number(BigInt.asIntN(64, x));
const fail = (errno: number): never => { throw new FsError(errno); };
const enc = new TextEncoder();

const CLONE = {VM: 0x100, FS: 0x200, FILES: 0x400, SIGHAND: 0x800, PIDFD: 0x1000, VFORK: 0x4000, PARENT: 0x8000,
  THREAD: 0x10000, SETTLS: 0x80000, PARENT_SETTID: 0x100000, CHILD_CLEARTID: 0x200000, CHILD_SETTID: 0x1000000};
// The native guest's floor refuses these too. No request for isolation may become an ordinary clone.
const NEW_NAMESPACES = 0x80 /* TIME */ | 0x20000 /* NS */ | 0x2000000 /* CGROUP */ | 0x4000000 /* UTS */ |
  0x8000000 /* IPC */ | 0x10000000 /* USER */ | 0x20000000 /* PID */ | 0x40000000 /* NET */;
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
  const pick = want > 0 ? (c: Proc) => c.pid === want : want === -1 ? () => true : want === 0 ? (c: Proc) => c.pgid === p.pgid : (c: Proc) => c.pgid === -want;
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
  return found.child.pid;
}

function waitid(p: Proc, idtype: bigint, id: bigint, infop: bigint, options: bigint): number {
  const o = N(options), which = N(idtype), n = N(id);
  if (!(o & (W.EXITED | W.UNTRACED | W.CONTINUED))) fail(E.INVAL);
  const pick = which === 0 ? () => true : which === 1 ? (c: Proc) => c.pid === n : which === 2 ? (c: Proc) => c.pgid === (n || p.pgid) : fail(E.INVAL);
  const found = waitable(p, pick, o);
  if (!found) {
    if (o & W.NOHANG) { if (N(infop)) p.bytes.fill(0, N(infop), N(infop) + 128); return 0; }
    throw new Wait();
  }
  taken(p, found, o);
  if (N(infop)) writeInfo(p, N(infop), {signo: SIG.CHLD, code: found.code, pid: found.child.pid, uid: 0, status: found.value});
  return 0;
}

function execve(p: Proc, nameAddress: bigint, argvAddress: bigint, envAddress: bigint): never {
  const name = p.cstring(N(nameAddress));
  const argv = p.strings(N(argvAddress)), env = p.strings(N(envAddress));
  p.execve(name, argv, env); // throws FsError before replacing anything
  throw new Exec();
}

/** clone(2), fork(2) and vfork(2): a thread of this process, or a new process. */
function clone(p: Proc, flags: number, stack: bigint, ptid: number, ctid: number, tls: bigint): number {
  if (flags & NEW_NAMESPACES) fail(E.PERM);
  const t = p.task, s = p.call!.state;
  // (A place for the new thread's id that is not the memory is not written, and the clone goes on: Linux's put_user
  // there is not looked at either.)
  const writeTid = (memory: WebAssembly.Memory, at: number, tid: number): void => {
    if (at > 0 && at + 4 <= memory.buffer.byteLength) new DataView(memory.buffer).setInt32(at, tid, true);
  };
  if (flags & CLONE.THREAD) {
    if (!(flags & CLONE.VM) || !(flags & CLONE.SIGHAND)) fail(E.INVAL);
    const nt = p.newThread(t.resumeAt, stack, flags & CLONE.SETTLS ? tls : null);
    if (flags & CLONE.PARENT_SETTID) writeTid(p.memory!, ptid, nt.tid);
    if (flags & CLONE.CHILD_SETTID) writeTid(p.memory!, ctid, nt.tid);
    if (flags & CLONE.CHILD_CLEARTID) nt.clearTid = ctid;
    p.kernel.go(nt);
    return nt.tid;
  }
  if (!s.child) {
    if (flags & CLONE.PIDFD) fail(E.INVAL);
    const child = p.forkProcess(t.resumeAt, {stack, vm: !!(flags & CLONE.VM), files: !!(flags & CLONE.FILES), exitSignal: flags & 0xff,
      tls: flags & CLONE.SETTLS ? tls : null, clearTid: flags & CLONE.CHILD_CLEARTID ? ctid : 0, parent: !!(flags & CLONE.PARENT)});
    if (flags & CLONE.PARENT_SETTID) writeTid(p.memory!, ptid, child.pid);
    if (flags & CLONE.CHILD_SETTID) writeTid(child.memory!, ctid, child.pid);
    s.child = child;
    // A vfork parent waits until its child has exec'd or ended: they share one memory until then.
    if (flags & CLONE.VFORK) s.vfork = child.vfork = {released: false};
    if (!s.vfork) return child.pid;
  }
  if (s.vfork && !s.vfork.released) throw new Wait();
  return s.child?.pid ?? fail(E.AGAIN);
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
  return p.kernel.procs.get(pid) ?? fail(E.SRCH);
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
  const procs = which === 0 ? live.filter((q) => q.pid === (who || p.pid)) // PRIO_PROCESS
    : which === 1 ? live.filter((q) => q.pgid === (who || p.pgid)) // PRIO_PGRP
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
// The Prompt's user namespace maps one id, 0, the person's own outside it (core/src/launch.rs writes uid_map and
// gid_map "0 ID 1", and setgroups "deny"). So a process is root and becomes no one else: an id not mapped is EINVAL
// (su to another user fails there as here), setgroups is EPERM, and it holds every capability within its namespace.

const KEEP = 0xffffffff;
/** Ids set*id may be given: 0, or (where the call allows it) -1 to keep one. */
function mapped(ids: bigint[], keep = true): number {
  for (const id of ids) {
    const x = Number(BigInt.asUintN(32, id));
    if (x !== 0 && !(keep && x === KEEP)) fail(E.INVAL);
  }
  return 0;
}

/** capget and capset's header (version, pid): the version known (v3), or EINVAL with the one it should have been. */
function capHeader(p: Proc, header: bigint): {target: Proc; words: number} {
  const v = p.view, at = N(header), version = v.getUint32(at, true);
  if (version !== 0x20080522 && version !== 0x20071026 && version !== 0x19980330) { v.setUint32(at, 0x20080522, true); fail(E.INVAL); }
  const pid = v.getInt32(at + 4, true);
  const target = (pid === 0 || pid === p.pid ? p : p.kernel.procs.get(pid)) ?? fail(E.SRCH);
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
    case 7: return p.keepCaps ? 1 : 0; // PR_GET_KEEPCAPS
    case 8: if (a !== 0 && a !== 1) fail(E.INVAL); p.keepCaps = a === 1; return 0; // PR_SET_KEEPCAPS
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
    case 21: return 0; // PR_GET_SECCOMP: none
    case 22: return fail(E.INVAL); // PR_SET_SECCOMP: neither strict mode nor filters are implemented
    case 23: if (a < 0 || a > 40) fail(E.INVAL); return p.dropped?.has(a) ? 0 : 1; // PR_CAPBSET_READ
    case 24: if (a < 0 || a > 40) fail(E.INVAL); (p.dropped ??= new Set()).add(a); return 0; // PR_CAPBSET_DROP
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
      if (a === 4) { if (arg3) fail(E.INVAL); p.ambient = 0n; return 0; }
      const cap = N(arg3);
      if (cap < 0 || cap > 40 || a < 1 || a > 3) fail(E.INVAL);
      const bit = 1n << BigInt(cap);
      if (a === 1) return p.ambient & bit ? 1 : 0;
      if (a === 2) { if (!(p.caps.permitted & p.caps.inheritable & bit)) fail(E.PERM); p.ambient |= bit; }
      else p.ambient &= ~bit;
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
  39() { return this.pid; },
  56(flags, stack, ptid, ctid, tls) { return clone(this, N(flags), BigInt.asUintN(64, stack), N(ptid), N(ctid), tls); },
  57() { return clone(this, SIG.CHLD, 0n, 0, 0, 0n); }, // fork
  58() { return clone(this, CLONE.VM | CLONE.VFORK | SIG.CHLD, 0n, 0, 0, 0n); }, // vfork
  59(name, argv, env) { return execve(this, name, argv, env); },
  60(code) { this.kernel.exitThread(this.task, exitStatus(N(code))); throw new Exit(exitStatus(N(code))); },
  61(pid, status, options, rusage) { return wait4(this, pid, status, options, rusage); },
  63(buf) {
    const fields = ['Linux', this.kernel.hostname ?? 'length3', '6.1.0', '#1 muk', 'x86_64', this.kernel.domainname ?? '(none)'];
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
  102() { return 0; }, 104() { return 0; }, 107() { return 0; }, 108() { return 0; }, // getuid, getgid, geteuid, getegid
  105(uid) { return mapped([uid], false); }, // setuid
  106(gid) { return mapped([gid], false); }, // setgid
  113(r, e) { return mapped([r, e]); }, // setreuid
  114(r, e) { return mapped([r, e]); }, // setregid
  109(pid, pgid) { // setpgid: itself or a child of its own, into a group of its session
    const target = proc(this, N(pid));
    if (target !== this && target.ppid !== this.pid) fail(E.SRCH);
    if (target.sid !== this.sid || target.pid === target.sid) fail(E.PERM);
    const group = N(pgid) || target.pid;
    if (group < 0) fail(E.INVAL);
    if (group !== target.pid && !this.kernel.hasGroup(group, this.sid)) fail(E.PERM);
    target.pgid = group;
    return 0;
  },
  110() { return this.ppid; },
  111() { return this.pgid; },
  112() { // setsid
    if (this.pgid === this.pid || [...this.kernel.procs.values()].some((q) => q.pgid === this.pid)) fail(E.PERM);
    this.sid = this.pgid = this.pid;
    return this.pid;
  },
  115(size) { if (N(size) < 0) fail(E.INVAL); return 0; }, // getgroups: none beside its group
  116() { return fail(E.PERM); }, // setgroups: denied in its namespace
  117(r, e, s) { return mapped([r, e, s]); }, // setresuid
  119(r, e, s) { return mapped([r, e, s]); }, // setresgid
  122() { return 0; }, 123() { return 0; }, // setfsuid, setfsgid: the old one, 0 (an id not mapped is not taken)
  125(header, data) { // capget
    const {target, words} = capHeader(this, header);
    if (!N(data)) return 0;
    const v = this.view, c = target.caps;
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
    if ((permitted & ~this.caps.permitted) || (effective & ~permitted)) fail(E.PERM);
    this.caps = {effective, permitted, inheritable};
    this.ambient &= permitted & inheritable;
    return 0;
  },
  118(r, e, s) { for (const a of [r, e, s]) if (N(a)) this.view.setUint32(N(a), 0, true); return 0; },
  120(r, e, s) { for (const a of [r, e, s]) if (N(a)) this.view.setUint32(N(a), 0, true); return 0; },
  121(pid) { return proc(this, N(pid)).pgid; },
  124(pid) { return proc(this, N(pid)).sid; },
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
  186() { return this.task.tid; },
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
  218(tidptr) { this.task.clearTid = N(tidptr); return this.task.tid; }, // set_tid_address
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
    const t = (N(pid) ? this.kernel.tasks.get(N(pid)) : this.task) ?? fail(E.SRCH);
    this.view.setBigUint64(N(head), BigInt(t.robust), true);
    this.view.setBigUint64(N(len), 24n, true);
    return 0;
  },
  302(pid, resource, next, old) { // prlimit64
    const target = (N(pid) === 0 || N(pid) === this.pid ? this : this.kernel.procs.get(N(pid))) ?? fail(E.SRCH);
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
  170(name, len) { this.kernel.hostname = names(this, name, len); return 0; }, // sethostname: the machine's (its own UTS)
  171(name, len) { this.kernel.domainname = names(this, name, len); return 0; }, // setdomainname
  135() { return 0; }, // personality: Linux's own (PER_LINUX); asked, or set, it stays that
  309(cpu, node) { // getcpu: one machine of one node, as it is to its guests
    if (N(cpu)) this.view.setUint32(N(cpu), 0, true);
    if (N(node)) this.view.setUint32(N(node), 0, true);
    return 0;
  },
  324(cmd) { return N(cmd) === 0 ? 0 : fail(E.INVAL); }, // membarrier: asked, it offers none (a program then fences itself)
  // What a container's root without its capabilities is refused: the machine's mounts, clock, log and modules are
  // the host's, not a Prompt's.
  165() { return fail(E.PERM); }, 166() { return fail(E.PERM); }, 155() { return fail(E.PERM); }, 161() { return fail(E.PERM); }, // mount, umount2, pivot_root, chroot
  169() { return fail(E.PERM); }, 227() { return fail(E.PERM); }, 103() { return fail(E.PERM); }, 308() { return fail(E.PERM); }, // reboot, clock_settime, syslog, setns
  167() { return fail(E.PERM); }, 168() { return fail(E.PERM); }, 175() { return fail(E.PERM); }, 176() { return fail(E.PERM); }, 313() { return fail(E.PERM); }, // swapon, swapoff, modules
  101() { return fail(E.PERM); }, // ptrace: no process here can be traced
  334() { return fail(E.NOSYS); }, // rseq
  435() { return fail(E.NOSYS); }, // clone3: libc falls back to clone
};
