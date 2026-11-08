// The kernel with each guest thread in a Worker of its own (cpu.ts), all
// running at once: memory is a shared WebAssembly.Memory (the kernel reads
// and writes it directly, as process.ts does), and a thread's system call
// is written to its channel (channel.ts) and answered from here. A call
// that waits leaves its thread blocked in Atomics.wait until the kernel
// makes the call again and it is done; a signal for a thread that waits
// answers it with the handler's registers. A thread that never makes a
// call runs on until it does, as on Linux until the timer tick; one whose
// process is killed ends at once (its Worker is terminated).
//
// It needs SharedArrayBuffer and Atomics.waitAsync: in a browser, a page
// that is cross-origin isolated (COOP same-origin and COEP require-corp).
// Where they are missing, process.ts's Kernel runs the same threads here,
// one at a time.

import {CH, OP, Outbox, REPLY, rouse, sleep, watch, type Forget, type Run, type Said} from './channel.ts';
import {INTERRUPT, KEEP_INSTANCES, Kernel, PROFILE, REG, TRACE_SYSCALLS, Task, goesOn, trace, type Image, type Made, type Process, type Pumped} from './process.ts';
import {Exec, Exit, Redirect, utf8} from './flow.ts';
import type {Saved} from '../../sods/runtime/x87.ts';
import type {Call, Mem, Range} from './parts.ts';
import {deliverable, take} from './signal.ts';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const NodeWorker = isNode ? (await import('node:worker_threads')).Worker : null;
const enc = new TextEncoder();

/** How long the kernel waits for a running thread's next call blocking (then it waits on the event loop), and serves at most before the host gets a turn. */
const BLOCK_MS = 4, YIELD_MS = 8;
/** Atomics.wait is allowed here (a Worker, or node's main thread; not a page's). */
const BLOCKING = isNode || 'WorkerGlobalScope' in globalThis;
const macrotask = (): Promise<void> => new Promise((go) => (typeof setImmediate === 'function' ? setImmediate(go) : setTimeout(go, 0)));

/** Whether this host can run threads apart: shared memory, and waiting on it from here without blocking. */
export const canRunApart = (): boolean => typeof SharedArrayBuffer === 'function' && typeof Atomics.waitAsync === 'function'
  && (isNode || globalThis.crossOriginIsolated === true);

/** What a Worker of the kernel's keeps (cpu.ts kept): the memory and image of each instance, and the modules it had then. */
interface Held { memoryId: number; imageId: number; extras: number }
/** A Worker for threads, the same in node and in a browser: what is posted to it and heard from it, and its kernel. */
interface Hand {
  post(m: Run | Forget): void;
  end(): void;
  on(fn: (m: Said) => void): void;
  onError(fn: (e: {message?: string}) => void): void;
  kernel?: RemoteKernel;
  kept?: Held[];
  /** It has the x87's module (cpu.ts): sent with its first run. */
  x87?: boolean;
}
/** What a RemoteKernel is made with besides a Kernel's: Workers kept spare, who hears it idle, and whether its Workers go on. */
export interface Apart extends Made { spares?: number; onIdle?: ((r: Pumped) => void) | null; passOn?: boolean }

/** Workers started before any kernel here (warmThreads), for its first threads. */
const warmed: Hand[] = [];
/** A number for each memory and image whose module is sent to a Worker: what is posted arrives there as another object each time. */
const ids = new WeakMap<object, number>();
let lastId = 0;
const idOf = (o: object): number => { let n = ids.get(o); if (!n) ids.set(o, n = ++lastId); return n; };
/** The modules an image has, where every Worker running it can see (count). */
const counters = new WeakMap<Image, Int32Array>();
/** Whether Worker `w` keeps an instance of image `imageId` (of any, null) on memory `memoryId` (as cpu.ts's kept says). */
const keeps = (w: Hand, memoryId: number | undefined, imageId: number | null): boolean => !!memoryId && !!w.kept?.some((x) => x.memoryId === memoryId && (imageId === null || x.imageId === imageId));

/**
 * Start `n` Workers for threads now, before the kernel is made (its program and translator still on their way):
 * a Worker takes a while to load and run its script, and the first threads would otherwise wait for theirs.
 */
export function warmThreads(n = 2): void {
  while (warmed.length < n) warmed.push(newWorker());
}

function newWorker(): Hand {
  if (NodeWorker) {
    // (Not new URL(…, import.meta.url) as such: a bundler would take this for a file of the page's to carry.)
    const here = import.meta.url;
    const w = new NodeWorker(new URL('./cpu.ts', here));
    // A spare one waiting for a thread keeps nothing alive.
    w.unref();
    return {post: (m) => w.postMessage(m), end: () => void w.terminate(), on: (fn) => w.on('message', fn), onError: (fn) => w.on('error', fn)};
  }
  const w = new Worker(new URL('./cpu.ts', import.meta.url), {type: 'module'});
  return {post: (m) => w.postMessage(m), end: () => w.terminate(), on: (fn) => w.addEventListener('message', (e) => fn(e.data)), onError: (fn) => w.addEventListener('error', fn)};
}

export class RemoteKernel extends Kernel {
  declare readonly tasks: Map<number, RemoteTask>;
  declare readonly door: Int32Array;
  declare readonly outbox: Outbox;
  declare readonly gils: WeakMap<WebAssembly.Memory, SharedArrayBuffer>;
  declare readonly spares: Hand[];
  declare readonly channels: SharedArrayBuffer[];
  declare readonly spareCount: number;
  declare readonly onIdle: ((r: Pumped) => void) | null;
  declare serving: Promise<number> | null;
  declare closing: boolean;
  declare readonly passOn: boolean;
  constructor(options: Apart) {
    super(options);
    this.shared = true;
    this.door = new Int32Array(new SharedArrayBuffer(8)); // rung by every thread that asks; [1]: the kernel sleeps (channel.ts sleep)
    this.outbox = new Outbox(); // what threads write to the console without asking (cpu.ts toConsole), taken here
    this.gils = new WeakMap(); // memory -> its threads' lock
    this.spares = []; // Workers started ahead, for the next thread
    this.channels = []; // channels of threads that ended, for the next (each given once its Worker has left it)
    this.spareCount = options.spares ?? 2;
    this.onIdle = options.onIdle ?? null; // (r) => void: every thread waits ({waiting, until?}) or it all ended ({status})
    this.serving = null;
    this.closing = false;
    // Once it ends, its Workers left over go on to the next kernel made here (a start rehearsed: their code is warm).
    this.passOn = options.passOn ?? false;
    // Started now, while the first program is translated (those warmed already first).
    for (const w of warmed.splice(0)) this.spares.push(this.adoptWorker(w));
    while (this.spares.length < this.spareCount) this.spares.push(this.spawnWorker());
  }

  override newTask(proc: Process): RemoteTask { return new RemoteTask(proc, this.nextPid++); }
  override ready(t: Task): void { this.go(t); }
  override go(t: Task): void { (t as RemoteTask).answer(); }
  /**
   * A memory let go of is taken again: its threads' lock is free, as a new one would be (no thread runs on a memory let
   * go of; one ended in guest code leaves it tainted, never taken again). The same lock, so a Worker that keeps an
   * instance on the memory has it already (RemoteTask.answer: an exec gone on with in its Worker).
   */
  override reuseMemory(memory: Mem): void { const g = this.gils.get(memory); if (g) new Int32Array(g).fill(0); }
  /** Raised as an interrupt is: the thread running guest code looks in at its next loop's head (cpu.ts pause). */
  override lookIn(p: Process): void { if (p.memory) Atomics.store(new Int32Array(p.memory.buffer), INTERRUPT >> 2, 1); }

  /** A Worker whose thread ended in a call: free for the next thread (up to a few). */
  keep(w: Hand): void {
    if (this.spares.length < 8) this.spares.push(w); else w.end();
  }

  /**
   * A Worker for `t`'s thread: one that still holds an instance of its program on the memory it runs on (cpu.ts keeps
   * its last few: `kept`), where that may go on (t.mayGoOn: again); any other, one started ahead.
   */
  worker(t: RemoteTask | null = null): Hand {
    let w: Hand | undefined;
    const k = t?.mayGoOn ? this.spares.findIndex((s) => this.holds(s, t)) : -1;
    if (t && k >= 0) { [w] = this.spares.splice(k, 1); t.again = true; PROFILE.instancesKept++; }
    w ??= this.spares.pop() ?? this.spawnWorker();
    while (this.spares.length < this.spareCount) this.spares.push(this.spawnWorker());
    return w;
  }

  /** Whether Worker `w` keeps an instance of `t`'s image on `t`'s memory. */
  holds(w: Hand, t: RemoteTask): boolean { return keeps(w, ids.get(t.memory), ids.get(t.image) ?? -1); }

  /** The Workers here: those spare and those running a thread. */
  workers(): Set<Hand> { return new Set([...this.spares, ...[...this.tasks.values()].flatMap((t) => (t.worker ? [t.worker] : []))]); }

  override keepsInstance(memory: Mem, image: Image | null = null): boolean {
    const memoryId = ids.get(memory), imageId = image ? ids.get(image) ?? null : null;
    return !!memoryId && (!image || !!imageId) && [...this.workers()].some((w) => keeps(w, memoryId, imageId));
  }

  /** `memory` is let go of for good: no Worker keeps an instance on it (each would hold it). */
  override forget(memory: Mem): void {
    const memoryId = ids.get(memory);
    if (!memoryId) return;
    for (const w of this.workers()) {
      if (!w.kept?.some((x) => x.memoryId === memoryId)) continue;
      w.kept = w.kept?.filter((x) => x.memoryId !== memoryId);
      w.post({type: 'forget', memoryId});
    }
  }

  /** A channel for a new thread: one an ended thread's Worker has left (cleared), else a new one. */
  channel(): SharedArrayBuffer {
    const k = this.channels.findIndex((c) => Atomics.load(new Int32Array(c), CH.LEFT) === 1);
    if (k < 0) return new SharedArrayBuffer(CH.SIZE);
    const [c] = this.channels.splice(k, 1);
    new Int32Array(c, 0, CH.DATA >> 2).fill(0);
    return c;
  }

  spawnWorker(): Hand { return this.adoptWorker(newWorker()); }

  /** A Worker for threads, heard by this kernel (by the kernel it is passed on to, after: `w.kernel`). */
  adoptWorker(w: Hand): Hand {
    const heard = !!w.kernel;
    w.kernel = this;
    if (heard) return w;
    w.on((m) => {
      const k = w.kernel;
      if (k && m?.type === 'error') {
        const t = [...k.tasks.values()].find((x) => x.worker === w);
        k.say(2, enc.encode(`xlat: ${m.message.split('\n')[0]}\n`));
        if (t) k.exitProcess(t.proc, 11);
        k.kick();
      }
    });
    w.onError((e) => { w.kernel?.say(2, enc.encode(`xlat: ${e?.message ?? e}\n`)); });
    return w;
  }

  gil(memory: WebAssembly.Memory): SharedArrayBuffer {
    let g = this.gils.get(memory);
    if (!g) this.gils.set(memory, (g = new SharedArrayBuffer(8))); // [0]: the thread holding it; [1]: how many wait
    return g;
  }

  /** Something changed outside (input came): look again. */
  kick(): void {
    this.dirty = true;
    Atomics.add(this.door, 0, 1);
    Atomics.notify(this.door, 0);
  }

  /**
   * What threads put in the console's outbox, written to it: as the kernel turns, unless the page has not taken in what
   * came before it (`always`: before what the kernel itself writes there, which comes after it).
   */
  takeOutbox(always = false): void {
    if (!this.outbox.held || (!always && this.console.full?.())) return;
    for (const {fd, bytes} of this.outbox.take()) this.console.write(fd, bytes);
  }
  override say(fd: number, bytes: Uint8Array): void { this.takeOutbox(true); super.say(fd, bytes); }

  /** Answer every thread that asks. True when one did. */
  drain(): boolean {
    let asking: RemoteTask[] | null = null;
    // Those asking first (handling one can end or add others), then each.
    for (const t of this.tasks.values()) if (!t.dead && Atomics.load(t.i32, CH.STATE) === 1) (asking ??= []).push(t);
    if (!asking) return false;
    for (const t of asking) {
      if (t.dead || Atomics.load(t.i32, CH.STATE) !== 1) continue;
      Atomics.store(t.i32, CH.STATE, 3);
      // Its time in its program since it went on (answer), up to here; the kernel's on what it asked.
      const at = performance.now();
      this.charge(t, at - t.since, 0);
      this.handle(t);
      // Answered (answer stamped when): the kernel's time on it ended there.
      this.charge(t, 0, (t.since >= at ? t.since : performance.now()) - at);
    }
    return true;
  }

  handle(t: RemoteTask): void {
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
    if (op === OP.YIELD) {
      // Its time is up in guest code: a signal sent meanwhile is taken now (as at a call's end); else it goes on.
      t.resumeAt = t.i64[CH.NEXT];
      t.redirected = false;
      t.regsChanged = false;
      if (t.proc.maps.length) t.proc.syncShared();
      if (deliverable(t)) take(this, t, t.context());
      if (t.dead) return;
      if (t.proc.stopped) { t.state = 'stopped'; return; }
      // Another of its threads that runs guest code (at the lock, next) is wanted too.
      if ([...t.proc.tasks].some((u) => u !== t && u.state === 'running' && deliverable(u))) this.lookIn(t.proc);
      return t.answer();
    }
    if (op === OP.FAULT) {
      const said = t.text();
      if (said) this.say(2, enc.encode(said));
      this.exitProcess(t.proc, Number(t.i64[CH.ARG0]));
    }
  }

  call(t: RemoteTask): void {
    const i64 = t.i64, nr = Number(i64[CH.NR]);
    const args = [i64[CH.ARGS], i64[CH.ARGS + 1], i64[CH.ARGS + 2], i64[CH.ARGS + 3], i64[CH.ARGS + 4], i64[CH.ARGS + 5]];
    const next = i64[CH.NEXT];
    if (nr === 56 || nr === 57 || nr === 58) { try { t.fpuState = JSON.parse(t.text()); } catch { t.fpuState = null; } }
    t.resumeAt = next;
    t.redirected = false;
    t.regsChanged = false;
    const call: Call = {nr, args, next, state: {}};
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
  busy(): boolean {
    for (const t of this.tasks.values()) if (!t.dead && t.state === 'running') return true;
    return false;
  }

  /** Start the first process and serve every thread until init ends; its wait status. */
  serve(): Promise<number> {
    this.serving ??= (async () => {
      let yielded = performance.now();
      while (this.status === null) {
        const seen = Atomics.load(this.door, 0);
        this.drain();
        this.retry();
        this.takeOutbox();
        if (this.status !== null) break;
        const now = performance.now();
        // Served without a break for a while: the host gets its turn (input, Ctrl-C) before more.
        // What the console gathered goes on its way when due (src/app/prompt/kernel.worker.ts), and before a wait that may be long, whole.
        this.console.flush?.(false);
        if (now - yielded > YIELD_MS) { await macrotask(); yielded = performance.now(); continue; }
        if (Atomics.load(this.door, 0) !== seen) continue;
        const until = this.deadline();
        const busy = this.busy();
        if (!busy) this.onIdle?.(until === undefined ? {waiting: true} : {waiting: true, until});
        // A thread runs and will likely ask soon: wait for it right here, which wakes far sooner than the event loop
        // (and watching first, sooner than a wait).
        if (busy && BLOCKING) {
          if (watch(this.door, 0, (v) => v !== seen)) continue;
          const r = sleep(this.door, 0, seen, 1, Math.min(BLOCK_MS, until === undefined ? BLOCK_MS : Math.max(0, until - now)));
          if (r !== 'timed-out') continue;
        }
        this.console.flush?.(true);
        Atomics.store(this.door, 1, 1);
        const r = Atomics.waitAsync(this.door, 0, seen, until === undefined ? Infinity : Math.max(0, until - performance.now()));
        if (r.async) { await r.value; yielded = performance.now(); }
        Atomics.store(this.door, 1, 0);
      }
      this.takeOutbox(true);
      this.close();
      this.onIdle?.({status: this.status ?? 0});
      return this.status ?? 0;
    })();
    return this.serving;
  }

  /** Everything ends now; serving ends with it. */
  override halt(): void { super.halt(); this.kick(); }

  /** End every Worker (threads, and spares unless they are passed on). */
  close(): void {
    this.closing = true;
    for (const t of this.tasks.values()) t.end();
    // (Those passed on wait in warmThreads' list, as Workers started ahead do.)
    for (const w of this.spares.splice(0)) if (this.passOn) warmed.push(w); else w.end();
  }

  /** Run to the end (a sleep is waited out); its wait status. */
  override async spawn(path: string, argv: string[], env: string[], cwd = '/'): Promise<number> {
    this.start(path, argv, env, cwd);
    return await this.serve();
  }
}

/** The modules an image has, where every Worker running it can see. */
function count(image: Image): Int32Array {
  let counter = counters.get(image);
  if (!counter) counters.set(image, counter = new Int32Array(new SharedArrayBuffer(4)));
  Atomics.store(counter, 0, image.extras.length);
  return counter;
}

/** A thread whose registers live in its channel while it waits there, and whose code runs in its Worker. */
class RemoteTask extends Task {
  declare readonly kernel: RemoteKernel;
  declare readonly channel: SharedArrayBuffer;
  declare readonly i32: Int32Array;
  declare readonly i64: BigInt64Array;
  declare worker: Hand | null;
  declare execd: boolean;
  declare fpuState: Saved | null;
  declare mayGoOn: boolean;
  declare again: boolean;
  declare keep: Range | null;
  declare renewed?: boolean;
  declare regsChanged: boolean;
  constructor(proc: Process, tid: number) {
    super(proc, tid);
    this.channel = this.kernel.channel();
    this.i32 = new Int32Array(this.channel);
    this.i64 = new BigInt64Array(this.channel);
    this.worker = null;
    this.execd = false; // a new image waits to be sent to its Worker
    this.fpuState = null;
  }

  override load(image: Image, memory: Mem, from: Task | null = null): void {
    this.image = image;
    this.memory = memory;
    this.fpuState = from instanceof RemoteTask ? from.fpuState : null;
    // An instance a Worker kept of this image on this memory may run it (RemoteKernel.worker, answer: again).
    this.mayGoOn = goesOn(image, memory, from);
    this.again = false;
    // A module that carries its data, instantiated over a memory in use: the image is put back (cpu.ts).
    this.keep = from && !image.segments && from.memory === memory ? [image.facts.imageStart ?? 0, image.facts.imageEnd] : null;
    if (this.worker) this.execd = true;
  }
  /** Its image starts again on its memory (Process.execve): its Worker keeps its instance, told to start afresh (REPLY.RENEW). */
  override renew(): void {
    this.fpuState = null;
    if (this.worker) this.renewed = true;
  }

  override attach(): void {}
  /** How deep its stack has gone, as its Worker last said (lower.rs G_LOW); null if not known. */
  override low(): bigint | null { const v = this.i64[CH.LOW]; return v === 0n ? null : v; }
  /** Its process stops: it does too, at its next loop's head if it runs guest code. */
  override stop = (): void => { this.kernel.lookIn(this.proc); };
  /**
   * Its registers in the channel: a thread sends them only with the calls that read them (channel.ts READS_REGS).
   * Needed in another (a signal taken as its call ends, one that cuts its call short), they are asked of it there and
   * then: it waits in its call, watching for the answer.
   */
  regs(): void {
    if (Atomics.load(this.i32, CH.HAVE_REGS) || !this.worker || Atomics.load(this.i32, CH.STATE) !== 3) return;
    this.i32[CH.REPLY] = REPLY.SEND_REGS;
    Atomics.store(this.i32, CH.STATE, 2);
    rouse(this.i32, CH.STATE, CH.ASLEEP);
    // It answers as it asks (cpu.ts ask): its channel's word set, the kernel's door rung. So it is watched for, then
    // slept for on the door, never on its own word, which no one notifies (a millisecond's timeout each time, before).
    const door = this.kernel.door;
    for (;;) {
      const seen = Atomics.load(door, 0);
      if (watch(this.i32, CH.STATE, (state) => state === 1)) break;
      sleep(door, 0, seen, 1);
    }
    Atomics.store(this.i32, CH.STATE, 3);
  }
  override reg(n: number): bigint { if (n) this.regs(); return this.i64[CH.REGS + n]; }
  override setReg(n: number, v: bigint | number): void {
    if (n) { this.regs(); this.regsChanged = true; }
    this.i64[CH.REGS + n] = BigInt.asIntN(64, BigInt(v));
  }
  /** All of them replaced: none needs asking for. */
  override setContext(regs: bigint[], rip: bigint): void {
    Atomics.store(this.i32, CH.HAVE_REGS, 1);
    super.setContext(regs, rip);
  }

  /** Text the thread left in the data area. */
  text(): string { return utf8(new Uint8Array(this.channel, CH.DATA, this.i32[CH.LENGTH])); }

  reply(kind: number): void {
    this.i32[CH.REPLY] = kind;
    Atomics.store(this.i32, CH.STATE, 2);
    rouse(this.i32, CH.STATE, CH.ASLEEP);
  }

  /** It goes on: its Worker starts, or hears its call is done (its value, other registers, or a new image). */
  answer(): void {
    if (this.dead) return;
    this.state = 'running';
    this.since = performance.now();
    if (!this.worker) { this.worker = this.kernel.worker(this); this.post(); return; }
    if (this.execd) {
      this.execd = false;
      // Its Worker may keep an instance of the program it now runs, on the memory it runs it on (a shell's commands):
      // that goes on there at once, told which in the channel, its registers and where it starts there too, with no
      // message posted and no Worker leaving its call for its event loop.
      if (this.mayGoOn && this.kernel.holds(this.worker, this)) {
        PROFILE.instancesKept++;
        const memoryId = idOf(this.memory), imageId = idOf(this.image);
        this.kept(this.worker, memoryId, imageId);
        this.i64[CH.ARG0] = BigInt(memoryId);
        this.i64[CH.ARG1] = BigInt(imageId);
        this.i64[CH.RIP] = this.resumeAt;
        Atomics.store(count(this.image), 0, this.image.extras.length);
        this.reply(REPLY.EXEC);
        return;
      }
      this.reply(REPLY.AWAY);
      this.post();
      return;
    }
    if (this.renewed) { this.renewed = false; this.i64[CH.RIP] = this.resumeAt; this.reply(REPLY.RENEW); return; }
    if (this.redirected) { this.i64[CH.RIP] = this.resumeAt; this.reply(REPLY.REDIRECT); return; }
    const changed = this.regsChanged;
    this.regsChanged = false;
    this.reply(changed ? REPLY.REGS : REPLY.VALUE);
  }

  /** What its Worker keeps after this run, as it keeps it (cpu.ts kept): this instance first, the few before it. */
  kept(w: Hand, memoryId: number, imageId: number): void {
    w.kept = [{memoryId, imageId, extras: this.image.extras.length}, ...(w.kept ?? []).filter((x) => x.memoryId !== memoryId || x.imageId !== imageId)].slice(0, KEEP_INSTANCES);
  }

  post(): void {
    const image = this.image, k = this.kernel, w = this.worker!;
    const memoryId = idOf(this.memory), imageId = idOf(image);
    // What its Worker has already is not sent again (cloning a memory or a module costs tens of microseconds): a
    // memory one of its kept threads ran on, and an image's module and the modules made for it as of then.
    const known = w.kept?.some((x) => x.memoryId === memoryId), like = w.kept?.find((x) => x.imageId === imageId);
    const from = like?.extras ?? 0;
    this.kept(w, memoryId, imageId);
    w.post({
      type: 'run', again: this.again, tid: this.tid, memoryId, imageId, module: like ? undefined : image.module,
      extrasFrom: from, extras: image.extras.slice(from).map(({module, base, count: n}) => ({module, base, count: n})),
      memory: known ? undefined : this.memory, channel: this.channel, door: k.door.buffer, gil: k.gil(this.memory), count: count(image).buffer,
      outbox: k.outbox.buffer, consoles: this.proc.fds.consoles.buffer,
      regs: REG.map((_, n) => this.reg(n)), resumeAt: this.resumeAt, x87: w.x87 ? undefined : k.x87Module ?? undefined, fpu: this.fpuState, keep: this.keep,
      origin: performance.timeOrigin, // the kernel's clocks begin here (clock.ts)
    });
    w.x87 = true;
    this.again = false;
  }

  override end(): void {
    const w = this.worker;
    this.worker = null;
    // A Worker waiting in a call (it ended itself, or was ended while it waited) is told to leave and is kept for the
    // next thread; one running guest code is ended where it is.
    const state = Atomics.load(this.i32, CH.STATE);
    if (w && (state === 1 || state === 3) && !this.kernel.closing) {
      this.reply(REPLY.AWAY);
      this.kernel.keep(w);
      // Its channel, for another thread once its Worker has left it (CH.LEFT).
      if (this.kernel.channels.length < 16) this.kernel.channels.push(this.channel);
    }
    else {
      // Ended while it ran guest code: it may write on a little, so its memory is never given to another process, and
      // what it would still put in the console's outbox is not put (its interrupt word, raised first: Outbox.put).
      if (w) this.kernel.lookIn(this.proc);
      w?.end();
      if (w && this.memory) this.memory.tainted = true;
    }
    // Ended while it held its process's lock (killed while running): the lock goes with it.
    if (this.memory) {
      const gil = new Int32Array(this.kernel.gil(this.memory));
      if (Atomics.compareExchange(gil, 0, this.tid, 0) === this.tid) Atomics.notify(gil, 0);
    }
  }
}
