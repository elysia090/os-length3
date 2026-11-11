// One guest thread in a Worker of its own (remote.ts is the kernel's
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

import {ANSWER_MS, CH, OP, OUTBOX_BYTES, Outbox, PARK, PARK_MS, PARK_WATCH_MS, READS_REGS, REPLY, REGS, rouse, sleep, watch, type Attached, type Forget, type Run} from './channel.ts';
import {isNode, nodeThreads, said} from '../../sods/runtime/host.ts';
import {namesIn, x87Of, type X87} from '../../sods/runtime/x87.ts';
import {answerTime, clocks, type Clocks} from './clock.ts';
import {INTERRUPT, KEEP_INSTANCES, Preempted, SHARES, SLICE_LOOPS, TRAP_YIELD, div128, fault, nextSlice, translatorsLimit, trapOrPreempt, type Translation} from './process.ts';

const parent = (await nodeThreads())?.parentPort ?? null;
/** Where this Worker hears from the kernel and says what went wrong. */
const port: {postMessage(m: unknown): void} = parent ?? self;
const listen = (fn: (e: {data: Run | Forget}) => void): void => {
  if (parent) parent.on('message', (data: Run | Forget) => fn({data})); else self.onmessage = fn;
};

class Again {} // registers were replaced: run from resumeAt
class Away {} // the image was replaced, or the thread ended: leave everything
/** Its process now runs a program this Worker keeps an instance of, on the memory it runs it on (REPLY.EXEC): that goes on. */
class Exec {
  declare readonly memoryId: number;
  declare readonly imageId: number;
  constructor(memoryId: number, imageId: number) { this.memoryId = memoryId; this.imageId = imageId; }
}

let task: Thread | null = null;
/** The threads run here last, most recent first, each with its instance on its memory (KEEP_INSTANCES; remote.ts mirrors it). */
let kept: Thread[] = [];
/** This Worker's x87 (x87.ts), from the translator's module its first run brought. */
let x87: X87 | null = null;
const theX87 = (): X87 => {
  if (!x87) throw new Error('a thread in a Worker given no x87');
  return x87;
};
/** Threads kept here past `keep`: their x87 registers go. */
const letGo = (was: Thread[], keep: Thread[]): void => { for (const t of was) if (!keep.includes(t) && t.fpu) { x87?.free(t.fpu); t.fpu = 0; } };

/** The thread, set up from a 'run' message. */
class Thread {
  declare readonly memory: WebAssembly.Memory;
  declare readonly module: WebAssembly.Module;
  declare readonly memoryId: number;
  declare readonly imageId: number;
  declare readonly instance: WebAssembly.Instance;
  declare readonly low: WebAssembly.Global | null;
  declare readonly initial: [WebAssembly.Global, unknown][];
  declare attached: number;
  declare tid: number;
  declare outbox: Outbox | null;
  declare consoles: Int32Array;
  declare channel: SharedArrayBuffer;
  declare i32: Int32Array;
  declare i64: BigInt64Array;
  declare bytes8: Uint8Array;
  declare door: Int32Array;
  declare gil: Int32Array;
  declare count: Int32Array;
  declare clock: Clocks;
  declare modules: Attached[];
  /** The run it was last given (what an exec gone on with here takes over: its channel, the kernel's words). */
  declare last: Run;
  /** Its x87 registers' handle in this Worker's x87 (x87.ts); 0 before it has any. */
  declare fpu: number;
  declare resumeAt: bigint;
  declare slice: number;
  declare ranAt: number;
  declare bytesBuffer: ArrayBufferLike | undefined;
  declare bytesOf: Uint8Array;
  declare viewOf: DataView;
  declare wordsOf: Int32Array;
  declare _globals?: (WebAssembly.Global | null)[];
  constructor(m: Run & {memory: WebAssembly.Memory; module: WebAssembly.Module}) {
    this.memory = m.memory;
    this.module = m.module;
    this.memoryId = m.memoryId; // (what remote.ts numbers them: the objects posted are new each time)
    this.imageId = m.imageId;
    this.fpu = 0;
    this.take(m);
    this.lock();
    const at = m.keep, keep = at ? new Uint8Array(this.memory.buffer).slice(at[0], at[1]) : null;
    this.instance = new WebAssembly.Instance(m.module, this.imports());
    this.low = this.exports.low ?? null; // (a translation made before it had one: not known)
    if (at && keep) new Uint8Array(this.memory.buffer).set(keep, at[0]);
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
  take(m: Run): void {
    this.last = m;
    this.tid = m.tid;
    // Where it writes to the console without asking (toConsole), and which of its process's descriptors are the console
    // (in its channel, kept there by the kernel: fd.ts readers).
    this.outbox = m.outbox ? new Outbox(m.outbox) : null;
    this.channel = m.channel;
    this.consoles = new Int32Array(m.channel, CH.CONSOLES << 2, 2);
    this.i32 = new Int32Array(m.channel);
    this.i64 = new BigInt64Array(m.channel);
    this.bytes8 = new Uint8Array(m.channel);
    Atomics.store(this.i32, CH.LEFT, 0);
    this.door = new Int32Array(m.door);
    this.gil = new Int32Array(m.gil);
    this.count = new Int32Array(m.count); // modules the program has, made by any process
    this.clock = clocks(m.origin); // the kernel's (clock.ts), read here as a vDSO does
    this.modules = m.extras; // [{module, base, count}] known here
    const x87 = theX87();
    x87.check(namesIn(this.module));
    if (this.fpu) x87.free(this.fpu);
    this.fpu = x87.restore(m.fpu);
  }
  begin(m: Run): void {
    if (this.exports.x87) this.exports.x87.value = this.fpu;
    this.setRegs(m.regs);
    this.resumeAt = BigInt(m.resumeAt);
    this.slice = SLICE_LOOPS;
  }
  /**
   * A thread of this program on the memory this instance was made on, where nothing instantiating writes is wanted
   * (process.ts goesOn; remote.ts said so: again): the instance goes on, its globals as a fresh one's, the modules
   * made since attached.
   */
  again(m: Run): void {
    this.take(m);
    this.lock();
    for (const [g, v] of this.initial) g.value = v;
    this.attach();
    this.begin(m);
  }

  /** Guest memory as bytes, made again only once it is another buffer (grown, here or by another thread). */
  get bytes(): Uint8Array {
    const b = this.memory.buffer;
    if (b !== this.bytesBuffer) { this.bytesBuffer = b; this.bytesOf = new Uint8Array(b); this.viewOf = new DataView(b); this.wordsOf = new Int32Array(b); }
    return this.bytesOf;
  }
  get view(): DataView { void this.bytes; return this.viewOf; }
  get words(): Int32Array { void this.bytes; return this.wordsOf; }
  /** What its instance exports. */
  get exports(): Translation { return this.instance.exports as unknown as Translation; }

  imports(): {env: WebAssembly.ModuleImports} {
    return {env: {
      memory: this.memory,
      syscall: (nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint) => this.syscall(nr, a, b, c, d, e, f, next),
      trap: trapOrPreempt,
      div128,
      clock: () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)),
      // Wasm to wasm, the x87's own (x87.ts): the instance's x87 global names whose registers.
      fpu: theX87().fpu,
      trace: () => {},
      miss: (address: bigint) => this.miss(address),
      // clock_gettime of a wall or steady clock, answered in the translated code itself (sods' integer.rs clock_gettime): the
      // clock's time in ms, a number crossing as it is; NaN where the kernel answers (a CPU-time clock, no clock).
      time: (id: number) => this.clock.readMs(id) ?? NaN,
    }};
  }

  // ---- the process's lock ----

  lock(): void {
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
  /** The interrupt word of this process's memory (process.ts INTERRUPT): its threads look in. */
  raise(): void { Atomics.store(new Int32Array(this.memory.buffer), INTERRUPT >> 2, 1); }
  unlock(): void {
    Atomics.store(this.gil, 0, 0);
    if (Atomics.load(this.gil, 1)) Atomics.notify(this.gil, 0, 1); // only when another thread waits for it
  }

  // ---- registers ----

  /** Each register's global, looked up once. */
  get globals(): (WebAssembly.Global | null)[] { return (this._globals ??= REGS.map((name) => this.exports[name] ?? null)); }
  regs(): bigint[] { return this.globals.map((g) => g?.value ?? 0n); }
  /** The registers into the channel, from REGS on. */
  putRegs(): void {
    const {i64} = this, g = this.globals;
    for (let n = 0; n < g.length; n++) i64[CH.REGS + n] = g[n]?.value ?? 0n;
    this.i32[CH.HAVE_REGS] = 1;
  }
  setRegs(regs: (bigint | number)[]): void {
    this.globals.forEach((g, n) => { if (g && regs[n] !== undefined) g.value = BigInt.asIntN(64, BigInt(regs[n])); });
  }

  // ---- the kernel ----

  /**
   * Make request `op` and wait for the answer; returns the reply's kind (the registers sent first if the kernel asks).
   * The answer may be to leave (Away), to any request: a thread ended while it asked for a module's bytes or code at an
   * address, had it asked again, would have waited on a channel no one serves, and its Worker, kept for the next
   * thread (remote.ts end), would never have heard the next run (a shell's command that hung after a screen program).
   */
  ask(op: number): number {
    const {i32} = this;
    this.i64[CH.LOW] = this.low ? this.low.value : 0n;
    for (;;) {
      i32[CH.OP] = op;
      Atomics.store(i32, CH.STATE, 1);
      Atomics.add(this.door, 0, 1);
      rouse(this.door, 0, 1);
      if (!watch(i32, CH.STATE, (state) => state === 2, ANSWER_MS)) {
        for (;;) {
          const state = Atomics.load(i32, CH.STATE);
          if (state === 2) break;
          sleep(i32, CH.STATE, state, CH.ASLEEP);
        }
      }
      const reply = i32[CH.REPLY];
      if (reply === REPLY.AWAY) throw new Away();
      if (reply !== REPLY.SEND_REGS) return reply;
      this.putRegs();
      op = OP.REGS;
    }
  }

  syscall(nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint): bigint {
    // A read of the clock is answered here (clock.ts), not by the kernel.
    if (nr === 228n || nr === 96n || nr === 201n) { const r = answerTime(this.memory, this.clock, nr, a, b); if (r !== null) return r; }
    // So is a write to the console (write, writev), as its writer sees it: put where the kernel takes it from.
    if ((nr === 1n || nr === 20n) && this.outbox) { const r = this.toConsole(nr, a, b, c); if (r !== null) return r; }
    const {i64} = this;
    i64[CH.NR] = nr; i64[CH.ARGS] = a; i64[CH.ARGS + 1] = b; i64[CH.ARGS + 2] = c;
    i64[CH.ARGS + 3] = d; i64[CH.ARGS + 4] = e; i64[CH.ARGS + 5] = f; i64[CH.NEXT] = next;
    if (READS_REGS.has(Number(nr))) this.putRegs(); else this.i32[CH.HAVE_REGS] = 0;
    // A new thread or process starts from this one's x87 too.
    if (nr === 56n || nr === 57n || nr === 58n) this.put(JSON.stringify(theX87().saved(this.fpu)));
    this.unlock();
    const reply = this.ask(OP.SYSCALL);
    if (reply === REPLY.EXEC) throw new Exec(Number(i64[CH.ARG0]), Number(i64[CH.ARG1]));
    this.lock();
    this.catchUp();
    if (reply === REPLY.REGS) this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
    // Its program starts again on this memory (an exec of the same image): this instance runs it, afresh.
    if (reply === REPLY.RENEW) {
      theX87().reset(this.fpu);
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
   * A write (1) or writev (20) of `fd` that its process has as the console, put in the outbox whole (channel.ts): what
   * it wrote, as the call returns it; null where the kernel answers it (another descriptor, an address past the
   * memory, more than a quarter of the outbox, or the outbox full: the page has not taken in what came before).
   */
  toConsole(nr: bigint, fd: bigint, b: bigint, c: bigint): bigint | null {
    const consoles = this.consoles, outbox = this.outbox;
    if (!outbox || fd < 0n || fd >= 32n || !((Atomics.load(consoles, 0) >>> Number(fd)) & 1)) return null;
    const bytes = this.bytes, size = bytes.length, pieces: [number, number][] = [];
    // A signal on its way (the interrupt word raised: Ctrl-C): the kernel's, to take it at this call, not more output
    // after the key that flushed what was on its way.
    if (Atomics.load(this.words, INTERRUPT >> 2)) return null;
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
      const first = outbox.put((Atomics.load(consoles, 1) >>> Number(fd)) & 1 ? 2 : 1, bytes, pieces, total, this.words, INTERRUPT >> 2);
      if (first === null) return null;
      if (first) { Atomics.add(this.door, 0, 1); rouse(this.door, 0, 1); }
    }
    return BigInt(total);
  }

  /** Text for the kernel, in the channel's data. */
  put(text: string): void {
    const b = new TextEncoder().encode(text);
    this.bytes8.set(b.subarray(0, CH.DATA_BYTES), CH.DATA);
    this.i32[CH.LENGTH] = Math.min(b.length, CH.DATA_BYTES);
  }

  /** The modules made since this thread last looked: their bytes from the kernel, compiled here. */
  catchUp(): void {
    const have = Atomics.load(this.count, 0);
    while (this.modules.length < have) {
      const k = this.modules.length, parts: Uint8Array[] = [];
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

  attach(): void {
    const {table} = this.exports;
    const env = this.imports().env;
    for (; this.attached < this.modules.length; this.attached++) {
      const x = this.modules[this.attached];
      if (table.length < x.base + x.count) table.grow(Math.max(x.base + x.count - table.length, table.length));
      const own = new WebAssembly.Instance(x.module, {env, main: this.instance.exports}).exports.table as WebAssembly.Table;
      for (let k = 0; k < x.count; k++) table.set(x.base + k, own.get(k));
    }
  }

  miss(address: bigint): bigint {
    this.i64[CH.ARG0] = address;
    this.ask(OP.MISS);
    const at = this.i64[CH.VALUE];
    this.catchUp();
    return at;
  }

  /** Its turn ended at `address` in guest code: the kernel hears (a signal may wait), the others may run, it goes on. */
  pause(address: bigint): void {
    const {i64} = this;
    Atomics.store(new Int32Array(this.memory.buffer), INTERRUPT >> 2, 0);
    i64[CH.NEXT] = address;
    this.putRegs();
    this.unlock();
    const reply = this.ask(OP.YIELD);
    this.lock();
    this.catchUp();
    if (reply === REPLY.REDIRECT) {
      this.setRegs(Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]));
      this.resumeAt = i64[CH.RIP];
    } else this.resumeAt = address;
  }

  /** Run until it leaves this Worker; what it runs next here, when its process exec'd a program kept here (Exec). */
  run(): Exec | undefined {
    for (;;) {
      try {
        this.catchUp();
        // A full time slice, and no frames yet (process.ts Preempted).
        const x = this.exports;
        if (x.budget) x.budget.value = this.slice;
        if (x.depth) x.depth.value = 0;
        this.ranAt = performance.now();
        x.run(this.resumeAt);
        return;
      } catch (e) {
        if (e instanceof Again) continue;
        if (e instanceof Away) return;
        if (e instanceof Exec) return e;
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
        if (isNode && said('MUK_FAULTS')) console.error(`[${this.tid}] fault: ${e instanceof Error ? e.stack : e}`);
        // A fault ends the process, as the kernel decides; what the translator cannot run yet is said.
        this.put(translatorsLimit(e) ? `sods: ${e.message}\n` : '');
        this.i64[CH.ARG0] = BigInt(sig);
        this.unlock();
        // The kernel ends its process: the answer is to leave.
        try { this.ask(OP.FAULT); } catch (away) { if (!(away instanceof Away)) throw away; }
        return;
      }
    }
  }
}

/**
 * `from`'s process exec'd a program whose instance on the memory it now runs on is kept here (remote.ts answer): that
 * thread goes on, as `from`'s thread (its channel, its process's consoles), its registers and where it starts in the
 * channel; its x87 afresh, its globals as a fresh instance's. It comes first of those kept, as remote.ts keeps it.
 */
function goOn(from: Thread, to: Exec): Thread {
  const was = kept.find((t) => t.memoryId === to.memoryId && t.imageId === to.imageId);
  if (!was) throw new Error('an exec gone on with in a Worker that does not keep its program');
  const m = from.last, i64 = from.i64;
  was.again({...was.last, again: true, tid: from.tid, channel: from.channel, door: m.door, outbox: m.outbox, origin: m.origin,
    regs: Array.from({length: REGS.length}, (_, n) => i64[CH.REGS + n]), resumeAt: i64[CH.RIP], fpu: null, keep: null,
    extras: was.modules});
  const keep = [was, ...kept.filter((t) => t !== was)].slice(0, KEEP_INSTANCES);
  letGo(kept, keep);
  kept = keep;
  return was;
}

type Ready = Run & {memory: WebAssembly.Memory; module: WebAssembly.Module};

/** A thread starts here: on the instance kept of its program on its memory where it may (again), else a new one. */
function start(run: Ready): Thread {
  const same = (t: Thread): boolean => t.memoryId === run.memoryId && t.imageId === run.imageId;
  const was = run.again ? kept.find(same) : null;
  const t = was ?? new Thread(run);
  if (was) was.again(run);
  const keep = [t, ...kept.filter((x) => x !== t && !same(x))].slice(0, KEEP_INSTANCES);
  letGo(kept, keep);
  kept = keep;
  return t;
}

/**
 * `t`'s thread gone, its Worker waits on its channel for the next (channel.ts PARK): that thread, as the kernel wrote it
 * there, of the instance kept here it names; null when none came within PARK_MS, or a message is on its way here.
 */
function park(t: Thread): Ready | null {
  const {i32, i64} = t;
  if (Atomics.compareExchange(i32, CH.PARKED, PARK.NO, PARK.WAITING) !== PARK.NO) { Atomics.store(i32, CH.PARKED, PARK.NO); return null; }
  if (!watch(i32, CH.PARKED, (v) => v !== PARK.WAITING, PARK_WATCH_MS)) Atomics.wait(i32, CH.PARKED, PARK.WAITING, PARK_MS);
  const v = Atomics.compareExchange(i32, CH.PARKED, PARK.WAITING, PARK.NO);
  if (v === PARK.WAITING) return null;
  if (v === PARK.DISMISSED) { Atomics.store(i32, CH.PARKED, PARK.NO); return null; }
  // Claimed: the kernel writes the thread in at once.
  watch(i32, CH.PARKED, (w) => w === PARK.OFFERED, Infinity);
  Atomics.store(i32, CH.PARKED, PARK.NO);
  const memoryId = Number(i64[CH.ARG0]), imageId = Number(i64[CH.ARG1]), n = i32[CH.LENGTH];
  const was = kept.find((x) => x.memoryId === memoryId && x.imageId === imageId);
  if (!was) throw new Error('a thread offered of a program or on a memory this Worker does not keep');
  return {...was.last, again: true, tid: i32[CH.TID], memoryId, imageId, memory: was.memory, module: was.module, channel: t.channel,
    regs: Array.from({length: REGS.length}, (_, k) => i64[CH.REGS + k]), resumeAt: i64[CH.RIP],
    fpu: n > 0 ? Array.from(t.bytes8.subarray(CH.DATA, CH.DATA + n)) : null, keep: null, extrasFrom: was.modules.length, extras: was.modules};
}

listen(({data: m}) => {
  if (m.type === 'forget') {
    const keep = kept.filter((t) => t.memoryId !== m.memoryId);
    letGo(kept, keep);
    kept = keep;
    if (task?.memoryId === m.memoryId) task = null;
    return;
  }
  if (m.type !== 'run') return;
  try {
    // What the kernel left out, this Worker has (remote.ts post): the memory, the image's module and its first modules.
    const like = kept.find((t) => t.imageId === m.imageId);
    const memory = m.memory ?? kept.find((t) => t.memoryId === m.memoryId)?.memory, module = m.module ?? like?.module;
    if (!memory || !module) throw new Error('a run of a program or on a memory this Worker does not have');
    if (m.x87) x87 = x87Of(m.x87);
    let t = task = start({...m, memory, module, extras: [...(like?.modules.slice(0, m.extrasFrom) ?? []), ...m.extras]});
    for (;;) {
      for (let next = t.run(); next; next = t.run()) task = t = goOn(t, next);
      const offered = park(t);
      if (!offered) break;
      task = t = start(offered);
    }
    // Left: its channel may go to another thread (remote.ts channel).
    Atomics.store(t.i32, CH.LEFT, 1);
  } catch (e) {
    port.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
  }
});
port.postMessage({type: 'up'});
