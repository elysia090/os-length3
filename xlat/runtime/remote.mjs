// The kernel with each guest thread in a Worker of its own (cpu.mjs), all
// running at once: memory is a shared WebAssembly.Memory (the kernel reads
// and writes it directly, as process.mjs does), and a thread's system call
// is written to its channel (channel.mjs) and answered from here. A call
// that waits leaves its thread blocked in Atomics.wait until the kernel
// makes the call again and it is done; a signal for a thread that waits
// answers it with the handler's registers. A thread that never makes a
// call runs on until it does, as on Linux until the timer tick; one whose
// process is killed ends at once (its Worker is terminated).
//
// It needs SharedArrayBuffer and Atomics.waitAsync: in a browser, a page
// that is cross-origin isolated (COOP same-origin and COEP require-corp).
// Where they are missing, process.mjs's Kernel runs the same threads here,
// one at a time.

import {CH, OP, REPLY} from './channel.mjs';
import {Exec, Exit, Kernel, REG, Redirect, TRACE_SYSCALLS, Task, trace} from './process.mjs';
import {deliverable} from './signal.mjs';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const NodeWorker = isNode ? (await import('node:worker_threads')).Worker : null;
const enc = new TextEncoder(), dec = new TextDecoder();

/** How long the kernel waits for a running thread's next call blocking (then it waits on the event loop), and serves at most before the host gets a turn. */
const BLOCK_MS = 4, YIELD_MS = 8;
/** Atomics.wait is allowed here (a Worker, or node's main thread; not a page's). */
const BLOCKING = isNode || typeof WorkerGlobalScope !== 'undefined';
const macrotask = () => new Promise((go) => (typeof setImmediate === 'function' ? setImmediate(go) : setTimeout(go, 0)));

/** Whether this host can run threads apart: shared memory, and waiting on it from here without blocking. */
export const canRunApart = () => typeof SharedArrayBuffer === 'function' && typeof Atomics.waitAsync === 'function'
  && (isNode || globalThis.crossOriginIsolated === true);

/** Workers started before any kernel here (warmThreads), for its first threads. */
const warmed = [];

/**
 * Start `n` Workers for threads now, before the kernel is made (its program and translator still on their way):
 * a Worker takes a while to load and run its script, and the first threads would otherwise wait for theirs.
 */
export function warmThreads(n = 2) {
  while (warmed.length < n) warmed.push(newWorker());
}

function newWorker() {
  if (NodeWorker) {
    // (Not new URL(…, import.meta.url) as such: a bundler would take this for a file of the page's to carry.)
    const here = import.meta.url;
    const w = new NodeWorker(new URL('./cpu.mjs', here));
    // A spare one waiting for a thread keeps nothing alive.
    w.unref();
    return {post: (m) => w.postMessage(m), end: () => w.terminate(), on: (fn) => w.on('message', fn), onError: (fn) => w.on('error', fn), raw: w};
  }
  const w = new Worker(new URL('./cpu.mjs', import.meta.url), {type: 'module'});
  return {post: (m) => w.postMessage(m), end: () => w.terminate(), on: (fn) => w.addEventListener('message', (e) => fn(e.data)), onError: (fn) => w.addEventListener('error', fn), raw: w};
}

export class RemoteKernel extends Kernel {
  constructor(options) {
    super(options);
    this.shared = true;
    this.door = new Int32Array(new SharedArrayBuffer(8)); // rung by every thread that asks
    this.gils = new WeakMap(); // memory -> its threads' lock
    this.spares = []; // Workers started ahead, for the next thread
    this.spareCount = options.spares ?? 2;
    this.onIdle = options.onIdle ?? null; // (r) => void: every thread waits ({waiting, until?}) or it all ended ({status})
    this.serving = null;
    this.closing = false;
    // Started now, while the first program is translated (those warmed already first).
    for (const w of warmed.splice(0)) this.spares.push(this.adoptWorker(w));
    while (this.spares.length < this.spareCount) this.spares.push(this.spawnWorker());
  }

  newTask(proc) { return new RemoteTask(proc, this.nextPid++); }
  ready(t) { this.go(t); }
  go(t) { t.answer(); }

  /** A Worker whose thread ended in a call: free for the next thread (up to a few). */
  keep(w) {
    if (this.spares.length < 8) this.spares.push(w); else w.end();
  }

  /** A Worker for a new thread, started ahead where one is spare. */
  worker() {
    const w = this.spares.pop() ?? this.spawnWorker();
    while (this.spares.length < this.spareCount) this.spares.push(this.spawnWorker());
    return w;
  }

  spawnWorker() { return this.adoptWorker(newWorker()); }

  /** A Worker for threads, heard by this kernel. */
  adoptWorker(w) {
    w.on((m) => {
      if (m?.type === 'error') {
        const t = [...this.tasks.values()].find((x) => x.worker === w);
        this.console.write(2, enc.encode(`xlat: ${m.message.split('\n')[0]}\n`));
        if (t) this.exitProcess(t.proc, 11);
        this.kick();
      }
    });
    w.onError((e) => { this.console.write(2, enc.encode(`xlat: ${e?.message ?? e}\n`)); });
    return w;
  }

  gil(memory) {
    let g = this.gils.get(memory);
    if (!g) this.gils.set(memory, (g = new SharedArrayBuffer(4)));
    return g;
  }

  /** Something changed outside (input came): look again. */
  kick() {
    this.dirty = true;
    Atomics.add(this.door, 0, 1);
    Atomics.notify(this.door, 0);
  }

  /** Answer every thread that asks. True when one did. */
  drain() {
    let did = false;
    for (const t of [...this.tasks.values()]) {
      if (t.dead || Atomics.load(t.i32, CH.STATE) !== 1) continue;
      Atomics.store(t.i32, CH.STATE, 3);
      did = true;
      this.handle(t);
    }
    return did;
  }

  handle(t) {
    const op = t.i32[CH.OP];
    if (op === OP.SYSCALL) return this.call(t);
    if (op === OP.MISS) {
      const address = t.i64[CH.ARG0], image = t.image;
      let at = image.entries.get(address);
      if (at === undefined && image.more(this.translateMore, address, (w) => this.prepare(w))) at = image.entries.get(address);
      count(image);
      t.i64[CH.VALUE] = at === undefined ? -1n : at;
      return t.reply(REPLY.VALUE);
    }
    if (op === OP.MODULE) {
      const x = t.image.extras[Number(t.i64[CH.ARG0])], from = Number(t.i64[CH.ARG1]);
      const part = x.bytes.subarray(from, from + CH.DATA_BYTES);
      new Uint8Array(t.channel).set(part, CH.DATA);
      t.i32[CH.LENGTH] = part.length;
      t.i64[CH.VALUE] = BigInt(x.bytes.length);
      t.i64[CH.ARG0] = BigInt(x.base);
      t.i64[CH.ARG1] = BigInt(x.count);
      return t.reply(REPLY.VALUE);
    }
    if (op === OP.FAULT) {
      const said = t.text();
      if (said) this.console.write(2, enc.encode(said));
      this.exitProcess(t.proc, Number(t.i64[CH.ARG0]));
    }
  }

  call(t) {
    const i64 = t.i64, nr = Number(i64[CH.NR]);
    const args = [i64[CH.ARGS], i64[CH.ARGS + 1], i64[CH.ARGS + 2], i64[CH.ARGS + 3], i64[CH.ARGS + 4], i64[CH.ARGS + 5]];
    const next = i64[CH.NEXT];
    if (nr === 56 || nr === 57 || nr === 58) { try { t.fpuState = JSON.parse(t.text()); } catch { t.fpuState = null; } }
    t.resumeAt = next;
    t.redirected = false;
    t.regsChanged = false;
    const call = {nr, args, next, state: {}};
    if (TRACE_SYSCALLS) trace(t, call);
    if (t.proc.stopped) { t.call = call; t.state = 'stopped'; return; }
    let v;
    try {
      v = this.attempt(t, call);
    } catch (e) {
      if (e instanceof Exec || e instanceof Redirect) { if (!t.dead) this.go(t); return; }
      if (e instanceof Exit) return;
      throw e;
    }
    if (typeof v !== 'bigint') {
      t.call = call;
      this.block(t);
      // A signal that came while it ran guest code (since its last call) is pending already, and
      // send() found no call to interrupt then: the call does not wait for another one, as Linux's
      // interruptible sleep sees a pending signal at once (pause after a check, sigsuspend, a read).
      if (deliverable(t)) this.interruptCall(t);
      return;
    }
    this.resumeWith(t, call, v, false);
  }

  /** Whether a thread runs guest code now (not waiting in a call, not stopped). */
  busy() { return [...this.tasks.values()].some((t) => !t.dead && t.state === 'running'); }

  /** Start the first process and serve every thread until init ends; its wait status. */
  serve() {
    this.serving ??= (async () => {
      let yielded = performance.now();
      while (this.status === null) {
        const seen = Atomics.load(this.door, 0);
        this.drain();
        this.retry();
        if (this.status !== null) break;
        const now = performance.now();
        // Served without a break for a while: the host gets its turn (input, Ctrl-C) before more.
        if (now - yielded > YIELD_MS) { await macrotask(); yielded = performance.now(); continue; }
        if (Atomics.load(this.door, 0) !== seen) continue;
        const until = this.deadline();
        const busy = this.busy();
        if (!busy) this.onIdle?.(until === undefined ? {waiting: true} : {waiting: true, until});
        // A thread runs and will likely ask soon: wait for it right here, which wakes far sooner than the event loop.
        if (busy && BLOCKING) {
          const r = Atomics.wait(this.door, 0, seen, Math.min(BLOCK_MS, until === undefined ? BLOCK_MS : Math.max(0, until - now)));
          if (r !== 'timed-out') continue;
        }
        const r = Atomics.waitAsync(this.door, 0, seen, until === undefined ? Infinity : Math.max(0, until - performance.now()));
        if (r.async) { await r.value; yielded = performance.now(); }
      }
      this.close();
      this.onIdle?.({status: this.status});
      return this.status;
    })();
    return this.serving;
  }

  /** End every Worker (threads and spares). */
  close() {
    this.closing = true;
    for (const t of this.tasks.values()) t.end();
    for (const w of this.spares.splice(0)) w.end();
  }

  /** Run to the end (a sleep is waited out); its wait status. */
  async spawn(path, argv, env, cwd = '/') {
    this.start(path, argv, env, cwd);
    return await this.serve();
  }
}

/** The modules an image has, where every Worker running it can see. */
function count(image) {
  image.counter ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(image.counter, 0, image.extras.length);
  return image.counter;
}

/** A thread whose registers live in its channel while it waits there, and whose code runs in its Worker. */
export class RemoteTask extends Task {
  constructor(proc, tid) {
    super(proc, tid);
    this.channel = new SharedArrayBuffer(CH.SIZE);
    this.i32 = new Int32Array(this.channel);
    this.i64 = new BigInt64Array(this.channel);
    this.worker = null;
    this.execd = false; // a new image waits to be sent to its Worker
    this.fpuState = null;
  }

  load(image, memory, from = null) {
    this.image = image;
    this.memory = memory;
    this.fpuState = from ? from.fpuState : null;
    // A module that carries its data, instantiated over a memory in use: the image is put back (cpu.mjs).
    this.keep = from && !image.segments && from.memory === memory ? [image.facts.imageStart ?? 0, image.facts.imageEnd] : null;
    if (this.worker) this.execd = true;
  }

  attach() {}
  reg(n) { return this.i64[CH.REGS + n]; }
  setReg(n, v) { this.i64[CH.REGS + n] = BigInt.asIntN(64, BigInt(v)); if (n) this.regsChanged = true; }

  /** Text the thread left in the data area. */
  text() { return dec.decode(new Uint8Array(this.channel, CH.DATA, this.i32[CH.LENGTH])); }

  reply(kind) {
    this.i32[CH.REPLY] = kind;
    Atomics.store(this.i32, CH.STATE, 2);
    Atomics.notify(this.i32, CH.STATE);
  }

  /** It goes on: its Worker starts, or hears its call is done (its value, other registers, or a new image). */
  answer() {
    if (this.dead) return;
    this.state = 'running';
    if (!this.worker) { this.worker = this.kernel.worker(); this.post(); return; }
    if (this.execd) { this.execd = false; this.reply(REPLY.AWAY); this.post(); return; }
    if (this.redirected) { this.i64[CH.RIP] = this.resumeAt; this.reply(REPLY.REDIRECT); return; }
    const changed = this.regsChanged;
    this.regsChanged = false;
    this.reply(changed ? REPLY.REGS : REPLY.VALUE);
  }

  post() {
    const image = this.image, k = this.kernel;
    this.worker.post({
      type: 'run', tid: this.tid, module: image.module,
      extras: image.extras.map(({module, base, count: n}) => ({module, base, count: n})),
      memory: this.memory, channel: this.channel, door: k.door.buffer, gil: k.gil(this.memory), count: count(image).buffer,
      regs: REG.map((_, n) => this.reg(n)), resumeAt: this.resumeAt, fpuOps: image.fpuOps, fpu: this.fpuState, keep: this.keep,
    });
  }

  end() {
    const w = this.worker;
    this.worker = null;
    // A Worker waiting in a call (it ended itself, or was ended while it waited) is told to leave and is kept for the
    // next thread; one running guest code is ended where it is.
    const state = Atomics.load(this.i32, CH.STATE);
    if (w && (state === 1 || state === 3) && !this.kernel.closing) { this.reply(REPLY.AWAY); this.kernel.keep(w); }
    else w?.end();
    // Ended while it held its process's lock (killed while running): the lock goes with it.
    if (this.memory) {
      const gil = new Int32Array(this.kernel.gil(this.memory));
      if (Atomics.compareExchange(gil, 0, this.tid, 0) === this.tid) Atomics.notify(gil, 0);
    }
  }
}
