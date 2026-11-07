// The machine's clocks, as clock_gettime, gettimeofday and time read them, in one place: the kernel answers with them,
// and so does a thread itself (cpu.ts, or the dispatcher's entry in process.ts) without a call to the kernel, as
// Linux's vDSO answers these three in the caller (a call that crosses to the kernel's Worker costs microseconds; a
// program reads the time in its loops, as it may where the vDSO makes that free).
//
//   CLOCK_REALTIME (_COARSE, _ALARM, TAI)                    the wall clock, to well under a millisecond (TAI's offset
//                                                            is Linux's own until a time daemon sets it: none)
//   CLOCK_MONOTONIC (_RAW, _COARSE, BOOTTIME, _ALARM)        time since the kernel began, never set back: the same
//                                                            in every thread, however far from the kernel it runs
//   the CPU-time clocks (the process's, the thread's, a pid's) the kernel's to answer (here: not known)

/** Clock ids Linux has: which clock each reads. */
const WALL = new Set([0, 5, 8, 11]), STEADY = new Set([1, 4, 6, 7, 9]), CPU = new Set([2, 3]);

/** A kernel's clocks (clocks()): ns as BigInts, ms as Numbers. */
export interface Clocks {
  wall(): bigint;
  monotonic(): bigint;
  wallMs(): number;
  readMs(id: number): number | null | undefined;
  read(id: number): bigint | null | undefined;
}

/**
 * The clocks of a kernel that began at `origin` (its realm's performance.timeOrigin, which a thread elsewhere is
 * told): each in ns, as a BigInt.
 */
export function clocks(origin: number = performance.timeOrigin): Clocks {
  const ms = () => performance.timeOrigin + performance.now();
  const wall = () => BigInt(Math.round(ms() * 1e6));
  const monotonic = () => BigInt(Math.round((ms() - origin) * 1e6));
  const wallMs = ms, steadyMs = () => ms() - origin;
  return {
    wall,
    monotonic,
    wallMs,
    /** Clock `id`'s time in ms (a Number); null for a CPU-time clock, undefined for no clock. */
    readMs(id: number) {
      if (WALL.has(id)) return wallMs();
      if (STEADY.has(id)) return steadyMs();
      if (CPU.has(id) || id < 0) return null;
      return undefined;
    },
    /** Clock `id`'s time in ns; null for a CPU-time clock (the kernel's), undefined for no clock (EINVAL). */
    read(id: number) {
      if (WALL.has(id)) return wall();
      if (STEADY.has(id)) return monotonic();
      if (CPU.has(id) || id < 0) return null;
      return undefined;
    },
  };
}

/**
 * Answer system call `nr` (args `a`, `b`) at once when it only reads a clock: clock_gettime of a clock not the
 * kernel's, gettimeofday, time. The result (a BigInt), or null when the kernel is to answer it (another call, a
 * CPU-time clock, an address not in `memory`, which the kernel says EFAULT to).
 */
export function answerTime(memory: WebAssembly.Memory, clock: Clocks, nr: bigint, a: bigint, b: bigint): bigint | null {
  // (Without BigInt arithmetic, and with the view kept while the memory's buffer is the same: this is a hot path.)
  const view = viewOf(memory);
  const out = (at: number, words: number[]): boolean => {
    if (at < 0 || at + 8 * words.length > view.byteLength) return false;
    for (let k = 0; k < words.length; k++) { const w = words[k]; view.setUint32(at + 8 * k, w % 0x100000000, true); view.setUint32(at + 8 * k + 4, Math.floor(w / 0x100000000), true); }
    return true;
  };
  if (nr === 228n) { // clock_gettime
    const id = Number(BigInt.asIntN(32, a));
    const ms = clock.readMs(id);
    if (ms === null || ms === undefined) return null;
    const s = Math.floor(ms / 1000);
    return out(Number(b), [s, Math.min(999999999, Math.round((ms - s * 1000) * 1e6))]) ? 0n : null;
  }
  if (nr === 96n) { // gettimeofday (a timezone asked for is UTC's: none west, no DST)
    const ms = clock.wallMs(), s = Math.floor(ms / 1000);
    if (a && !out(Number(a), [s, Math.min(999999, Math.round((ms - s * 1000) * 1e3))])) return null;
    if (b && !out(Number(b), [0])) return null;
    return 0n;
  }
  if (nr === 201n) { // time
    const s = Math.floor(clock.wallMs() / 1000);
    if (a && !out(Number(a), [s])) return null;
    return BigInt(s);
  }
  return null;
}

const views = new WeakMap<WebAssembly.Memory, DataView>();
/** A DataView of `memory` as it is now (a new one once it has grown). */
function viewOf(memory: WebAssembly.Memory): DataView {
  const buffer = memory.buffer;
  let v = views.get(memory);
  if (!v || v.buffer !== buffer) { v = new DataView(buffer); views.set(memory, v); }
  return v;
}
