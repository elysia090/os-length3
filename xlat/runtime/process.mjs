// Processes and threads for translated programs. There is no machine to
// boot: a process starts at its ELF entry with a SysV stack and its system
// calls land in the tables of sys-file.mjs, sys-proc.mjs and signal.mjs.
//
// Every process runs at once with every other, as on Linux: fork returns
// in the parent at once and the child is one more thread to run; a call
// that must wait (input not typed yet, a child still running, a full pipe)
// leaves its thread waiting, and the kernel makes the call again when
// something changed, so whatever can run, runs. Threads (clone with
// CLONE_VM) share their process's memory and run the same way.
//
// Where the threads run is the kernel's choice of backend:
//   - here, in this thread (the default): one thread at a time, each until
//     it waits, or for a time slice measured at its system calls. A call
//     that waits unwinds the wasm stack and the thread goes on after its
//     syscall instruction once the call is done; nothing is suspended, so no
//     shared memory is needed (remote.mjs says how this is used when it is).
//   - in Workers (remote.mjs), each thread in its own, all at once, with
//     memory shared (SharedArrayBuffer) and system calls made to this
//     kernel through Atomics: preempted by the host, as a Linux thread is.

import {Fpu} from './fpu.mjs';
import {Description, FdTable} from './fd.mjs';
import {E, FsError, Vfs, loadedFiles} from './fs.mjs';
import {FILE_CALLS} from './sys-file.mjs';
import {PROC_CALLS} from './sys-proc.mjs';
import {lay, prepare} from './share.mjs';
import {CLD, SA, SIG, SIGNAL_CALLS, Pending, SI, actionOf, bit, deliverable, send, take} from './signal.mjs';

const PAGE = 4096;
const WASM_PAGE = 65536;
const STACK_BYTES = 8 << 20;
const GUARD = 1 << 16;

const CALLS = {...FILE_CALLS, ...PROC_CALLS, ...SIGNAL_CALLS};
const dec = new TextDecoder(), enc = new TextEncoder();

/** How long a thread runs before another that can run gets a turn (checked at the calls in YIELDS). */
const SLICE = 10;
/** Calls a thread may be made to wait at for another's turn: ones that may wait anyway, so nothing a program relies on across them (its flags) is held. */
const YIELDS = new Set([0, 1, 7, 17, 18, 19, 20, 23, 24, 35, 61, 202, 230, 232, 247, 270, 271, 281]);
/** Calls Linux makes again after a handler with SA_RESTART (the rest say EINTR). */
const RESTARTS = new Set([0, 1, 2, 16, 17, 18, 19, 20, 61, 72, 73, 202, 247, 257, 295, 296]);

export class GuestTrap extends Error {
  constructor(address, code) {
    const kind = {1: 'jump to untranslated code', 2: 'undecodable code', 3: 'unsupported instruction', 4: 'divide error'}[code] ?? `trap ${code}`;
    super(`${kind} at 0x${address.toString(16)}`);
    this.address = address;
    this.code = code;
  }
}

/**
 * The signal a fault in guest code ends its process with: an instruction
 * that cannot run (SIGILL), a crash on purpose (hlt, as musl's a_crash,
 * SIGSEGV as Linux gives it), a divide error (SIGFPE), a stray access out
 * of its memory (SIGSEGV). Null for anything else, which is the host's.
 */
export function fault(e) {
  if (e instanceof GuestTrap) return {1: 4, 2: 4, 3: 11, 4: 8}[e.code] ?? 4;
  if (e instanceof WebAssembly.RuntimeError && /out of bounds|unreachable/i.test(e.message)) return 11;
  return null;
}

/** Thrown through wasm frames once the thread (or its whole process) has ended. */
export class Exit { constructor(status) { this.status = status; } }
/** Thrown through wasm frames after execve replaced the image. */
export class Exec {}
/** Thrown by a system call that must wait; the kernel makes the call again later. */
export class Wait {}
/** Thrown through wasm frames once a thread's registers were replaced (a signal handler, sigreturn): it goes on at resumeAt. */
export class Redirect {}
/** What attempt() says of a call that waits. */
const WAITS = Symbol('waits');

const u64s = (module, name) => {
  const [s] = WebAssembly.Module.customSections(module, name);
  return s ? new BigUint64Array(s.slice(0)) : new BigUint64Array(0);
};

/**
 * A loaded program: its first module, its loader facts, and the code reached
 * later. A jump to code the first translation did not find asks the host
 * (the module's `miss`), which translates from there into one more module
 * that shares everything with the first; every process of the program then
 * uses it, and nothing is translated twice.
 */
export class Image {
  constructor(module, source = null, size = 0, segments = null) {
    this.module = module;
    // Its data, when kept outside the module (share.mjs): exec lays it in memory, and an instance writes nothing.
    this.segments = segments;
    this.source = source; // () => the ELF's bytes, for code reached later
    this.size = size; // bytes of wasm made for it (what its translations hold, before the engine compiles them)
    const section = (name) => dec.decode(WebAssembly.Module.customSections(module, name)[0]);
    this.facts = JSON.parse(section('xlat.facts'));
    this.fpuOps = section('xlat.fpu').split(',');
    this.known = new Set(u64s(module, 'xlat.starts'));
    this.slots = this.known.size; // the first module's table
    this.extras = []; // {module, base, count, bytes}
    this.entries = new Map(); // address -> function slot << 32 | block, for code reached later
  }

  /** Translate the code at `address` into one more module; false if there is none to be had. */
  more(translateMore, address, prepare = (w) => ({wasm: w})) {
    if (!translateMore || !this.source) return false;
    let t = performance.now();
    // The starts known go as they are: the translator reads them only when it opens the ELF (it keeps them after).
    const wasm = prepare(translateMore(this.source(), [address], this.known, this.slots)).wasm;
    PROFILE.translate += performance.now() - t; t = performance.now();
    const module = new WebAssembly.Module(wasm);
    PROFILE.compile += performance.now() - t; PROFILE.modules++; PROFILE.bytes += wasm.length;
    const starts = u64s(module, 'xlat.starts');
    if (!starts.length) return false;
    const entries = u64s(module, 'xlat.entries');
    for (let k = 0; k < entries.length; k += 2) this.entries.set(entries[k], entries[k + 1]);
    for (const a of starts) this.known.add(a);
    this.extras.push({module, base: this.slots, count: starts.length, bytes: wasm});
    this.size += wasm.length;
    this.slots += starts.length;
    return this.entries.has(address);
  }
}

export class Kernel {
  /**
   * vfs: the filesystem. translate(bytes) -> wasm bytes for an ELF.
   * console: {write(fd, bytes), read(n) -> Uint8Array | null (nothing yet), ready?(), interactive?}.
   */
  constructor({vfs = new Vfs(), translate, console}) {
    this.vfs = vfs;
    this.translate = translate;
    // Code reached later, when the translator can do it: translate.more(elf, seeds, known, base).
    this.translateMore = translate?.more ?? null;
    this.console = console;
    this.nextPid = 1;
    this.images = new Map(); // File node -> {version, image, used, kept}
    this.uses = 0; // counts loads, so the least recently used image is known
    // What may be kept for programs run again (translations, the translator, root files read) once nothing runs them.
    this.budget = 256 << 20;
    this.procs = new Map(); // pid -> Process (live, or a zombie until waited for)
    this.tasks = new Map(); // tid -> Task
    this.runq = []; // threads that can run here, in turn
    this.blocked = new Set(); // threads in a call that waits
    this.futexes = new Map(); // memory -> Map(address -> Set of waiters)
    this.dirty = false; // something changed that a waiting call may be waiting for
    this.current = null; // the thread running here, if any
    // The console as a terminal: its session and the group in front (Ctrl-C goes to it).
    this.tty = {sid: 0, fg: 0};
    this.status = null; // init's wait status once it ended
    this.shared = false; // memories are SharedArrayBuffers (remote.mjs)
    this.timers = new Set(); // {at, fire}: alarms (performance.now() ms)
    // What a program reads of the machine: the memory a process may have (sysinfo says the same) and the CPUs.
    const cpus = Math.max(1, Math.min(64, globalThis.navigator?.hardwareConcurrency ?? 1));
    if (!vfs.resolve('/proc/meminfo', '/').node) {
      const kb = 4 << 20;
      vfs.writeFile('/proc/meminfo', `MemTotal:       ${kb} kB\nMemFree:        ${kb} kB\nMemAvailable:   ${kb} kB\nBuffers:               0 kB\nCached:                0 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n`, 0o444);
    }
    if (!vfs.resolve('/proc/cpuinfo', '/').node) {
      vfs.writeFile('/proc/cpuinfo', Array.from({length: cpus}, (_, k) => `processor\t: ${k}\nvendor_id\t: GenuineIntel\nmodel name\t: xlat x86-64\nflags\t\t: fpu tsc cx8 cmov sse sse2 ssse3 sse4_1 sse4_2 popcnt\n\n`).join(''), 0o444);
    }
  }

  /** The image for an executable file, translating it once per version. */
  image(node) {
    const cached = this.images.get(node);
    if (cached && cached.version === node.version) { cached.used = ++this.uses; return cached.image; }
    // A view of the file, not a copy: a later write to it changes a copy (File.share).
    const bytes = node.share();
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new FsError(E.NOEXEC);
    let t = performance.now();
    const {wasm, segments} = this.prepare(this.translate(bytes));
    PROFILE.translate += performance.now() - t; t = performance.now();
    // Code reached later is read from the very bytes this was translated from (and the translator keeps them parsed by identity).
    const image = new Image(new WebAssembly.Module(wasm), () => bytes, wasm.length, segments);
    PROFILE.compile += performance.now() - t; PROFILE.images++;
    this.images.set(node, {version: node.version, image, used: ++this.uses, kept: false});
    return image;
  }

  /** A translation as it is run here: {wasm, segments} (share.mjs; shared memory when threads run apart). */
  prepare(wasm) { return prepare(wasm, {shared: this.shared}); }

  /**
   * A file whose translation was made ahead of time (by the same translator,
   * from exactly these bytes). It holds only while the file is unchanged; a
   * write makes it translate again.
   */
  prebuilt(node, module, segments = null) {
    let view = null;
    // Kept: nothing here could make it again.
    this.images.set(node, {version: node.version, image: new Image(module, () => (view ??= node.share()), 0, segments), used: ++this.uses, kept: true});
  }

  /** Every live process. */
  live() { return [...this.procs.values()].filter((p) => p.state === 'live'); }

  /** Bytes of guest memory the running processes hold (their wasm memories, each once). */
  memoryBytes() {
    return [...new Set(this.live().map((p) => p.memory).filter(Boolean))].reduce((n, m) => n + m.buffer.byteLength, 0);
  }

  /**
   * What this kernel holds, by kind, and how much of it can go without
   * stopping anything: `guest` (the running processes' memories, exact),
   * `translations` (the wasm made for each program; the engine's compiled
   * code is more, and not visible), `translator` (its memory, exact) and
   * `files` (bytes of root files read, exact). `spare` is what can go:
   * translations no running process uses, the translator's memory (a
   * running program parses its ELF again on its next miss), and files no
   * kept translation reads from.
   */
  held() {
    const using = new Set(this.live().map((p) => p.image));
    let translations = 0, spareTranslations = 0;
    const keep = new Set();
    for (const [node, e] of this.images) {
      translations += e.image.size;
      if (e.kept || using.has(e.image)) keep.add(node);
      else spareTranslations += e.image.size;
    }
    let files = 0, spareFiles = 0;
    for (const f of loadedFiles()) {
      files += f._data.length;
      if (!keep.has(f)) spareFiles += f._data.length;
    }
    const guest = this.memoryBytes(), translator = this.translate?.held?.() ?? 0, spareTranslator = this.translate?.spare?.() ?? translator;
    return {guest, translations, translator, files, spare: spareTranslations + spareTranslator + spareFiles, total: guest + translations + translator + files, spareTranslator};
  }

  /**
   * Give back what nothing running needs, least recently used first, until
   * what can go is at most `budget` bytes (0: all of it). Returns what was
   * held before and after.
   */
  free(budget = 0) {
    const before = this.held();
    if (before.spare <= budget) return {before, after: before};
    const using = new Set(this.live().map((p) => p.image));
    let over = before.spare - budget;
    const spare = [...this.images].filter(([, e]) => !e.kept && !using.has(e.image)).sort((a, b) => a[1].used - b[1].used);
    for (const [node, e] of spare) {
      if (over <= 0) break;
      this.images.delete(node);
      this.translate?.close?.(e.image.source());
      over -= e.image.size;
    }
    if (over > 0 && before.spareTranslator > 0 && this.translate?.renew?.()) over -= before.spareTranslator;
    // A translation that went leaves its program's file spare too: with no budget, every such file goes.
    if (over > 0 || budget === 0) {
      const keep = new Set([...this.images].filter(([, e]) => e.kept || using.has(e.image)).map(([node]) => node));
      for (const f of [...loadedFiles()]) if ((over > 0 || budget === 0) && !keep.has(f)) over -= f.release();
    }
    return {before, after: this.held()};
  }

  /** A new thread of `proc` (the backend's kind). */
  newTask(proc) { return new Task(proc, this.nextPid++); }

  /** Create the first process (pid 1, a session and group of its own, in front on the console). */
  start(path, argv, env, cwd = '/') {
    const p = new Process(this, null);
    p.cwd = cwd;
    ['stdin', 'stdout', 'stderr'].forEach((name, fd) => p.fds.install(new Description('console', {path: name}), {fd}));
    const t = this.newTask(p);
    p.pid = p.pgid = p.sid = t.tid;
    p.tasks.add(t);
    this.procs.set(p.pid, p);
    this.tasks.set(t.tid, t);
    this.tty = {sid: p.sid, fg: p.pgid};
    p.task = t;
    p.execve(path, argv, env);
    this.ready(t);
  }

  // ---- threads in turn (the backend here) ----

  ready(t) { if (!t.dead) { t.state = 'ready'; this.blocked.delete(t); this.runq.push(t); } }
  block(t) { t.state = 'blocked'; this.blocked.add(t); }

  /**
   * Run until every process has exited or every thread waits (for input, a
   * child, or until a time: `until`, in performance.now() ms, the soonest a
   * waiting call times out or a sleep ends). Returns {waiting: true, until?}
   * or {status} of the first process.
   */
  pump() {
    // The host runs it again because something may have changed (input came, a time passed).
    this.dirty = true;
    for (;;) {
      if (this.status !== null) return {status: this.status};
      this.retry();
      const t = this.runq.shift();
      if (!t) {
        if (this.status !== null) return {status: this.status};
        const until = this.deadline();
        return until === undefined ? {waiting: true} : {waiting: true, until};
      }
      this.run(t);
    }
  }

  /** Run `t` here until it waits, yields, or ends. */
  run(t) {
    if (t.dead || t.proc.stopped) { t.state = t.dead ? 'dead' : 'stopped'; return; }
    this.current = t;
    t.state = 'running';
    t.sliceStart = performance.now();
    try {
      // A call it was made to wait at for this turn, first.
      if (t.call) {
        const call = t.call;
        const v = this.attempt(t, call);
        if (v === WAITS) { this.block(t); return; }
        this.resumeWith(t, call, v, false);
        if (t.dead || t.state !== 'running') return;
      } else if (deliverable(t)) {
        take(this, t, t.context());
        if (t.dead || t.proc.stopped) { if (!t.dead) t.state = 'stopped'; return; }
      }
      for (;;) {
        try {
          t.attach();
          t.instance.exports.run(t.resumeAt);
        } catch (e) {
          if (e instanceof Exec || e instanceof Redirect) continue;
          if (e instanceof Wait || e instanceof Exit) return;
          // A fault ends this process only, as a signal would: the shell, and
          // anything else, runs on and sees how it ended.
          const sig = fault(e);
          if (sig) {
            // What the translator cannot run yet is said, so it is not taken for the program's own fault.
            if (e instanceof GuestTrap && (e.code === 1 || e.code === 2)) this.console.write(2, enc.encode(`xlat: ${e.message}\n`));
            else if (TRACE_FAULTS) console.error(`[${t.tid}] fault: ${e.stack}`);
            this.exitProcess(t.proc, sig);
            return;
          }
          throw e;
        }
      }
    } finally {
      this.current = null;
    }
  }

  /**
   * A system call from guest code (here: the module's `syscall` import).
   * Done at once: its value, or the thread goes elsewhere (Redirect, Exit,
   * Exec thrown). To wait: Wait is thrown, and the thread goes on after
   * the call once it is done.
   */
  enter(t, nr, args, next) {
    t.resumeAt = next;
    const call = {nr: Number(nr), args, next, state: {}};
    if (TRACE_SYSCALLS) trace(t, call);
    // Another's turn, if this one has had its time: it makes this call when it runs again.
    if (YIELDS.has(call.nr) && (call.nr === 24 || performance.now() - t.sliceStart > SLICE) && (this.runq.length || this.dirty)) {
      t.call = call;
      this.ready(t);
      throw new Wait();
    }
    const v = this.attempt(t, call);
    if (v === WAITS) { t.call = call; this.block(t); throw new Wait(); }
    if (!t.dead && !t.proc.stopped && !deliverable(t)) return v;
    this.resumeWith(t, call, v, true);
    if (t.dead) throw new Exit();
    if (t.state !== 'running') throw new Wait();
    if (t.redirected) throw new Redirect();
    return v;
  }

  /** Make `call` for `t`: its value, or WAITS. Exit, Exec and Redirect go through. */
  attempt(t, call) {
    const p = t.proc;
    p.task = t;
    p.call = call;
    const handler = CALLS[call.nr];
    if (!handler) return BigInt(-E.NOSYS);
    try {
      const r = handler.apply(p, call.args);
      this.dirty = true;
      const v = typeof r === 'bigint' ? r : BigInt(r);
      if (TRACE_SYSCALLS) console.error(`[${t.tid}]   = ${BigInt.asIntN(64, v)}`);
      return v;
    } catch (error) {
      if (error instanceof FsError) {
        this.dirty = true;
        if (TRACE_SYSCALLS) console.error(`[${t.tid}]   = -${error.errno}`);
        return BigInt(-error.errno);
      }
      if (error instanceof Wait) return WAITS;
      if (error instanceof Exit || error instanceof Exec || error instanceof Redirect) this.dirty = true;
      throw error;
    } finally {
      p.call = null;
    }
  }

  /**
   * `call` of `t` is done with `v`: it goes on after the call, through a
   * handler for a signal it can take now, or not at all (it ended, or its
   * process is stopped). `now`: it is the thread running (enter).
   */
  resumeWith(t, call, v, now) {
    t.call = null;
    this.blocked.delete(t);
    t.redirected = false;
    t.setReg(0, v);
    t.resumeAt = call.next;
    if (deliverable(t)) take(this, t, t.context());
    if (t.dead) return;
    if (t.proc.stopped) { t.state = 'stopped'; return; }
    if (!now) this.go(t);
  }

  /** A thread whose call is done goes on (here: it runs in turn). */
  go(t) { if (this.current === t) t.state = 'running'; else this.ready(t); }

  addTimer(at, fire) { const timer = {at, fire}; this.timers.add(timer); this.dirty = true; return timer; }
  removeTimer(timer) { this.timers.delete(timer); }

  /** Make the waiting calls again while something changed; the ones done go on. */
  retry() {
    for (const timer of [...this.timers]) if (timer.at <= performance.now()) { this.timers.delete(timer); timer.fire(); }
    for (let pass = 0; pass < 64; pass++) {
      const now = performance.now();
      const due = [...this.blocked].some((t) => t.call?.state.deadline !== undefined && t.call.state.deadline <= now);
      if (!this.dirty && !due) return;
      this.dirty = false;
      for (const t of [...this.blocked]) {
        if (!t.call || t.dead || t.proc.stopped || !this.blocked.has(t)) continue;
        const call = t.call;
        let v;
        try { v = this.attempt(t, call); } catch (e) {
          if (e instanceof Exit) continue;
          if (e instanceof Redirect || e instanceof Exec) { t.call = null; this.blocked.delete(t); this.go(t); continue; }
          throw e;
        }
        if (v === WAITS) continue;
        this.resumeWith(t, call, v, false);
      }
    }
  }

  /** The soonest a waiting call times out (performance.now() ms), if any does. */
  deadline() {
    let until;
    for (const timer of this.timers) if (until === undefined || timer.at < until) until = timer.at;
    for (const t of this.blocked) {
      const d = t.call?.state.deadline;
      if (d !== undefined && !t.proc.stopped && (until === undefined || d < until)) until = d;
    }
    return until;
  }

  /**
   * A signal `t` can take came while it waits in a call. One with a handler
   * interrupts the call: what it moved already is its value, or it is made
   * again after the handler (SA_RESTART, for a call Linux restarts), or it
   * says EINTR; then the thread goes on in the handler.
   */
  interruptCall(t) {
    const call = t.call;
    if (!call || t.dead || t.proc.stopped) return;
    const sig = this.peek(t);
    if (!sig) return;
    const a = actionOf(t.proc, sig);
    if (a.handler <= 1n) return; // ignored, or its default (which send() did already if it ends or stops)
    const s = call.state;
    s.cancel?.();
    t.call = null;
    this.blocked.delete(t);
    const ctx = t.context();
    if (s.done > 0) { ctx.regs[0] = BigInt(s.done); ctx.rip = call.next; }
    else if (a.flags & SA.RESTART && RESTARTS.has(call.nr) && !s.timed) { ctx.regs[0] = BigInt(call.nr); ctx.rip = call.next - 2n; }
    else { ctx.regs[0] = BigInt(-E.INTR); ctx.rip = call.next; s.interrupted?.(); }
    t.setContext(ctx.regs, ctx.rip);
    t.redirected = false;
    take(this, t, t.context());
    if (t.dead) return;
    if (t.proc.stopped) { t.state = 'stopped'; return; }
    this.go(t);
  }

  /** The signal `t` would take next, without taking it. */
  peek(t) {
    const m = (t.pending.mask | t.proc.pending.mask) & ~t.mask;
    for (let sig = 1; sig <= 64; sig++) if (m & bit(sig)) return sig;
    return 0;
  }

  // ---- processes coming and going ----

  /** The live processes of group `pgid`. */
  group(pgid) { return this.live().filter((p) => p.pgid === pgid); }

  /** One thread ends: its tid is cleared and woken for (CLONE_CHILD_CLEARTID), its robust futexes marked; the last one ends its process. */
  exitThread(t, status) {
    if (t.dead) return;
    const p = t.proc;
    this.endTask(t);
    p.tasks.delete(t);
    if (!p.tasks.size) this.exitProcess(p, status);
  }

  endTask(t) {
    if (t.dead) return;
    t.dead = true;
    t.state = 'dead';
    t.call?.state.cancel?.();
    t.call = null;
    this.blocked.delete(t);
    const at = this.runq.indexOf(t);
    if (at >= 0) this.runq.splice(at, 1);
    this.tasks.delete(t.tid);
    const p = t.proc;
    if (p.memory) {
      try { robustExit(this, t); } catch { /* a list it broke is its own */ }
      if (t.clearTid) {
        try { p.view.setInt32(t.clearTid, 0, true); } catch { /* gone */ }
        this.futexWake(p.memory, t.clearTid, 1, -1);
      }
    }
    t.end();
    this.dirty = true;
  }

  /** A process ends with wait status `status`: its threads, its files; its parent is told, and its children go to init. */
  exitProcess(p, status) {
    if (p.state !== 'live') return;
    p.state = 'zombie';
    p.exitStatus = status;
    p.stopped = 0;
    if (p.alarm) { this.removeTimer(p.alarm.timer); p.alarm = null; }
    for (const t of [...p.tasks]) this.endTask(t);
    p.tasks.clear();
    p.fds.closeAll();
    this.releaseVfork(p);
    this.dirty = true;
    if (p.pid === 1 || p.pid === this.initPid) {
      // Init is gone: everything else goes with it (a PID namespace's end).
      for (const q of this.live()) this.exitProcess(q, SIG.KILL);
      this.status = status;
      this.procs.clear();
      this.runq.length = 0;
      this.blocked.clear();
      this.stopped?.();
      return;
    }
    const init = this.procs.get(1);
    for (const c of p.children) {
      c.ppid = 1;
      if (init?.state === 'live') init.children.add(c); else if (c.state === 'zombie') this.procs.delete(c.pid);
    }
    p.children.clear();
    const parent = this.procs.get(p.ppid);
    const signalled = status & 0x7f;
    const info = {signo: SIG.CHLD, code: signalled ? CLD.KILLED : CLD.EXITED, pid: p.pid, uid: 0, status: signalled ? signalled : status >> 8};
    if (!parent || parent.state !== 'live') { this.procs.delete(p.pid); return; }
    const a = actionOf(parent, SIG.CHLD);
    // A parent that ignores SIGCHLD (or says SA_NOCLDWAIT) leaves no zombie (POSIX).
    if (a.handler === 1n || a.flags & SA.NOCLDWAIT) { parent.children.delete(p); this.procs.delete(p.pid); }
    if (p.exitSignal) send(this, parent, p.exitSignal, info);
  }

  /** A child made with CLONE_VFORK exec'd or ended: its parent goes on. */
  releaseVfork(p) {
    if (p.vfork) { p.vfork.released = true; p.vfork = null; this.dirty = true; }
  }

  stopProcess(p, sig) {
    if (p.state !== 'live' || p.stopped) return;
    p.stopped = sig;
    p.report = {kind: 'stopped', sig, seen: false};
    for (const t of p.tasks) {
      const at = this.runq.indexOf(t);
      if (at >= 0) { this.runq.splice(at, 1); t.state = 'stopped'; }
      t.stop?.();
    }
    this.dirty = true;
    const parent = this.procs.get(p.ppid);
    if (parent?.state === 'live' && !(actionOf(parent, SIG.CHLD).flags & SA.NOCLDSTOP)) send(this, parent, SIG.CHLD, {code: CLD.STOPPED, pid: p.pid, uid: 0, status: sig});
  }

  continueProcess(p) {
    if (!p.stopped) return;
    p.stopped = 0;
    p.report = {kind: 'continued', seen: false};
    for (const t of p.tasks) {
      if (t.dead || t.state !== 'stopped') continue;
      if (t.call) this.block(t); else this.go(t);
      t.cont?.();
    }
    this.dirty = true;
    const parent = this.procs.get(p.ppid);
    if (parent?.state === 'live' && !(actionOf(parent, SIG.CHLD).flags & SA.NOCLDSTOP)) send(this, parent, SIG.CHLD, {code: CLD.CONTINUED, pid: p.pid, uid: 0, status: SIG.CONT});
  }

  // ---- futexes ----

  futexQueue(memory, address) {
    let m = this.futexes.get(memory);
    if (!m) this.futexes.set(memory, (m = new Map()));
    let q = m.get(address);
    if (!q) m.set(address, (q = new Set()));
    return q;
  }

  /** Wake up to `n` waiters on `address` whose bitset meets `bitset`; how many. */
  futexWake(memory, address, n, bitset) {
    const q = this.futexes.get(memory)?.get(address);
    if (!q) return 0;
    let woken = 0;
    for (const w of q) {
      if (woken >= n) break;
      if (!(w.bitset & bitset)) continue;
      q.delete(w);
      w.woken = true;
      woken++;
    }
    if (!q.size) this.futexes.get(memory).delete(address);
    if (woken) this.dirty = true;
    return woken;
  }

  /** Move up to `n` waiters from one address to another; how many. */
  futexRequeue(memory, from, to, n) {
    const q = this.futexes.get(memory)?.get(from);
    if (!q) return 0;
    let moved = 0;
    for (const w of q) {
      if (moved >= n) break;
      q.delete(w);
      w.address = to;
      this.futexQueue(memory, to).add(w);
      moved++;
    }
    return moved;
  }

  // ---- the console ----

  /**
   * Ctrl-C: SIGINT to the group in front on the console (the shell's own,
   * unless a shell with job control put a job there). An interactive shell
   * survives it; what it runs does not, as at a terminal. False when there
   * was nobody to send it to.
   */
  interrupt(sig = SIG.INT) {
    const group = this.group(this.tty.fg);
    if (!group.length) return false;
    for (const p of group) send(this, p, sig, {code: SI.KERNEL});
    return true;
  }

  /** Start and run to the end; for hosts whose input is all known up front (a sleep is waited out here). */
  spawn(path, argv, env, cwd = '/') {
    this.start(path, argv, env, cwd);
    let r = this.pump();
    while (r.waiting && r.until !== undefined) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, r.until - performance.now()));
      r = this.pump();
    }
    if (r.waiting) throw new Error(`process waits for input that will never come (${[...this.blocked].map((t) => `${t.tid}:${t.call?.nr}`).join(' ')})`);
    return r.status;
  }
}

/** On a thread's exit, each robust futex it holds says its owner died, and one waiter is woken (Linux's exit_robust_list). */
function robustExit(kernel, t) {
  if (!t.robust) return;
  const p = t.proc, v = p.view;
  const head = t.robust;
  const offset = Number(v.getBigInt64(head + 8, true));
  const pending = Number(v.getBigUint64(head + 16, true) & ~1n);
  const mark = (entry) => {
    const at = entry + offset;
    const word = v.getUint32(at, true);
    if ((word & 0x3fffffff) !== t.tid) return;
    v.setUint32(at, (word & 0x80000000) | 0x40000000, true); // FUTEX_OWNER_DIED, waiters kept
    if (word & 0x80000000) kernel.futexWake(p.memory, at, 1, -1);
  };
  let entry = Number(v.getBigUint64(head, true) & ~1n);
  for (let n = 0; entry !== head && entry && n < 2048; n++) {
    const next = Number(v.getBigUint64(entry, true) & ~1n);
    if (entry !== pending) mark(entry);
    entry = next;
  }
  if (pending) mark(pending);
}

export class Process {
  constructor(kernel, parent) {
    this.kernel = kernel;
    this.pid = 0;
    this.ppid = parent?.pid ?? 0;
    this.pgid = parent?.pgid ?? 0;
    this.sid = parent?.sid ?? 0;
    this.fds = parent ? parent.fds.fork() : new FdTable();
    this.cwd = parent?.cwd ?? '/';
    this.umask = parent?.umask ?? 0o022;
    this.children = new Set(); // Process
    this.tasks = new Set(); // its threads
    this.actions = new Map(parent?.actions ?? []); // signal -> {handler, flags, restorer, mask}
    this.pending = new Pending();
    this.state = 'live'; // or 'zombie', once it ended and until it is waited for
    this.exitStatus = undefined;
    this.exitSignal = SIG.CHLD;
    this.stopped = 0; // the signal that stopped it
    this.report = null; // a stop or continue not yet waited for
    this.vfork = null; // {released}: its parent waits on this (CLONE_VFORK)
    this.task = null; // the thread whose call runs now
    this.call = null; // that call: {nr, args, next, state}
  }

  /** Make one system call as this process's thread (or as a thread of it that has none yet), as the dispatcher does. */
  syscall(nr, a, b, c, d, e, f, next = 0n) {
    const t = [...this.tasks][0] ?? {proc: this, tid: this.pid};
    const v = this.kernel.attempt(t, {nr: Number(nr), args: [a, b, c, d, e, f], next, state: {}});
    if (v === WAITS) throw new Wait();
    return v;
  }

  // ---- memory ----

  get bytes() { return new Uint8Array(this.memory.buffer); }
  get view() { return new DataView(this.memory.buffer); }

  cstring(address) {
    const b = this.bytes;
    let end = address;
    while (b[end]) end++;
    return dec.decode(b.slice(address, end));
  }

  /** NULL-terminated array of string pointers. */
  strings(address) {
    const out = [];
    if (!address) return out;
    for (let at = address; ; at += 8) {
      const p = Number(this.view.getBigUint64(at, true));
      if (!p) return out;
      out.push(this.cstring(p));
    }
  }

  reserve(length) {
    length = Math.ceil(length / PAGE) * PAGE;
    const k = this.free.findIndex((r) => r.length >= length);
    if (k >= 0) {
      const r = this.free[k];
      this.free.splice(k, 1);
      if (r.length > length) this.free.push({start: r.start + length, length: r.length - length});
      this.bytes.fill(0, r.start, r.start + length);
      return r.start;
    }
    const start = this.mapEnd;
    const need = start + length - this.memory.buffer.byteLength;
    if (need > 0) this.memory.grow(Math.ceil(need / WASM_PAGE));
    this.mapEnd += length;
    return start;
  }

  release(start, length) {
    if (start >= this.mapBase) this.free.push({start, length: Math.ceil(length / PAGE) * PAGE});
  }

  /** A memory for this process of `pages` wasm pages (shared between threads where the backend runs them apart). */
  newMemory(pages) {
    return new WebAssembly.Memory({initial: pages, maximum: 65536, ...(this.kernel.shared ? {shared: true} : {})});
  }

  // ---- images ----

  /**
   * Replace the image (the calling thread's, `this.task`). Throws FsError
   * before replacing anything; on success the old image is gone, every
   * other thread with it, and the calling thread starts at the entry.
   */
  execve(path, argv, env) {
    let node = this.kernel.vfs.lookup(path, this.cwd);
    if (!node.isFile) throw new FsError(node.isDir ? E.ACCES : E.NOEXEC);
    if (!(node.mode & 0o111)) throw new FsError(E.ACCES);
    const head = node.read(0, 128);
    if (head[0] === 0x23 && head[1] === 0x21) {
      // #!interpreter [arg]
      const line = dec.decode(head).split('\n')[0].slice(2).trim();
      const [interpreter, ...rest] = line.split(/\s+/);
      return this.execve(interpreter, [interpreter, ...rest.slice(0, 1), path, ...argv.slice(1)], env);
    }
    const image = this.kernel.image(node);
    const f = image.facts;
    // The point of no return: the other threads go (Linux's de_thread), and so does a memory shared with a vfork parent.
    const t = this.task;
    for (const other of [...this.tasks]) if (other !== t) { this.kernel.endTask(other); this.tasks.delete(other); }
    this.image = image;
    this.stackLow = Math.ceil((f.imageEnd + GUARD) / PAGE) * PAGE;
    this.stackTop = this.stackLow + STACK_BYTES;
    this.mapBase = Math.ceil((this.stackTop + GUARD) / WASM_PAGE) * WASM_PAGE;
    this.mapEnd = this.mapBase;
    this.free = [];
    this.fixed = []; // MAP_FIXED mappings below mapBase
    this.memory = this.newMemory(this.mapBase / WASM_PAGE);
    this.argv = argv;
    this.fds.exec();
    // Handled signals go back to their default; ignored ones stay ignored.
    for (const [sig, h] of this.actions) if (h.handler > 1n) this.actions.delete(sig);
    t.altstack = {sp: 0n, size: 0n, flags: 2};
    if (image.segments) lay(this.bytes, image.segments);
    t.load(image, this.memory);
    t.setReg(4, BigInt(this.stack(argv, env)));
    t.resumeAt = BigInt(f.entry);
    t.redirected = true;
    this.kernel.releaseVfork(this);
  }

  /** SysV entry stack: argc, argv, envp, auxv, then the strings. */
  stack(argv, env) {
    let top = this.stackTop;
    const put = (bytes) => { top -= bytes.length; this.bytes.set(bytes, top); return top; };
    const strings = (list) => list.map((s) => put(enc.encode(s + '\0')));
    const random = put(crypto.getRandomValues(new Uint8Array(16)));
    const execfn = put(enc.encode((argv[0] ?? '') + '\0'));
    const envp = strings(env), args = strings(argv);
    const f = this.image.facts;
    const aux = [[3, f.phdr], [4, f.phent], [5, f.phnum], [6, PAGE], [9, f.entry], [11, 0], [12, 0], [13, 0], [14, 0],
      [23, 0], [25, random], [31, execfn], [0, 0]];
    const words = [args.length, ...args, 0, ...envp, 0, ...aux.flat()];
    top = (top - words.length * 8) & ~15;
    words.forEach((w, k) => this.view.setBigUint64(top + k * 8, BigInt(w), true));
    return top;
  }

  // ---- fork ----

  /**
   * Copy what this process can be using into `child`: the image, the stack
   * from just under the stack pointer (the 128-byte red zone) to its top,
   * everything mapped, and fixed mappings placed elsewhere. The untouched
   * rest of the 8 MiB stack and the room below the image stay zero, as
   * they are in the parent.
   */
  copyLive(child) {
    const from = this.bytes, to = child.bytes;
    const span = (a, b) => { if (b > a) to.set(from.subarray(a, b), a); };
    const f = this.image.facts;
    span(f.imageStart ?? 0, Math.min(f.imageEnd, this.stackLow));
    const sp = Number(BigInt.asUintN(64, this.task.reg(4)));
    const low = sp > this.stackLow && sp <= this.stackTop ? Math.max(this.stackLow, (sp - 128) & ~15) : this.stackLow;
    span(low, this.mapBase);
    span(this.mapBase, from.length);
    for (const r of this.fixed) span(r.start, Math.min(r.start + r.length, this.mapBase));
  }

  /**
   * A new process from this one (fork, vfork, clone without CLONE_THREAD),
   * starting at `resume` with `stack` (0: the caller's) and rax 0. Its
   * memory is a copy, or this very memory with CLONE_VM. It is ready to run.
   */
  forkProcess(resume, {stack = 0n, vm = false, files = false, exitSignal = SIG.CHLD, tls = null, clearTid = 0, parent = false} = {}) {
    const k = this.kernel, t = this.task;
    const child = new Process(k, this);
    const up = parent ? k.procs.get(this.ppid) ?? this : this;
    child.ppid = up.pid;
    if (files) child.fds = this.fds;
    const ct = k.newTask(child);
    child.pid = ct.tid;
    child.exitSignal = exitSignal;
    child.image = this.image;
    for (const key of ['stackLow', 'stackTop', 'mapBase', 'mapEnd', 'argv']) child[key] = this[key];
    child.free = this.free.map((r) => ({...r}));
    child.fixed = this.fixed.map((r) => ({...r}));
    if (vm) child.memory = this.memory;
    else {
      child.memory = child.newMemory(this.memory.buffer.byteLength / WASM_PAGE);
      // Instantiating writes the image's first data; the parent's memory goes
      // over it afterwards, so the child sees what the parent changed.
    }
    ct.mask = t.mask;
    ct.load(this.image, child.memory, t);
    if (!vm) this.copyLive(child);
    const regs = t.context().regs;
    regs[0] = 0n;
    if (stack) regs[4] = stack;
    if (tls !== null) regs[16] = tls;
    ct.setContext(regs, resume);
    ct.redirected = false;
    ct.clearTid = clearTid;
    child.tasks.add(ct);
    up.children.add(child);
    k.procs.set(child.pid, child);
    k.tasks.set(ct.tid, ct);
    k.go(ct);
    return child;
  }

  /** A new thread of this process (clone with CLONE_THREAD): the caller's registers, rax 0, on `stack`. */
  newThread(resume, stack, tls) {
    const k = this.kernel, t = this.task;
    const nt = k.newTask(this);
    nt.mask = t.mask;
    nt.load(this.image, this.memory, t);
    const regs = t.context().regs;
    regs[0] = 0n;
    if (stack) regs[4] = stack;
    if (tls !== null) regs[16] = tls;
    nt.setContext(regs, resume);
    nt.redirected = false;
    this.tasks.add(nt);
    k.tasks.set(nt.tid, nt);
    return nt;
  }
}

/** A thread: its registers (a wasm instance's globals here), its signal mask and pending signals, its x87. */
export class Task {
  constructor(proc, tid) {
    this.proc = proc;
    this.kernel = proc.kernel;
    this.tid = tid;
    this.mask = 0n;
    this.savedMask = null; // the mask to come back to after a handler (rt_sigsuspend)
    this.pending = new Pending();
    this.altstack = {sp: 0n, size: 0n, flags: 2};
    this.clearTid = 0; // CLONE_CHILD_CLEARTID / set_tid_address
    this.robust = 0; // set_robust_list
    this.call = null; // the call it waits in: {nr, args, next, state}
    this.resumeAt = 0n;
    this.redirected = false; // its registers were replaced since its call
    this.state = 'new';
    this.dead = false;
    this.trail = null;
  }

  /** Run `image` over `memory` from here on (exec, or a new thread or process copying `from`). */
  load(image, memory, from = null) {
    this.image = image;
    this.fpu = from ? from.fpu.clone(() => this.bytes) : new Fpu(() => this.bytes, image.fpuOps);
    this.memory = memory;
    // A module that carries its data writes it as it is instantiated: over a memory in use (a thread's, a vfork
    // child's), what the image holds now is put back.
    const keep = from && !image.segments && from.memory === memory ? this.bytes.slice(image.facts.imageStart ?? 0, image.facts.imageEnd) : null;
    this.instance = new WebAssembly.Instance(image.module, this.imports());
    if (keep) this.bytes.set(keep, image.facts.imageStart ?? 0);
    this.attached = 0;
    this.attach();
  }

  get bytes() { return new Uint8Array(this.memory.buffer); }

  imports() {
    return {env: {
      memory: this.memory,
      syscall: (nr, a, b, c, d, e, f, next) => this.kernel.enter(this, nr, [a, b, c, d, e, f], next),
      trap: (address, code) => { throw new GuestTrap(address, code); },
      div128: (hi, lo, d, signed) => div128(hi, lo, d, signed),
      clock: () => BigInt(Math.round(performance.now() * 1e6)),
      fpu: (op, size, address, a, b) => this.fpu.call(op, size, address, a, b),
      trace: (address) => { if (TRACE_BLOCKS) console.error(`[${this.tid}] block 0x${BigInt.asUintN(64, BigInt(address)).toString(16)}`); else if (this.trail) this.trail[this.trailAt++ & 255] = address; },
      miss: (address) => this.miss(address),
    }};
  }

  /** Instantiate the modules made since this thread last looked (by it or another). */
  attach() {
    const extras = this.image.extras;
    if (this.attached >= extras.length) return;
    const {table} = this.instance.exports;
    const env = this.imports().env;
    for (; this.attached < extras.length; this.attached++) {
      const x = extras[this.attached];
      // Doubling, so a program reaching its code a function at a time grows the table a few times, not once a module.
      if (table.length < x.base + x.count) table.grow(Math.max(x.base + x.count - table.length, table.length));
      const own = new WebAssembly.Instance(x.module, {env, main: this.instance.exports}).exports.table;
      for (let k = 0; k < x.count; k++) table.set(x.base + k, own.get(k));
    }
  }

  /** dispatch found no translated code at `address`: find or make it, else -1. */
  miss(address) {
    let at = this.image.entries.get(address);
    if (at === undefined && this.image.more(this.kernel.translateMore, address, (w) => this.kernel.prepare(w))) at = this.image.entries.get(address);
    if (at === undefined) return -1n;
    this.attach();
    return at;
  }

  // ---- registers: 0..15 as x86 numbers them (rax, rcx, rdx, rbx, rsp, rbp, rsi, rdi, r8..r15), 16 fs, 17 the flags, 18 the rest of rflags and MXCSR ----

  reg(n) { return this.instance.exports[REG[n]]?.value ?? 0n; }
  setReg(n, v) { const g = this.instance.exports[REG[n]]; if (g) g.value = BigInt.asIntN(64, BigInt(v)); }
  /** Its registers and where it goes on. */
  context() { return {regs: REG.map((_, n) => this.reg(n)), rip: this.resumeAt}; }
  /** Go on at `rip` with `regs`. */
  setContext(regs, rip) {
    regs.forEach((v, n) => this.setReg(n, v));
    this.resumeAt = BigInt(rip);
    this.redirected = true;
  }
  /** It ended (the backend lets go of what ran it). */
  end() {}
}

// 18: what a translation keeps of rflags beyond fl and of MXCSR (DF, AC, ID), when it has it.
export const REG = [...Array.from({length: 16}, (_, n) => `r${n}`), 'fs', 'fl', 'rf'];

/** Where the time went (run.mjs prints it with XLAT_TIMING=1): translating, compiling wasm, how much, and what a pack root fetched. */
export const PROFILE = {images: 0, modules: 0, bytes: 0, translate: 0, compile: 0, fetches: 0, fetched: 0};
/** XLAT_SYSCALLS=1 lists every system call on stderr (node only). */
const TRACE_SYSCALLS = typeof process !== 'undefined' && !!process.env?.XLAT_SYSCALLS;
/** XLAT_FAULTS=1 says what each fault that ends a process was (node only). */
const TRACE_FAULTS = typeof process !== 'undefined' && !!process.env?.XLAT_FAULTS;
/** XLAT_BLOCKS=1 lists every block entered (node only; run.mjs then translates with --trace). */
const TRACE_BLOCKS = typeof process !== 'undefined' && !!process.env?.XLAT_BLOCKS;
/** Which argument of a call names a path (0: the first, 1: the second, after a directory). */
const PATH_ARG = {2: 0, 4: 0, 6: 0, 21: 0, 59: 0, 80: 0, 83: 0, 84: 0, 87: 0, 89: 0, 257: 1, 262: 1, 263: 1, 269: 1, 439: 1};

function trace(t, call) {
  // A path in the first argument (or the second, for the *at calls) is shown as text.
  const at = PATH_ARG[call.nr];
  let path = '';
  try { if (at !== undefined) path = ` "${t.proc.cstring(Number(BigInt.asUintN(64, call.args[at])))}"`; } catch { /* not a string */ }
  console.error(`[${t.tid}] syscall ${call.nr}${CALLS[call.nr] ? '' : ' (none)'} ${call.args.slice(0, 3).map((x) => '0x' + BigInt.asUintN(64, x).toString(16)).join(' ')}${path}`);
}

export function div128(hi, lo, d, signed) {
  let n = (BigInt.asUintN(64, hi) << 64n) | BigInt.asUintN(64, lo);
  let divisor = BigInt.asUintN(64, d);
  if (signed) { n = BigInt.asIntN(128, n); divisor = BigInt.asIntN(64, divisor); }
  if (divisor === 0n) throw new GuestTrap(0n, 4);
  const q = n / divisor, r = n % divisor;
  if (signed ? BigInt.asIntN(64, q) !== q : BigInt.asUintN(64, q) !== q) throw new GuestTrap(0n, 4);
  return [BigInt.asIntN(64, q), BigInt.asIntN(64, r)];
}
