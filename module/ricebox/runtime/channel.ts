// The channel between a guest thread's Worker (cpu.ts) and the kernel
// (remote.ts): one SharedArrayBuffer per thread. Int32 words say whose
// turn it is and what is asked; 64-bit words carry the call, its value and
// the registers; the data area carries text and module bytes.

import type {Saved} from '../../sods/runtime/x87.ts';
import type {Range} from './parts.ts';
import {REG} from './process.ts';

export const CH = {
  // Int32 indices
  STATE: 0, // 0: the thread runs; 1: it asks (the kernel's turn); 2: answered
  OP: 1,
  REPLY: 2,
  LENGTH: 3, // bytes in the data area
  ASLEEP: 120, // the thread waits for its answer in Atomics.wait (else it watches: no notify needed)
  HAVE_REGS: 121, // the registers are in REGS (a call that reads them, or the kernel asked: REPLY.SEND_REGS)
  LEFT: 122, // its Worker ran its thread and left it (cpu.ts): the channel may be given to another (remote.ts)
  // BigInt64 indices
  NR: 2, ARGS: 3, NEXT: 9, VALUE: 10, RIP: 11, ARG0: 12, ARG1: 13, REGS: 16,
  LOW: 40, // how deep the thread's stack has gone (lower.rs G_LOW), as of its last request; 0: not known
  // bytes
  DATA: 512, DATA_BYTES: 256 << 10,
  /** Bytes of a channel. */
  get SIZE(): number { return this.DATA + this.DATA_BYTES; },
};

/**
 * What a thread asks: a system call, code at an address (miss), a module's bytes, the end its fault brings, or its
 * turn's end while it ran guest code (a signal that came meanwhile is taken then, at the address in NEXT).
 */
export const OP = {SYSCALL: 1, MISS: 2, MODULE: 3, FAULT: 4, YIELD: 5, REGS: 6};
/**
 * What the kernel answers to a call: its value (in rax), registers to go on with at RIP, leave (exec, or the end),
 * its value with registers it set (arch_prctl's fs), or (not yet an answer) that it needs the registers (OP.REGS);
 * its program begun again on its memory (RENEW), or an exec of a program whose instance on the memory the process
 * now runs on its Worker keeps (EXEC: which in ARG0 and ARG1, its registers and RIP in the channel).
 */
export const REPLY = {VALUE: 1, REDIRECT: 2, AWAY: 3, REGS: 4, SEND_REGS: 5, RENEW: 6, EXEC: 7};
/**
 * The calls that read the caller's registers: those a thread sends them with. For any other the kernel asks for them
 * only if it comes to need them (a signal taken as the call ends): copying them each call cost more than the call.
 */
export const READS_REGS = new Set([15, 56, 57, 58, 131, 158, 435]);

export const REGS = REG;

/** A module of code reached later, as a thread's Worker attaches it: its module, first table slot and how many. */
export interface Attached { module: WebAssembly.Module; base: number; count: number }
/**
 * What the kernel sends a thread's Worker to run it (remote.ts post, cpu.ts): its thread and channel, the kernel's door
 * and the process's lock, its program (the module and its memory left out where the Worker has them already), its
 * registers and where it goes on, its x87, what of the image to put back (`keep`), and the kernel's clocks' origin.
 */
export interface Run {
  type: 'run';
  again: boolean;
  tid: number;
  memoryId: number;
  imageId: number;
  module?: WebAssembly.Module;
  extrasFrom: number;
  extras: Attached[];
  memory?: WebAssembly.Memory;
  channel: SharedArrayBuffer;
  door: ArrayBufferLike;
  gil: SharedArrayBuffer;
  count: ArrayBufferLike;
  outbox: SharedArrayBuffer;
  consoles: ArrayBufferLike;
  regs: bigint[];
  resumeAt: bigint;
  /** The translator's module, for the Worker's x87 (x87.ts): sent once, with a Worker's first run. */
  x87?: WebAssembly.Module;
  /** Its thread's x87 registers as bytes; null: as they start. */
  fpu: Saved | null;
  keep: Range | null;
  origin: number;
}
/** A memory a Worker kept an instance on is let go of for good. */
export interface Forget { type: 'forget'; memoryId: number }
/** What a thread's Worker says: it is up, or what went wrong. */
export type Said = {type: 'up'} | {type: 'error'; message: string};

/**
 * What threads in Workers of their own write to the console, put straight into memory the kernel's Worker takes it
 * from (remote.ts takeOutbox), not asked of the kernel a call at a time: a terminal's output comes a line a write,
 * and each write the kernel answered kept its writer waiting a few microseconds (`yes | head -c 5M` took 14 s, five times
 * what the same threads took in turn). A ring of OUTBOX_BYTES behind four words: [0] a lock, [1] where the bytes held
 * begin, [2] how many are held. A write that does not fit whole goes to the kernel as any call does (which waits, as a
 * terminal's writer waits, when the page has not taken in what came before it).
 */
export const OUTBOX_BYTES = 64 << 10;
/** Each write held: which of the console's two (1, 2) it went to, its length, then its bytes. */
const HEAD = 5;
export class Outbox {
  declare readonly buffer: SharedArrayBuffer;
  declare readonly words: Int32Array;
  declare readonly bytes: Uint8Array;
  declare readonly head: Uint8Array;
  constructor(buffer = new SharedArrayBuffer(16 + OUTBOX_BYTES)) {
    this.buffer = buffer;
    this.words = new Int32Array(buffer, 0, 4);
    this.bytes = new Uint8Array(buffer, 16);
    this.head = new Uint8Array(HEAD);
  }
  // Held for a copy at most (a few microseconds): spun on, never slept on.
  #lock(): void { while (Atomics.compareExchange(this.words, 0, 0, 1) !== 0); }
  #unlock(): void { Atomics.store(this.words, 0, 0); }
  /** `src` copied in at `at` (round the ring's end); where it ends. */
  #in(src: Uint8Array, at: number): number {
    const size = this.bytes.length, first = Math.min(src.length, size - at);
    this.bytes.set(first === src.length ? src : src.subarray(0, first), at);
    if (src.length > first) this.bytes.set(src.subarray(first), 0);
    return (at + src.length) % size;
  }
  /** `n` bytes from `at` copied out into `to` at `into`; where they end. */
  #out(at: number, n: number, to: Uint8Array, into: number): number {
    const size = this.bytes.length, first = Math.min(n, size - at);
    to.set(this.bytes.subarray(at, at + first), into);
    if (n > first) to.set(this.bytes.subarray(0, n - first), into + first);
    return (at + n) % size;
  }
  /**
   * A write to the console's `fd`: the pieces of `from` ([address, length] each, `total` bytes in all) put in whole and
   * in order. Null when they do not all fit, or when the writer's interrupt word (`stop[word]`) is raised, else whether
   * the outbox was empty before (the kernel is then rung; else it has been, and has not yet taken what was there, which
   * it takes with these). The word is looked at while the outbox is held: a write is in before the kernel takes all
   * (Ctrl-C flushing what was on its way) or not made at all, never left in after it.
   */
  put(fd: number, from: Uint8Array, pieces: [number, number][], total: number, stop: Int32Array | null = null, word = 0): boolean | null {
    const w = this.words, size = this.bytes.length, h = this.head;
    this.#lock();
    if (stop && Atomics.load(stop, word)) { this.#unlock(); return null; }
    const start = w[1], held = w[2];
    if (held + HEAD + total > size) { this.#unlock(); return null; }
    h[0] = fd; h[1] = total & 255; h[2] = (total >>> 8) & 255; h[3] = (total >>> 16) & 255; h[4] = total >>> 24;
    let at = this.#in(h, (start + held) % size);
    for (const [a, n] of pieces) at = this.#in(from.subarray(a, a + n), at);
    w[2] = held + HEAD + total;
    this.#unlock();
    return held === 0;
  }
  /** How many bytes are held. */
  get held(): number { return Atomics.load(this.words, 2); }
  /** All that is held, taken out: what went to each fd in turn, writes in a row to one fd as one. */
  take(): {fd: number; bytes: Uint8Array}[] {
    const w = this.words, h = this.head, size = this.bytes.length, runs: {fd: number; parts: number[]; n: number}[] = [];
    this.#lock();
    const held = w[2];
    let at = w[1];
    // Where each write's bytes are, in runs of one fd; then each run copied out whole.
    for (let done = 0; done < held; done += HEAD) {
      at = this.#out(at, HEAD, h, 0);
      const fd = h[0], n = h[1] | (h[2] << 8) | (h[3] << 16) | (h[4] << 24);
      let run = runs.at(-1);
      if (run?.fd !== fd) runs.push((run = {fd, parts: [], n: 0}));
      run.parts.push(at, n);
      run.n += n;
      at = (at + n) % size;
      done += n;
    }
    const out = runs.map(({fd, parts, n}) => {
      const bytes = new Uint8Array(n);
      for (let k = 0, into = 0; k < parts.length; into += parts[k + 1], k += 2) this.#out(parts[k], parts[k + 1], bytes, into);
      return {fd, bytes};
    });
    w[1] = at;
    w[2] = 0;
    this.#unlock();
    return out;
  }
}

/**
 * Watch word `index` of `words` for up to `ms` (spinning, as a lock does before it sleeps): true once `ready` says
 * it changed. A thread woken from Atomics.wait takes tens of microseconds to run again; a call answered while its
 * caller still watches costs well under one, so each side watches a little before it sleeps.
 */
export function watch(words: Int32Array, index: number, ready: (word: number) => boolean, ms = WATCH_MS): boolean {
  const end = performance.now() + ms;
  do {
    for (let k = 0; k < 256; k++) if (ready(Atomics.load(words, index))) return true;
  } while (performance.now() < end);
  return false;
}
/** How long: about what a call takes the kernel, and what a program computes between two calls that come quickly. */
const WATCH_MS = 0.05;

/**
 * Wait (Atomics.wait) while `words[index]` is `value`, saying so in `words[asleep]` first: who changes the word then
 * looks there, after changing it, and notifies only a sleeper (Atomics.notify costs as much as the call it ends).
 * Seen in that order on both sides, no change goes unnoticed. Returns as Atomics.wait does.
 */
export function sleep(words: Int32Array, index: number, value: number, asleep: number, ms = Infinity): 'ok' | 'not-equal' | 'timed-out' {
  Atomics.store(words, asleep, 1);
  const r = Atomics.wait(words, index, value, ms);
  Atomics.store(words, asleep, 0);
  return r;
}
/** The other side of sleep: `words[index]` was changed; a sleeper on it is woken. */
export function rouse(words: Int32Array, index: number, asleep: number): void { if (Atomics.load(words, asleep)) Atomics.notify(words, index); }
