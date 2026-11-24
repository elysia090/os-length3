// Translated-thread helpers shared by the inline kernel and the apart CPU.

class GuestTrap extends Error {
  declare readonly address: bigint | number;
  declare readonly code: number;
  constructor(address: bigint | number, code: number) {
    const kind = ({1: 'jump to untranslated code', 2: 'undecodable code', 3: 'unsupported instruction', 4: 'divide error',
      7: 'ud2', 8: 'int3', 9: 'hlt'} as Record<number, string>)[code] ?? `trap ${code}`;
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
export function fault(e: unknown): number | null {
  if (e instanceof GuestTrap) return ({1: 11, 2: 4, 3: 4, 4: 8, 7: 4, 8: 5, 9: 11} as Record<number, number>)[e.code] ?? 4;
  if (!(e instanceof WebAssembly.RuntimeError)) return null;
  // A division translated as the engine's own (the divisor's width the dividend's: sods' integer.rs), which the
  // processor would have refused: by zero, or a quotient too large (the least integer by -1). The engine traps, and
  // says which in its own words (V8: "divide by zero", "remainder by zero", "divide result unrepresentable";
  // SpiderMonkey: "integer divide by zero", "integer overflow"; JavaScriptCore: "Division by zero", "Integer
  // overflow"). SIGFPE, as the wider division's own check gives it (div128: a GuestTrap of code 4).
  if (/divi(de|sion) by zero|remainder by zero|unrepresentable|integer overflow/i.test(e.message)) return 8;
  if (/out of bounds|unreachable/i.test(e.message)) return 11;
  return null;
}

/** A trap that is the translator's limit, not the program's: said on stderr, so it is not taken for the program's own. */
export const translatorsLimit = (e: unknown): e is GuestTrap => e instanceof GuestTrap && e.code >= 1 && e.code <= 3;
/**
 * Thrown through wasm frames when translated code gives the thread back: its time slice is up at a loop's head
 * (code 5), or its calls are deep and the next one starts afresh (code 6). Registers are in their globals; it goes
 * on at `address`.
 */
export class Preempted {
  declare readonly address: bigint;
  declare readonly code: number;
  constructor(address: bigint | number, code: number) { this.address = BigInt.asUintN(64, BigInt(address)); this.code = code; }
}
export const TRAP_YIELD = 5, TRAP_UNWIND = 6;
/**
 * A thread's time slice: about SLICE_MS of guest code, counted as the loops it goes round and the calls it makes
 * (translated code counts them down), so the kernel looks at timers, signals and other threads that often. How many
 * fit in it is learnt from the last one; SLICE_LOOPS is the first guess.
 */
export const SLICE_MS = 1, SLICE_LOOPS = 1 << 16;
export const nextSlice = (loops: number, ms: number): number => Math.max(1 << 10, Math.min(1 << 26, Math.round(loops * Math.sqrt(SLICE_MS / Math.max(ms, SLICE_MS / 64)))));
/** Where translated code looks for the kernel's call to look in (sods' abi.rs INTERRUPT): a word, and whether its process shares memory with another. */
export const INTERRUPT = 0x100, SHARES = INTERRUPT + 4;

export const trapOrPreempt = (address: bigint | number, code: number): never => {
  if (code === TRAP_YIELD || code === TRAP_UNWIND) throw new Preempted(address, code);
  throw new GuestTrap(address, code);
};

/**
 * The instances kept on a memory its processes ended on, each of its own program (Task.load; a Worker's, remote.ts
 * and cpu.ts): a shell's fork child and the command it runs take turns on one memory.
 */
export const KEEP_INSTANCES = 2;

export function div128(hi: bigint, lo: bigint, d: bigint, signed: number): [bigint, bigint] {
  let n = (BigInt.asUintN(64, hi) << 64n) | BigInt.asUintN(64, lo);
  let divisor = BigInt.asUintN(64, d);
  if (signed) { n = BigInt.asIntN(128, n); divisor = BigInt.asIntN(64, divisor); }
  if (divisor === 0n) throw new GuestTrap(0n, 4);
  const q = n / divisor, r = n % divisor;
  if (signed ? BigInt.asIntN(64, q) !== q : BigInt.asUintN(64, q) !== q) throw new GuestTrap(0n, 4);
  return [BigInt.asIntN(64, q), BigInt.asIntN(64, r)];
}
