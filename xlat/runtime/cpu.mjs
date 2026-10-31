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

import {CH, OP, READS_REGS, REPLY, REGS, rouse, sleep, watch} from './channel.mjs';
import {Fpu} from './fpu.mjs';
import {INTERRUPT, Preempted, SHARES, SLICE_LOOPS, TRAP_YIELD, div128, fault, nextSlice, translatorsLimit, trapOrPreempt} from './process.mjs';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const port = isNode ? (await import('node:worker_threads')).parentPort : self;
const listen = (fn) => (isNode ? port.on('message', (data) => fn({data})) : (self.onmessage = fn));

class Again {} // registers were replaced: run from resumeAt
class Away {} // the image was replaced, or the thread ended: leave everything

let task = null;

/** The thread, set up from a 'run' message. */
class Thread {
  constructor(m) {
    this.tid = m.tid;
    this.memory = m.memory;
    this.channel = m.channel;
    this.i32 = new Int32Array(m.channel);
    this.i64 = new BigInt64Array(m.channel);
    this.bytes8 = new Uint8Array(m.channel);
    this.door = new Int32Array(m.door);
    this.gil = new Int32Array(m.gil);
    this.count = new Int32Array(m.count); // modules the program has, made by any process
    this.module = m.module;
    this.modules = m.extras; // [{module, base, count}] known here
    this.fpu = new Fpu(() => new Uint8Array(this.memory.buffer), m.fpuOps);
    if (m.fpu) Object.assign(this.fpu, {top: m.fpu.top, cw: m.fpu.cw, sw: m.fpu.sw, st: m.fpu.st.map(([kind, sign, e, mm]) => ({kind, sign, e, m: BigInt(mm)}))});
    this.lock();
    const keep = m.keep ? new Uint8Array(this.memory.buffer).slice(m.keep[0], m.keep[1]) : null;
    this.instance = new WebAssembly.Instance(m.module, this.imports());
    if (keep) new Uint8Array(this.memory.buffer).set(keep, m.keep[0]);
    this.attached = 0;
    this.attach();
    this.setRegs(m.regs);
    this.resumeAt = BigInt(m.resumeAt);
    this.slice = SLICE_LOOPS;
  }

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
    const {i64} = this;
    i64[CH.NR] = nr; i64[CH.ARGS] = a; i64[CH.ARGS + 1] = b; i64[CH.ARGS + 2] = c;
    i64[CH.ARGS + 3] = d; i64[CH.ARGS + 4] = e; i64[CH.ARGS + 5] = f; i64[CH.NEXT] = next;
    if (READS_REGS.has(Number(nr))) this.putRegs(); else this.i32[CH.HAVE_REGS] = 0;
    // A new thread or process starts from this one's x87 too.
    if (nr === 56n || nr === 57n || nr === 58n) this.put(JSON.stringify({top: this.fpu.top, cw: this.fpu.cw, sw: this.fpu.sw, st: this.fpu.st.map((x) => [x.kind, x.sign, x.e, String(x.m)])}));
    this.unlock();
    const reply = this.ask(OP.SYSCALL);
    if (reply === REPLY.AWAY) throw new Away();
    this.lock();
    this.catchUp();
    if (reply === REPLY.REGS) this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
    if (reply === REPLY.REDIRECT) {
      this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
      this.resumeAt = i64[CH.RIP];
      throw new Again();
    }
    return i64[CH.REGS];
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
  if (m.type !== 'run') return;
  try {
    task = new Thread(m);
    task.run();
  } catch (e) {
    port.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
  }
});
port.postMessage({type: 'up'});
