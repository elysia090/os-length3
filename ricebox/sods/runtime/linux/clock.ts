// The machine's clocks, as clock_gettime, gettimeofday and time read them, in one place: the kernel answers with them,
// and so does a thread itself (cpu.ts, or the dispatcher's entry in process.ts) without a call to the kernel, as
// Linux's vDSO answers these three in the caller (a call that crosses to the kernel's Worker costs microseconds; a
// program reads the time in its loops, as it may where the vDSO makes that free).
//
//   CLOCK_REALTIME (_COARSE, _ALARM, TAI)                    the wall clock, to well under a millisecond (TAI's offset
//                                                            is Linux's own until a time daemon sets it: none)
//   CLOCK_MONOTONIC (_RAW, _COARSE, BOOTTIME, _ALARM)        time since the kernel began, never set back: the same
//                                                            in every thread, however far from the kernel it runs
//   the CPU-time clocks (the process's, the thread's, a pid's) the kernel's to answer: the time each thread ran its
//                                                            program and the kernel made its calls (Kernel.charge)

import type {Cpu, Proc} from './parts.ts';
import {began, steady} from '../host.ts';

/** Clock ids Linux has: which clock each reads (1 the wall, 2 the steady, 3 a CPU-time one; 0 none), by id. */
const KIND = new Uint8Array([1, 2, 3, 3, 2, 1, 2, 2, 1, 2, 0, 1]);
const kindOf = (id: number): number => (id < 0 ? 3 : id < KIND.length ? KIND[id] : 0);

/** A kernel's clocks (clocks()): ns as BigInts, ms as Numbers. */
export interface Clocks {
  wall(): bigint;
  monotonic(): bigint;
  wallMs(): number;
  /** Time since the kernel began (ms). */
  steadyMs(): number;
  readMs(id: number): number | null | undefined;
  read(id: number): bigint | null | undefined;
}

/**
 * The clocks of a kernel that began at `origin` (when its realm began: host.ts began, which a thread elsewhere is
 * told): each in ns, as a BigInt.
 */
export function clocks(origin: number = began): Clocks {
  const ms = () => began + steady();
  const wall = () => BigInt(Math.round(ms() * 1e6));
  const monotonic = () => BigInt(Math.round((ms() - origin) * 1e6));
  const wallMs = ms, steadyMs = () => ms() - origin;
  return {
    wall,
    monotonic,
    wallMs,
    steadyMs,
    /** Clock `id`'s time in ms (a Number); null for a CPU-time clock, undefined for no clock. */
    readMs(id: number) {
      const kind = kindOf(id);
      return kind === 1 ? wallMs() : kind === 2 ? steadyMs() : kind === 3 ? null : undefined;
    },
    /** Clock `id`'s time in ns; null for a CPU-time clock (the kernel's), undefined for no clock (EINVAL). */
    read(id: number) {
      const kind = kindOf(id);
      return kind === 1 ? wall() : kind === 2 ? monotonic() : kind === 3 ? null : undefined;
    },
  };
}

/**
 * Answer system call `nr` (args `a`, `b`) at once when it only reads a clock: clock_gettime of a clock not the
 * kernel's, gettimeofday, time. The result (a BigInt), or null when the kernel is to answer it (another call, a
 * CPU-time clock, an address not in `memory`, which the kernel says EFAULT to).
 */
export function answerTime(memory: WebAssembly.Memory, clock: Clocks, nr: bigint, a: bigint, b: bigint): bigint | null {
  // (No BigInt arithmetic, nothing made a call, and the view kept while the memory's buffer is the same: a program
  // reads the clock in its loops.)
  if (nr === 228n) { // clock_gettime
    const kind = kindOf(Number(BigInt.asIntN(32, a)));
    if (kind !== 1 && kind !== 2) return null;
    const ms = kind === 1 ? clock.wallMs() : clock.steadyMs();
    const s = Math.floor(ms / 1000);
    return put(viewOf(memory), Number(b), s, Math.min(999999999, Math.round((ms - s * 1000) * 1e6))) ? 0n : null;
  }
  if (nr === 96n) { // gettimeofday (a timezone asked for is UTC's: none west, no DST)
    const view = viewOf(memory), ms = clock.wallMs(), s = Math.floor(ms / 1000);
    if (a && !put(view, Number(a), s, Math.min(999999, Math.round((ms - s * 1000) * 1e3)))) return null;
    if (b && !put(view, Number(b), 0, -1)) return null;
    return 0n;
  }
  if (nr === 201n) { // time
    const s = Math.floor(clock.wallMs() / 1000);
    if (a && !put(viewOf(memory), Number(a), s, -1)) return null;
    return BigInt(s);
  }
  return null;
}

/**
 * 64-bit words `x` and `y` (none when -1: one word alone) put at `at`; false for an address past the memory, or in its
 * first page, which a program never has (vm.mmap_min_addr) and the kernel keeps its words in (process.ts INTERRUPT).
 */
function put(view: DataView, at: number, x: number, y: number): boolean {
  if (at < 4096 || at + (y < 0 ? 8 : 16) > view.byteLength) return false;
  view.setUint32(at, x % 0x100000000, true); view.setUint32(at + 4, Math.floor(x / 0x100000000), true);
  if (y >= 0) { view.setUint32(at + 8, y % 0x100000000, true); view.setUint32(at + 12, Math.floor(y / 0x100000000), true); }
  return true;
}

const views = new WeakMap<WebAssembly.Memory, DataView>();
/** A DataView of `memory` as it is now (a new one once it has grown). */
function viewOf(memory: WebAssembly.Memory): DataView {
  const buffer = memory.buffer;
  let v = views.get(memory);
  if (!v || v.buffer !== buffer) { v = new DataView(buffer); views.set(memory, v); }
  return v;
}

/** A process's time on the processor (ms): its threads' that ended, and theirs that run. */
export function cpuOf(p: Proc): Cpu {
  let {user, sys} = p.cpu;
  for (const t of p.tasks) { user += t.cpu.user; sys += t.cpu.sys; }
  return {user, sys};
}

/**
 * A CPU-time clock as `p` reads it (ns): its process's (CLOCK_PROCESS_CPUTIME_ID), its thread's (_THREAD_), or one
 * clock_getcpuclockid or pthread_getcpuclockid made of a pid or a tid (~id << 3, 4 for a thread's; 0 the caller's own;
 * its low bits: 1 its program's time alone, else with the kernel's). Undefined for no such clock, or no one there.
 */
export function cpuClock(p: Proc, id: number): bigint | undefined {
  let c: Cpu | undefined, kind = 2;
  if (id === 2) c = cpuOf(p);
  else if (id === 3) c = p.task.cpu;
  else if (id < 0 && (id & 3) !== 3) {
    const n = ~(id >> 3);
    kind = id & 3;
    if (id & 4) c = (n ? p.kernel.tasks.get(n) : p.task)?.cpu;
    else { const q = n ? p.kernel.procs.get(n) : p; c = q && cpuOf(q); }
  }
  return c && BigInt(Math.round((kind === 1 ? c.user : c.user + c.sys) * 1e6));
}
