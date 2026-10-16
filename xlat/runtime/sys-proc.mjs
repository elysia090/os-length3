// Process, memory, signal, time and identity system calls. Handlers run
// with `this` bound to the calling Process.

import {E, FsError} from './fs.mjs';
import {Exec, Exit} from './process.mjs';

const N = (x) => Number(BigInt.asIntN(64, x));
const fail = (errno) => { throw new FsError(errno); };
const enc = new TextEncoder();

const CLONE = {VM: 0x100, VFORK: 0x4000, THREAD: 0x10000, SETTLS: 0x80000};
const WNOHANG = 1;

function exitStatus(code) { return (code & 0xff) << 8; }
function signalStatus(sig) { return sig & 0x7f; }

function writeTime(p, address, ns) {
  p.view.setBigInt64(address, ns / 1000000000n, true);
  p.view.setBigInt64(address + 8, ns % 1000000000n, true);
}

const wall = () => BigInt(Date.now()) * 1000000n;
const monotonic = () => BigInt(Math.round(performance.now() * 1e6));

function wait(p, pid, statusAddress, options) {
  const want = N(pid);
  for (const [child, status] of p.zombies) {
    if (want > 0 && child !== want) continue;
    p.zombies.delete(child);
    if (N(statusAddress)) p.view.setInt32(N(statusAddress), status, true);
    return child;
  }
  // Children always finish inside fork, so nothing else will ever arrive.
  if (N(options) & WNOHANG && p.children.size) return 0;
  fail(E.CHILD);
}

function execve(p, nameAddress, argvAddress, envAddress) {
  const name = p.cstring(N(nameAddress));
  const argv = p.strings(N(argvAddress)), env = p.strings(N(envAddress));
  p.execve(name, argv, env); // throws FsError before replacing anything
  throw new Exec();
}

export const PROC_CALLS = {
  9(addr, len, prot, flags, fd, off) {
    const length = N(len), fixed = N(flags) & 0x10, anonymous = N(flags) & 0x20;
    if (length <= 0) fail(E.INVAL);
    const start = fixed ? N(addr) : this.reserve(length);
    if (fixed) this.bytes.fill(0, start, start + length);
    if (!anonymous) {
      const d = this.fds.get(N(fd));
      if (!d || d.kind !== 'file') fail(E.BADF);
      this.bytes.set(d.node.read(N(off), N(off) + length), start);
    }
    return start;
  },
  10() { return 0; },
  11(addr, len) { this.release(N(addr), N(len)); return 0; },
  12() { return this.mapBase; }, // brk never grows; libc then uses mmap
  13(sig, act, old) {
    const s = N(sig), previous = this.signals.get(s);
    if (N(old)) {
      this.bytes.fill(0, N(old), N(old) + 32);
      if (previous) this.view.setBigUint64(N(old), previous.handler, true);
    }
    if (N(act)) this.signals.set(s, {handler: this.view.getBigUint64(N(act), true)});
    return 0;
  },
  14(how, set, old) { if (N(old)) this.bytes.fill(0, N(old), N(old) + 8); return 0; },
  24() { return 0; },
  25(old, oldLength, newLength, flags) {
    const start = this.reserve(N(newLength));
    this.bytes.copyWithin(start, N(old), N(old) + Math.min(N(oldLength), N(newLength)));
    this.release(N(old), N(oldLength));
    return start;
  },
  26() { return 0; }, 27() { return 0; }, 28() { return 0; },
  34() { fail(E.INTR); },
  35() { return 0; }, // nanosleep: nothing else can run meanwhile
  37() { return 0; },
  39() { return this.pid; },
  56(flags, stack) {
    const f = N(flags);
    if (f & CLONE.THREAD) fail(E.NOSYS);
    return this.fork(this.resumeAt, N(stack) ? BigInt(N(stack)) : 0n);
  },
  57() { return this.fork(this.resumeAt); },
  58() { return this.fork(this.resumeAt); },
  59(name, argv, env) { return execve(this, name, argv, env); },
  60(code) { throw new Exit(exitStatus(N(code))); },
  61(pid, status, options) { return wait(this, pid, status, options); },
  62(pid, sig) {
    const target = N(pid), s = N(sig);
    if (target === this.pid || target === 0 || target === -this.pgid) {
      if (s === 0) return 0;
      const handler = this.signals.get(s)?.handler ?? 0n;
      if (handler === 1n || s === 17 || s === 28) return 0; // ignored, SIGCHLD, SIGWINCH
      throw new Exit(signalStatus(s));
    }
    if (this.zombies.has(target)) return 0;
    fail(E.SRCH);
  },
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
  99(info) { this.bytes.fill(0, N(info), N(info) + 112); return 0; },
  100(buf) { if (N(buf)) this.bytes.fill(0, N(buf), N(buf) + 32); return Number(monotonic() / 10000000n); },
  102() { return 0; }, 104() { return 0; }, 105() { return 0; }, 106() { return 0; },
  107() { return 0; }, 108() { return 0; },
  109(pid, pgid) { if (N(pid) === 0 || N(pid) === this.pid) this.pgid = N(pgid) || this.pid; return 0; },
  110() { return this.ppid; },
  111() { return this.pgid; },
  112() { this.pgid = this.pid; return this.pid; },
  115() { return 0; }, 116() { return 0; },
  117() { return 0; }, 119() { return 0; },
  118(r, e, s) { for (const a of [r, e, s]) if (N(a)) this.view.setUint32(N(a), 0, true); return 0; },
  120(r, e, s) { for (const a of [r, e, s]) if (N(a)) this.view.setUint32(N(a), 0, true); return 0; },
  121() { return this.pgid; },
  124() { return this.pgid; },
  127(set) { this.bytes.fill(0, N(set), N(set) + 8); return 0; },
  130() { fail(E.INTR); },
  131() { return 0; },
  157() { return 0; },
  158(code, addr) {
    if (N(code) === 0x1002) { this.instance.exports.fs.value = addr; return 0; } // ARCH_SET_FS
    if (N(code) === 0x1003) { this.view.setBigUint64(N(addr), this.instance.exports.fs.value, true); return 0; }
    fail(E.INVAL);
  },
  160() { return 0; },
  186() { return this.pid; },
  201(t) { const s = wall() / 1000000000n; if (N(t)) this.view.setBigInt64(N(t), s, true); return s; },
  202() { return 0; }, // futex: one thread
  218() { return this.pid; },
  228(clock, ts) { writeTime(this, N(ts), N(clock) === 0 ? wall() : monotonic()); return 0; },
  229(clock, ts) { if (N(ts)) writeTime(this, N(ts), 1n); return 0; },
  230() { return 0; },
  231(code) { throw new Exit(exitStatus(N(code))); },
  234(tgid, tid, sig) { return PROC_CALLS[62].call(this, tid, sig); },
  273() { return 0; },
  302(pid, resource, next, old) {
    if (N(old)) { this.view.setBigInt64(N(old), -1n, true); this.view.setBigInt64(N(old) + 8, -1n, true); }
    return 0;
  },
  318(buf, len) {
    const n = Math.min(N(len), 65536);
    crypto.getRandomValues(this.bytes.subarray(N(buf), N(buf) + n));
    return n;
  },
  334() { fail(E.NOSYS); }, // rseq
  435() { fail(E.NOSYS); }, // clone3: libc falls back to clone
  436() { return 0; },
};
