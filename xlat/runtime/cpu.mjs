// One guest thread in a Worker of its own (remote.mjs is the kernel's
// side). It runs translated code over the process's memory, shared with
// the kernel and with the process's other threads, and makes each system
// call to the kernel through a channel (a SharedArrayBuffer): the call and
// the registers are written there, the kernel is rung, and this thread
// waits on the channel (Atomics.wait) until the kernel answers: a value, or
// registers to go on with elsewhere (a signal handler, sigreturn), or that
// its image was replaced (exec: a 'run' message brings the new one), or
// nothing (the thread ended; the kernel ends this Worker).
//
// The threads of one process take turns at a lock in shared memory (taken
// while guest code runs, let go at each call): the translator lowers
// `lock`-prefixed instructions to plain loads and stores, which are atomic
// only while no other thread of the process runs.

import {CH, OP, OUTBOX_BYTES, Outbox, READS_REGS, REPLY, REGS, rouse, sleep, watch} from './channel.mjs';
import {Fpu} from './fpu.mjs';
import {answerTime, clocks} from './clock.mjs';
import {INTERRUPT, KEEP_INSTANCES, Preempted, SHARES, SLICE_LOOPS, TRAP_YIELD, div128, fault, nextSlice, translatorsLimit, trapOrPreempt} from './process.mjs';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const port = isNode ? (await import('node:worker_threads')).parentPort : self;
const listen = (fn) => (isNode ? port.on('message', (data) => fn({data})) : (self.onmessage = fn));

class Again {} // registers were replaced: run from resumeAt
class Away {} // the image was replaced, or the thread ended: leave everything

let task = null;
/** The threads run here last, most recent first, each with its instance on its memory (KEEP_INSTANCES; remote.mjs mirrors it). */
let kept = [];

/** The thread, set up from a 'run' message. */
class Thread {
  constructor(m) {
    this.memory = m.memory;
    this.module = m.module;
    this.memoryId = m.memoryId; // (what remote.mjs numbers them: the objects posted are new each time)
    this.imageId = m.imageId;
    this.fpuOps = m.fpuOps;
    this.take(m);
    this.lock();
    const keep = m.keep ? new Uint8Array(this.memory.buffer).slice(m.keep[0], m.keep[1]) : null;
    this.instance = new WebAssembly.Instance(m.module, this.imports());
    this.low = this.instance.exports.low ?? null; // (a translation made before it had one: not known)
    if (keep) new Uint8Array(this.memory.buffer).set(keep, m.keep[0]);
    // Its globals as they start, for a run of the program after this one on this memory (again).
    this.initial = [];
    for (const g of Object.values(this.instance.exports)) {
      if (!(g instanceof WebAssembly.Global)) continue;
      try { this.initial.push([g, g.value]); } catch { /* a vector register: none is kept across a call */ }
    }
    this.attached = 0;
    this.attach();
    this.begin(m);
  }

  /** What a run brings: its thread, its channel and the kernel's words, the modules known, its x87. */
  take(m) {
    this.tid = m.tid;
    // Where it writes to the console without asking (toConsole), and which of its process's descriptors are the console.
    this.outbox = m.outbox ? new Outbox(m.outbox) : null;
    this.consoles = m.consoles ? new Int32Array(m.consoles) : null;
    this.channel = m.channel;
    this.i32 = new Int32Array(m.channel);
    this.i64 = new BigInt64Array(m.channel);
    this.bytes8 = new Uint8Array(m.channel);
    Atomics.store(this.i32, CH.LEFT, 0);
    this.door = new Int32Array(m.door);
    this.gil = new Int32Array(m.gil);
    this.count = new Int32Array(m.count); // modules the program has, made by any process
    this.clock = clocks(m.origin); // the kernel's (clock.mjs), read here as a vDSO does
    this.modules = m.extras; // [{module, base, count}] known here
    this.fpu = new Fpu(() => this.bytes, m.fpuOps);
    if (m.fpu) this.fpu.restore(m.fpu);
  }
  begin(m) {
    this.setRegs(m.regs);
    this.resumeAt = BigInt(m.resumeAt);
    this.slice = SLICE_LOOPS;
  }
  /**
   * A thread of this program on the memory this instance was made on, where nothing instantiating writes is wanted
   * (process.mjs goesOn; remote.mjs said so: again): the instance goes on, its globals as a fresh one's, the modules
   * made since attached.
   */
  again(m) {
    this.take(m);
    this.lock();
    for (const [g, v] of this.initial) g.value = v;
    this.attach();
    this.begin(m);
  }

  /** Guest memory as bytes, made again only once it is another buffer (grown, here or by another thread). */
  get bytes() {
    const b = this.memory.buffer;
    if (b !== this.bytesBuffer) { this.bytesBuffer = b; this.bytesOf = new Uint8Array(b); this.viewOf = new DataView(b); }
    return this.bytesOf;
  }
  get view() { void this.bytes; return this.viewOf; }

  imports() {
    return {env: {
      memory: this.memory,
      syscall: (nr, a, b, c, d, e, f, next) => this.syscall(nr, a, b, c, d, e, f, next),
      trap: trapOrPreempt,
      div128,
      clock: () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)),
      fpu: (op, size, address, a, b) => this.fpu.call(op, size, address, a, b),
      trace: () => {},
      miss: (address) => this.miss(address),
    }};
  }

  // ---- the process's lock ----

  lock() {
    const me = this.tid;
    for (;;) {
      const held = Atomics.compareExchange(this.gil, 0, 0, me);
      if (held === 0 || held === me) return;
      // The one holding it gives its turn up at its next loop's head (pause), as a time slice ends.
      this.raise();
      Atomics.add(this.gil, 1, 1);
      Atomics.wait(this.gil, 0, held);
      Atomics.sub(this.gil, 1, 1);
    }
  }
  /** The interrupt word of this process's memory (process.mjs INTERRUPT): its threads look in. */
  raise() { Atomics.store(new Int32Array(this.memory.buffer), INTERRUPT >> 2, 1); }
  unlock() {
    Atomics.store(this.gil, 0, 0);
    if (Atomics.load(this.gil, 1)) Atomics.notify(this.gil, 0, 1); // only when another thread waits for it
  }

  // ---- registers ----

  /** Each register's global, looked up once. */
  get globals() { return (this._globals ??= REGS.map((name) => this.instance.exports[name] ?? null)); }
  regs() { return this.globals.map((g) => g?.value ?? 0n); }
  /** The registers into the channel, from REGS on. */
  putRegs() {
    const {i64} = this, g = this.globals;
    for (let n = 0; n < g.length; n++) i64[CH.REGS + n] = g[n] ? g[n].value : 0n;
    this.i32[CH.HAVE_REGS] = 1;
  }
  setRegs(regs) {
    this.globals.forEach((g, n) => { if (g && regs[n] !== undefined) g.value = BigInt.asIntN(64, BigInt(regs[n])); });
  }

  // ---- the kernel ----

  /** Make request `op` and wait for the answer; returns the reply's kind (the registers sent first if the kernel asks). */
  ask(op) {
    const {i32} = this;
    this.i64[CH.LOW] = this.low ? this.low.value : 0n;
    for (;;) {
      i32[CH.OP] = op;
      Atomics.store(i32, CH.STATE, 1);
      Atomics.add(this.door, 0, 1);
      rouse(this.door, 0, 1);
      if (!watch(i32, CH.STATE, (state) => state === 2)) {
        for (;;) {
          const state = Atomics.load(i32, CH.STATE);
          if (state === 2) break;
          sleep(i32, CH.STATE, state, CH.ASLEEP);
        }
      }
      if (i32[CH.REPLY] !== REPLY.SEND_REGS) return i32[CH.REPLY];
      this.putRegs();
      op = OP.REGS;
    }
  }

  syscall(nr, a, b, c, d, e, f, next) {
    // A read of the clock is answered here (clock.mjs), not by the kernel.
    if (nr === 228n || nr === 96n || nr === 201n) { const r = answerTime(this.memory, this.clock, nr, a, b); if (r !== null) return r; }
    // So is a write to the console (write, writev), as its writer sees it: put where the kernel takes it from.
    if ((nr === 1n || nr === 20n) && this.outbox) { const r = this.toConsole(nr, a, b, c); if (r !== null) return r; }
    const {i64} = this;
    i64[CH.NR] = nr; i64[CH.ARGS] = a; i64[CH.ARGS + 1] = b; i64[CH.ARGS + 2] = c;
    i64[CH.ARGS + 3] = d; i64[CH.ARGS + 4] = e; i64[CH.ARGS + 5] = f; i64[CH.NEXT] = next;
    if (READS_REGS.has(Number(nr))) this.putRegs(); else this.i32[CH.HAVE_REGS] = 0;
    // A new thread or process starts from this one's x87 too.
    if (nr === 56n || nr === 57n || nr === 58n) this.put(JSON.stringify(this.fpu.saved()));
    this.unlock();
    const reply = this.ask(OP.SYSCALL);
    if (reply === REPLY.AWAY) throw new Away();
    this.lock();
    this.catchUp();
    if (reply === REPLY.REGS) this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
    // Its program starts again on this memory (an exec of the same image): this instance runs it, afresh.
    if (reply === REPLY.RENEW) {
      this.fpu = new Fpu(() => this.bytes, this.fpuOps);
      if (this.low) this.low.value = -1n;
    }
    if (reply === REPLY.REDIRECT || reply === REPLY.RENEW) {
      this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
      this.resumeAt = i64[CH.RIP];
      throw new Again();
    }
    return i64[CH.REGS];
  }

  /**
   * A write (1) or writev (20) of `fd` that its process has as the console, put in the outbox whole (channel.mjs): what
   * it wrote, as the call returns it; null where the kernel answers it (another descriptor, an address past the
   * memory, more than a quarter of the outbox, or the outbox full: the page has not taken in what came before).
   */
  toConsole(nr, fd, b, c) {
    if (fd < 0n || fd >= 32n || !((Atomics.load(this.consoles, 0) >>> Number(fd)) & 1)) return null;
    const bytes = this.bytes, size = bytes.length, pieces = [];
    let total = 0;
    if (nr === 1n) {
      const at = Number(b), n = Number(c);
      if (!(n >= 0 && at >= 0 && at + n <= size)) return null;
      pieces.push([at, n]);
      total = n;
    } else {
      const v = Number(b), k = Number(c);
      if (!(k >= 0 && k <= 16 && v >= 0 && v + 16 * k <= size)) return null;
      const view = this.view;
      for (let i = 0; i < k; i++) {
        const at = Number(view.getBigUint64(v + 16 * i, true)), n = Number(view.getBigUint64(v + 16 * i + 8, true));
        if (!(at + n <= size)) return null;
        if (n) pieces.push([at, n]);
        total += n;
      }
    }
    if (total > OUTBOX_BYTES / 4) return null;
    if (total) {
      const first = this.outbox.put((Atomics.load(this.consoles, 1) >>> Number(fd)) & 1 ? 2 : 1, bytes, pieces, total);
      if (first === null) return null;
      if (first) { Atomics.add(this.door, 0, 1); rouse(this.door, 0, 1); }
    }
    return BigInt(total);
  }

  /** Text for the kernel, in the channel's data. */
  put(text) {
    const b = new TextEncoder().encode(text);
    this.bytes8.set(b.subarray(0, CH.DATA_BYTES), CH.DATA);
    this.i32[CH.LENGTH] = Math.min(b.length, CH.DATA_BYTES);
  }

  /** The modules made since this thread last looked: their bytes from the kernel, compiled here. */
  catchUp() {
    const have = Atomics.load(this.count, 0);
    while (this.modules.length < have) {
      const k = this.modules.length, parts = [];
      let at = 0, total = 0;
      do {
        this.i64[CH.ARG0] = BigInt(k); this.i64[CH.ARG1] = BigInt(at);
        this.ask(OP.MODULE);
        const n = this.i32[CH.LENGTH];
        total = Number(this.i64[CH.VALUE]);
        parts.push(this.bytes8.slice(CH.DATA, CH.DATA + n));
        at += n;
      } while (at < total);
      const wasm = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { wasm.set(p, o); o += p.length; }
      this.modules.push({module: new WebAssembly.Module(wasm), base: Number(this.i64[CH.ARG0]), count: Number(this.i64[CH.ARG1])});
    }
    this.attach();
  }

  attach() {
    const {table} = this.instance.exports;
    const env = this.imports().env;
    for (; this.attached < this.modules.length; this.attached++) {
      const x = this.modules[this.attached];
      if (table.length < x.base + x.count) table.grow(Math.max(x.base + x.count - table.length, table.length));
      const own = new WebAssembly.Instance(x.module, {env, main: this.instance.exports}).exports.table;
      for (let k = 0; k < x.count; k++) table.set(x.base + k, own.get(k));
    }
  }

  miss(address) {
    this.i64[CH.ARG0] = address;
    this.ask(OP.MISS);
    const at = this.i64[CH.VALUE];
    this.catchUp();
    return at;
  }

  /** Its turn ended at `address` in guest code: the kernel hears (a signal may wait), the others may run, it goes on. */
  pause(address) {
    const {i64} = this;
    Atomics.store(new Int32Array(this.memory.buffer), INTERRUPT >> 2, 0);
    i64[CH.NEXT] = address;
    this.putRegs();
    this.unlock();
    const reply = this.ask(OP.YIELD);
    if (reply === REPLY.AWAY) throw new Away();
    this.lock();
    this.catchUp();
    if (reply === REPLY.REDIRECT) {
      this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
      this.resumeAt = i64[CH.RIP];
    } else this.resumeAt = address;
  }

  run() {
    for (;;) {
      try {
        this.catchUp();
        // A full time slice, and no frames yet (process.mjs Preempted).
        const x = this.instance.exports;
        if (x.budget) { x.budget.value = this.slice; x.depth.value = 0; }
        this.ranAt = performance.now();
        x.run(this.resumeAt);
        return;
      } catch (e) {
        if (e instanceof Again) continue;
        if (e instanceof Away) return;
        if (e instanceof Preempted) {
          // Calls deep enough: on afresh. Its time is up: the kernel hears only if it asked (the interrupt word),
          // or the process shares memory with another (what it wrote there goes to the others then).
          this.resumeAt = e.address;
          if (e.code !== TRAP_YIELD) continue;
          const words = new Int32Array(this.memory.buffer);
          const spent = Atomics.load(words, INTERRUPT >> 2) === 0;
          if (spent) this.slice = nextSlice(this.slice, performance.now() - this.ranAt);
          if (!spent || Atomics.load(words, SHARES >> 2)) {
            try { this.pause(e.address); } catch (away) { if (away instanceof Away) return; throw away; }
          }
          continue;
        }
        const sig = fault(e);
        if (!sig) throw e;
        if (isNode && process.env.XLAT_FAULTS) console.error(`[${this.tid}] fault: ${e.stack}`);
        // A fault ends the process, as the kernel decides; what the translator cannot run yet is said.
        this.put(translatorsLimit(e) ? `xlat: ${e.message}\n` : '');
        this.i64[CH.ARG0] = BigInt(sig);
        this.unlock();
        this.ask(OP.FAULT);
        return;
      }
    }
  }
}

listen(({data: m}) => {
  if (m.type === 'forget') {
    kept = kept.filter((t) => t.memoryId !== m.memoryId);
    if (task?.memoryId === m.memoryId) task = null;
    return;
  }
  if (m.type !== 'run') return;
  try {
    // What the kernel left out, this Worker has (remote.mjs post): the memory, the image's module and its first modules.
    const like = kept.find((t) => t.imageId === m.imageId);
    m.memory ??= kept.find((t) => t.memoryId === m.memoryId).memory;
    m.module ??= like.module;
    m.fpuOps ??= like.fpuOps;
    m.extras = [...(like?.modules.slice(0, m.extrasFrom) ?? []), ...m.extras];
    const same = (t) => t.memoryId === m.memoryId && t.imageId === m.imageId;
    const was = m.again ? kept.find(same) : null;
    if (was) { task = was; task.again(m); } else task = new Thread(m);
    kept = [task, ...kept.filter((t) => t !== task && !same(t))].slice(0, KEEP_INSTANCES);
    task.run();
    // Left: its channel may go to another thread (remote.mjs channel).
    Atomics.store(task.i32, CH.LEFT, 1);
  } catch (e) {
    port.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
  }
});
port.postMessage({type: 'up'});
