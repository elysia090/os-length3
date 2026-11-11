// File, directory, descriptor and pipe system calls. Handlers run with
// `this` bound to the calling Process (`this.task` the thread, `this.call`
// the call, whose `state` lasts while it waits) and throw FsError for errno
// results, or Wait for a call to be made again once something changed. Where
// a failure is what is most often asked (a name looked up that is not there),
// its errno is given back negated instead, as the call's value: a throw cost
// more than the call.

import {Description, PIPE_BUF, Pipe, flock, unflock, type Interest} from './fd.ts';
import * as net from './sys-net.ts';
import {Made, procDescriptor} from './procfs.ts';
import {Dir, Device, E, Fifo, File, FsError, Link, S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFSOCK, type Entry} from './fs.ts';
import {Wait} from './flow.ts';
import type {Calls, Kern, Proc, Termios} from './parts.ts';
import {SIG, SI, UNBLOCKABLE, actionOf, bit, deliverable, send} from './signal.ts';
import {epoch, steady} from '../../sods/runtime/host.ts';

const AT_FDCWD = -100;
const O = {WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, TRUNC: 0x200, APPEND: 0x400, NONBLOCK: 0x800,
  DIRECTORY: 0x10000, NOFOLLOW: 0x20000, CLOEXEC: 0x80000};
const AT = {SYMLINK_NOFOLLOW: 0x100, REMOVEDIR: 0x200, EMPTY_PATH: 0x1000};

declare module './fs.ts' {
  interface Fifo {
    /** Opens that wait for the other end, by the process whose open it is. */
    pending?: Map<Proc, Description>;
  }
}

/** What a stat says of: a node, or what a descriptor without one stands for (a pipe, the console, a socket). */
interface Statted {
  mode: number; ino: number; nlink: number; uid: number; gid: number; mtime: number; rdev?: number; size?: number;
  /** The device it is on: the root's file system (1) unless said (a pipe's is pipefs). */
  dev?: number;
  atime?: number; atimeNs?: number; mtimeNs?: number; ctime?: number;
  readonly isFile: boolean; readonly isDir: boolean; readonly isLink: boolean;
}
/** A time a call sets: now, left as it is, or [seconds, nanoseconds]. */
type Time = 'now' | 'omit' | [number, number];

const N = (x: bigint): number => Number(BigInt.asIntN(64, x));
/** pipefs's device, as Linux numbers it (0:12). */
const PIPEFS = 12;
const fail = (errno: number): never => { throw new FsError(errno); };
const enc = new TextEncoder();

/** What `d` has open, as its kind has it (a file, a directory, a device, a pipe, an eventfd's counter, an epoll's list). */
const fileOf = (d: Description): File => (d.node instanceof File ? d.node : fail(E.BADF));
const dirOf = (d: Description): Dir => (d.node instanceof Dir ? d.node : fail(E.NOTDIR));
const deviceOf = (d: Description): Device => (d.node instanceof Device ? d.node : fail(E.BADF));
const pipeOf = (d: Description): Pipe => d.pipe ?? fail(E.BADF);
const counterOf = (d: Description) => d.event ?? fail(E.BADF);
const interestOf = (d: Description) => d.interest ?? fail(E.INVAL);

/** The directory a *at() path is relative to. */
function base(p: Proc, dirfd: bigint): string {
  const fd = N(dirfd);
  if (fd === AT_FDCWD) return p.cwd;
  const d = p.fds.get(fd) ?? fail(E.BADF);
  if (d.kind !== 'dir') fail(E.NOTDIR);
  return d.path;
}

function path(p: Proc, address: bigint): string {
  return p.cstring(N(address)) || fail(E.NOENT);
}

/** `n` (a safe integer, negative too) at `at` as a 64-bit little-endian word, in two halves: no BigInt made for it. */
function put64(v: DataView, at: number, n: number): void {
  v.setUint32(at, n >>> 0, true);
  v.setInt32(at + 4, Math.floor(n / 4294967296), true);
}

function writeStat(p: Proc, address: bigint, node: Statted): number {
  const v = p.view, at = N(address);
  p.bytes.fill(0, at, at + 144);
  const size = node.isFile || node.isLink ? node.size ?? 0 : node.isDir ? 4096 : 0;
  put64(v, at, node.dev ?? 1);
  put64(v, at + 8, node.ino);
  put64(v, at + 16, node.nlink);
  v.setUint32(at + 24, node.mode, true);
  v.setUint32(at + 28, node.uid, true);
  v.setUint32(at + 32, node.gid, true);
  put64(v, at + 40, node.rdev ?? 0);
  put64(v, at + 48, size);
  put64(v, at + 56, 4096);
  // What it takes on a disk, in 512-byte units, as Linux's filesystems count it: whole 4 KiB blocks (a symlink's
  // target is kept in its inode, and takes none).
  put64(v, at + 64, node.isLink ? 0 : Math.ceil(size / 4096) * 8);
  // atime, mtime, ctime: as set (utimensat keeps nanoseconds), else the time of the last change.
  const times = (off: number, ms: number, ns: number | undefined) => {
    put64(v, at + off, Math.floor(ms / 1000));
    put64(v, at + off + 8, ns ?? Math.floor(ms % 1000) * 1e6);
  };
  times(72, node.atime ?? node.mtime, node.atimeNs);
  times(88, node.mtime, node.mtimeNs);
  times(104, node.ctime ?? node.mtime, undefined);
  return 0;
}

const UTIME_NOW = (1 << 30) - 1, UTIME_OMIT = (1 << 30) - 2;
/** A directory entry's type (d_type) by its node's: DT_DIR, DT_LNK, DT_CHR, DT_FIFO, DT_SOCK; else DT_REG. */
const DT: Record<number, number> = {[S_IFDIR]: 4, [S_IFLNK]: 10, [S_IFCHR]: 2, [S_IFIFO]: 1, [S_IFSOCK]: 12};

/** The file a time-setting call names: by its path from `dirfd`, or the descriptor itself (a NULL or empty path). */
function timed(p: Proc, dirfd: bigint, name: bigint, follow: boolean): Entry {
  if (!N(name) || !p.bytes[N(name)]) {
    if (N(dirfd) === AT_FDCWD) return p.kernel.vfs.lookup(p.cwd, '/');
    return descriptor(p, dirfd).node ?? fail(E.BADF);
  }
  return p.kernel.vfs.lookup(path(p, name), base(p, dirfd), follow);
}

/** Set a file's access and modification times, each [seconds, nanoseconds], 'now' or 'omit'; its ctime is now. */
function setTimes(node: Entry, access: Time, modify: Time): number {
  const now = epoch();
  const at = (t: 'now' | [number, number]): [number, number] => t === 'now' ? [now, (now % 1000) * 1e6] : [t[0] * 1000 + Math.floor(t[1] / 1e6), t[1]];
  if (access !== 'omit') { const [ms, ns] = at(access); node.atime = ms; node.atimeNs = ns; }
  if (modify !== 'omit') { const [ms, ns] = at(modify); node.mtime = ms; node.mtimeNs = ns; }
  node.ctime = now;
  return 0;
}

/** Times from a struct timespec[2] (utimensat), with UTIME_NOW and UTIME_OMIT; none given is now for both. */
function timespecs(p: Proc, address: bigint): Time[] {
  if (!N(address)) return ['now', 'now'];
  return [0, 16].map((off): Time => {
    const s = Number(p.view.getBigInt64(N(address) + off, true)), ns = Number(p.view.getBigInt64(N(address) + off + 8, true));
    if (ns === UTIME_NOW) return 'now';
    if (ns === UTIME_OMIT) return 'omit';
    if (ns < 0 || ns >= 1e9) fail(E.INVAL);
    return [s, ns];
  });
}
/** Times from a struct timeval[2] (utimes, futimesat): microseconds. */
function timevals(p: Proc, address: bigint): Time[] {
  if (!N(address)) return ['now', 'now'];
  return [0, 16].map((off): Time => {
    const s = Number(p.view.getBigInt64(N(address) + off, true)), us = Number(p.view.getBigInt64(N(address) + off + 8, true));
    if (us < 0 || us >= 1e6) fail(E.INVAL);
    return [s, us * 1000];
  });
}

function describe(p: Proc, d: Description): Statted {
  // Something to stat for a descriptor without a node.
  if (d.node) return d.node;
  // A pipe is an inode of pipefs as on Linux (the N of /proc/PID/fd's pipe:[N]), each pipe its own: two pipes are never one
  // file to what compares them so (diff, cmp, cp: the same device and inode, the same file).
  if (d.kind === 'pipe-r' || d.kind === 'pipe-w' || d.kind === 'pipe-rw') return {mode: S_IFIFO | 0o600, dev: PIPEFS, ino: d.pipe?.id ?? 0, nlink: 1, uid: 0, gid: 0, mtime: epoch(), isFile: false, isDir: false, isLink: false};
  if (d.kind === 'socket') return net.stat(d);
  // The console: the terminal it is, /dev/pts/0 (fs.ts), so a stat of that name is the same file.
  return p.kernel.vfs.terminal as Statted | undefined ?? {mode: 0o020620, ino: 0, nlink: 1, uid: 0, gid: 0, rdev: 0x8800, mtime: epoch(), isFile: false, isDir: false, isLink: false};
}

/** /dev/fd/N, /dev/stdin and the rest, and /proc/self/fd/N, as the /proc/PID/fd/N they are. */
function descriptorPath(p: Proc, name: string): string {
  if (!name.startsWith('/dev/') && !name.startsWith('/proc/self/fd/')) return name;
  const std = ({'/dev/stdin': 0, '/dev/stdout': 1, '/dev/stderr': 2} as Record<string, number>)[name];
  if (std !== undefined) return `/proc/${p.pid}/fd/${std}`;
  const m = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(name);
  return m ? `/proc/${p.pid}/fd/${m[1]}` : name;
}

/** What a stat of `name` that follows links stats: a descriptor's /proc name (Linux's links to what is open there), what
 * that descriptor has open, a file renamed over or removed included; else the node there, or the errno its lookup fails with. */
function statNode(p: Proc, name: string, dirfd: bigint, follow: boolean): Statted | number {
  const d = follow && name.startsWith('/') ? procDescriptor(p.kernel, descriptorPath(p, name)) : null;
  return d ? describe(p, d) : p.kernel.vfs.find(name, base(p, dirfd), follow);
}
/** A stat of what `found` is into `st`, or the errno it is, negated. */
const statOf = (p: Proc, st: bigint, found: Statted | number): number => (typeof found === 'number' ? -found : writeStat(p, st, found));

function openAt(p: Proc, dirfd: bigint, address: bigint, flags: bigint, mode: bigint): number {
  const f = N(flags), name = path(p, address);
  // A descriptor opened by its /proc name opens what it has open: the same pipe or terminal, a file afresh.
  const named = name.startsWith('/') ? procDescriptor(p.kernel, descriptorPath(p, name)) : null;
  if (named) {
    const d = named.kind === 'file' || named.kind === 'dir' ? new Description(named.kind, {node: named.node, flags: f, path: named.path}) : named;
    if (d !== named && named.node instanceof File && (f & 3) && (f & O.TRUNC)) named.node.truncate(0);
    const fd = p.fds.install(d, {cloexec: !!(f & O.CLOEXEC)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  }
  const names: string[] = [];
  const r = p.kernel.vfs.walk(name, base(p, dirfd), !(f & O.NOFOLLOW), 0, names);
  if (typeof r === 'number') return -r;
  let node = r.node;
  if (!node) {
    if (!(f & O.CREAT)) return -E.NOENT;
    node = new File(new Uint8Array(0), N(mode) & ~p.umask & 0o7777);
    r.parent.entries.set(r.name, node);
  } else if ((f & O.CREAT) && (f & O.EXCL)) {
    fail(E.EXIST);
  }
  if (node instanceof Link) fail(E.LOOP);
  if ((f & O.DIRECTORY) && !node.isDir) fail(E.NOTDIR);
  // The controlling terminal (/dev/tty), and the terminal the console is (/dev/pts/0): the console, where it is one.
  if (node instanceof Device && (node.rdev === 0x500 || node === p.kernel.vfs.terminal)) {
    if (!p.kernel.console.interactive) fail(E.NXIO);
    const fd = p.fds.install(new Description('console', {flags: f & (3 | O.NONBLOCK), path: 'tty'}), {cloexec: !!(f & O.CLOEXEC)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  }
  const writing = (f & 3) !== 0;
  if (node.isDir && writing) fail(E.ISDIR);
  if (node instanceof File && writing && (f & O.TRUNC)) node.truncate(0);
  // A named pipe: read, write or both ends of the one pipe its opens share. As on Linux, a reader waits for a writer
  // and a writer for a reader, each there from the moment its open began (so two waiting opens meet); O_RDWR and a
  // non-blocking reader do not wait, and a non-blocking writer with no reader is ENXIO.
  if (node instanceof Fifo) {
    const me = p; // the process whose open waits (a retry may be made from elsewhere than its thread)
    node.pending ??= new Map();
    let d = node.pending.get(me);
    if (!d) {
      if (!node.pipe || (!node.pipe.readers && !node.pipe.writers)) node.pipe = new Pipe();
      const pipe = node.pipe;
      const access = f & 3, kind = access === 0 ? 'pipe-r' : access === 1 ? 'pipe-w' : 'pipe-rw';
      if (kind === 'pipe-w' && (f & O.NONBLOCK) && !pipe.readers) fail(E.NXIO);
      // What each side waits for is an open of the other since it began (Linux's r_counter and w_counter): a writer
      // that came, wrote and went while a reader waited still lets it go on, to what it wrote.
      d = new Description(kind, {pipe, flags: f & (3 | O.NONBLOCK), path: name});
      d.seen = {reads: pipe.readOpens, writes: pipe.writeOpens};
      if (kind !== 'pipe-w') pipe.readOpens++;
      if (kind !== 'pipe-r') pipe.writeOpens++;
    }
    const pipe = pipeOf(d), seen = d.seen ?? {reads: 0, writes: 0};
    const met = d.kind === 'pipe-rw' || (f & O.NONBLOCK) || (d.kind === 'pipe-r' ? pipe.writers || pipe.writeOpens !== seen.writes : pipe.readers || pipe.readOpens !== seen.reads);
    if (!met) { node.pending.set(me, d); pipe.changes++; p.kernel.dirty = true; throw new Wait(); }
    node.pending.delete(me);
    pipe.changes++;
    p.kernel.dirty = true;
    const fd = p.fds.install(d, {cloexec: !!(f & O.CLOEXEC)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  }
  // /proc's files are read as they are when opened.
  if (node instanceof Made) node = node.snapshot();
  const kind = node.isDir ? 'dir' : node instanceof Device ? 'device' : 'file';
  // Its canonical path (/proc/self/fd's link to it): the names the walk went down by, and its own where it was made.
  const full = `/${(r.node ? names : [...names, r.name]).join('/')}`;
  const d = new Description(kind, {node, flags: f, path: full});
  const fd = p.fds.install(d, {cloexec: !!(f & O.CLOEXEC)});
  if (fd < 0) fail(E.MFILE);
  return fd;
}

/**
 * A read of the console by a process of a group behind the one in front:
 * SIGTTIN to its group (it stops), or EIO when that signal is ignored or
 * blocked, as a terminal does. Only where the console is a terminal.
 */
function background(p: Proc): boolean {
  const k = p.kernel;
  if (!k.console.interactive || p.sid !== k.tty.sid || p.pgid === k.tty.fg) return false;
  if (actionOf(p, SIG.TTIN).handler === 1n || p.task.mask & bit(SIG.TTIN)) fail(E.IO);
  for (const q of k.group(p.pgid)) send(k, q, SIG.TTIN, {code: SI.KERNEL});
  return true;
}

/** Bytes read from `d` into `into` at `at` (a view of guest memory, or a buffer readv scatters). */
function readTo(p: Proc, d: Description, into: Uint8Array, at: number, length: number, offset: number | null = null): number {
  if (length === 0) return 0;
  const nonblock = d.flags & O.NONBLOCK;
  switch (d.kind) {
    case 'console': {
      if (background(p)) throw new Wait();
      // null: nothing typed yet, so the call waits.
      const data = p.kernel.console.read(length);
      if (data === null) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
      into.set(data, at);
      return data.length;
    }
    case 'pipe-r': case 'pipe-rw': {
      const pipe = pipeOf(d);
      if (pipe.size) return pipe.readInto(into, at, length);
      // Empty with no writer left: the end of the data.
      if (!pipe.writers) return 0;
      if (nonblock) fail(E.AGAIN);
      throw new Wait();
    }
    case 'eventfd': {
      if (length < 8) fail(E.INVAL);
      const e = counterOf(d);
      if (!e.count) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
      const n = e.semaphore ? 1n : e.count;
      e.count -= n;
      e.changes++;
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      into.set(b, at);
      return 8;
    }
    case 'device': {
      const data = deviceOf(d).readDevice(length);
      into.set(data, at);
      return data.length;
    }
    case 'file': {
      if ((d.flags & 3) === O.WRONLY) fail(E.BADF);
      const from = offset ?? d.offset;
      const data = fileOf(d).read(from, from + length);
      into.set(data, at);
      if (offset === null) d.offset += data.length;
      return data.length;
    }
    case 'dir': return fail(E.ISDIR);
    case 'socket': return net.read(p, d, into, at, length);
  }
  return fail(E.BADF);
}

const readInto = (p: Proc, d: Description, address: number, length: number, offset: number | null = null): number => readTo(p, d, p.bytes, address, length, offset);

/**
 * Write `data` to `d`. A pipe takes what fits; a writer finding it full
 * waits for a reader to make room (what it moved so far is the call's, in
 * state.done, and is its value if a handler interrupts it). A write of at
 * most PIPE_BUF bytes lands whole. With no reader left: SIGPIPE, and EPIPE.
 */
function writeData(p: Proc, d: Description, data: Uint8Array, offset: number | null = null): number {
  const length = data.length, nonblock = d.flags & O.NONBLOCK;
  switch (d.kind) {
    case 'console':
      // What shows it has not taken in what came before (a flood): the writer waits, as on a terminal.
      if (p.kernel.console.full?.()) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
      p.kernel.say(d.path === 'stderr' ? 2 : 1, data.slice());
      return length;
    case 'pipe-w': case 'pipe-rw': {
      const pipe = pipeOf(d), s = p.call!.state;
      const done = s.done ?? 0;
      if (!pipe.readers) {
        send(p.kernel, p, SIG.PIPE, {code: SI.USER, pid: p.pid, uid: 0}, p.task);
        return done || fail(E.PIPE);
      }
      if (length <= PIPE_BUF && !pipe.fits(length)) {
        if (nonblock) fail(E.AGAIN);
        throw new Wait();
      }
      const wrote = done + pipe.write(data.subarray(done));
      if (wrote === length) return length;
      if (nonblock) return wrote || fail(E.AGAIN);
      // What it wrote may be what a reader waits for.
      if (wrote > done) p.kernel.dirty = true;
      s.done = wrote;
      throw new Wait();
    }
    case 'eventfd': {
      if (length < 8) fail(E.INVAL);
      const n = new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true), e = counterOf(d);
      if (n === 0xffffffffffffffffn) fail(E.INVAL);
      if (e.count + n > 0xfffffffffffffffen) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
      e.count += n;
      e.changes++;
      return 8;
    }
    case 'device': return deviceOf(d).writeDevice(data);
    case 'socket': return net.write(p, d, data);
    case 'file': {
      if ((d.flags & 3) === 0) fail(E.BADF);
      const file = fileOf(d), at = offset ?? (d.flags & O.APPEND ? file.size : d.offset);
      file.write(at, data);
      if (offset === null) d.offset = at + length;
      return length;
    }
  }
  return fail(E.BADF);
}

/**
 * struct statfs for the filesystem `at` is on, as large as the machine's storage is and as free (machine.ts): /proc
 * is proc's, /dev a tmpfs, and the rest the root as it is, read-only files under the ones written (an overlay).
 */
function writeStatfs(p: Proc, buf: number, at: string): number {
  const BLOCK = 4096, m = p.kernel.machine;
  const s = m.storage() ?? {total: m.memory, free: Math.max(0, m.memory - p.kernel.memoryBytes())};
  const type = /^\/proc(\/|$)/.test(at) ? 0x9fa0 : /^\/dev(\/|$)/.test(at) ? 0x01021994 : 0x794c7630;
  const v = p.view, blocks = BigInt(Math.floor(s.total / BLOCK)), free = BigInt(Math.floor(s.free / BLOCK));
  p.bytes.fill(0, buf, buf + 120);
  v.setBigInt64(buf, BigInt(type), true); // f_type
  v.setBigInt64(buf + 8, BigInt(BLOCK), true); // f_bsize
  v.setBigUint64(buf + 16, blocks, true); // f_blocks
  v.setBigUint64(buf + 24, free, true); // f_bfree
  v.setBigUint64(buf + 32, free, true); // f_bavail
  v.setBigUint64(buf + 40, blocks, true); // f_files: an inode a block at most
  v.setBigUint64(buf + 48, free, true); // f_ffree
  v.setBigInt64(buf + 64, 255n, true); // f_namelen
  v.setBigInt64(buf + 72, BigInt(BLOCK), true); // f_frsize
  return 0;
}

const writeFrom = (p: Proc, d: Description, address: number, length: number, offset: number | null = null): number => writeData(p, d, p.bytes.subarray(address, address + length), offset);
function descriptor(p: Proc, fd: bigint): Description {
  return p.fds.get(N(fd)) ?? fail(E.BADF);
}

/** The (base, length) pairs of an iovec array. */
function vectors(p: Proc, address: bigint, count: bigint): [number, number][] {
  if (N(count) < 0 || N(count) > 1024) fail(E.INVAL);
  const out: [number, number][] = [];
  for (let k = 0; k < N(count); k++) {
    const at = N(address) + k * 16;
    out.push([Number(p.view.getBigUint64(at, true)), Number(p.view.getBigUint64(at + 8, true))]);
  }
  return out;
}

/** readv: one read for all of it (so a pipe or the console waits once), scattered. */
function readv(p: Proc, d: Description, address: bigint, count: bigint, offset: number | null = null): number {
  const parts = vectors(p, address, count), total = parts.reduce((n, [, l]) => n + l, 0);
  if (d.kind === 'file' || d.kind === 'device') {
    let at = offset;
    return iov(p, address, count, (b, l) => { const n = readInto(p, d, b, l, at); if (at !== null) at += n; return n; });
  }
  const buf = new Uint8Array(total);
  const n = readTo(p, d, buf, 0, total);
  let at = 0;
  for (const [b, l] of parts) { if (at >= n) break; const k = Math.min(l, n - at); p.bytes.set(buf.subarray(at, at + k), b); at += k; }
  return n;
}

/** writev: what the vectors hold, as one write (a pipe takes it whole or waits, as Linux does). */
function writev(p: Proc, d: Description, address: bigint, count: bigint, offset: number | null = null): number {
  const parts = vectors(p, address, count), total = parts.reduce((n, [, l]) => n + l, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const [b, l] of parts) { buf.set(p.bytes.subarray(b, b + l), at); at += l; }
  return writeData(p, d, buf, offset);
}
function iov(p: Proc, address: bigint, count: bigint, each: (base: number, length: number) => number): number {
  let total = 0;
  for (let k = 0; k < N(count); k++) {
    const at = N(address) + k * 16;
    const base = Number(p.view.getBigUint64(at, true)), length = Number(p.view.getBigUint64(at + 8, true));
    const n = each(base, length);
    total += n;
    if (n < length) break;
  }
  return total;
}

function remove(p: Proc, dirfd: bigint, address: bigint, directory: boolean): number {
  const r = p.kernel.vfs.resolve(path(p, address), base(p, dirfd), false);
  const node = r.node ?? fail(E.NOENT);
  if (directory) {
    if (!(node instanceof Dir)) return fail(E.NOTDIR);
    if (node.entries.size) fail(E.NOTEMPTY);
  } else if (node.isDir) {
    fail(E.ISDIR);
  }
  r.parent.entries.delete(r.name);
  unlinked(r.parent, node);
  return 0;
}

/** `node`'s name in `dir` gone: one link fewer (none, for a directory, and one fewer for its parent's ..), as fstat
 * on what a process still holds open of it says. */
function unlinked(dir: Dir, node: Entry): void {
  if (node.isDir) { node.nlink = 0; dir.nlink--; } else if (node.nlink > 0) node.nlink--;
}

function makeDir(p: Proc, dirfd: bigint, address: bigint, mode: bigint): number {
  const r = p.kernel.vfs.resolve(path(p, address), base(p, dirfd), false);
  if (r.node) fail(E.EXIST);
  r.parent.entries.set(r.name, new Dir(N(mode) & ~p.umask & 0o7777));
  r.parent.nlink++;
  return 0;
}

function rename(p: Proc, olddir: bigint, oldaddr: bigint, newdir: bigint, newaddr: bigint): number {
  const vfs = p.kernel.vfs;
  const from = vfs.resolve(path(p, oldaddr), base(p, olddir), false);
  const node = from.node ?? fail(E.NOENT);
  const to = vfs.resolve(path(p, newaddr), base(p, newdir), false);
  if (to.node instanceof Dir && !node.isDir) fail(E.ISDIR);
  if (to.node instanceof Dir && to.node.entries.size) fail(E.NOTEMPTY);
  if (to.node === node) return 0; /* the same file by two names: nothing changes */
  from.parent.entries.delete(from.name);
  if (to.node) unlinked(to.parent, to.node);
  to.parent.entries.set(to.name, node);
  if (node.isDir && from.parent !== to.parent) { from.parent.nlink--; to.parent.nlink++; }
  return 0;
}

/** What a link holds; else its errno, given back (realpath asks it of each name on the way). */
function readlink(p: Proc, dirfd: bigint, address: bigint, buf: bigint, size: bigint): number {
  const node = p.kernel.vfs.find(path(p, address), base(p, dirfd), false);
  if (typeof node === 'number') return -node;
  if (!(node instanceof Link)) return -E.INVAL;
  const bytes = enc.encode(node.target).subarray(0, N(size));
  p.bytes.set(bytes, N(buf));
  return bytes.length;
}

function getdents(p: Proc, fd: bigint, buf: bigint, count: bigint): number {
  const d = descriptor(p, fd);
  if (d.kind !== 'dir') fail(E.NOTDIR);
  const dir = dirOf(d);
  // Linux leaves the order unspecified; name order keeps listings readable. Where it goes on from is the name it gave
  // last (d.after), not how many it gave, so one removed or added meanwhile moves none of the others: each there all
  // along is given once (rm -r removes what it reads as it reads).
  const names = [...dir.entries.keys()].sort();
  let i = 0;
  const after = d.after;
  if (after !== undefined) for (let hi = names.length; i < hi;) { const m = (i + hi) >> 1; if (names[m] <= after) i = m + 1; else hi = m; }
  let at = N(buf);
  const end = at + N(count);
  for (;;) {
    const dot = d.offset < 2;
    if (!dot && i >= names.length) break;
    const name = dot ? (d.offset ? '..' : '.') : names[i];
    const node = dot ? dir : dir.entries.get(name);
    if (!node) break;
    const bytes = enc.encode(name);
    const reclen = (19 + bytes.length + 1 + 7) & ~7;
    if (at + reclen > end) break;
    const v = p.view;
    v.setBigUint64(at, BigInt(node.ino), true);
    v.setBigInt64(at + 8, BigInt(d.offset + 1), true);
    v.setUint16(at + 16, reclen, true);
    v.setUint8(at + 18, DT[node.type] ?? 8);
    p.bytes.set(bytes, at + 19);
    p.bytes.fill(0, at + 19 + bytes.length, at + reclen);
    at += reclen;
    d.offset++;
    if (!dot) d.after = names[i++];
  }
  return at - N(buf);
}

/** access, faccessat, faccessat2: whether the node is there (F_OK) and may be read, written, run (R_OK 4, W_OK 2,
 * X_OK 1). Every process here is root (uid 0, the one mapped): reading and writing are always allowed, as
 * CAP_DAC_OVERRIDE allows them, but running only a directory or a node with some x bit, as Linux has it (a file of
 * 0644 is not run, and a shell says Permission denied of it, not "bad interpreter"). */
function access(p: Proc, dirfd: bigint, address: bigint, mode: bigint, flags = 0n): number {
  const m = N(mode), f = N(flags);
  if (m & ~7) fail(E.INVAL);
  if (f & ~(AT.SYMLINK_NOFOLLOW | AT_EACCESS | AT.EMPTY_PATH)) fail(E.INVAL);
  const node = f & AT.EMPTY_PATH && !p.bytes[N(address)]
    ? (N(dirfd) === AT_FDCWD ? p.kernel.vfs.lookup(p.cwd, '/') : descriptor(p, dirfd).node ?? fail(E.BADF))
    : p.kernel.vfs.find(path(p, address), base(p, dirfd), !(f & AT.SYMLINK_NOFOLLOW));
  if (typeof node === 'number') return -node;
  if (m & 1 && !node.isDir && !(node.mode & 0o111)) fail(E.ACCES);
  return 0;
}
const AT_EACCESS = 0x200;

// ---- extended attributes ----
//
// Kept with each node while this kernel runs, as tmpfs keeps them: names in the namespaces Linux has (user.,
// trusted., security., system.), values of up to 64 KiB, XATTR_CREATE and XATTR_REPLACE, a size of 0 asking how
// large. A pipe or socket has none and takes none (ENODATA, EOPNOTSUPP); a link takes no user. attribute (EPERM).

const XATTR = {CREATE: 1, REPLACE: 2, NAME_MOST: 255, VALUE_MOST: 65536};
/** What attributes are kept on: a node, or NONE. */
interface Attributed { xattrs?: Map<string, Uint8Array> | null; readonly isLink: boolean; readonly takesNone?: boolean }
const xnode = (p: Proc, name: bigint, follow: boolean): Entry => p.kernel.vfs.lookup(path(p, name), p.cwd, follow);
/** What a descriptor with no node has (a pipe's, a socket's): no attributes, and room for none. */
const NONE: Attributed = {xattrs: null, isLink: false, takesNone: true};
const xnodeOf = (p: Proc, fd: bigint): Attributed => descriptor(p, fd).node ?? NONE;
function xname(p: Proc, at: bigint): string {
  const name = p.cstring(N(at));
  if (!name || name.length > XATTR.NAME_MOST) fail(E.RANGE);
  if (!/^(user|trusted|security|system)\./.test(name)) fail(E.OPNOTSUPP);
  return name;
}
function setXattr(p: Proc, node: Attributed, at: bigint, value: bigint, size: bigint, flags: bigint): number {
  const name = xname(p, at), n = N(size), f = N(flags);
  if (n < 0 || n > XATTR.VALUE_MOST) fail(E.TOOBIG);
  if (f & ~(XATTR.CREATE | XATTR.REPLACE)) fail(E.INVAL);
  if (node.takesNone) fail(E.OPNOTSUPP);
  if (node.isLink && name.startsWith('user.')) fail(E.PERM);
  const all = (node.xattrs ??= new Map());
  if ((f & XATTR.CREATE) && all.has(name)) fail(E.EXIST);
  if ((f & XATTR.REPLACE) && !all.has(name)) fail(E.NODATA);
  all.set(name, p.bytes.slice(N(value), N(value) + n));
  return 0;
}
function getXattr(p: Proc, node: Attributed, at: bigint, value: bigint, size: bigint): number {
  const v = node.xattrs?.get(xname(p, at)) ?? fail(E.NODATA);
  if (N(size) === 0) return v.length;
  if (N(size) < v.length) fail(E.RANGE);
  p.bytes.set(v, N(value));
  return v.length;
}
function listXattr(p: Proc, node: Attributed, list: bigint, size: bigint): number {
  const names = enc.encode([...(node.xattrs?.keys() ?? [])].map((k) => `${k}\0`).join(''));
  if (N(size) === 0) return names.length;
  if (N(size) < names.length) fail(E.RANGE);
  p.bytes.set(names, N(list));
  return names.length;
}
function removeXattr(p: Proc, node: Attributed, at: bigint): number {
  const name = xname(p, at);
  if (!node.xattrs?.delete(name)) fail(E.NODATA);
  return 0;
}

/** mknod: a named pipe or an empty regular file where nothing is; a device is not made here (EPERM). */
function makeNode(p: Proc, dirfd: bigint, address: bigint, mode: bigint): number {
  const r = p.kernel.vfs.resolve(path(p, address), base(p, dirfd), false);
  if (r.node) fail(E.EXIST);
  const m = N(mode), perm = m & ~p.umask & 0o7777, type = m & 0o170000;
  if (type === S_IFIFO) r.parent.entries.set(r.name, new Fifo(perm));
  else if (type === 0 || type === 0o100000) r.parent.entries.set(r.name, new File(new Uint8Array(0), perm));
  else fail(E.PERM);
  return 0;
}

function pipe(p: Proc, address: bigint, flags: bigint): number {
  const pipe = new Pipe();
  const cloexec = !!(N(flags) & O.CLOEXEC), nonblock = N(flags) & O.NONBLOCK;
  const r = p.fds.install(new Description('pipe-r', {pipe, flags: nonblock}), {cloexec});
  const w = p.fds.install(new Description('pipe-w', {pipe, flags: O.WRONLY | nonblock}), {cloexec});
  p.view.setInt32(N(address), r, true);
  p.view.setInt32(N(address) + 4, w, true);
  return 0;
}

const POLL = {IN: 1, PRI: 2, OUT: 4, ERR: 8, HUP: 0x10, NVAL: 0x20, RDNORM: 0x40, RDBAND: 0x80, WRNORM: 0x100, WRBAND: 0x200, RDHUP: 0x2000};

/**
 * What `d` is ready for now, as poll's bits. Files are always ready; a pipe
 * is readable with data (or no writer left: POLLHUP) and writable with room
 * (no reader left: POLLERR); the console is readable when it says so
 * (console.ready), or at its end.
 */
function readiness(p: Proc, d: Description): number {
  let r;
  switch (d.kind) {
    case 'pipe-r': { const pipe = pipeOf(d); r = (pipe.size ? POLL.IN : 0) | (pipe.writers ? 0 : POLL.HUP); break; }
    case 'pipe-w': { const pipe = pipeOf(d); r = pipe.readers ? (pipe.writable ? POLL.OUT : 0) : POLL.ERR; break; }
    case 'pipe-rw': { const pipe = pipeOf(d); r = (pipe.size ? POLL.IN : 0) | (pipe.writable ? POLL.OUT : 0); break; }
    case 'console': r = (p.kernel.console.ready?.() ? POLL.IN : 0) | POLL.OUT; break;
    case 'eventfd': { const e = counterOf(d); r = (e.count ? POLL.IN : 0) | (e.count < 0xfffffffffffffffen ? POLL.OUT : 0); break; }
    case 'epoll': r = epollReady(p, d, 1).length ? POLL.IN : 0; break;
    case 'socket': r = net.ready(d); break;
    default: r = POLL.IN | POLL.OUT;
  }
  if (r & POLL.IN) r |= POLL.RDNORM;
  if (r & POLL.OUT) r |= POLL.WRNORM;
  return r;
}

/** A counter that moves whenever `d`'s readiness may have (epoll's edge). */
const changes = (p: Proc, d: Description): number => (d.kind === 'socket' ? net.changes(d) : d.pipe?.changes ?? d.event?.changes ?? (d.kind === 'console' ? p.kernel.inputs ?? 0 : 0));

/** The calling thread's mask is `set` while the call waits (ppoll, pselect6, epoll_pwait), as rt_sigsuspend does. */
function swapMask(p: Proc, address: number): void {
  const s = p.call!.state, t = p.task;
  if (!address || s.swapped) return;
  s.swapped = true;
  t.savedMask = t.mask;
  t.mask = p.view.getBigUint64(address, true) & ~UNBLOCKABLE;
  // One it lets through that is pending already interrupts the call at once.
  if (deliverable(t)) fail(E.INTR);
}

/** The call is done without a handler: its mask is as before. */
function restoreMask(p: Proc): void {
  const s = p.call!.state, t = p.task;
  if (s.swapped && t.savedMask !== null) { t.mask = t.savedMask; t.savedMask = null; }
}

/** Wait for a timeout of `ms` (null: none) from the first time the call was made; true once it is over. */
function timedOut(p: Proc, ms: number | null): boolean {
  const s = p.call!.state;
  if (ms === null) return false;
  s.deadline ??= steady() + ms;
  return steady() >= s.deadline;
}

/** poll/ppoll. With nothing ready and a timeout other than 0 the call waits, like a blocking read. */
function poll(p: Proc, address: bigint, count: bigint, timeout: number, mask = 0): number {
  const at = N(address), n = N(count);
  if (n < 0 || n > 1024) fail(E.INVAL);
  swapMask(p, mask);
  let ready = 0;
  for (let i = 0; i < n; i++) {
    const slot = at + i * 8;
    const fd = p.view.getInt32(slot, true), events = p.view.getInt16(slot + 4, true);
    let revents = 0;
    if (fd >= 0) {
      const d = p.fds.get(fd);
      revents = d ? readiness(p, d) & (events | POLL.ERR | POLL.HUP) : POLL.NVAL;
    }
    p.view.setInt16(slot + 6, revents, true);
    if (revents) ready++;
  }
  if (ready || timeout === 0 || timedOut(p, timeout < 0 ? null : timeout)) { restoreMask(p); return ready; }
  throw new Wait();
}

/** select/pselect6 over fd_sets of `nfds` bits; the sets are rewritten to what is ready. */
function select(p: Proc, nfds: bigint, sets: bigint[], timeout: number, mask = 0): number {
  const n = N(nfds);
  if (n < 0 || n > 1024) fail(E.INVAL);
  swapMask(p, mask);
  const words = Math.ceil(n / 64), v = p.view;
  const read = (at: number): bigint[] => Array.from({length: words}, (_, k) => (at ? v.getBigUint64(at + k * 8, true) : 0n));
  const want = sets.map((a) => read(N(a)));
  const got = want.map((): bigint[] => new Array<bigint>(words).fill(0n));
  let ready = 0;
  for (let fd = 0; fd < n; fd++) {
    const w = BigInt(fd % 64), k = fd >> 6, asked = want.map((set) => (set[k] >> w) & 1n);
    if (!asked.some((x) => x)) continue;
    const r = readiness(p, p.fds.get(fd) ?? fail(E.BADF));
    const is = [r & (POLL.IN | POLL.HUP | POLL.ERR), r & (POLL.OUT | POLL.ERR), r & POLL.PRI];
    for (let s = 0; s < 3; s++) if (asked[s] && is[s]) { got[s][k] |= 1n << w; ready++; }
  }
  if (ready || timeout === 0 || timedOut(p, timeout < 0 ? null : timeout)) {
    sets.forEach((a, s) => { if (N(a)) got[s].forEach((word, k) => v.setBigUint64(N(a) + k * 8, word, true)); });
    restoreMask(p);
    return ready;
  }
  throw new Wait();
}

// ---- epoll ----

const EPOLL = {ET: 1 << 31, ONESHOT: 1 << 30};

/** What `ep` (an epoll description) has ready now, up to `max`: [{events, data, entry}]. */
function epollReady(p: Proc, ep: Description, max: number): {events: number; data: bigint; entry: Interest; fd: number}[] {
  const out: {events: number; data: bigint; entry: Interest; fd: number}[] = [];
  for (const [fd, e] of interestOf(ep)) {
    if (out.length >= max) break;
    if (e.off || e.desc.closed) continue;
    const r = readiness(p, e.desc) & (e.events | POLL.ERR | POLL.HUP);
    if (!r) continue;
    // Edge-triggered: once for each change since it was last said.
    if (e.events & EPOLL.ET && e.seen === changes(p, e.desc)) continue;
    out.push({events: r, data: e.data, entry: e, fd});
  }
  return out;
}

function epollCtl(p: Proc, epfd: bigint, op: bigint, fd: bigint, event: bigint): number {
  const ep = descriptor(p, epfd);
  if (ep.kind !== 'epoll') fail(E.INVAL);
  const interest = interestOf(ep);
  const d = descriptor(p, fd), o = N(op), key = N(fd);
  if (d === ep) fail(E.INVAL);
  if (d.kind === 'file' || d.kind === 'dir') fail(E.PERM); // a regular file is always ready: Linux will not watch it
  const read = () => ({events: p.view.getUint32(N(event), true) | 0, data: p.view.getBigUint64(N(event) + 4, true)});
  if (o === 1) { // ADD
    if (interest.has(key)) fail(E.EXIST);
    interest.set(key, {desc: d, ...read(), seen: -1, off: false});
  } else if (o === 2) { // DEL
    if (!interest.delete(key)) fail(E.NOENT);
  } else if (o === 3) { // MOD
    const e = interest.get(key) ?? fail(E.NOENT);
    Object.assign(e, read(), {seen: -1, off: false});
  } else fail(E.INVAL);
  return 0;
}

function epollWait(p: Proc, epfd: bigint, events: bigint, max: bigint, timeout: number, mask = 0): number {
  const ep = descriptor(p, epfd);
  if (ep.kind !== 'epoll' || N(max) <= 0) fail(E.INVAL);
  swapMask(p, mask);
  const ready = epollReady(p, ep, N(max));
  if (ready.length || timeout === 0 || timedOut(p, timeout < 0 ? null : timeout)) {
    ready.forEach(({events: r, data, entry}, k) => {
      p.view.setUint32(N(events) + k * 12, r >>> 0, true);
      p.view.setBigUint64(N(events) + k * 12 + 4, data, true);
      entry.seen = changes(p, entry.desc);
      if (entry.events & EPOLL.ONESHOT) entry.off = true;
    });
    restoreMask(p);
    return ready.length;
  }
  throw new Wait();
}

function epollCreate(p: Proc, flags: number): number {
  const d = new Description('epoll', {flags: 0});
  d.interest = new Map();
  const fd = p.fds.install(d, {cloexec: !!(flags & O.CLOEXEC)});
  if (fd < 0) fail(E.MFILE);
  return fd;
}

function eventfd(p: Proc, initval: number, flags: number): number {
  const d = new Description('eventfd', {flags: O.RDWR | (flags & O.NONBLOCK)});
  d.event = {count: BigInt.asUintN(32, BigInt(initval)), semaphore: !!(flags & 1), changes: 0};
  const fd = p.fds.install(d, {cloexec: !!(flags & O.CLOEXEC)});
  if (fd < 0) fail(E.MFILE);
  return fd;
}

/** A timespec at `at` as milliseconds (null: none given, so no timeout). */
const timespecMs = (p: Proc, at: number): number | null => (at ? Number(p.view.getBigInt64(at, true)) * 1000 + Number(p.view.getBigInt64(at + 8, true)) / 1e6 : null);
/** A timeval at `at` as milliseconds. */
const timevalMs = (p: Proc, at: number): number | null => (at ? Number(p.view.getBigInt64(at, true)) * 1000 + Number(p.view.getBigInt64(at + 8, true)) / 1e3 : null);

/**
 * The console as a terminal, where it says it is one: set as Linux sets one (`stty sane`): a line at a time, echoed,
 * signals from keys. What is typed comes in lines, edited and shown by the page; ECHO says whether it shows them (off:
 * a password, out of sight).
 */
const TERMIOS = {iflag: 0x500, oflag: 0x5, cflag: 0xbf, lflag: 0x8a3b};
const ICANON = 2, ECHO = 8, ECHOK = 0x20;

/**
 * How the Prompt's shell (the session's first process) has the terminal set, as it reads it: the page edits its lines,
 * so it never sees ECHO while a line is read a line at a time; else its line editor (BusyBox's) would take the line
 * from the page, read key by key and echo it itself (once `stty echo` or `reset` had put ECHO there). ECHO is what the
 * rest last set it to (`echo`), the shell only hushing it, as `read -s` does: ECHOK put out with it.
 */
const shells = (k: Kern, p: Proc): boolean => p.pid === k.tty.sid;
const seenBy = (k: Kern, p: Proc, lflag: number): number => (shells(k, p) && lflag & ICANON ? lflag & ~ECHO : lflag);
function setBy(k: Kern, p: Proc, tio: Termios, lflag: number): number {
  if (!shells(k, p)) { tio.echo = lflag & ECHO; return lflag; }
  return (lflag & ~ECHO) | (lflag & ECHOK ? tio.echo : 0);
}

/**
 * The terminal handed between the shell and its jobs (TIOCSPGRP), as bash hands it (BusyBox's ash does not): how the
 * shell had it set is kept as it hands it to a job; taken back from a job a signal cut short (killed, or stopped: then
 * kept for when it is brought back, fg) that left it reading key by key, put back as the shell had it, so its prompt
 * line is a line again. A job that ended of itself leaves it as it set it (`stty raw`), as there.
 */
const setting = (tio: Termios): Termios => ({iflag: tio.iflag, oflag: tio.oflag, cflag: tio.cflag, lflag: tio.lflag, echo: tio.echo, cc: tio.cc.slice()});
function handed(k: Kern, tio: Termios, g: number): void {
  const shell = k.tty.sid, from = k.tty.fg;
  if (g === from) return;
  const put = (to: Termios): void => {
    const was = tio.lflag, wasOut = tio.oflag;
    Object.assign(tio, setting(to));
    if (tio.lflag !== was || tio.oflag !== wasOut) k.console.mode?.({iflag: tio.iflag, oflag: tio.oflag, lflag: tio.lflag});
  };
  if (g === shell) {
    const cut = k.tty.cut === from && !(tio.lflag & ICANON);
    k.tty.left = cut ? {pgid: from, setting: setting(tio)} : null;
    k.tty.cut = 0;
    if (cut && k.tty.shell) put(k.tty.shell);
    return;
  }
  if (from === shell) k.tty.shell = setting(tio);
  if (k.tty.left?.pgid === g) put(k.tty.left.setting);
  k.tty.left = null;
}

function ioctl(p: Proc, d: Description, request: number, arg: number): number {
  const k = p.kernel, r = request, v = p.view;
  if (r === 0x5421) { // FIONBIO
    if (v.getInt32(arg, true)) d.flags |= O.NONBLOCK; else d.flags &= ~O.NONBLOCK;
    return 0;
  }
  if (r === 0x5451 || r === 0x5450) return 0; // FIOCLEX, FIONCLEX (the table's: done by fcntl too)
  if (r === 0x541b) { // FIONREAD
    const n = d.kind === 'pipe-r' || d.kind === 'pipe-rw' ? pipeOf(d).size : d.kind === 'socket' ? net.pending(d) : d.kind === 'console' ? k.console.pending?.() ?? 0 : d.kind === 'file' ? Math.max(0, fileOf(d).size - d.offset) : null;
    v.setInt32(arg, n ?? fail(E.NOTTY), true);
    return 0;
  }
  // A socket's (SIOCOUTQ, what an interface is): sys-net.ts's.
  if (d.kind === 'socket') return net.control(p, d, r, arg);
  // The console's output, where what is written to it is shown as a terminal's screen (`screen`: the app's Prompt), is
  // a terminal to what writes to it: as wide as the screen, set as a terminal is, so a listing comes in columns. What
  // reads keys from it is not, until the console is interactive (the keys are sent a line at a time).
  if (d.kind === 'console' && !k.console.interactive && k.console.screen && (d.path === 'stdout' || d.path === 'stderr')) {
    if (r === 0x5413) { // TIOCGWINSZ
      p.bytes.fill(0, arg, arg + 8);
      v.setUint16(arg, k.console.rows ?? 24, true);
      v.setUint16(arg + 2, k.console.cols ?? 80, true);
      return 0;
    }
    if (r === 0x5401) { // TCGETS
      p.bytes.fill(0, arg, arg + 36);
      v.setUint32(arg, TERMIOS.iflag, true); v.setUint32(arg + 4, TERMIOS.oflag, true);
      v.setUint32(arg + 8, TERMIOS.cflag, true); v.setUint32(arg + 12, TERMIOS.lflag, true);
      return 0;
    }
    return -E.NOTTY;
  }
  // The rest are a terminal's, and only the console is one (when it says it is interactive). Not one: what every
  // program's stdio asks of its output once (isatty), so given back.
  if (d.kind !== 'console' || !k.console.interactive) return -E.NOTTY;
  k.tty.termios ??= {...TERMIOS, echo: TERMIOS.lflag & ECHO, cc: new Uint8Array([3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0])};
  const tio = k.tty.termios;
  switch (r) {
    case 0x5401: // TCGETS
      p.bytes.fill(0, arg, arg + 36);
      v.setUint32(arg, tio.iflag, true); v.setUint32(arg + 4, tio.oflag, true);
      v.setUint32(arg + 8, tio.cflag, true); v.setUint32(arg + 12, seenBy(k, p, tio.lflag), true);
      p.bytes.set(tio.cc, arg + 17);
      return 0;
    case 0x5402: case 0x5403: case 0x5404: { // TCSETS, TCSETSW, TCSETSF
      const was = tio.lflag, wasOut = tio.oflag;
      tio.iflag = v.getUint32(arg, true); tio.oflag = v.getUint32(arg + 4, true);
      tio.cflag = v.getUint32(arg + 8, true); tio.lflag = setBy(k, p, tio, v.getUint32(arg + 12, true));
      tio.cc = p.bytes.slice(arg + 17, arg + 36);
      // What shows the terminal hears how keys are now read (a line at a time, or each as it comes; echoed or not;
      // signals from keys or not) and how lines are put out, as it is the one that reads the keys.
      if (tio.lflag !== was || tio.oflag !== wasOut) k.console.mode?.({iflag: tio.iflag, oflag: tio.oflag, lflag: tio.lflag});
      return 0;
    }
    case 0x5413: // TIOCGWINSZ
      p.bytes.fill(0, arg, arg + 8);
      v.setUint16(arg, k.console.rows ?? 24, true);
      v.setUint16(arg + 2, k.console.cols ?? 80, true);
      return 0;
    case 0x5414: // TIOCSWINSZ
      k.console.rows = v.getUint16(arg, true);
      k.console.cols = v.getUint16(arg + 2, true);
      for (const q of k.group(k.tty.fg)) send(k, q, SIG.WINCH, {code: SI.KERNEL});
      return 0;
    case 0x540f: v.setInt32(arg, k.tty.fg, true); return 0; // TIOCGPGRP
    case 0x5410: { // TIOCSPGRP: a group of the terminal's session
      const g = v.getInt32(arg, true);
      if (p.sid !== k.tty.sid) fail(E.NOTTY);
      if (g < 0) fail(E.INVAL);
      if (!k.hasGroup(g, p.sid)) fail(E.PERM);
      handed(k, tio, g);
      k.tty.fg = g;
      return 0;
    }
    case 0x5429: v.setInt32(arg, k.tty.sid, true); return 0; // TIOCGSID
    case 0x540e: // TIOCSCTTY
      if (p.sid !== p.pid) fail(E.PERM);
      k.tty.sid = p.sid;
      k.tty.fg = p.pgid;
      return 0;
    case 0x5422: return 0; // TIOCNOTTY
    case 0x540b: case 0x5409: case 0x540a: case 0x5425: return 0; // TCFLSH, TCSBRK, TCXONC, TCSBRKP
  }
  return fail(E.NOTTY);
}
/**
 * chown of `node` (looked up already: a name not there is ENOENT first): to the one owner this machine has, 0, or -1
 * to keep it; any other id is not mapped in the Prompt's namespace (EINVAL, as there). As Linux's, it takes away a
 * file's set-user-ID bit, and its set-group-ID bit where the group may run it.
 */
function chown(_p: Proc, node: Entry | null, uid: bigint, gid: bigint): number {
  for (const id of [uid, gid]) {
    const x = Number(BigInt.asUintN(32, id));
    if (x !== 0 && x !== 0xffffffff) fail(E.INVAL);
  }
  if (node && !node.isDir && node.mode !== undefined) {
    node.mode &= ~0o4000;
    if (node.mode & 0o010) node.mode &= ~0o2000;
  }
  return 0;
}

function dup(p: Proc, oldfd: bigint, newfd: number, cloexec: boolean): number {
  const d = descriptor(p, oldfd);
  if (newfd < 0 || newfd >= p.fds.limit) fail(E.BADF);
  return p.fds.install(d, {fd: newfd, cloexec});
}

export const FILE_CALLS: Calls = {
  0(fd, buf, len) { return readInto(this, descriptor(this, fd), N(buf), N(len)); },
  23(nfds, r, w, e, tv) { // select, which says what time was left
    const ms = timevalMs(this, N(tv)), s = this.call!.state;
    const n = select(this, nfds, [r, w, e], ms ?? -1);
    if (N(tv) && ms !== null) {
      const left = Math.max(0, (s.deadline ?? steady()) - steady());
      this.view.setBigInt64(N(tv), BigInt(Math.floor(left / 1000)), true);
      this.view.setBigInt64(N(tv) + 8, BigInt(Math.floor((left % 1000) * 1000)), true);
    }
    return n;
  },
  270(nfds, r, w, e, ts, sig) { // pselect6: sig points at {sigset *, size}
    const mask = N(sig) ? Number(this.view.getBigUint64(N(sig), true)) : 0;
    return select(this, nfds, [r, w, e], timespecMs(this, N(ts)) ?? -1, mask);
  },
  213() { return epollCreate(this, 0); },
  291(flags) { return epollCreate(this, N(flags)); },
  233(epfd, op, fd, event) { return epollCtl(this, epfd, op, fd, event); },
  232(epfd, events, max, timeout) { return epollWait(this, epfd, events, max, Number(BigInt.asIntN(32, timeout))); },
  281(epfd, events, max, timeout, mask) { return epollWait(this, epfd, events, max, Number(BigInt.asIntN(32, timeout)), N(mask)); },
  441(epfd, events, max, ts, mask) { return epollWait(this, epfd, events, max, timespecMs(this, N(ts)) ?? -1, N(mask)); },
  284(initval) { return eventfd(this, N(initval), 0); },
  290(initval, flags) { return eventfd(this, N(initval), N(flags)); },
  436(first, last, flags) { // close_range
    const from = Number(BigInt.asUintN(32, first)), to = Number(BigInt.asUintN(32, last)), cloexec = N(flags) & 4;
    if (from > to) fail(E.INVAL);
    for (const fd of [...this.fds.slots.keys()]) if (fd >= from && fd <= to) { if (cloexec) this.fds.setCloexec(fd, true); else this.fds.close(fd); }
    return 0;
  },
  1(fd, buf, len) { return writeFrom(this, descriptor(this, fd), N(buf), N(len)); },
  2(name, flags, mode) { return openAt(this, BigInt(AT_FDCWD), name, flags, mode); },
  3(fd) { if (!this.fds.close(N(fd))) fail(E.BADF); return 0; },
  4(name, st) { return statOf(this, st, statNode(this, path(this, name), BigInt(AT_FDCWD), true)); },
  5(fd, st) { return writeStat(this, st, describe(this, descriptor(this, fd))); },
  6(name, st) { return statOf(this, st, this.kernel.vfs.find(path(this, name), this.cwd, false)); },
  7(fds, count, timeout) { return poll(this, fds, count, Number(BigInt.asIntN(32, timeout))); },
  271(fds, count, spec, mask) { return poll(this, fds, count, timespecMs(this, N(spec)) ?? -1, N(mask)); },
  8(fd, offset, whence) {
    const d = descriptor(this, fd);
    if (d.kind === 'pipe-r' || d.kind === 'pipe-w' || d.kind === 'pipe-rw' || d.kind === 'socket' || d.kind === 'console') fail(E.SPIPE);
    if (d.kind === 'dir') { if (N(offset) === 0 && N(whence) === 0) { d.offset = 0; d.after = undefined; return 0; } return fail(E.INVAL); }
    const start = [0, d.offset, d.node instanceof File ? d.node.size : 0][N(whence)];
    if (start === undefined || start + N(offset) < 0) fail(E.INVAL);
    d.offset = start + N(offset);
    return d.offset;
  },
  16(fd, request, arg) { return ioctl(this, descriptor(this, fd), Number(BigInt.asUintN(32, request)), N(arg)); },
  17(fd, buf, len, off) { return readInto(this, descriptor(this, fd), N(buf), N(len), N(off)); },
  18(fd, buf, len, off) { return writeFrom(this, descriptor(this, fd), N(buf), N(len), N(off)); },
  19(fd, vec, count) { return readv(this, descriptor(this, fd), vec, count); },
  20(fd, vec, count) { return writev(this, descriptor(this, fd), vec, count); },
  295(fd, vec, count, off) { return readv(this, descriptor(this, fd), vec, count, N(off)); }, // preadv
  296(fd, vec, count, off) { return writev(this, descriptor(this, fd), vec, count, N(off)); }, // pwritev
  21(name, mode) { return access(this, BigInt(AT_FDCWD), name, mode); },
  22(fds) { return pipe(this, fds, 0n); },
  32(fd) { const d = descriptor(this, fd); return this.fds.install(d); },
  33(oldfd, newfd) { if (N(oldfd) === N(newfd)) { descriptor(this, oldfd); return N(newfd); } return dup(this, oldfd, N(newfd), false); },
  72(fd, cmd, arg) {
    const d = descriptor(this, fd), c = N(cmd);
    if (c === 0 || c === 1030) { // F_DUPFD, F_DUPFD_CLOEXEC
      // From past the descriptor limit: EINVAL; none free below it: EMFILE.
      if (N(arg) < 0 || N(arg) >= this.fds.limit) fail(E.INVAL);
      const target = this.fds.lowest(N(arg));
      if (target < 0) fail(E.MFILE);
      return this.fds.install(d, {fd: target, cloexec: c === 1030});
    }
    if (c === 1) return this.fds.cloexec(N(fd)) ? 1 : 0;
    if (c === 2) { this.fds.setCloexec(N(fd), (N(arg) & 1) === 1); return 0; }
    if (c === 3) return d.flags;
    if (c === 4) { d.flags = (d.flags & ~(O.APPEND | O.NONBLOCK)) | (N(arg) & (O.APPEND | O.NONBLOCK)); return 0; }
    if (c === 1032) return pipeOf(d).capacity; // F_GETPIPE_SZ
    if (c === 1031) { // F_SETPIPE_SZ
      const n = pipeOf(d).resize(N(arg));
      if (n === -1) fail(E.PERM);
      if (n === -2) fail(E.BUSY);
      return n;
    }
    return 0; // the rest succeed trivially, record locks (F_SETLK and its kin) among them: each is granted
  },

  // flock: LOCK_SH 1 or LOCK_EX 2, or LOCK_UN 8; with LOCK_NB 4 it says EWOULDBLOCK rather than wait. Waiting, it is
  // made again when another call is done (a lock let go is one: LOCK_UN, the last close, an exit).
  73(fd, op) {
    const d = descriptor(this, fd), o = N(op), kind = o & ~4;
    if (kind === 8) { unflock(d); return 0; }
    if (kind !== 1 && kind !== 2) fail(E.INVAL);
    if (flock(d, kind === 2)) return 0;
    if (o & 4) fail(E.AGAIN);
    throw new Wait();
  },
  74() { return 0; }, 75() { return 0; },
  // What is written is where it goes already (memory; a repo's files mirrored as they change): nothing to wait for.
  162() { return 0; }, // sync
  306(fd) { descriptor(this, fd); return 0; }, // syncfs
  277(fd) { descriptor(this, fd); return 0; }, // sync_file_range
  221(fd) { // fadvise64: advice, taken and not needed (every file is in memory once read)
    const d = descriptor(this, fd);
    if (d.kind !== 'file' && d.kind !== 'dir' && d.kind !== 'device') fail(E.SPIPE);
    return 0;
  },
  // Extended attributes (setfattr, setcap, setfacl): by path (following a link, or not: l*) or by descriptor.
  188(name, at, value, size, flags) { return setXattr(this, xnode(this, name, true), at, value, size, flags); }, // setxattr
  189(name, at, value, size, flags) { return setXattr(this, xnode(this, name, false), at, value, size, flags); }, // lsetxattr
  190(fd, at, value, size, flags) { return setXattr(this, xnodeOf(this, fd), at, value, size, flags); }, // fsetxattr
  191(name, at, value, size) { return getXattr(this, xnode(this, name, true), at, value, size); }, // getxattr
  192(name, at, value, size) { return getXattr(this, xnode(this, name, false), at, value, size); }, // lgetxattr
  193(fd, at, value, size) { return getXattr(this, xnodeOf(this, fd), at, value, size); }, // fgetxattr
  194(name, list, size) { return listXattr(this, xnode(this, name, true), list, size); }, // listxattr
  195(name, list, size) { return listXattr(this, xnode(this, name, false), list, size); }, // llistxattr
  196(fd, list, size) { return listXattr(this, xnodeOf(this, fd), list, size); }, // flistxattr
  197(name, at) { return removeXattr(this, xnode(this, name, true), at); }, // removexattr
  198(name, at) { return removeXattr(this, xnode(this, name, false), at); }, // lremovexattr
  199(fd, at) { return removeXattr(this, xnodeOf(this, fd), at); }, // fremovexattr
  319(name, flags) { // memfd_create: a file in no directory, as shared anonymous memory is
    const f = N(flags);
    if (f & ~0x7) fail(E.INVAL); // MFD_CLOEXEC, MFD_ALLOW_SEALING, MFD_HUGETLB
    const node = new File(new Uint8Array(0), 0o777);
    const d = new Description('file', {node, flags: O.RDWR, path: `/memfd:${this.cstring(N(name))} (deleted)`});
    const fd = this.fds.install(d, {cloexec: !!(f & 1)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  },
  285(fd, mode, offset, len) { // fallocate: room made (a file's bytes are memory: zeros), or a range made zero
    const d = descriptor(this, fd), m = N(mode), at = N(offset), n = N(len);
    // As Linux asks: open for writing, then a file.
    if ((d.flags & 3) === 0) fail(E.BADF);
    if (d.kind !== 'file') fail(d.kind.startsWith('pipe') || d.kind === 'socket' ? E.SPIPE : E.NODEV);
    if (at < 0 || n <= 0) fail(E.INVAL);
    const KEEP_SIZE = 1, PUNCH_HOLE = 2, ZERO_RANGE = 0x10, node = fileOf(d);
    if (m & ~(KEEP_SIZE | PUNCH_HOLE | ZERO_RANGE)) fail(E.OPNOTSUPP);
    if (m & (PUNCH_HOLE | ZERO_RANGE)) {
      if ((m & PUNCH_HOLE) && !(m & KEEP_SIZE)) fail(E.INVAL);
      const end = m & KEEP_SIZE ? Math.min(at + n, node.size) : at + n;
      if (end > at) node.write(at, new Uint8Array(end - at));
      return 0;
    }
    if (!(m & KEEP_SIZE) && at + n > node.size) node.truncate(at + n);
    return 0;
  },
  40(out, from, offsetAt, count) { // sendfile: a file's bytes written to `out`, as a write of them is (it may wait)
    const dout = descriptor(this, out), din = descriptor(this, from);
    if (din.kind !== 'file' || (din.flags & 3) === O.WRONLY) fail(E.INVAL);
    if ((dout.flags & 3) === 0 && dout.kind === 'file') fail(E.BADF);
    const at = N(offsetAt) ? Number(this.view.getBigInt64(N(offsetAt), true)) : din.offset;
    if (at < 0) fail(E.INVAL);
    const data = fileOf(din).read(at, at + Math.min(N(count), 1 << 20));
    if (!data.length) return 0;
    const n = writeData(this, dout, data);
    if (N(offsetAt)) this.view.setBigInt64(N(offsetAt), BigInt(at + n), true); else din.offset = at + n;
    return n;
  },
  326(inFd, inAt, outFd, outAt, len, flags) { // copy_file_range: between files, done here
    if (N(flags)) fail(E.INVAL);
    const din = descriptor(this, inFd), dout = descriptor(this, outFd);
    if (din.kind !== 'file' || dout.kind !== 'file') fail(E.INVAL);
    if ((din.flags & 3) === O.WRONLY || (dout.flags & 3) === 0 || (dout.flags & O.APPEND)) fail(E.BADF);
    const from = N(inAt) ? Number(this.view.getBigInt64(N(inAt), true)) : din.offset;
    const to = N(outAt) ? Number(this.view.getBigInt64(N(outAt), true)) : dout.offset;
    if (from < 0 || to < 0) fail(E.INVAL);
    const data = fileOf(din).read(from, from + Math.min(N(len), 1 << 30));
    if (din.node === dout.node && from < to + data.length && to < from + data.length) fail(E.INVAL);
    if (data.length) fileOf(dout).write(to, data.slice());
    if (N(inAt)) this.view.setBigInt64(N(inAt), BigInt(from + data.length), true); else din.offset = from + data.length;
    if (N(outAt)) this.view.setBigInt64(N(outAt), BigInt(to + data.length), true); else dout.offset = to + data.length;
    return data.length;
  },
  // preadv2 and pwritev2: preadv and pwritev, an offset of -1 the descriptor's own (RWF_ flags change nothing here).
  327(fd, vec, count, pos) { const at = N(pos); return readv(this, descriptor(this, fd), vec, count, at === -1 ? null : at); },
  328(fd, vec, count, pos) { const at = N(pos); return writev(this, descriptor(this, fd), vec, count, at === -1 ? null : at); },
  76(name, length) { const node = this.kernel.vfs.lookup(path(this, name), this.cwd); if (!(node instanceof File)) return fail(E.INVAL); node.truncate(N(length)); return 0; },
  77(fd, length) { const d = descriptor(this, fd); if (d.kind !== 'file') fail(E.INVAL); fileOf(d).truncate(N(length)); return 0; },
  79(buf, size) {
    const bytes = enc.encode(this.cwd + '\0');
    if (bytes.length > N(size)) fail(E.RANGE);
    this.bytes.set(bytes, N(buf));
    return bytes.length;
  },
  80(name) {
    const target = path(this, name);
    if (!this.kernel.vfs.lookup(target, this.cwd).isDir) fail(E.NOTDIR);
    this.cwd = this.kernel.vfs.realpath(target, this.cwd);
    return 0;
  },
  81(fd) { const d = descriptor(this, fd); if (d.kind !== 'dir') fail(E.NOTDIR); this.cwd = d.path; return 0; },
  82(a, b) { return rename(this, BigInt(AT_FDCWD), a, BigInt(AT_FDCWD), b); },
  83(name, mode) { return makeDir(this, BigInt(AT_FDCWD), name, mode); },
  84(name) { return remove(this, BigInt(AT_FDCWD), name, true); },
  85(name, mode) { return openAt(this, BigInt(AT_FDCWD), name, BigInt(O.CREAT | O.WRONLY | O.TRUNC), mode); },
  86(a, b) { return FILE_CALLS[265].call(this, BigInt(AT_FDCWD), a, BigInt(AT_FDCWD), b, 0n); },
  87(name) { return remove(this, BigInt(AT_FDCWD), name, false); },
  88(target, name) { return FILE_CALLS[266].call(this, target, BigInt(AT_FDCWD), name); },
  89(name, buf, size) { return readlink(this, BigInt(AT_FDCWD), name, buf, size); },
  90(name, mode) { const n = this.kernel.vfs.lookup(path(this, name), this.cwd); n.mode = (n.mode & ~0o7777) | (N(mode) & 0o7777); return 0; },
  91(fd, mode) { const n = descriptor(this, fd).node; if (n) n.mode = (n.mode & ~0o7777) | (N(mode) & 0o7777); return 0; },
  92(name, uid, gid) { return chown(this, this.kernel.vfs.lookup(path(this, name), this.cwd), uid, gid); },
  93(fd, uid, gid) { return chown(this, descriptor(this, fd).node, uid, gid); }, // fchown
  94(name, uid, gid) { return chown(this, this.kernel.vfs.lookup(path(this, name), this.cwd, false), uid, gid); }, // lchown
  95(mask) { const old = this.umask; this.umask = N(mask) & 0o777; return old; },
  // utime, utimes, futimesat, utimensat: the times of a file that is there (ENOENT for one that is not, which
  // is how touch knows to make it).
  133(name, mode, _dev) { return makeNode(this, BigInt(AT_FDCWD), name, mode); },
  259(dirfd, name, mode, _dev) { return makeNode(this, dirfd, name, mode); },
  132(name, buf) {
    const n = this.kernel.vfs.lookup(path(this, name), this.cwd);
    if (!N(buf)) return setTimes(n, 'now', 'now');
    const t = (off: number): [number, number] => [Number(this.view.getBigInt64(N(buf) + off, true)), 0];
    return setTimes(n, t(0), t(8));
  },
  235(name, tv) { const [a, m] = timevals(this, tv) as [Time, Time]; return setTimes(this.kernel.vfs.lookup(path(this, name), this.cwd), a, m); },
  261(dirfd, name, tv) { const [a, m] = timevals(this, tv) as [Time, Time]; return setTimes(timed(this, dirfd, name, true), a, m); },
  280(dirfd, name, ts, flags) {
    const [a, m] = timespecs(this, ts) as [Time, Time];
    return setTimes(timed(this, dirfd, name, !(N(flags) & AT.SYMLINK_NOFOLLOW)), a, m);
  },
  137(name, buf) { // statfs: the filesystem the path is on (it must be there)
    const at = path(this, name);
    this.kernel.vfs.lookup(at, this.cwd);
    return writeStatfs(this, N(buf), at.startsWith('/') ? at : `${this.cwd}/${at}`);
  },
  138(fd, buf) { return writeStatfs(this, N(buf), descriptor(this, fd).path ?? '/'); }, // fstatfs
  217(fd, buf, count) { return getdents(this, fd, buf, count); },
  257(dirfd, name, flags, mode) { return openAt(this, dirfd, name, flags, mode); },
  258(dirfd, name, mode) { return makeDir(this, dirfd, name, mode); },
  260(dirfd, name, uid, gid, flags) { // fchownat
    const f = N(flags), named = N(name) && this.cstring(N(name));
    if (!named && f & AT.EMPTY_PATH) return chown(this, N(dirfd) === AT_FDCWD ? this.kernel.vfs.lookup(this.cwd, '/') : descriptor(this, dirfd).node, uid, gid);
    return chown(this, this.kernel.vfs.lookup(path(this, name), base(this, dirfd), !(f & AT.SYMLINK_NOFOLLOW)), uid, gid);
  },
  262(dirfd, name, st, flags) {
    if ((N(flags) & AT.EMPTY_PATH) && !this.bytes[N(name)]) return writeStat(this, st, describe(this, descriptor(this, dirfd)));
    return statOf(this, st, statNode(this, path(this, name), dirfd, !(N(flags) & AT.SYMLINK_NOFOLLOW)));
  },
  263(dirfd, name, flags) { return remove(this, dirfd, name, (N(flags) & AT.REMOVEDIR) !== 0); },
  264(od, oa, nd, na) { return rename(this, od, oa, nd, na); },
  265(od, oa, nd, na) {
    const vfs = this.kernel.vfs;
    const node = vfs.lookup(path(this, oa), base(this, od), false);
    if (node.isDir) fail(E.PERM);
    const to = vfs.resolve(path(this, na), base(this, nd), false);
    if (to.node) fail(E.EXIST);
    to.parent.entries.set(to.name, node);
    node.nlink++;
    return 0;
  },
  266(target, dirfd, name) {
    const to = this.kernel.vfs.resolve(path(this, name), base(this, dirfd), false);
    if (to.node) fail(E.EXIST);
    to.parent.entries.set(to.name, new Link(this.cstring(N(target))));
    return 0;
  },
  267(dirfd, name, buf, size) { return readlink(this, dirfd, name, buf, size); },
  268(dirfd, name, mode) { const n = this.kernel.vfs.lookup(path(this, name), base(this, dirfd)); n.mode = (n.mode & ~0o7777) | (N(mode) & 0o7777); return 0; },
  269(dirfd, name, mode) { return access(this, dirfd, name, mode); },
  292(oldfd, newfd, flags) { if (N(oldfd) === N(newfd)) fail(E.INVAL); return dup(this, oldfd, N(newfd), (N(flags) & O.CLOEXEC) !== 0); },
  293(fds, flags) { return pipe(this, fds, flags); },
  316(od, oa, nd, na) { return rename(this, od, oa, nd, na); },
  332() { return fail(E.NOSYS); },
  439(dirfd, name, mode, flags) { return access(this, dirfd, name, mode, flags); },
};
