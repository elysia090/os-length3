// Open file descriptions and per-process descriptor tables.

/** Bytes a write of at most this many lands whole or not at all (POSIX PIPE_BUF). */
export const PIPE_BUF = 4096;
/** A pipe's room, as Linux gives one (16 pages); F_SETPIPE_SZ changes it. */
export const PIPE_SIZE = 65536;
export const PIPE_MAX = 1 << 20;

const PAGE = 4096;

/**
 * A pipe as Linux keeps one: a ring of page buffers (16 by default). A
 * write first tops up the last page with its odd tail when that fits
 * whole, then fills fresh pages while there are free ones; so a full pipe
 * holds what Linux's would. A writer finding it full waits (the call in
 * sys-file.mjs) until a reader frees a page; a reader finding it empty
 * waits until a writer writes or the last writer is gone.
 */
export class Pipe {
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
  fits(n) {
    const last = this.pages.at(-1);
    return this.writable || (!!last && n % PAGE !== 0 && last.end + (n % PAGE) <= PAGE && n < PAGE);
  }
  /** Put in what fits of `bytes`; how much. */
  write(bytes) {
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
  readInto(into, at, n) {
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
  read(n) {
    const out = new Uint8Array(Math.min(n, this.size));
    this.readInto(out, 0, out.length);
    return out;
  }
  /** F_SETPIPE_SZ: at least `n` bytes (a power of two pages); never fewer pages than it holds. */
  resize(n) {
    let cap = PAGE;
    while (cap < n) cap *= 2;
    if (cap > PIPE_MAX) return -1;
    if (cap / PAGE < this.pages.length) return -2;
    this.slots = cap / PAGE;
    return cap;
  }
}

/** One open file description, shared by dup'd and inherited descriptors. */
export class Description {
  constructor(kind, {node = null, pipe = null, flags = 0, path = ''} = {}) {
    this.kind = kind; // file | dir | pipe-r | pipe-w | console | device | eventfd | epoll
    this.node = node;
    this.pipe = pipe;
    this.flags = flags;
    this.path = path;
    this.offset = 0;
    this.refs = 0;
    this.closed = false;
    if (kind === 'pipe-r') pipe.readers++;
    if (kind === 'pipe-w') pipe.writers++;
  }
  retain() { this.refs++; return this; }
  release() {
    if (--this.refs > 0) return;
    this.closed = true;
    if (this.kind === 'pipe-r') { this.pipe.readers--; this.pipe.changes++; }
    if (this.kind === 'pipe-w') { this.pipe.writers--; this.pipe.changes++; }
  }
}

export const MAX_FDS = 1024;

export class FdTable {
  constructor() {
    this.slots = new Map(); // fd -> {description, cloexec}
  }
  get(fd) { return this.slots.get(fd)?.description ?? null; }
  lowest(from = 0) {
    let fd = from;
    while (this.slots.has(fd)) fd++;
    return fd < MAX_FDS ? fd : -1;
  }
  install(description, {fd = this.lowest(), cloexec = false} = {}) {
    if (fd < 0) return -1;
    this.close(fd);
    this.slots.set(fd, {description: description.retain(), cloexec});
    return fd;
  }
  close(fd) {
    const slot = this.slots.get(fd);
    if (!slot) return false;
    this.slots.delete(fd);
    slot.description.release();
    return true;
  }
  setCloexec(fd, on) { const s = this.slots.get(fd); if (s) s.cloexec = on; }
  cloexec(fd) { return this.slots.get(fd)?.cloexec ?? false; }
  /** A child's table: the same descriptions, each retained once more. */
  fork() {
    const t = new FdTable();
    for (const [fd, s] of this.slots) t.slots.set(fd, {description: s.description.retain(), cloexec: s.cloexec});
    return t;
  }
  /** exec closes descriptors marked close-on-exec. */
  exec() { for (const [fd, s] of [...this.slots]) if (s.cloexec) this.close(fd); }
  closeAll() { for (const fd of [...this.slots.keys()]) this.close(fd); }
}
