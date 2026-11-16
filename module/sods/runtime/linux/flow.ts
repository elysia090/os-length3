// What the kernel's parts say to each other as a call goes, under all of them (process.ts and the calls' modules,
// sys-*.ts, signal.ts, procfs.ts, each take from here and from nothing of each other's that takes back): what a call
// throws through the wasm frames to say the thread waits, ended, exec'd or was sent elsewhere; every capability; and
// random bytes drawn ahead.

import {isShared, random} from '../host.ts';


/** Thrown through wasm frames once the thread (or its whole process) has ended. */
export class Exit {
  declare readonly status: number;
  constructor(status: number) { this.status = status; }
}

/** Thrown through wasm frames after execve replaced the image. */
export class Exec {}

/** Thrown by a system call that must wait; the kernel makes the call again later. */
export class Wait {}

/** Thrown through wasm frames once a thread's registers were replaced (a signal handler, sigreturn): it goes on at resumeAt. */
export class Redirect {}

/**
 * Bytes read as UTF-8 text, copied first where they are a view of shared memory (the guest's when its threads run
 * apart, or a thread's channel): a browser's TextDecoder refuses such a view, where Node's takes it, so only the
 * browser showed it (git, faulting in the web Prompt, halted the kernel as its message was read). Every text the
 * kernel reads goes through here (tests/boundary.test.ts).
 */
const decoder = new TextDecoder();
export function utf8(b: Uint8Array | ArrayBuffer): string {
  // A path or a name, short and ASCII (as nearly every one a call reads is): its characters as they are, which costs a
  // tenth of a decoder's call (each call that names a file read one).
  if (b instanceof Uint8Array && b.length <= 255) {
    let k = 0;
    while (k < b.length && b[k] < 0x80) k++;
    if (k === b.length) return String.fromCharCode.apply(null, b as unknown as number[]);
  }
  return decoder.decode(b instanceof Uint8Array && isShared(b.buffer) ? b.slice() : b);
}

/** Random bytes drawn ahead (a draw costs tens of microseconds however few it gives: an exec's AT_RANDOM took one). */
const pool = {bytes: new Uint8Array(0), at: 0};
/** `n` random bytes (at most 65536), each given once. */
export function randomBytes(n: number): Uint8Array {
  if (pool.at + n > pool.bytes.length) { pool.bytes = random(Math.max(4096, n)); pool.at = 0; }
  pool.at += n;
  return pool.bytes.subarray(pool.at - n, pool.at);
}

/** A random UUID (version 4), as /proc/sys/kernel/random says them: made of 16 random bytes. */
export function uuid(): string {
  const b = randomBytes(16).slice();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
