// File, directory, descriptor and pipe system calls. Handlers run with
// `this` bound to the calling Process and throw FsError for errno results.

import {Description, Pipe} from './fd.mjs';
import {Dir, Device, E, File, FsError, Link, S_IFIFO} from './fs.mjs';
import {Wait} from './process.mjs';

const AT_FDCWD = -100;
const O = {WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, TRUNC: 0x200, APPEND: 0x400, NONBLOCK: 0x800,
  DIRECTORY: 0x10000, NOFOLLOW: 0x20000, CLOEXEC: 0x80000};
const AT = {SYMLINK_NOFOLLOW: 0x100, REMOVEDIR: 0x200, EMPTY_PATH: 0x1000};
const PIPE_LIMIT = 64 << 20;

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
  const s = BigInt(Math.floor(node.mtime / 1000)), ns = BigInt((node.mtime % 1000) * 1e6);
  for (const off of [72, 88, 104]) { v.setBigInt64(at + off, s, true); v.setBigInt64(at + off + 8, ns, true); }
  return 0;
}

function describe(d) {
  // Something to stat for a descriptor without a node.
  if (d.node) return d.node;
  if (d.kind === 'pipe-r' || d.kind === 'pipe-w') return {mode: S_IFIFO | 0o600, ino: 0, nlink: 1, uid: 0, gid: 0, mtime: Date.now(), isFile: false, isDir: false, isLink: false};
  return {mode: 0o020620, ino: 0, nlink: 1, uid: 0, gid: 0, rdev: 0x8800, mtime: Date.now(), isFile: false, isDir: false, isLink: false};
}

function openAt(p, dirfd, address, flags, mode) {
  const f = N(flags), name = path(p, address);
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
  const writing = (f & 3) !== 0;
  if (node.isDir && writing) fail(E.ISDIR);
  if (node.isFile && writing && (f & O.TRUNC)) node.truncate(0);
  const kind = node.isDir ? 'dir' : node instanceof Device ? 'device' : 'file';
  const full = p.kernel.vfs.realpath(name, base(p, dirfd));
  const d = new Description(kind, {node, flags: f, path: full});
  const fd = p.fds.install(d, {cloexec: !!(f & O.CLOEXEC)});
  if (fd < 0) fail(E.MFILE);
  return fd;
}

function readInto(p, d, address, length, offset = null) {
  if (length === 0) return 0;
  switch (d.kind) {
    case 'console': {
      // null: nothing typed yet, so wait and restart this read later.
      const data = p.kernel.console.read(length);
      if (data === null) throw new Wait();
      p.bytes.set(data, address);
      return data.length;
    }
    case 'pipe-r': {
      // Writers finished before we run, so empty means end of data.
      const data = d.pipe.read(length);
      p.bytes.set(data, address);
      return data.length;
    }
    case 'device': {
      const data = d.node.readDevice(length);
      p.bytes.set(data, address);
      return data.length;
    }
    case 'file': {
      if ((d.flags & 3) === O.WRONLY) fail(E.BADF);
      const at = offset ?? d.offset;
      const data = d.node.read(at, at + length);
      p.bytes.set(data, address);
      if (offset === null) d.offset += data.length;
      return data.length;
    }
    case 'dir': fail(E.ISDIR);
  }
  fail(E.BADF);
}

function writeFrom(p, d, address, length, offset = null) {
  const data = p.bytes.subarray(address, address + length);
  switch (d.kind) {
    case 'console': p.kernel.console.write(d.path === 'stderr' ? 2 : 1, data.slice()); return length;
    case 'pipe-w':
      if (d.pipe.readers === 0 || d.pipe.size + length > PIPE_LIMIT) fail(E.PIPE);
      d.pipe.write(data);
      return length;
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

function descriptor(p, fd) {
  const d = p.fds.get(N(fd));
  if (!d) fail(E.BADF);
  return d;
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

function pipe(p, address, flags) {
  const pipe = new Pipe();
  const cloexec = !!(N(flags) & O.CLOEXEC);
  const r = p.fds.install(new Description('pipe-r', {pipe}), {cloexec});
  const w = p.fds.install(new Description('pipe-w', {pipe}), {cloexec});
  p.view.setInt32(N(address), r, true);
  p.view.setInt32(N(address) + 4, w, true);
  return 0;
}

function dup(p, oldfd, newfd, cloexec) {
  const d = descriptor(p, oldfd);
  return p.fds.install(d, {fd: newfd, cloexec});
}

export const FILE_CALLS = {
  0(fd, buf, len) { return readInto(this, descriptor(this, fd), N(buf), N(len)); },
  1(fd, buf, len) { return writeFrom(this, descriptor(this, fd), N(buf), N(len)); },
  2(name, flags, mode) { return openAt(this, BigInt(AT_FDCWD), name, flags, mode); },
  3(fd) { if (!this.fds.close(N(fd))) fail(E.BADF); return 0; },
  4(name, st) { return writeStat(this, st, this.kernel.vfs.lookup(path(this, name), this.cwd)); },
  5(fd, st) { return writeStat(this, st, describe(descriptor(this, fd))); },
  6(name, st) { return writeStat(this, st, this.kernel.vfs.lookup(path(this, name), this.cwd, false)); },
  8(fd, offset, whence) {
    const d = descriptor(this, fd);
    if (d.kind === 'pipe-r' || d.kind === 'pipe-w' || d.kind === 'console') fail(E.SPIPE);
    if (d.kind === 'dir') { if (N(offset) === 0 && N(whence) === 0) { d.offset = 0; return 0; } fail(E.INVAL); }
    const start = [0, d.offset, d.node.size ?? 0][N(whence)];
    if (start === undefined || start + N(offset) < 0) fail(E.INVAL);
    d.offset = start + N(offset);
    return d.offset;
  },
  16(fd, request, arg) {
    const d = descriptor(this, fd);
    // TCGETS/TIOCGWINSZ only answer for an interactive console.
    if (d.kind !== 'console' || !this.kernel.console.interactive) fail(E.NOTTY);
    const r = N(request);
    if (r === 0x5413) { // TIOCGWINSZ
      this.view.setUint16(N(arg), this.kernel.console.rows ?? 24, true);
      this.view.setUint16(N(arg) + 2, this.kernel.console.cols ?? 80, true);
      return 0;
    }
    if (r === 0x5401) { this.bytes.fill(0, N(arg), N(arg) + 60); return 0; } // TCGETS
    if (r === 0x5402 || r === 0x5403 || r === 0x5404) return 0; // TCSETS*
    if (r === 0x540f) { this.view.setInt32(N(arg), this.pgid, true); return 0; } // TIOCGPGRP
    if (r === 0x5410) return 0; // TIOCSPGRP
    fail(E.NOTTY);
  },
  17(fd, buf, len, off) { return readInto(this, descriptor(this, fd), N(buf), N(len), N(off)); },
  18(fd, buf, len, off) { return writeFrom(this, descriptor(this, fd), N(buf), N(len), N(off)); },
  19(fd, vec, count) { const d = descriptor(this, fd); return iov(this, vec, count, (b, l) => readInto(this, d, b, l)); },
  20(fd, vec, count) { const d = descriptor(this, fd); return iov(this, vec, count, (b, l) => writeFrom(this, d, b, l)); },
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
  132() { return 0; }, 235() { return 0; }, 280() { return 0; },
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
