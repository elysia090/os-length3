// The channel between a guest thread's Worker (cpu.mjs) and the kernel
// (remote.mjs): one SharedArrayBuffer per thread. Int32 words say whose
// turn it is and what is asked; 64-bit words carry the call, its value and
// the registers; the data area carries text and module bytes.

import {REG} from './process.mjs';

export const CH = {
  // Int32 indices
  STATE: 0, // 0: the thread runs; 1: it asks (the kernel's turn); 2: answered
  OP: 1,
  REPLY: 2,
  LENGTH: 3, // bytes in the data area
  ASLEEP: 120, // the thread waits for its answer in Atomics.wait (else it watches: no notify needed)
  HAVE_REGS: 121, // the registers are in REGS (a call that reads them, or the kernel asked: REPLY.SEND_REGS)
  // BigInt64 indices
  NR: 2, ARGS: 3, NEXT: 9, VALUE: 10, RIP: 11, ARG0: 12, ARG1: 13, REGS: 16,
  // bytes
  DATA: 512, DATA_BYTES: 256 << 10,
};
CH.SIZE = CH.DATA + CH.DATA_BYTES;

/**
 * What a thread asks: a system call, code at an address (miss), a module's bytes, the end its fault brings, or its
 * turn's end while it ran guest code (a signal that came meanwhile is taken then, at the address in NEXT).
 */
export const OP = {SYSCALL: 1, MISS: 2, MODULE: 3, FAULT: 4, YIELD: 5, REGS: 6};
/**
 * What the kernel answers to a call: its value (in rax), registers to go on with at RIP, leave (exec, or the end),
 * its value with registers it set (arch_prctl's fs), or (not yet an answer) that it needs the registers (OP.REGS).
 */
export const REPLY = {VALUE: 1, REDIRECT: 2, AWAY: 3, REGS: 4, SEND_REGS: 5};
/**
 * The calls that read the caller's registers: those a thread sends them with. For any other the kernel asks for them
 * only if it comes to need them (a signal taken as the call ends): copying them each call cost more than the call.
 */
export const READS_REGS = new Set([15, 56, 57, 58, 131, 158, 435]);

export const REGS = REG;

/**
 * Watch word `index` of `words` for up to `ms` (spinning, as a lock does before it sleeps): true once `ready` says
 * it changed. A thread woken from Atomics.wait takes tens of microseconds to run again; a call answered while its
 * caller still watches costs well under one, so each side watches a little before it sleeps.
 */
export function watch(words, index, ready, ms = WATCH_MS) {
  const end = performance.now() + ms;
  do {
    for (let k = 0; k < 256; k++) if (ready(Atomics.load(words, index))) return true;
  } while (performance.now() < end);
  return false;
}
/** How long: about what a call takes the kernel, and what a program computes between two calls that come quickly. */
export const WATCH_MS = 0.05;

/**
 * Wait (Atomics.wait) while `words[index]` is `value`, saying so in `words[asleep]` first: who changes the word then
 * looks there, after changing it, and notifies only a sleeper (Atomics.notify costs as much as the call it ends).
 * Seen in that order on both sides, no change goes unnoticed. Returns as Atomics.wait does.
 */
export function sleep(words, index, value, asleep, ms = Infinity) {
  Atomics.store(words, asleep, 1);
  const r = Atomics.wait(words, index, value, ms);
  Atomics.store(words, asleep, 0);
  return r;
}
/** The other side of sleep: `words[index]` was changed; a sleeper on it is woken. */
export function rouse(words, index, asleep) { if (Atomics.load(words, asleep)) Atomics.notify(words, index); }
