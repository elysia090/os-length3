// Signals as Linux has them on x86-64: an action per signal for each
// process, a blocked mask and a pending set per thread, a pending set per
// process, and delivery into a handler through an rt_sigframe (siginfo and
// ucontext) that rt_sigreturn reads back.
//
// A signal is delivered where the kernel sees the thread: when one of its
// system calls returns (at once, or after it waited), or before a thread
// that is ready runs again. A thread waiting in a call that a handler
// interrupts gets EINTR, or has the call made again after the handler
// (SA_RESTART, for the calls Linux restarts), or the count of what it
// moved already. A signal whose action is to end the process ends it when
// it is sent, as Linux does, however busy the process is.

import {E, FsError} from './fs.mjs';
import {Redirect, Wait} from './process.mjs';

export const SIG = {HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11,
  USR2: 12, PIPE: 13, ALRM: 14, TERM: 15, STKFLT: 16, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22,
  URG: 23, XCPU: 24, XFSZ: 25, VTALRM: 26, PROF: 27, WINCH: 28, IO: 29, PWR: 30, SYS: 31};
export const NSIG = 64;
export const SA = {NOCLDSTOP: 1, NOCLDWAIT: 2, SIGINFO: 4, RESTORER: 0x04000000, ONSTACK: 0x08000000,
  RESTART: 0x10000000, NODEFER: 0x40000000, RESETHAND: 0x80000000};
export const SI = {USER: 0, KERNEL: 0x80, QUEUE: -1, TKILL: -6};
export const CLD = {EXITED: 1, KILLED: 2, DUMPED: 3, TRAPPED: 4, STOPPED: 5, CONTINUED: 6};
const SS_ONSTACK = 1, SS_DISABLE = 2, MINSIGSTKSZ = 2048n;
const SIG_DFL = 0n, SIG_IGN = 1n;

export const bit = (sig) => 1n << BigInt(sig - 1);
const UNBLOCKABLE = bit(SIG.KILL) | bit(SIG.STOP);
const ALL = (1n << 64n) - 1n;
const STOPS = bit(SIG.STOP) | bit(SIG.TSTP) | bit(SIG.TTIN) | bit(SIG.TTOU);

/** What a signal does when nothing else is asked: 'term', 'core', 'ign', 'stop' or 'cont'. */
export function defaultAction(sig) {
  switch (sig) {
    case SIG.CHLD: case SIG.URG: case SIG.WINCH: return 'ign';
    case SIG.CONT: return 'cont';
    case SIG.STOP: case SIG.TSTP: case SIG.TTIN: case SIG.TTOU: return 'stop';
    case SIG.QUIT: case SIG.ILL: case SIG.TRAP: case SIG.ABRT: case SIG.BUS: case SIG.FPE: case SIG.SEGV:
    case SIG.XCPU: case SIG.XFSZ: case SIG.SYS: return 'core';
    default: return 'term';
  }
}

/** Signals waiting to be taken: a mask, and what each one says (standard ones once, real-time ones queued). */
export class Pending {
  constructor() { this.mask = 0n; this.info = new Map(); }
  add(sig, info) {
    const b = bit(sig);
    if (sig < 32 && this.mask & b) return false; // a standard signal already pending is not pending twice
    this.mask |= b;
    const q = this.info.get(sig);
    if (q) q.push(info); else this.info.set(sig, [info]);
    return true;
  }
  take(sig) {
    const q = this.info.get(sig);
    const info = q?.shift() ?? {signo: sig, code: SI.KERNEL};
    if (!q?.length) { this.info.delete(sig); this.mask &= ~bit(sig); }
    return info;
  }
  drop(mask) {
    for (let sig = 1; sig <= NSIG; sig++) if (mask & this.mask & bit(sig)) { this.info.delete(sig); this.mask &= ~bit(sig); }
  }
}

/** The action for `sig` in `proc`: {handler, flags, restorer, mask}. */
export const actionOf = (proc, sig) => proc.actions.get(sig) ?? {handler: SIG_DFL, flags: 0, restorer: 0n, mask: 0n};

/** Whether `sig` sent to `proc` would be dropped at once: ignored, by its action or by default. */
function ignored(proc, sig) {
  const a = actionOf(proc, sig);
  if (a.handler === SIG_IGN) return true;
  return a.handler === SIG_DFL && defaultAction(sig) === 'ign';
}

/**
 * Send `sig` to `proc` (thread: to that thread only, as tgkill and a fault
 * do). What it does at once: SIGKILL and an unhandled, unblocked fatal
 * signal end the process; a stop signal stops it, SIGCONT continues it.
 * Otherwise it is pending, and a thread waiting in a call that can take it
 * is interrupted.
 */
export function send(kernel, proc, sig, info = {signo: sig, code: SI.KERNEL}, thread = null) {
  if (!sig || proc.state !== 'live') return;
  info = {signo: sig, ...info};
  if (sig === SIG.KILL) { kernel.exitProcess(proc, sig); return; }
  if (sig === SIG.CONT) {
    proc.pending.drop(STOPS);
    for (const t of proc.tasks) t.pending.drop(STOPS);
    if (proc.stopped) kernel.continueProcess(proc);
  }
  if (STOPS & bit(sig)) {
    proc.pending.drop(bit(SIG.CONT));
    for (const t of proc.tasks) t.pending.drop(bit(SIG.CONT));
  }
  const blockedByAll = [...proc.tasks].every((t) => (t.mask & bit(sig)) !== 0n);
  if (ignored(proc, sig) && !(thread ? thread.mask & bit(sig) : blockedByAll)) return;
  const a = actionOf(proc, sig);
  // Fatal at once (Linux's complete_signal): no handler, not blocked, and it ends the process.
  if (a.handler === SIG_DFL && !(thread ? thread.mask & bit(sig) : blockedByAll)) {
    const what = defaultAction(sig);
    if (what === 'term' || what === 'core') { kernel.exitProcess(proc, sig); return; }
    if (what === 'stop') {
      // A stop from the terminal (TSTP, TTIN, TTOU) does nothing to an orphaned group; SIGSTOP always stops.
      kernel.stopProcess(proc, sig);
      return;
    }
  }
  (thread ?? proc).pending.add(sig, info);
  kernel.dirty = true;
  // Who takes it: the thread named, else one that does not block it, and of those one that waits first.
  const takers = thread ? [thread] : [...proc.tasks].filter((t) => !(t.mask & bit(sig)));
  const waiting = takers.find((t) => t.call);
  if (waiting) kernel.interruptCall(waiting);
  else if (takers.length) kernel.lookIn(proc);
}

/** Whether `task` has a signal it does not block, pending for it or its process. */
export function deliverable(task) {
  const pending = (task.pending.mask | task.proc.pending.mask) & ~task.mask;
  return pending !== 0n;
}

/** The next signal `task` takes: its own first, lowest number first (as Linux's next_signal). */
function next(task) {
  const synchronous = bit(SIG.SEGV) | bit(SIG.BUS) | bit(SIG.ILL) | bit(SIG.TRAP) | bit(SIG.FPE) | bit(SIG.SYS);
  for (const from of [task.pending, task.proc.pending]) {
    const m = from.mask & ~task.mask;
    if (!m) continue;
    const pick = m & synchronous ? m & synchronous : m;
    for (let sig = 1; sig <= NSIG; sig++) if (pick & bit(sig)) return {sig, info: from.take(sig)};
  }
  return null;
}

/**
 * Take the signals `task` can take now, in front of `ctx` (the registers
 * and rip it would go on with). Ignored ones go; one whose default is to
 * end the process ends it (true is returned: nothing is to run); one with a
 * handler gets a frame and the registers become the handler's (true).
 * False when there was nothing to do and ctx stands.
 */
export function take(kernel, task, ctx) {
  for (;;) {
    const got = next(task);
    if (!got) return false;
    const {sig, info} = got, a = actionOf(task.proc, sig);
    if (a.handler === SIG_IGN) continue;
    if (a.handler === SIG_DFL) {
      const what = defaultAction(sig);
      if (what === 'ign' || what === 'cont') continue;
      if (what === 'stop') { kernel.stopProcess(task.proc, sig); return true; }
      kernel.exitProcess(task.proc, sig);
      return true;
    }
    frame(kernel, task, sig, info, a, ctx);
    return true;
  }
}

// ---- the frame ----

// sigcontext's general registers, in its order, as the translator numbers them (rax 0, rcx 1, rdx 2, rbx 3, rsp 4, rbp 5, rsi 6, rdi 7, r8..r15).
const SIGCONTEXT = [8, 9, 10, 11, 12, 13, 14, 15, 7, 6, 5, 3, 2, 0, 1, 4];
const UC = 8, MCONTEXT = UC + 40, SIGMASK = UC + 296, INFO = UC + 304, FRAME = INFO + 128;
// The translator's flags global holds CF, ZF, SF, OF, PF as bits 0..4; rflags has them where x86 does.
const FLAGS = [[0, 0x1], [1, 0x40], [2, 0x80], [3, 0x800], [4, 0x4]];
const toRflags = (fl) => FLAGS.reduce((r, [k, m]) => (fl >> BigInt(k)) & 1n ? r | BigInt(m) : r, 0x202n);
const fromRflags = (rf) => FLAGS.reduce((f, [k, m]) => rf & BigInt(m) ? f | (1n << BigInt(k)) : f, 0n);

/** Write a siginfo_t at `at`. */
export function writeInfo(p, at, info) {
  const v = p.view;
  p.bytes.fill(0, at, at + 128);
  v.setInt32(at, info.signo, true);
  v.setInt32(at + 4, info.errno ?? 0, true);
  v.setInt32(at + 8, info.code ?? 0, true);
  if (info.addr !== undefined) { v.setBigUint64(at + 16, BigInt(info.addr), true); return; }
  v.setInt32(at + 16, info.pid ?? 0, true);
  v.setInt32(at + 20, info.uid ?? 0, true);
  if (info.status !== undefined) v.setInt32(at + 24, info.status, true);
  else if (info.value !== undefined) v.setBigUint64(at + 24, BigInt.asUintN(64, BigInt(info.value)), true);
}

/** stack_t at `at` for `task`'s alternate stack as seen from stack pointer `sp`. */
function writeStack(p, at, task, sp) {
  const alt = task.altstack, v = p.view;
  v.setBigUint64(at, alt.sp, true);
  v.setInt32(at + 8, alt.size === 0n ? SS_DISABLE : onAltStack(task, sp) ? SS_ONSTACK : alt.flags & ~SS_ONSTACK, true);
  v.setInt32(at + 12, 0, true);
  v.setBigUint64(at + 16, alt.size, true);
}

const onAltStack = (task, sp) => task.altstack.size > 0n && sp > task.altstack.sp && sp <= task.altstack.sp + task.altstack.size;

function frame(kernel, task, sig, info, a, ctx) {
  const p = task.proc, regs = ctx.regs;
  let sp = BigInt.asUintN(64, regs[4]);
  if (a.flags & SA.ONSTACK && task.altstack.size > 0n && !(task.altstack.flags & SS_DISABLE) && !onAltStack(task, sp)) sp = task.altstack.sp + task.altstack.size;
  else sp -= 128n; // the red zone
  const at = ((sp - BigInt(FRAME)) & ~15n) - 8n;
  const base = Number(at);
  if (at < 0n || base + FRAME > p.memory.buffer.byteLength) { kernel.exitProcess(p, SIG.SEGV); return; }
  const v = p.view;
  p.bytes.fill(0, base, base + FRAME);
  v.setBigUint64(base, a.flags & SA.RESTORER ? a.restorer : 0n, true);
  writeStack(p, base + UC + 16, task, BigInt.asUintN(64, regs[4]));
  SIGCONTEXT.forEach((r, k) => v.setBigUint64(base + MCONTEXT + k * 8, BigInt.asUintN(64, regs[r]), true));
  v.setBigUint64(base + MCONTEXT + 128, BigInt.asUintN(64, ctx.rip), true);
  v.setBigUint64(base + MCONTEXT + 136, toRflags(regs[17]), true);
  // The translation's other flags (DF, AC, ID) and MXCSR, kept where sigcontext has room (its reserved words).
  v.setBigUint64(base + MCONTEXT + 192, BigInt.asUintN(64, regs[18] ?? 0n), true);
  v.setUint16(base + MCONTEXT + 144, 0x33, true); // cs
  v.setUint16(base + MCONTEXT + 150, 0x2b, true); // ss
  const mask = task.savedMask ?? task.mask;
  v.setBigUint64(base + MCONTEXT + 168, mask, true); // oldmask
  v.setBigUint64(base + SIGMASK, mask, true);
  writeInfo(p, base + INFO, info);
  task.savedMask = null;
  // The handler's registers: (sig, &info, &uc), rax 0, on the frame; what it does not use is as it was.
  const next = regs.slice();
  next[7] = BigInt(sig); next[6] = at + BigInt(INFO); next[2] = at + BigInt(UC); next[0] = 0n; next[4] = at;
  task.setContext(next, a.handler);
  task.mask = (task.mask | a.mask | (a.flags & SA.NODEFER ? 0n : bit(sig))) & ~UNBLOCKABLE;
  if (a.flags & SA.RESETHAND) p.actions.delete(sig);
}

/** rt_sigreturn: the registers, mask and alternate stack the frame under the stack pointer holds. */
function sigreturn(task) {
  const p = task.proc, v = p.view;
  const at = Number(BigInt.asUintN(64, task.reg(4)) - 8n);
  if (at < 0 || at + FRAME > p.memory.buffer.byteLength) throw new FsError(E.FAULT);
  const regs = task.context().regs;
  SIGCONTEXT.forEach((r, k) => { regs[r] = v.getBigInt64(at + MCONTEXT + k * 8, true); });
  regs[17] = fromRflags(v.getBigUint64(at + MCONTEXT + 136, true));
  regs[18] = v.getBigInt64(at + MCONTEXT + 192, true);
  const rip = v.getBigUint64(at + MCONTEXT + 128, true);
  task.mask = v.getBigUint64(at + SIGMASK, true) & ~UNBLOCKABLE;
  // The alternate stack as the frame says (Linux's restore_altstack), unless the thread is on it.
  const ss = {sp: v.getBigUint64(at + UC + 16, true), flags: v.getInt32(at + UC + 24, true), size: v.getBigUint64(at + UC + 32, true)};
  if (!onAltStack(task, BigInt.asUintN(64, task.reg(4)))) setAltstack(task, ss);
  task.setContext(regs, rip);
  task.kernel.dirty = true;
  throw new Redirect();
}

function setAltstack(task, ss) {
  if (ss.flags & SS_DISABLE) { task.altstack = {sp: 0n, size: 0n, flags: SS_DISABLE}; return; }
  if (ss.flags & ~(SS_ONSTACK | 0x80000000)) throw new FsError(E.INVAL);
  if (ss.size < MINSIGSTKSZ) throw new FsError(E.NOMEM);
  task.altstack = {sp: ss.sp, size: ss.size, flags: 0};
}

// ---- system calls ----

const N = (x) => Number(BigInt.asIntN(64, x));
const fail = (errno) => { throw new FsError(errno); };
const readSet = (p, at) => (at ? p.view.getBigUint64(at, true) : 0n);

/** Is `sig` a signal number a program may name? */
const valid = (sig) => sig >= 1 && sig <= NSIG;

export const SIGNAL_CALLS = {
  13(sig, act, old, size) { // rt_sigaction
    const s = N(sig);
    if (!valid(s) || (N(act) && (s === SIG.KILL || s === SIG.STOP))) fail(E.INVAL);
    if (N(size) !== 8) fail(E.INVAL);
    const previous = actionOf(this, s);
    let next = null;
    if (N(act)) {
      const v = this.view, at = N(act);
      next = {handler: v.getBigUint64(at, true), flags: Number(v.getBigUint64(at + 8, true) & 0xffffffffn), restorer: v.getBigUint64(at + 16, true), mask: v.getBigUint64(at + 24, true) & ~UNBLOCKABLE};
    }
    if (N(old)) {
      const v = this.view, at = N(old);
      v.setBigUint64(at, previous.handler, true);
      v.setBigUint64(at + 8, BigInt(previous.flags >>> 0), true);
      v.setBigUint64(at + 16, previous.restorer, true);
      v.setBigUint64(at + 24, previous.mask, true);
    }
    if (next) {
      if (next.handler === SIG_DFL && !next.flags) this.actions.delete(s); else this.actions.set(s, next);
      // Ignored now: what was pending of it goes (POSIX), in every thread.
      if (ignored(this, s)) { this.pending.drop(bit(s)); for (const t of this.tasks) t.pending.drop(bit(s)); }
    }
    return 0;
  },
  14(how, set, old, size) { // rt_sigprocmask
    if (N(size) !== 8) fail(E.INVAL);
    const t = this.task, was = t.mask;
    if (N(set)) {
      const s = readSet(this, N(set));
      if (N(how) === 0) t.mask |= s;
      else if (N(how) === 1) t.mask &= ~s;
      else if (N(how) === 2) t.mask = s;
      else fail(E.INVAL);
      t.mask &= ~UNBLOCKABLE;
    }
    if (N(old)) this.view.setBigUint64(N(old), was, true);
    this.kernel.dirty = true;
    return 0;
  },
  15() { return sigreturn(this.task); }, // rt_sigreturn
  34() { throw new Wait(); }, // pause: until a handler runs (the kernel then says EINTR)
  127(set, size) { // rt_sigpending
    const t = this.task;
    this.view.setBigUint64(N(set), (t.pending.mask | this.pending.mask) & t.mask, true);
    return 0;
  },
  128(set, info, timeout, size) { // rt_sigtimedwait: take a pending signal of `set`, blocked or not
    const t = this.task, s = this.call.state, want = readSet(this, N(set)) & ~UNBLOCKABLE;
    for (const from of [t.pending, this.pending]) {
      const m = from.mask & want;
      if (!m) continue;
      for (let sig = 1; sig <= NSIG; sig++) {
        if (!(m & bit(sig))) continue;
        const i = from.take(sig);
        if (N(info)) writeInfo(this, N(info), i);
        return sig;
      }
    }
    if (N(timeout)) {
      s.deadline ??= performance.now() + (Number(this.view.getBigInt64(N(timeout), true)) * 1e3 + Number(this.view.getBigInt64(N(timeout) + 8, true)) / 1e6);
      if (performance.now() >= s.deadline) fail(E.AGAIN);
    }
    // Waiting, the set is taken as unblocked so that sending one wakes this call (Linux does the same).
    s.waitFor = want;
    throw new Wait();
  },
  130(set, size) { // rt_sigsuspend: the mask is `set` until a handler ran, then as it was
    const t = this.task, s = this.call.state;
    if (!s.started) {
      s.started = true;
      t.savedMask = t.mask;
      t.mask = readSet(this, N(set)) & ~UNBLOCKABLE;
    }
    throw new Wait();
  },
  131(ss, old) { // sigaltstack
    const t = this.task, sp = BigInt.asUintN(64, t.reg(4));
    if (N(old)) writeStack(this, N(old), t, sp);
    if (N(ss)) {
      if (onAltStack(t, sp)) fail(E.PERM);
      const v = this.view, at = N(ss);
      setAltstack(t, {sp: v.getBigUint64(at, true), flags: v.getInt32(at + 8, true), size: v.getBigUint64(at + 16, true)});
    }
    return 0;
  },
  62(pid, sig) { return kill(this, N(pid), N(sig)); },
  200(tid, sig) { return tkill(this, -1, N(tid), N(sig)); }, // tkill
  234(tgid, tid, sig) { return tkill(this, N(tgid), N(tid), N(sig)); }, // tgkill
  129(pid, sig, info) { // rt_sigqueueinfo
    const i = {code: this.view.getInt32(N(info) + 8, true), pid: this.pid, value: this.view.getBigInt64(N(info) + 24, true)};
    return kill(this, N(pid), N(sig), i);
  },
};

/** kill(2): one process, a group (0: the caller's), or every process but init and the caller (-1). */
export function kill(p, pid, sig, info = {code: SI.USER, pid: p.pid, uid: 0}) {
  if (sig < 0 || sig > NSIG) fail(E.INVAL);
  const k = p.kernel;
  let targets;
  if (pid > 0) targets = [k.procs.get(pid)].filter(Boolean);
  else if (pid === 0) targets = k.group(p.pgid);
  else if (pid === -1) targets = [...k.procs.values()].filter((q) => q.pid !== 1 && q !== p);
  else targets = k.group(-pid);
  if (!targets.length) fail(E.SRCH);
  // A zombie is still there to be signalled; nothing happens to it.
  for (const q of targets) if (sig && q.state === 'live') send(k, q, sig, {...info, signo: sig});
  return 0;
}

function tkill(p, tgid, tid, sig) {
  if (sig < 0 || sig > NSIG || tid <= 0) fail(E.INVAL);
  const k = p.kernel, t = k.tasks.get(tid);
  if (!t || (tgid > 0 && t.proc.pid !== tgid)) fail(E.SRCH);
  if (sig) send(k, t.proc, sig, {signo: sig, code: SI.TKILL, pid: p.pid, uid: 0}, t);
  return 0;
}

export {SIG_DFL, SIG_IGN, UNBLOCKABLE, ALL};
