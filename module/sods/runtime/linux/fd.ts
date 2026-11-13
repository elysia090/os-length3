// Open file descriptions and per-process descriptor tables.

import type {Entry} from './fs.ts';

declare module './fs.ts' {
  /** A named pipe's pipe: what its opens share, made afresh once every end of the last is closed. */
  interface Fifo { pipe: Pipe | null }
}

/** Bytes a write of at most this many lands whole or not at all (POSIX PIPE_BUF). */
export const PIPE_BUF = 4096;
/** A pipe's room, as Linux gives one (16 pages); F_SETPIPE_SZ changes it. */
const PIPE_SIZE = 65536;
const PIPE_MAX = 1 << 20;

const PAGE = 4096;

/**
 * A pipe as Linux keeps one: a ring of page buffers (16 by default). A
 * write first tops up the last page with its odd tail when that fits
 * whole, then fills fresh pages while there are free ones; so a full pipe
 * holds what Linux's would. A writer finding it full waits (the call in
 * sys-file.ts) until a reader frees a page; a reader finding it empty
 * waits until a writer writes or the last writer is gone.
 */
/** Pipes made so far: each its own number. */
let pipes = 1;

/** A page of a pipe: its bytes, and what of them is still to be read. */
interface Page { buf: Uint8Array; start: number; end: number }

export class Pipe {
  declare slots: number;
  declare readonly pages: Page[];
  declare readonly spare: Uint8Array[];
  declare size: number;
  declare readers: number;
  declare writers: number;
  declare changes: number;
  /** Which pipe it is (/proc/PID/fd's pipe:[N]). */
  readonly id = pipes++;
  /** A FIFO's: how many opens for reading and for writing it has had (an open waits for the other end's). */
  readOpens = 0;
  writeOpens = 0;
  constructor(capacity = PIPE_SIZE) {
    this.slots = capacity / PAGE;
    this.pages = []; // {buf, start, end}, oldest first
    this.spare = []; // pages to use again
    this.size = 0;
    this.readers = 0;
    this.writers = 0;
    this.changes = 0; // counts every change a poller may be waiting for (epoll's edge)
  }
  get capacity() { return this.slots * PAGE; }
  /** A page is free: a write can put something in (poll's POLLOUT). */
  get writable() { return this.pages.length < this.slots; }
  /** Whether a write of `n` bytes (at most a page) would go in whole now. */
  fits(n: number): boolean {
    const last = this.pages.at(-1);
    return this.writable || (!!last && n % PAGE !== 0 && last.end + (n % PAGE) <= PAGE && n < PAGE);
  }
  /** Put in what fits of `bytes`; how much. */
  write(bytes: Uint8Array): number {
    let at = 0;
    const tail = bytes.length % PAGE, last = this.pages.at(-1);
    if (tail && last && last.end + tail <= PAGE) {
      last.buf.set(bytes.subarray(0, tail), last.end);
      last.end += tail;
      at = tail;
    }
    while (at < bytes.length && this.pages.length < this.slots) {
      const buf = this.spare.pop() ?? new Uint8Array(PAGE), n = Math.min(PAGE, bytes.length - at);
      buf.set(bytes.subarray(at, at + n));
      this.pages.push({buf, start: 0, end: n});
      at += n;
    }
    this.size += at;
    if (at) this.changes++;
    return at;
  }
  /** Take up to `n` bytes into `into` at `at` (a Uint8Array); how many. */
  readInto(into: Uint8Array, at: number, n: number): number {
    let done = 0;
    while (done < n && this.pages.length) {
      const p = this.pages[0], k = Math.min(n - done, p.end - p.start);
      into.set(p.buf.subarray(p.start, p.start + k), at + done);
      p.start += k;
      done += k;
      if (p.start === p.end) { this.pages.shift(); if (this.spare.length < 4) this.spare.push(p.buf); }
    }
    this.size -= done;
    if (done) this.changes++;
    return done;
  }
  read(n: number): Uint8Array {
    const out = new Uint8Array(Math.min(n, this.size));
    this.readInto(out, 0, out.length);
    return out;
  }
  /** F_SETPIPE_SZ: at least `n` bytes (a power of two pages); never fewer pages than it holds. */
  resize(n: number): number {
    let cap = PAGE;
    while (cap < n) cap *= 2;
    if (cap > PIPE_MAX) return -1;
    if (cap / PAGE < this.pages.length) return -2;
    this.slots = cap / PAGE;
    return cap;
  }
}

/**
 * flock's advisory locks, by what is locked (a file's node, a pipe): the one description holding it exclusive (`ex`)
 * and those holding it shared (`sh`). A lock is the open file description's (dup'd and inherited descriptors share
 * it), and goes with its last descriptor.
 */
const flocks = new WeakMap<object, {ex: Description | null; sh: Set<Description>}>();

/**
 * Lock what `d` opened, exclusive or shared, for `d` (one lock each: taking another changes the one it holds). Whether
 * it was taken: false while another description holds it otherwise. A lock changed, shared to exclusive or back, is
 * let go first, as Linux does (flock_lock_inode), taken or not: so two that hold it shared and both ask for it
 * exclusive do not wait on each other for ever, and one that waits for it holds nothing meanwhile.
 */
export function flock(d: Description, exclusive: boolean): boolean {
  const key = d.node ?? d.pipe ?? d;
  const held = flocks.get(key) ?? {ex: null, sh: new Set()};
  if (exclusive ? held.ex === d : held.sh.has(d)) return true;
  held.sh.delete(d);
  if (held.ex === d) held.ex = null;
  flocks.set(key, held);
  d.locked = null;
  const others = held.ex !== null || (exclusive && held.sh.size > 0);
  if (others) return false;
  if (exclusive) held.ex = d; else held.sh.add(d);
  flocks.set(key, held);
  d.locked = key;
  return true;
}

/** Let go of the lock `d` holds, if any. */
export function unflock(d: Description): void {
  if (!d.locked) return;
  const held = flocks.get(d.locked);
  if (held) { if (held.ex === d) held.ex = null; held.sh.delete(d); }
  d.locked = null;
}

/** One open file description, shared by dup'd and inherited descriptors. */
/** What a description is of. */
export type Kind = 'file' | 'dir' | 'pipe-r' | 'pipe-w' | 'pipe-rw' | 'console' | 'device' | 'eventfd' | 'epoll' | 'socket';

/** An eventfd's counter (and whether it is a semaphore's), and how often it changed. */
export interface Counter { count: bigint; semaphore: boolean; changes: number }
/** What an epoll instance watches, by descriptor: its description, events asked and data given back. */
export interface Interest { desc: Description; events: number; data: bigint; seen: number; off: boolean }

export class Description {
  declare kind: Kind;
  declare node: Entry | null;
  declare pipe: Pipe | null;
  declare flags: number;
  declare path: string;
  declare offset: number;
  declare refs: number;
  declare closed: boolean;
  declare locked: object | null;
  /** A directory read: the name last given (getdents goes on after it). */
  declare after?: string;
  /** A FIFO open: the other end's opens as they were when it began. */
  declare seen?: {reads: number; writes: number};
  /** An eventfd's counter. */
  declare event?: Counter;
  /** An epoll instance's interest list. */
  declare interest?: Map<number, Interest>;
  constructor(kind: Kind, {node = null, pipe = null, flags = 0, path = ''}: {node?: Entry | null; pipe?: Pipe | null; flags?: number; path?: string} = {}) {
    this.kind = kind; // file | dir | pipe-r | pipe-w | console | device | eventfd | epoll | socket (`sock`: sys-net.ts)
    this.node = node;
    this.pipe = pipe;
    this.flags = flags;
    this.path = path;
    this.offset = 0;
    this.refs = 0;
    this.closed = false;
    this.locked = null; // what it holds a flock on
    // A FIFO opened for both reading and writing (pipe-rw) is a reader and a writer of its pipe at once.
    if (pipe && (kind === 'pipe-r' || kind === 'pipe-rw')) pipe.readers++;
    if (pipe && (kind === 'pipe-w' || kind === 'pipe-rw')) pipe.writers++;
  }
  retain(): this { this.refs++; return this; }
  release(): void {
    if (--this.refs > 0) {
      // A local socket still held, perhaps only by descriptors in flight that no one can receive any more (sys-net.ts).
      if (this.kind === 'socket') this.sock?.released();
      return;
    }
    this.closed = true;
    unflock(this);
    if (this.pipe && (this.kind === 'pipe-r' || this.kind === 'pipe-rw')) { this.pipe.readers--; this.pipe.changes++; }
    if (this.pipe && (this.kind === 'pipe-w' || this.kind === 'pipe-rw')) { this.pipe.writers--; this.pipe.changes++; }
    // A local socket's last descriptor gone: it is closed (sys-net.ts).
    if (this.kind === 'socket') this.sock?.close();
  }
}

/** How many descriptors a process starts allowed (RLIMIT_NOFILE's soft limit; sys-proc.ts's setrlimit moves it). */
const FDS = 1024;

export class FdTable {
  declare readonly slots: Map<number, {description: Description; cloexec: boolean}>;
  declare limit: number;
  /** How many processes hold this table (one; more where clone shared it, CLONE_FILES): the last to let go closes it. */
  declare holders: number;
  declare readonly consoles: Int32Array;
  declare readonly readers: Set<Int32Array>;
  constructor(limit = FDS) {
    this.slots = new Map(); // fd -> {description, cloexec}
    this.limit = limit; // RLIMIT_NOFILE's soft limit: no descriptor at or past it
    this.holders = 1;
    // Which of its first 32 descriptors are the console ([0], a bit each) and which of those its stderr ([1]), kept as
    // the table changes, in it and where each of its threads in a Worker of its own reads them (`readers`: two words of
    // the thread's channel, remote.ts), to write there without asking the kernel (cpu.ts toConsole).
    this.consoles = new Int32Array(2);
    this.readers = new Set();
  }
  /** `fd`'s bits in `consoles` as the table has it now. */
  marked(fd: number): void {
    if (fd >= 32) return;
    const d = this.slots.get(fd)?.description, bit = 1 << fd, c = this.consoles;
    const console = d?.kind === 'console', err = console && d.path === 'stderr';
    // (Each open and close comes here: nothing made, and a word written only when its bit changes.)
    const was = c[0], now = console ? was | bit : was & ~bit, wasErr = c[1], nowErr = err ? wasErr | bit : wasErr & ~bit;
    if (now === was && nowErr === wasErr) return;
    c[0] = now;
    c[1] = nowErr;
    for (const r of this.readers) this.show(r);
  }
  /** The bits where `reader` reads them. */
  show(reader: Int32Array): void {
    Atomics.store(reader, 0, this.consoles[0]);
    Atomics.store(reader, 1, this.consoles[1]);
  }
  get(fd: number): Description | null { return this.slots.get(fd)?.description ?? null; }
  lowest(from = 0): number {
    let fd = from;
    while (this.slots.has(fd)) fd++;
    return fd < this.limit ? fd : -1;
  }
  install(description: Description, {fd = this.lowest(), cloexec = false}: {fd?: number; cloexec?: boolean} = {}): number {
    if (fd < 0 || fd >= this.limit) return -1;
    this.close(fd);
    this.slots.set(fd, {description: description.retain(), cloexec});
    this.marked(fd);
    return fd;
  }
  close(fd: number): boolean {
    const slot = this.slots.get(fd);
    if (!slot) return false;
    this.slots.delete(fd);
    this.marked(fd);
    slot.description.release();
    return true;
  }
  setCloexec(fd: number, on: boolean): void { const s = this.slots.get(fd); if (s) s.cloexec = on; }
  cloexec(fd: number): boolean { return this.slots.get(fd)?.cloexec ?? false; }
  /** A child's table: the same descriptions, each retained once more. */
  fork(): FdTable {
    const t = new FdTable(this.limit);
    for (const [fd, s] of this.slots) t.slots.set(fd, {description: s.description.retain(), cloexec: s.cloexec});
    t.consoles.set(this.consoles);
    return t;
  }
  /** The same table, held by one process more (clone with CLONE_FILES): what one opens or closes, the other sees. */
  share(): this { this.holders++; return this; }
  /** One process lets go of it (it ended, or took a table of its own): closed once the last one has. */
  letGo(): void { if (--this.holders <= 0) this.closeAll(); }
  /**
   * The table a process execs with: its own. Shared till then, it takes a copy and lets go of the one shared (as
   * Linux's unshare_files), so the descriptors exec closes are closed for it alone.
   */
  own(): FdTable {
    if (this.holders <= 1) return this;
    const mine = this.fork();
    this.letGo();
    return mine;
  }
  /** exec closes descriptors marked close-on-exec. */
  exec(): void { for (const [fd, s] of [...this.slots]) if (s.cloexec) this.close(fd); }
  closeAll(): void { for (const fd of [...this.slots.keys()]) this.close(fd); }
}
