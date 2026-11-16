// What a thread puts over its own calls, as Linux has it (seccomp(2)): strict mode, and filters, each a program in
// the kernel's small machine for them (classic BPF) that is shown a call (its number, the machine it is made for,
// where it was made from, its six arguments) and answers what becomes of it. A filter is for the thread that sets
// it and all it starts, a thread or a process, across exec, and nothing takes one away: each more only narrows.
// Every filter is asked of every call, and the answer that allows least is the one that holds.
//
// muk ends the making of a box with one (../../../muk/src/filter.h): what no box asks the kernel is refused here by
// that same program, read as the kernel reads it, not by a list of this kernel's own.

import {E, FsError} from './fs.ts';
import type {Filter, Proc} from './parts.ts';

/** What a filter answers (its upper half: the action; its lower, the action's own word). */
export const RET = {KILL_PROCESS: 0x80000000, KILL_THREAD: 0, TRAP: 0x00030000, ERRNO: 0x00050000, USER_NOTIF: 0x7fc00000,
  TRACE: 0x7ff00000, LOG: 0x7ffc0000, ALLOW: 0x7fff0000};
/** The actions answered here: asked of one that is not, a program is told so (SECCOMP_GET_ACTION_AVAIL). */
export const ACTIONS: readonly number[] = [RET.KILL_PROCESS, RET.KILL_THREAD, RET.TRAP, RET.ERRNO, RET.TRACE, RET.LOG, RET.ALLOW];

/** What is shown of a call: 64 bytes (struct seccomp_data). */
const SHOWN = 64;
/** The machine translated code is made for, as audit names it (AUDIT_ARCH_X86_64). */
export const ARCH = 0xc000003e;
const MOST = 4096, WORDS = 16;

const fail = (errno: number): never => { throw new FsError(errno); };

/** The class of an instruction, and for each what may be asked of a call's 64 bytes and of the filter's own words. */
const LD = 0, LDX = 1, ST = 2, STX = 3, ALU = 4, JMP = 5, RETURN = 6, MISC = 7;

/**
 * The filter at `at` in `p`'s memory (struct sock_fprog: how many instructions, and where they are), read once and
 * checked as the kernel checks one before it takes it: only what a filter over calls may do, every jump inside it,
 * its last instruction an answer, no word read before it was written. Anything else is EINVAL, and the filter is not
 * set.
 */
export function read(p: Proc, at: number): Filter {
  const v = p.view, n = v.getUint16(at, true), from = Number(v.getBigUint64(at + 8, true));
  if (n === 0 || n > MOST) fail(E.INVAL);
  if (from + n * 8 > p.bytes.length) fail(E.FAULT);
  const f: Filter = {code: new Uint16Array(n), jt: new Uint8Array(n), jf: new Uint8Array(n), k: new Uint32Array(n)};
  for (let i = 0; i < n; i++) {
    f.code[i] = v.getUint16(from + i * 8, true);
    f.jt[i] = v.getUint8(from + i * 8 + 2);
    f.jf[i] = v.getUint8(from + i * 8 + 3);
    f.k[i] = v.getUint32(from + i * 8 + 4, true);
  }
  // Which of its sixteen words are written on every way to each instruction (jumps go forward only): a bit each.
  const written = new Uint16Array(n).fill(0xffff);
  written[0] = 0;
  const reach = (to: number, words: number): void => { if (to >= n) fail(E.INVAL); written[to] &= words; };
  for (let i = 0; i < n; i++) {
    const code = f.code[i], k = f.k[i], cls = code & 7;
    let words = written[i], next = true;
    switch (cls) {
      case LD: case LDX: {
        const mode = code & 0xe0, size = code & 0x18;
        if (size !== 0) fail(E.INVAL); // (a word at a time: nothing of a call is a byte or a half)
        if (mode === 0x20) { if (cls !== LD || k & 3 || k + 4 > SHOWN) fail(E.INVAL); } // ABS: a word of the call
        else if (mode === 0x60) { if (k >= WORDS || !(words >> k & 1)) fail(E.INVAL); } // MEM: a word of its own, written
        else if (mode !== 0x00 && mode !== 0x80) fail(E.INVAL); // IMM, LEN
        break;
      }
      case ST: case STX:
        if (code !== cls || k >= WORDS) fail(E.INVAL);
        words |= 1 << k;
        break;
      case ALU: {
        const op = code & 0xf0, byX = code & 0x08;
        if (op > 0xa0 || op === 0x90) fail(E.INVAL); // (no remainder: a filter over calls has none)
        if (op === 0x80 && code !== 0x84) fail(E.INVAL);
        if (op === 0x30 && !byX && k === 0) fail(E.INVAL); // divided by nothing, known as it is read
        if ((op === 0x60 || op === 0x70) && !byX && k >= 32) fail(E.INVAL);
        break;
      }
      case JMP: {
        const op = code & 0xf0;
        if (op === 0x00) { if (code !== 0x05) fail(E.INVAL); reach(i + 1 + k, words); next = false; }
        else if (op <= 0x40) { reach(i + 1 + f.jt[i], words); reach(i + 1 + f.jf[i], words); next = false; }
        else fail(E.INVAL);
        break;
      }
      case RETURN:
        if (code !== 0x06 && code !== 0x16) fail(E.INVAL);
        next = false;
        break;
      case MISC:
        if (code !== 0x07 && code !== 0x87) fail(E.INVAL);
        break;
    }
    if (next) reach(i + 1, words);
  }
  if ((f.code[n - 1] & 7) !== RETURN) fail(E.INVAL);
  return f;
}

/** What `f` answers to the call shown in `shown` (64 bytes): the word it returns. */
export function answer(f: Filter, shown: DataView): number {
  const words = new Uint32Array(WORDS), {code, jt, jf, k} = f;
  let a = 0, x = 0;
  for (let i = 0; ; i++) {
    const c = code[i], w = k[i];
    switch (c & 7) {
      case LD: {
        const mode = c & 0xe0;
        a = mode === 0x20 ? shown.getUint32(w, true) : mode === 0x60 ? words[w] : mode === 0x80 ? SHOWN : w;
        break;
      }
      case LDX: {
        const mode = c & 0xe0;
        x = mode === 0x60 ? words[w] : mode === 0x80 ? SHOWN : w;
        break;
      }
      case ST: words[w] = a; break;
      case STX: words[w] = x; break;
      case ALU: {
        const by = c & 0x08 ? x : w;
        switch (c & 0xf0) {
          case 0x00: a = (a + by) >>> 0; break;
          case 0x10: a = (a - by) >>> 0; break;
          case 0x20: a = Math.imul(a, by) >>> 0; break;
          case 0x30: if (by === 0) return 0; a = Math.floor(a / by) >>> 0; break; // (by nothing: the filter answers 0)
          case 0x40: a = (a | by) >>> 0; break;
          case 0x50: a = (a & by) >>> 0; break;
          case 0x60: a = by >= 32 ? 0 : (a << by) >>> 0; break;
          case 0x70: a = by >= 32 ? 0 : a >>> by; break;
          case 0x80: a = -a >>> 0; break;
          case 0xa0: a = (a ^ by) >>> 0; break;
        }
        break;
      }
      case JMP: {
        const op = c & 0xf0;
        if (op === 0x00) { i += w; break; }
        const by = c & 0x08 ? x : w;
        const met = op === 0x10 ? a === by : op === 0x20 ? a > by : op === 0x30 ? a >= by : (a & by) !== 0;
        i += met ? jt[i] : jf[i];
        break;
      }
      case RETURN: return c === 0x16 ? a : w;
      case MISC: if (c === 0x07) x = a; else a = x; break;
    }
  }
}

/** An answer's action as the kernel orders them: a signed word, the least allowing least (KILL_PROCESS is below 0). */
const action = (said: number): number => said & ~0xffff;

/**
 * What becomes of the call numbered `nr`, made from `ip` with `args`, under `filters` (the first set first): the
 * answer that allows least, the later filter's where two allow the same. ALLOW where there is none.
 */
export function verdict(filters: readonly Filter[], nr: number, args: readonly bigint[], ip: bigint): number {
  const shown = new DataView(new ArrayBuffer(SHOWN));
  shown.setInt32(0, nr, true);
  shown.setUint32(4, ARCH, true);
  shown.setBigUint64(8, BigInt.asUintN(64, ip), true);
  for (let i = 0; i < 6; i++) shown.setBigUint64(16 + 8 * i, BigInt.asUintN(64, args[i] ?? 0n), true);
  let held = RET.ALLOW;
  for (let i = filters.length - 1; i >= 0; i--) {
    const said = answer(filters[i], shown) >>> 0;
    if (action(said) < action(held)) held = said;
  }
  return held;
}

/** The calls strict mode leaves a thread: read, write, _exit, rt_sigreturn. Any other ends it (SIGKILL). */
export const STRICT: ReadonlySet<number> = new Set([0, 1, 60, 15]);
