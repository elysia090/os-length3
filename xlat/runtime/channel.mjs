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
  // BigInt64 indices
  NR: 2, ARGS: 3, NEXT: 9, VALUE: 10, RIP: 11, ARG0: 12, ARG1: 13, REGS: 16,
  // bytes
  DATA: 512, DATA_BYTES: 256 << 10,
};
CH.SIZE = CH.DATA + CH.DATA_BYTES;

/** What a thread asks: a system call, code at an address (miss), a module's bytes, or the end its fault brings. */
export const OP = {SYSCALL: 1, MISS: 2, MODULE: 3, FAULT: 4};
/** What the kernel answers to a call: its value (in rax), registers to go on with at RIP, leave (exec, or the end), or its value with registers it set (arch_prctl's fs). */
export const REPLY = {VALUE: 1, REDIRECT: 2, AWAY: 3, REGS: 4};

export const REGS = REG;
