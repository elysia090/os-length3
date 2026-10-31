// File, directory, descriptor and pipe system calls. Handlers run with
// `this` bound to the calling Process (`this.task` the thread, `this.call`
// the call, whose `state` lasts while it waits) and throw FsError for errno
// results, or Wait for a call to be made again once something changed.

import {Description, PIPE_BUF, Pipe} from './fd.mjs';
import {procDescriptor} from './procfs.mjs';
import {Dir, Device, E, Fifo, File, FsError, Link, S_IFIFO} from './fs.mjs';
import {Wait} from './process.mjs';
import {SIG, SI, UNBLOCKABLE, actionOf, bit, deliverable, send} from './signal.mjs';

const AT_FDCWD = -100;
const O = {WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, TRUNC: 0x200, APPEND: 0x400, NONBLOCK: 0x800,
  DIRECTORY: 0x10000, NOFOLLOW: 0x20000, CLOEXEC: 0x80000};
const AT = {SYMLINK_NOFOLLOW: 0x100, REMOVEDIR: 0x200, EMPTY_PATH: 0x1000};

const N = (x) => Number(BigInt.asIntN(64, x));
const fail = (errno) => { throw new FsError(errno); };
const enc = new TextEncoder();

/** The directory a *at() path is relative to. */
function base(p, dirfd) {
  const fd = N(dirfd);
  if (fd === AT_FDCWD) return p.cwd;
  const d = p.fds.get(fd);
  if (!d) fail(E.BADF);
  if (d.kind !== 'dir') fail(E.NOTDIR);
  return d.path;
}

function path(p, address) {
  const s = p.cstring(N(address));
  if (!s) fail(E.NOENT);
  return s;
}

function writeStat(p, address, node) {
  const v = p.view, at = N(address);
  p.bytes.fill(0, at, at + 144);
  const size = node.isFile ? node.size : node.isLink ? node.size : node.isDir ? 4096 : 0;
  v.setBigUint64(at, 1n, true); // dev
  v.setBigUint64(at + 8, BigInt(node.ino), true);
  v.setBigUint64(at + 16, BigInt(node.nlink), true);
  v.setUint32(at + 24, node.mode, true);
  v.setUint32(at + 28, node.uid, true);
  v.setUint32(at + 32, node.gid, true);
  v.setBigUint64(at + 40, BigInt(node.rdev ?? 0), true);
  v.setBigInt64(at + 48, BigInt(size), true);
  v.setBigInt64(at + 56, 4096n, true);
  v.setBigInt64(at + 64, BigInt(Math.ceil(size / 512)), true);
  // atime, mtime, ctime: as set (utimensat keeps nanoseconds), else the time of the last change.
  for (const [off, ms, ns] of [[72, node.atime ?? node.mtime, node.atimeNs], [88, node.mtime, node.mtimeNs], [104, node.ctime ?? node.mtime, undefined]]) {
    v.setBigInt64(at + off, BigInt(Math.floor(ms / 1000)), true);
    v.setBigInt64(at + off + 8, BigInt(ns ?? Math.floor(ms % 1000) * 1e6), true);
  }
  return 0;
}

const UTIME_NOW = (1 << 30) - 1, UTIME_OMIT = (1 << 30) - 2;

/** The file a time-setting call names: by its path from `dirfd`, or the descriptor itself (a NULL or empty path). */
function timed(p, dirfd, name, follow) {
  if (!N(name) || !p.bytes[N(name)]) {
    if (N(dirfd) === AT_FDCWD) return p.kernel.vfs.lookup(p.cwd, '/');
    const d = descriptor(p, dirfd);
    if (!d.node) fail(E.BADF);
    return d.node;
  }
  return p.kernel.vfs.lookup(path(p, name), base(p, dirfd), follow);
}

/** Set a file's access and modification times, each [seconds, nanoseconds], 'now' or 'omit'; its ctime is now. */
function setTimes(node, access, modify) {
  const now = Date.now();
  const at = (t) => t === 'now' ? [now, (now % 1000) * 1e6] : [t[0] * 1000 + Math.floor(t[1] / 1e6), t[1]];
  if (access !== 'omit') { const [ms, ns] = at(access); node.atime = ms; node.atimeNs = ns; }
  if (modify !== 'omit') { const [ms, ns] = at(modify); node.mtime = ms; node.mtimeNs = ns; }
  node.ctime = now;
  return 0;
}

/** Times from a struct timespec[2] (utimensat), with UTIME_NOW and UTIME_OMIT; none given is now for both. */
function timespecs(p, address) {
  if (!N(address)) return ['now', 'now'];
  return [0, 16].map((off) => {
    const s = Number(p.view.getBigInt64(N(address) + off, true)), ns = Number(p.view.getBigInt64(N(address) + off + 8, true));
    if (ns === UTIME_NOW) return 'now';
    if (ns === UTIME_OMIT) return 'omit';
    if (ns < 0 || ns >= 1e9) fail(E.INVAL);
    return [s, ns];
  });
}
/** Times from a struct timeval[2] (utimes, futimesat): microseconds. */
function timevals(p, address) {
  if (!N(address)) return ['now', 'now'];
  return [0, 16].map((off) => {
    const s = Number(p.view.getBigInt64(N(address) + off, true)), us = Number(p.view.getBigInt64(N(address) + off + 8, true));
    if (us < 0 || us >= 1e6) fail(E.INVAL);
    return [s, us * 1000];
  });
}

function describe(d) {
  // Something to stat for a descriptor without a node.
  if (d.node) return d.node;
  if (d.kind === 'pipe-r' || d.kind === 'pipe-w' || d.kind === 'pipe-rw') return {mode: S_IFIFO | 0o600, ino: 0, nlink: 1, uid: 0, gid: 0, mtime: Date.now(), isFile: false, isDir: false, isLink: false};
  return {mode: 0o020620, ino: 0, nlink: 1, uid: 0, gid: 0, rdev: 0x8800, mtime: Date.now(), isFile: false, isDir: false, isLink: false};
}

/** /dev/fd/N, /dev/stdin and the rest, and /proc/self/fd/N, as the /proc/PID/fd/N they are. */
function descriptorPath(p, name) {
  const std = {'/dev/stdin': 0, '/dev/stdout': 1, '/dev/stderr': 2}[name];
  if (std !== undefined) return `/proc/${p.pid}/fd/${std}`;
  const m = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(name);
  return m ? `/proc/${p.pid}/fd/${m[1]}` : name;
}

function openAt(p, dirfd, address, flags, mode) {
  const f = N(flags), name = path(p, address);
  // A descriptor opened by its /proc name opens what it has open: the same pipe or terminal, a file afresh.
  const named = name.startsWith('/') ? procDescriptor(p.kernel, descriptorPath(p, name)) : null;
  if (named) {
    const d = named.kind === 'file' || named.kind === 'dir' ? new Description(named.kind, {node: named.node, flags: f, path: named.path}) : named;
    if (d !== named && named.node?.isFile && (f & 3) && (f & O.TRUNC)) named.node.truncate(0);
    const fd = p.fds.install(d, {cloexec: !!(f & O.CLOEXEC)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  }
  const r = p.kernel.vfs.resolve(name, base(p, dirfd), !(f & O.NOFOLLOW));
  let node = r.node;
  if (!node) {
    if (!(f & O.CREAT)) fail(E.NOENT);
    if (!r.parent.isDir) fail(E.NOTDIR);
    node = new File(new Uint8Array(0), N(mode) & ~p.umask & 0o7777);
    r.parent.entries.set(r.name, node);
  } else if ((f & O.CREAT) && (f & O.EXCL)) {
    fail(E.EXIST);
  }
  if (node.isLink) fail(E.LOOP);
  if ((f & O.DIRECTORY) && !node.isDir) fail(E.NOTDIR);
  // The controlling terminal is the console, where the console is one.
  if (node instanceof Device && node.rdev === 0x500) {
    if (!p.kernel.console.interactive) fail(E.NXIO);
    const fd = p.fds.install(new Description('console', {flags: f & (3 | O.NONBLOCK), path: 'tty'}), {cloexec: !!(f & O.CLOEXEC)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  }
  const writing = (f & 3) !== 0;
  if (node.isDir && writing) fail(E.ISDIR);
  if (node.isFile && writing && (f & O.TRUNC)) node.truncate(0);
  // A named pipe: read, write or both ends of the one pipe its opens share. As on Linux, a reader waits for a writer
  // and a writer for a reader, each there from the moment its open began (so two waiting opens meet); O_RDWR and a
  // non-blocking reader do not wait, and a non-blocking writer with no reader is ENXIO.
  if (node instanceof Fifo) {
    const me = p; // the process whose open waits (a retry may be made from elsewhere than its thread)
    node.pending ??= new Map();
    let d = node.pending.get(me);
    if (!d) {
      if (!node.pipe || (!node.pipe.readers && !node.pipe.writers)) node.pipe = Object.assign(new Pipe(), {readOpens: 0, writeOpens: 0});
      const access = f & 3, kind = access === 0 ? 'pipe-r' : access === 1 ? 'pipe-w' : 'pipe-rw';
      if (kind === 'pipe-w' && (f & O.NONBLOCK) && !node.pipe.readers) fail(E.NXIO);
      // What each side waits for is an open of the other since it began (Linux's r_counter and w_counter): a writer
      // that came, wrote and went while a reader waited still lets it go on, to what it wrote.
      d = new Description(kind, {pipe: node.pipe, flags: f & (3 | O.NONBLOCK), path: name});
      d.seen = {reads: node.pipe.readOpens, writes: node.pipe.writeOpens};
      if (kind !== 'pipe-w') node.pipe.readOpens++;
      if (kind !== 'pipe-r') node.pipe.writeOpens++;
    }
    const met = d.kind === 'pipe-rw' || (f & O.NONBLOCK) || (d.kind === 'pipe-r' ? d.pipe.writers || d.pipe.writeOpens !== d.seen.writes : d.pipe.readers || d.pipe.readOpens !== d.seen.reads);
    if (!met) { node.pending.set(me, d); d.pipe.changes++; p.kernel.dirty = true; throw new Wait(); }
    node.pending.delete(me);
    d.pipe.changes++;
    p.kernel.dirty = true;
    const fd = p.fds.install(d, {cloexec: !!(f & O.CLOEXEC)});
    if (fd < 0) fail(E.MFILE);
    return fd;
  }
  // /proc's files are read as they are when opened.
  if (node.snapshot) node = node.snapshot();
  const kind = node.isDir ? 'dir' : node instanceof Device ? 'device' : 'file';
  const full = p.kernel.vfs.realpath(name, base(p, dirfd));
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
function background(p) {
  const k = p.kernel;
  if (!k.console.interactive || p.sid !== k.tty.sid || p.pgid === k.tty.fg) return false;
  if (actionOf(p, SIG.TTIN).handler === 1n || p.task.mask & bit(SIG.TTIN)) fail(E.IO);
  for (const q of k.group(p.pgid)) send(k, q, SIG.TTIN, {code: SI.KERNEL});
  return true;
}

/** Bytes read from `d` into `into` at `at` (a view of guest memory, or a buffer readv scatters). */
function readTo(p, d, into, at, length, offset = null) {
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
      const pipe = d.pipe;
      if (pipe.size) return pipe.readInto(into, at, length);
      // Empty with no writer left: the end of the data.
      if (!pipe.writers) return 0;
      if (nonblock) fail(E.AGAIN);
      throw new Wait();
    }
    case 'eventfd': {
      if (length < 8) fail(E.INVAL);
      const e = d.event;
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
      const data = d.node.readDevice(length);
      into.set(data, at);
      return data.length;
    }
    case 'file': {
      if ((d.flags & 3) === O.WRONLY) fail(E.BADF);
      const from = offset ?? d.offset;
      const data = d.node.read(from, from + length);
      into.set(data, at);
      if (offset === null) d.offset += data.length;
      return data.length;
    }
    case 'dir': fail(E.ISDIR);
  }
  fail(E.BADF);
}

const readInto = (p, d, address, length, offset = null) => readTo(p, d, p.bytes, address, length, offset);

/**
 * Write `data` to `d`. A pipe takes what fits; a writer finding it full
 * waits for a reader to make room (what it moved so far is the call's, in
 * state.done, and is its value if a handler interrupts it). A write of at
 * most PIPE_BUF bytes lands whole. With no reader left: SIGPIPE, and EPIPE.
 */
function writeData(p, d, data, offset = null) {
  const length = data.length, nonblock = d.flags & O.NONBLOCK;
  switch (d.kind) {
    case 'console': p.kernel.console.write(d.path === 'stderr' ? 2 : 1, data.slice()); return length;
    case 'pipe-w': case 'pipe-rw': {
      const pipe = d.pipe, s = p.call.state;
      const done = s.done ?? 0;
      if (!pipe.readers) {
        send(p.kernel, p, SIG.PIPE, {code: SI.USER, pid: p.pid, uid: 0}, p.task);
        if (done) return done;
        fail(E.PIPE);
      }
      if (length <= PIPE_BUF && !pipe.fits(length)) {
        if (nonblock) fail(E.AGAIN);
        throw new Wait();
      }
      const wrote = done + pipe.write(data.subarray(done));
      if (wrote === length) return length;
      if (nonblock) { if (wrote) return wrote; fail(E.AGAIN); }
      // What it wrote may be what a reader waits for.
      if (wrote > done) p.kernel.dirty = true;
      s.done = wrote;
      throw new Wait();
    }
    case 'eventfd': {
      if (length < 8) fail(E.INVAL);
      const n = new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true), e = d.event;
      if (n === 0xffffffffffffffffn) fail(E.INVAL);
      if (e.count + n > 0xfffffffffffffffen) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
      e.count += n;
      e.changes++;
      return 8;
    }
    case 'device': return d.node.writeDevice(data);
    case 'file': {
      if ((d.flags & 3) === 0) fail(E.BADF);
      const at = offset ?? (d.flags & O.APPEND ? d.node.size : d.offset);
      d.node.write(at, data);
      if (offset === null) d.offset = at + length;
      return length;
    }
  }
  fail(E.BADF);
}

const writeFrom = (p, d, address, length, offset = null) => writeData(p, d, p.bytes.subarray(address, address + length), offset);
function descriptor(p, fd) {
  const d = p.fds.get(N(fd));
  if (!d) fail(E.BADF);
  return d;
}

/** The (base, length) pairs of an iovec array. */
function vectors(p, address, count) {
  if (N(count) < 0 || N(count) > 1024) fail(E.INVAL);
  const out = [];
  for (let k = 0; k < N(count); k++) {
    const at = N(address) + k * 16;
    out.push([Number(p.view.getBigUint64(at, true)), Number(p.view.getBigUint64(at + 8, true))]);
  }
  return out;
}

/** readv: one read for all of it (so a pipe or the console waits once), scattered. */
function readv(p, d, address, count, offset = null) {
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
function writev(p, d, address, count, offset = null) {
  const parts = vectors(p, address, count), total = parts.reduce((n, [, l]) => n + l, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const [b, l] of parts) { buf.set(p.bytes.subarray(b, b + l), at); at += l; }
  return writeData(p, d, buf, offset);
}
function iov(p, address, count, each) {
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

function remove(p, dirfd, address, directory) {
  const r = p.kernel.vfs.resolve(path(p, address), base(p, dirfd), false);
  if (!r.node) fail(E.NOENT);
  if (directory) {
    if (!r.node.isDir) fail(E.NOTDIR);
    if (r.node.entries.size) fail(E.NOTEMPTY);
  } else if (r.node.isDir) {
    fail(E.ISDIR);
  }
  r.parent.entries.delete(r.name);
  return 0;
}

function makeDir(p, dirfd, address, mode) {
  const r = p.kernel.vfs.resolve(path(p, address), base(p, dirfd), false);
  if (r.node) fail(E.EXIST);
  r.parent.entries.set(r.name, new Dir(N(mode) & ~p.umask & 0o7777));
  r.parent.nlink++;
  return 0;
}

function rename(p, olddir, oldaddr, newdir, newaddr) {
  const vfs = p.kernel.vfs;
  const from = vfs.resolve(path(p, oldaddr), base(p, olddir), false);
  if (!from.node) fail(E.NOENT);
  const to = vfs.resolve(path(p, newaddr), base(p, newdir), false);
  if (to.node?.isDir && !from.node.isDir) fail(E.ISDIR);
  if (to.node?.isDir && to.node.entries.size) fail(E.NOTEMPTY);
  from.parent.entries.delete(from.name);
  to.parent.entries.set(to.name, from.node);
  return 0;
}

function readlink(p, dirfd, address, buf, size) {
  const node = p.kernel.vfs.lookup(path(p, address), base(p, dirfd), false);
  if (!node.isLink) fail(E.INVAL);
  const bytes = enc.encode(node.target).subarray(0, N(size));
  p.bytes.set(bytes, N(buf));
  return bytes.length;
}

function getdents(p, fd, buf, count) {
  const d = descriptor(p, fd);
  if (d.kind !== 'dir') fail(E.NOTDIR);
  // Linux leaves the order unspecified; name order keeps listings readable.
  const names = ['.', '..', ...[...d.node.entries.keys()].sort()];
  let at = N(buf);
  const end = at + N(count);
  while (d.offset < names.length) {
    const name = names[d.offset];
    const node = name === '.' || name === '..' ? d.node : d.node.entries.get(name);
    const bytes = enc.encode(name);
    const reclen = (19 + bytes.length + 1 + 7) & ~7;
    if (at + reclen > end) break;
    const v = p.view;
    v.setBigUint64(at, BigInt(node.ino), true);
    v.setBigInt64(at + 8, BigInt(d.offset + 1), true);
    v.setUint16(at + 16, reclen, true);
    v.setUint8(at + 18, node.isDir ? 4 : node.isLink ? 10 : node instanceof Device ? 2 : 8);
    p.bytes.set(bytes, at + 19);
    p.bytes.fill(0, at + 19 + bytes.length, at + reclen);
    at += reclen;
    d.offset++;
  }
  return at - N(buf);
}

function access(p, dirfd, address) {
  p.kernel.vfs.lookup(path(p, address), base(p, dirfd));
  return 0;
}

/** mknod: a named pipe or an empty regular file where nothing is; a device is not made here (EPERM). */
function makeNode(p, dirfd, address, mode) {
  const r = p.kernel.vfs.resolve(path(p, address), base(p, dirfd), false);
  if (r.node) fail(E.EXIST);
  if (!r.parent.isDir) fail(E.NOTDIR);
  const m = N(mode), perm = m & ~p.umask & 0o7777, type = m & 0o170000;
  if (type === S_IFIFO) r.parent.entries.set(r.name, new Fifo(perm));
  else if (type === 0 || type === 0o100000) r.parent.entries.set(r.name, new File(new Uint8Array(0), perm));
  else fail(E.PERM);
  return 0;
}

function pipe(p, address, flags) {
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
function readiness(p, d) {
  let r;
  switch (d.kind) {
    case 'pipe-r': r = (d.pipe.size ? POLL.IN : 0) | (d.pipe.writers ? 0 : POLL.HUP); break;
    case 'pipe-w': r = d.pipe.readers ? (d.pipe.writable ? POLL.OUT : 0) : POLL.ERR; break;
    case 'pipe-rw': r = (d.pipe.size ? POLL.IN : 0) | (d.pipe.writable ? POLL.OUT : 0); break;
    case 'console': r = (p.kernel.console.ready?.() ? POLL.IN : 0) | POLL.OUT; break;
    case 'eventfd': r = (d.event.count ? POLL.IN : 0) | (d.event.count < 0xfffffffffffffffen ? POLL.OUT : 0); break;
    case 'epoll': r = epollReady(p, d, 1).length ? POLL.IN : 0; break;
    default: r = POLL.IN | POLL.OUT;
  }
  if (r & POLL.IN) r |= POLL.RDNORM;
  if (r & POLL.OUT) r |= POLL.WRNORM;
  return r;
}

/** A counter that moves whenever `d`'s readiness may have (epoll's edge). */
const changes = (p, d) => d.pipe?.changes ?? d.event?.changes ?? (d.kind === 'console' ? p.kernel.inputs ?? 0 : 0);

/** The calling thread's mask is `set` while the call waits (ppoll, pselect6, epoll_pwait), as rt_sigsuspend does. */
function swapMask(p, address) {
  const s = p.call.state, t = p.task;
  if (!address || s.swapped) return;
  s.swapped = true;
  t.savedMask = t.mask;
  t.mask = p.view.getBigUint64(address, true) & ~UNBLOCKABLE;
  // One it lets through that is pending already interrupts the call at once.
  if (deliverable(t)) fail(E.INTR);
}

/** The call is done without a handler: its mask is as before. */
function restoreMask(p) {
  const s = p.call.state, t = p.task;
  if (s.swapped && t.savedMask !== null) { t.mask = t.savedMask; t.savedMask = null; }
}

/** Wait for a timeout of `ms` (null: none) from the first time the call was made; true once it is over. */
function timedOut(p, ms) {
  const s = p.call.state;
  if (ms === null) return false;
  s.deadline ??= performance.now() + ms;
  return performance.now() >= s.deadline;
}

/** poll/ppoll. With nothing ready and a timeout other than 0 the call waits, like a blocking read. */
function poll(p, address, count, timeout, mask = 0) {
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
function select(p, nfds, sets, timeout, mask = 0) {
  const n = N(nfds);
  if (n < 0 || n > 1024) fail(E.INVAL);
  swapMask(p, mask);
  const words = Math.ceil(n / 64), v = p.view;
  const read = (at) => Array.from({length: words}, (_, k) => (at ? v.getBigUint64(at + k * 8, true) : 0n));
  const want = sets.map((a) => read(N(a)));
  const got = want.map(() => new Array(words).fill(0n));
  let ready = 0;
  for (let fd = 0; fd < n; fd++) {
    const w = BigInt(fd % 64), k = fd >> 6, asked = want.map((set) => (set[k] >> w) & 1n);
    if (!asked.some((x) => x)) continue;
    const d = p.fds.get(fd);
    if (!d) fail(E.BADF);
    const r = readiness(p, d);
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
function epollReady(p, ep, max) {
  const out = [];
  for (const [fd, e] of ep.interest) {
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

function epollCtl(p, epfd, op, fd, event) {
  const ep = descriptor(p, epfd);
  if (ep.kind !== 'epoll') fail(E.INVAL);
  const d = descriptor(p, fd), o = N(op), key = N(fd);
  if (d === ep) fail(E.INVAL);
  if (d.kind === 'file' || d.kind === 'dir') fail(E.PERM); // a regular file is always ready: Linux will not watch it
  const read = () => ({events: p.view.getUint32(N(event), true) | 0, data: p.view.getBigUint64(N(event) + 4, true)});
  if (o === 1) { // ADD
    if (ep.interest.has(key)) fail(E.EXIST);
    ep.interest.set(key, {desc: d, ...read(), seen: -1, off: false});
  } else if (o === 2) { // DEL
    if (!ep.interest.delete(key)) fail(E.NOENT);
  } else if (o === 3) { // MOD
    const e = ep.interest.get(key);
    if (!e) fail(E.NOENT);
    Object.assign(e, read(), {seen: -1, off: false});
  } else fail(E.INVAL);
  return 0;
}

function epollWait(p, epfd, events, max, timeout, mask = 0) {
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

function epollCreate(p, flags) {
  const d = new Description('epoll', {flags: 0});
  d.interest = new Map();
  const fd = p.fds.install(d, {cloexec: !!(flags & O.CLOEXEC)});
  if (fd < 0) fail(E.MFILE);
  return fd;
}

function eventfd(p, initval, flags) {
  const d = new Description('eventfd', {flags: O.RDWR | (flags & O.NONBLOCK)});
  d.event = {count: BigInt.asUintN(32, BigInt(initval)), semaphore: !!(flags & 1), changes: 0};
  const fd = p.fds.install(d, {cloexec: !!(flags & O.CLOEXEC)});
  if (fd < 0) fail(E.MFILE);
  return fd;
}

/** A timespec at `at` as milliseconds (null: none given, so no timeout). */
const timespecMs = (p, at) => (at ? Number(p.view.getBigInt64(at, true)) * 1000 + Number(p.view.getBigInt64(at + 8, true)) / 1e6 : null);
/** A timeval at `at` as milliseconds. */
const timevalMs = (p, at) => (at ? Number(p.view.getBigInt64(at, true)) * 1000 + Number(p.view.getBigInt64(at + 8, true)) / 1e3 : null);

/**
 * The console as a terminal, where it says it is one: canonical input with
 * no echo (what is typed comes in lines and the page shows it), so a line
 * editor (BusyBox's) reads lines plainly; signals from keys (ISIG).
 */
const TERMIOS = {iflag: 0x500, oflag: 0x5, cflag: 0xbf, lflag: 0x8003};

function ioctl(p, d, request, arg) {
  const k = p.kernel, r = request, v = p.view;
  if (r === 0x5421) { // FIONBIO
    if (v.getInt32(arg, true)) d.flags |= O.NONBLOCK; else d.flags &= ~O.NONBLOCK;
    return 0;
  }
  if (r === 0x5451 || r === 0x5450) return 0; // FIOCLEX, FIONCLEX (the table's: done by fcntl too)
  if (r === 0x541b) { // FIONREAD
    const n = d.kind === 'pipe-r' || d.kind === 'pipe-rw' ? d.pipe.size : d.kind === 'console' ? k.console.pending?.() ?? 0 : d.kind === 'file' ? Math.max(0, d.node.size - d.offset) : null;
    if (n === null) fail(E.NOTTY);
    v.setInt32(arg, n, true);
    return 0;
  }
  // The rest are a terminal's, and only the console is one (when it says it is interactive).
  if (d.kind !== 'console' || !k.console.interactive) fail(E.NOTTY);
  k.tty.termios ??= {...TERMIOS, cc: new Uint8Array([3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0])};
  const tio = k.tty.termios;
  switch (r) {
    case 0x5401: // TCGETS
      p.bytes.fill(0, arg, arg + 36);
      v.setUint32(arg, tio.iflag, true); v.setUint32(arg + 4, tio.oflag, true);
      v.setUint32(arg + 8, tio.cflag, true); v.setUint32(arg + 12, tio.lflag, true);
      p.bytes.set(tio.cc, arg + 17);
      return 0;
    case 0x5402: case 0x5403: case 0x5404: // TCSETS, TCSETSW, TCSETSF
      tio.iflag = v.getUint32(arg, true); tio.oflag = v.getUint32(arg + 4, true);
      tio.cflag = v.getUint32(arg + 8, true); tio.lflag = v.getUint32(arg + 12, true);
      tio.cc = p.bytes.slice(arg + 17, arg + 36);
      return 0;
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
      if (!k.live().some((q) => q.pgid === g && q.sid === p.sid)) fail(E.PERM);
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
  fail(E.NOTTY);
}
function dup(p, oldfd, newfd, cloexec) {
  const d = descriptor(p, oldfd);
  return p.fds.install(d, {fd: newfd, cloexec});
}

export const FILE_CALLS = {
  0(fd, buf, len) { return readInto(this, descriptor(this, fd), N(buf), N(len)); },
  23(nfds, r, w, e, tv) { // select, which says what time was left
    const ms = timevalMs(this, N(tv)), s = this.call.state;
    const n = select(this, nfds, [r, w, e], ms ?? -1);
    if (N(tv) && ms !== null) {
      const left = Math.max(0, (s.deadline ?? performance.now()) - performance.now());
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
  4(name, st) { return writeStat(this, st, this.kernel.vfs.lookup(path(this, name), this.cwd)); },
  5(fd, st) { return writeStat(this, st, describe(descriptor(this, fd))); },
  6(name, st) { return writeStat(this, st, this.kernel.vfs.lookup(path(this, name), this.cwd, false)); },
  7(fds, count, timeout) { return poll(this, fds, count, Number(BigInt.asIntN(32, timeout))); },
  271(fds, count, spec, mask) { return poll(this, fds, count, timespecMs(this, N(spec)) ?? -1, N(mask)); },
  8(fd, offset, whence) {
    const d = descriptor(this, fd);
    if (d.kind === 'pipe-r' || d.kind === 'pipe-w' || d.kind === 'pipe-rw' || d.kind === 'console') fail(E.SPIPE);
    if (d.kind === 'dir') { if (N(offset) === 0 && N(whence) === 0) { d.offset = 0; return 0; } fail(E.INVAL); }
    const start = [0, d.offset, d.node.size ?? 0][N(whence)];
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
  21(name) { return access(this, BigInt(AT_FDCWD), name); },
  22(fds) { return pipe(this, fds, 0n); },
  32(fd) { const d = descriptor(this, fd); return this.fds.install(d); },
  33(oldfd, newfd) { if (N(oldfd) === N(newfd)) { descriptor(this, oldfd); return N(newfd); } return dup(this, oldfd, N(newfd), false); },
  72(fd, cmd, arg) {
    const d = descriptor(this, fd), c = N(cmd);
    if (c === 0 || c === 1030) { // F_DUPFD, F_DUPFD_CLOEXEC
      const target = this.fds.lowest(N(arg));
      if (target < 0) fail(E.MFILE);
      return this.fds.install(d, {fd: target, cloexec: c === 1030});
    }
    if (c === 1) return this.fds.cloexec(N(fd)) ? 1 : 0;
    if (c === 2) { this.fds.setCloexec(N(fd), (N(arg) & 1) === 1); return 0; }
    if (c === 3) return d.flags;
    if (c === 4) { d.flags = (d.flags & ~(O.APPEND | O.NONBLOCK)) | (N(arg) & (O.APPEND | O.NONBLOCK)); return 0; }
    if (c === 1032) { if (!d.pipe) fail(E.BADF); return d.pipe.capacity; } // F_GETPIPE_SZ
    if (c === 1031) { // F_SETPIPE_SZ
      if (!d.pipe) fail(E.BADF);
      const n = d.pipe.resize(N(arg));
      if (n === -1) fail(E.PERM);
      if (n === -2) fail(E.BUSY);
      return n;
    }
    return 0; // locks and the rest succeed trivially
  },

  73() { return 0; }, 74() { return 0; }, 75() { return 0; },
  76(name, length) { const node = this.kernel.vfs.lookup(path(this, name), this.cwd); if (!node.isFile) fail(E.INVAL); node.truncate(N(length)); return 0; },
  77(fd, length) { const d = descriptor(this, fd); if (d.kind !== 'file') fail(E.INVAL); d.node.truncate(N(length)); return 0; },
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
  92() { return 0; }, 93() { return 0; }, 94() { return 0; },
  95(mask) { const old = this.umask; this.umask = N(mask) & 0o777; return old; },
  // utime, utimes, futimesat, utimensat: the times of a file that is there (ENOENT for one that is not, which
  // is how touch knows to make it).
  133(name, mode, dev) { return makeNode(this, BigInt(AT_FDCWD), name, mode); },
  259(dirfd, name, mode, dev) { return makeNode(this, dirfd, name, mode); },
  132(name, buf) {
    const n = this.kernel.vfs.lookup(path(this, name), this.cwd);
    if (!N(buf)) return setTimes(n, 'now', 'now');
    const t = (off) => [Number(this.view.getBigInt64(N(buf) + off, true)), 0];
    return setTimes(n, t(0), t(8));
  },
  235(name, tv) { const [a, m] = timevals(this, tv); return setTimes(this.kernel.vfs.lookup(path(this, name), this.cwd), a, m); },
  261(dirfd, name, tv) { const [a, m] = timevals(this, tv); return setTimes(timed(this, dirfd, name, true), a, m); },
  280(dirfd, name, ts, flags) {
    const [a, m] = timespecs(this, ts);
    return setTimes(timed(this, dirfd, name, !(N(flags) & AT.SYMLINK_NOFOLLOW)), a, m);
  },
  137(name, buf) { this.bytes.fill(0, N(buf), N(buf) + 120); return 0; },
  138(fd, buf) { this.bytes.fill(0, N(buf), N(buf) + 120); return 0; },
  217(fd, buf, count) { return getdents(this, fd, buf, count); },
  257(dirfd, name, flags, mode) { return openAt(this, dirfd, name, flags, mode); },
  258(dirfd, name, mode) { return makeDir(this, dirfd, name, mode); },
  260() { return 0; },
  262(dirfd, name, st, flags) {
    if ((N(flags) & AT.EMPTY_PATH) && !this.bytes[N(name)]) return writeStat(this, st, describe(descriptor(this, dirfd)));
    return writeStat(this, st, this.kernel.vfs.lookup(path(this, name), base(this, dirfd), !(N(flags) & AT.SYMLINK_NOFOLLOW)));
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
  269(dirfd, name) { return access(this, dirfd, name); },
  292(oldfd, newfd, flags) { if (N(oldfd) === N(newfd)) fail(E.INVAL); return dup(this, oldfd, N(newfd), (N(flags) & O.CLOEXEC) !== 0); },
  293(fds, flags) { return pipe(this, fds, flags); },
  316(od, oa, nd, na) { return rename(this, od, oa, nd, na); },
  332() { fail(E.NOSYS); },
  439(dirfd, name) { return access(this, dirfd, name); },
};
