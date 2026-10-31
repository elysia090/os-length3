// Local sockets (AF_UNIX): the machine's own channels between its processes, as Linux has them, all of them in this
// kernel (nothing goes out): socketpair, and sockets named by a path (bind, listen, connect, accept) or in the
// abstract namespace; stream, datagram and sequenced packets; send and recv, sendmsg and recvmsg with descriptors
// passed (SCM_RIGHTS) and credentials (SCM_CREDENTIALS, SO_PEERCRED). The internet's families are what a browser does
// not give a page (no raw TCP or UDP): a program is told they are not there (EAFNOSUPPORT), as by a host built
// without them, not that the call does not exist.
//
// A connected stream is two pipes (fd.mjs), one each way: each end reads its own and writes its peer's. So what a
// pipe does, a stream does as Linux's: a full one makes the writer wait and an empty one the reader, the last writer
// gone is the end of the data and the last reader gone EPIPE (and SIGPIPE, unless MSG_NOSIGNAL). Datagrams and
// packets keep their bounds in a queue of messages (Messages), each read whole or cut (MSG_TRUNC).
//
// Read, write, readv, writev, poll, select and epoll reach a socket through sys-file.mjs (read, write, ready,
// changes, below); its last descriptor closed, Description.release closes it.

import {Description, Pipe} from './fd.mjs';
import {E, FsError, SocketName, S_IFSOCK} from './fs.mjs';
import {Wait} from './process.mjs';
import {SIG, SI, send} from './signal.mjs';

const N = (x) => Number(BigInt.asIntN(64, x));
const fail = (errno) => { throw new FsError(errno); };
// (Those fs.mjs does not name, as Linux numbers them.)
const ERR = {PROTOTYPE: 91, NOPROTOOPT: 92, PROTONOSUPPORT: 93, SOCKTNOSUPPORT: 94, ADDRINUSE: 98, NOTSOCK: 88,
  MSGSIZE: 90, ISCONN: 106, NOTCONN: 107, CONNREFUSED: 111};

const AF = {UNIX: 1};
const SOCK = {STREAM: 1, DGRAM: 2, SEQPACKET: 5, NONBLOCK: 0x800, CLOEXEC: 0x80000};
const MSG = {PEEK: 2, CTRUNC: 8, TRUNC: 0x20, DONTWAIT: 0x40, WAITALL: 0x100, NOSIGNAL: 0x4000, CMSG_CLOEXEC: 0x40000000};
const SOL_SOCKET = 1, SCM = {RIGHTS: 1, CREDENTIALS: 2};
const SO = {TYPE: 3, ERROR: 4, SNDBUF: 7, RCVBUF: 8, PASSCRED: 16, PEERCRED: 17, ACCEPTCONN: 30, PROTOCOL: 38, DOMAIN: 39};
const O_NONBLOCK = 0x800;
const POLL = {IN: 1, OUT: 4, ERR: 8, HUP: 0x10, RDHUP: 0x2000};

/** What one end of a stream may have on its way to it (Linux's default socket buffer is about this), in pipe pages. */
const STREAM_ROOM = 256 << 10;
/** What a datagram or packet queue holds before a sender waits, in bytes and in messages. */
const MESSAGE_ROOM = 212992, MESSAGES = 512;
/** Descriptors one message may carry (SCM_MAX_FD). */
const RIGHTS_MOST = 253;

let inodes = 1;

/** Datagrams or packets one way, each whole: what a stream's pipe is to its bytes. */
class Messages {
  constructor() {
    this.list = []; // {bytes, from (the sender's name, or null), rights: [Description], creds}
    this.size = 0;
    this.readers = 0;
    this.writers = 0;
    this.changes = 0;
  }
  get capacity() { return MESSAGE_ROOM; }
  /** One of `n` bytes goes in now (one always does into an empty queue). */
  fits(n) { return !this.list.length || (this.list.length < MESSAGES && this.size + n <= MESSAGE_ROOM); }
  get writable() { return this.fits(1); }
  push(m) { this.list.push(m); this.size += m.bytes.length; this.changes++; }
  shift() { const m = this.list.shift(); this.size -= m.bytes.length; this.changes++; return m; }
}

/** One socket: its kind, its name, what comes to it, and the end it is connected to. */
class Endpoint {
  constructor(kernel, type, proc) {
    this.kernel = kernel;
    this.type = type;
    this.state = 'unconnected'; // | 'listening' | 'connected'
    this.rx = type === SOCK.STREAM ? new Pipe(STREAM_ROOM) : new Messages();
    this.rx.readers = 1;
    this.peer = null;
    this.name = null; // the address it is bound to (sockaddr_un's path bytes), or null
    this.peerName = null; // the address of the one it connected to
    this.node = null; // the SocketName on the path it is bound to
    this.abstract = null; // its key in the abstract namespace
    this.backlog = []; // connections a listener has not accepted yet: their server ends
    this.backlogMost = 0;
    this.shut = {rd: false, wr: false};
    this.creds = {pid: proc.pid, uid: 0, gid: 0};
    this.passcred = false;
    this.events = 0; // what else moves its readiness (a connection to accept, its peer closing)
    this.closed = false;
    this.ino = inodes++;
    // A stream's descriptors in flight (SCM_RIGHTS), each with the byte of the stream it came with.
    this.rights = [];
    this.arrived = 0; // bytes of the stream written to it so far
    this.consumed = 0; // and read
  }
  get stream() { return this.type === SOCK.STREAM; }
  /** Moves whenever its readiness may have (epoll's edge). */
  get changes() { return this.rx.changes + this.events + (this.peer ? this.peer.rx.changes : 0); }

  /** Its last descriptor closed: its peer sees the end, what it held in flight is let go, its name is free. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.shut.rd) this.rx.readers--;
    this.rx.changes++;
    const peer = this.peer;
    if (peer && peer.peer === this) {
      if (!this.shut.wr) peer.rx.writers--;
      peer.rx.changes++;
      peer.events++;
    }
    for (const r of this.rights) for (const d of r.descs) d.release();
    this.rights = [];
    for (const m of this.rx.list ?? []) for (const d of m.rights) d.release();
    for (const s of this.backlog) s.close();
    this.backlog = [];
    if (this.abstract !== null && this.kernel.abstractSockets?.get(this.abstract) === this) this.kernel.abstractSockets.delete(this.abstract);
    // The path stays (as on Linux: unlinked by whoever made it), and connecting to it is refused.
    if (this.node?.endpoint === this) this.node.endpoint = null;
  }
}

/** Two ends of a connection, each reading what the other writes. */
function link(a, b) {
  a.peer = b;
  b.peer = a;
  a.state = b.state = 'connected';
  if (a.type !== SOCK.DGRAM) { a.rx.writers++; b.rx.writers++; }
}

/** The socket of descriptor `fd`. */
function socketOf(p, fd) {
  const d = p.fds.get(N(fd));
  if (!d) fail(E.BADF);
  if (d.kind !== 'socket') fail(ERR.NOTSOCK);
  return d;
}

/** A new descriptor for `sock`, as its type's flags say (SOCK_NONBLOCK, SOCK_CLOEXEC). */
function install(p, sock, flags) {
  const d = new Description('socket', {flags: flags & SOCK.NONBLOCK ? O_NONBLOCK : 0});
  d.sock = sock;
  const fd = p.fds.install(d, {cloexec: !!(flags & SOCK.CLOEXEC)});
  if (fd < 0) { sock.close(); fail(E.MFILE); }
  return fd;
}

function typeOf(raw) {
  const type = raw & ~(SOCK.NONBLOCK | SOCK.CLOEXEC);
  if (type !== SOCK.STREAM && type !== SOCK.DGRAM && type !== SOCK.SEQPACKET) fail(ERR.SOCKTNOSUPPORT);
  return type;
}

// ---- addresses ----

/** sockaddr_un at `address` (`length` bytes): {path} for a name on the filesystem, {abstract} for one that is not. */
function readName(p, address, length) {
  const len = N(length);
  if (len < 2 || len > 110) fail(E.INVAL);
  if (p.view.getUint16(N(address), true) !== AF.UNIX) fail(E.INVAL);
  const raw = p.bytes.slice(N(address) + 2, N(address) + len);
  if (!raw.length) fail(E.INVAL);
  if (raw[0] === 0) return {abstract: [...raw.subarray(1)].join(','), bytes: raw};
  const end = raw.indexOf(0);
  const bytes = end < 0 ? raw : raw.subarray(0, end);
  return {path: new TextDecoder().decode(bytes), bytes};
}

/** Write `name` (path bytes, or null for an unnamed socket) as sockaddr_un at `address`, its length to `lengthAt`. */
function writeName(p, address, lengthAt, name) {
  if (!N(address) || !N(lengthAt)) return;
  const have = p.view.getUint32(N(lengthAt), true);
  const full = new Uint8Array(2 + (name ? name.length + (name[0] === 0 ? 0 : 1) : 0));
  full[0] = AF.UNIX;
  if (name) full.set(name, 2);
  p.bytes.set(full.subarray(0, Math.min(have, full.length)), N(address));
  p.view.setUint32(N(lengthAt), full.length, true);
}

/** The socket bound to `name`, or the error connecting to it gives. */
function boundTo(p, name) {
  if (name.abstract !== undefined) {
    const s = p.kernel.abstractSockets?.get(name.abstract);
    if (!s) fail(ERR.CONNREFUSED);
    return s;
  }
  const node = p.kernel.vfs.lookup(name.path, p.cwd);
  if (!(node instanceof SocketName) || !node.endpoint) fail(ERR.CONNREFUSED);
  return node.endpoint;
}

// ---- moving bytes ----

const nonblocking = (d, flags) => !!(d.flags & O_NONBLOCK) || !!(flags & MSG.DONTWAIT);

/** What a pipe holds, copied without taking it (MSG_PEEK). */
function peek(pipe, into, at, n) {
  let done = 0;
  for (const page of pipe.pages) {
    if (done >= n) break;
    const k = Math.min(n - done, page.end - page.start);
    into.set(page.buf.subarray(page.start, page.start + k), at + done);
    done += k;
  }
  return done;
}

/**
 * Up to `length` bytes received by `d` into `into` at `at`: {n, size (the message's whole, for MSG_TRUNC), from (the
 * sender's name), rights, creds}. Waits (Wait) as a read of a pipe does; MSG_WAITALL waits for all of `length` on a
 * stream, what came so far kept in the call's state.
 */
function receive(p, d, into, at, length, flags) {
  const s = d.sock;
  if (s.state === 'listening' || (s.type !== SOCK.DGRAM && s.state !== 'connected')) fail(ERR.NOTCONN);
  if (s.shut.rd) return {n: 0, size: 0, from: null, rights: [], creds: null};
  const wait = () => { if (nonblocking(d, flags)) fail(E.AGAIN); throw new Wait(); };
  if (s.stream) {
    const pipe = s.rx, state = p.call?.state ?? {};
    const done = state.got ?? 0;
    if (!pipe.size) {
      if (!pipe.writers || done) return {n: done, size: done, from: null, rights: [], creds: null};
      wait();
    }
    // A read stops where descriptors came with a later part of the stream (as Linux keeps each send's apart).
    const next = s.rights.find((r) => r.at > s.consumed);
    const most = Math.min(length - done, next ? next.at - s.consumed : Infinity);
    if (flags & MSG.PEEK) return {n: done + peek(pipe, into, at + done, most), size: 0, from: null, rights: [], creds: null};
    const k = pipe.readInto(into, at + done, most);
    const from = s.consumed;
    s.consumed += k;
    const rights = [];
    for (const r of s.rights.filter((x) => x.at >= from && x.at < s.consumed)) { rights.push(...r.descs); s.rights.splice(s.rights.indexOf(r), 1); }
    const got = done + k;
    if ((flags & MSG.WAITALL) && got < length && pipe.writers && !rights.length) { state.got = got; p.kernel.dirty = true; wait(); }
    return {n: got, size: got, from: s.peerName, rights, creds: s.peer?.creds ?? null};
  }
  const q = s.rx;
  if (!q.list.length) {
    // A packet socket's peer gone is its end; a datagram socket waits on.
    if (s.type === SOCK.SEQPACKET && !q.writers) return {n: 0, size: 0, from: null, rights: [], creds: null};
    wait();
  }
  const m = flags & MSG.PEEK ? q.list[0] : q.shift();
  const n = Math.min(length, m.bytes.length);
  into.set(m.bytes.subarray(0, n), at);
  return {n, size: m.bytes.length, from: m.from, rights: flags & MSG.PEEK ? [] : m.rights, creds: m.creds};
}

/** A peer that is gone: SIGPIPE (unless MSG_NOSIGNAL), and EPIPE; what was sent before it counts. */
function broken(p, flags, done) {
  if (!(flags & MSG.NOSIGNAL)) send(p.kernel, p, SIG.PIPE, {code: SI.USER, pid: p.pid, uid: 0}, p.task);
  if (done) return done;
  fail(E.PIPE);
}

/** Send `data` from `d` (to `to`, a name, for a datagram socket not connected), with descriptors `rights`: how much went. */
function transmit(p, d, data, flags, to = null, rights = []) {
  const s = d.sock, wait = () => { if (nonblocking(d, flags)) fail(E.AGAIN); throw new Wait(); };
  const own = () => rights.map((r) => r.retain());
  if (s.type === SOCK.DGRAM) {
    const target = to ? boundTo(p, to) : s.peer;
    if (!target) fail(ERR.NOTCONN);
    if (target.closed) fail(ERR.CONNREFUSED);
    if (target.type !== SOCK.DGRAM) fail(ERR.PROTOTYPE);
    // Connected to another, it takes nothing from this one.
    if (target.peer && target.peer !== s) fail(E.PERM);
    if (data.length > MESSAGE_ROOM) fail(ERR.MSGSIZE);
    if (!target.rx.fits(data.length)) wait();
    target.rx.push({bytes: data.slice(), from: s.name, rights: own(), creds: s.creds});
    return data.length;
  }
  if (to) fail(s.state === 'connected' ? ERR.ISCONN : E.OPNOTSUPP);
  if (s.state !== 'connected') fail(ERR.NOTCONN);
  const state = p.call?.state ?? {}, done = state.done ?? 0;
  if (s.shut.wr) return broken(p, flags, done);
  const peer = s.peer;
  if (!peer || !peer.rx.readers) return broken(p, flags, done);
  if (s.type === SOCK.SEQPACKET) {
    if (data.length > MESSAGE_ROOM) fail(ERR.MSGSIZE);
    if (!peer.rx.fits(data.length)) wait();
    peer.rx.push({bytes: data.slice(), from: s.name, rights: own(), creds: s.creds});
    return data.length;
  }
  // A stream: what fits, then the rest once there is room (all of it unless it does not wait).
  if (!done && rights.length) peer.rights.push({at: peer.arrived, descs: own()});
  const wrote = done + peer.rx.write(data.subarray(done));
  peer.arrived += wrote - done;
  if (wrote === data.length) return wrote;
  if (nonblocking(d, flags)) { if (wrote) return wrote; fail(E.AGAIN); }
  if (wrote > done) p.kernel.dirty = true;
  state.done = wrote;
  throw new Wait();
}

// ---- for sys-file.mjs ----

/** read and readv of a socket: recv without flags. */
export function read(p, d, into, at, length) {
  const r = receive(p, d, into, at, length, 0);
  // Descriptors that came with what a plain read took are let go (as Linux drops them).
  for (const x of r.rights) x.release();
  return r.n;
}
/** write and writev of a socket: send without flags. */
export const write = (p, d, data) => transmit(p, d, data, 0);

/** What a socket is ready for, as poll's bits. */
export function ready(d) {
  const s = d.sock;
  if (s.state === 'listening') return s.backlog.length ? POLL.IN : 0;
  let r = 0;
  const has = s.stream ? s.rx.size > 0 : s.rx.list.length > 0;
  if (has) r |= POLL.IN;
  if (s.type === SOCK.DGRAM) {
    const target = s.peer;
    if (!target || target.closed || target.rx.writable) r |= POLL.OUT;
    return r;
  }
  if (s.state !== 'connected') return r | POLL.OUT | POLL.HUP;
  const ended = !s.rx.writers || s.shut.rd;
  if (ended) r |= POLL.IN | POLL.RDHUP;
  const gone = !s.peer || !s.peer.rx.readers || s.shut.wr;
  if (gone || s.peer.rx.writable) r |= POLL.OUT;
  if (ended && gone) r |= POLL.HUP;
  return r;
}

export const changes = (d) => d.sock.changes;

/** fstat of a socket. */
export const stat = (d) => ({mode: S_IFSOCK | 0o777, ino: d.sock.ino, nlink: 1, uid: 0, gid: 0, mtime: Date.now(), isFile: false, isDir: false, isLink: false});

/** FIONREAD (SIOCINQ): a stream's bytes waiting, or the next datagram's size. */
export const pending = (d) => (d.sock.stream ? d.sock.rx.size : d.sock.rx.list[0]?.bytes.length ?? 0);

// ---- the calls ----

/** The iovecs at `address`: [[base, length]]. */
function vectors(p, address, count) {
  if (count < 0 || count > 1024) fail(E.INVAL);
  const out = [];
  for (let k = 0; k < count; k++) out.push([Number(p.view.getBigUint64(address + k * 16, true)), Number(p.view.getBigUint64(address + k * 16 + 8, true))]);
  return out;
}

/** The descriptors and credentials a msghdr's control data carries (SCM_RIGHTS, SCM_CREDENTIALS). */
function controls(p, at, length) {
  const rights = [];
  for (let off = 0; off + 16 <= length;) {
    const len = Number(p.view.getBigUint64(at + off, true)), level = p.view.getInt32(at + off + 8, true), type = p.view.getInt32(at + off + 12, true);
    if (len < 16 || off + len > length) fail(E.INVAL);
    if (level === SOL_SOCKET && type === SCM.RIGHTS) {
      for (let k = 16; k + 4 <= len; k += 4) {
        const d = p.fds.get(p.view.getInt32(at + off + k, true));
        if (!d) fail(E.BADF);
        rights.push(d);
      }
      if (rights.length > RIGHTS_MOST) fail(E.INVAL);
    } else if (!(level === SOL_SOCKET && type === SCM.CREDENTIALS)) fail(E.INVAL);
    off += (len + 7) & ~7;
  }
  return rights;
}

function sendmsg(p, fd, msg, flags) {
  const d = socketOf(p, fd), at = N(msg), v = p.view;
  const nameAt = Number(v.getBigUint64(at, true)), nameLen = v.getUint32(at + 8, true);
  const iov = vectors(p, Number(v.getBigUint64(at + 16, true)), Number(v.getBigUint64(at + 24, true)));
  const control = Number(v.getBigUint64(at + 32, true)), controlLen = Number(v.getBigUint64(at + 40, true));
  const rights = control && controlLen ? controls(p, control, controlLen) : [];
  const total = iov.reduce((n, [, l]) => n + l, 0), data = new Uint8Array(total);
  let off = 0;
  for (const [b, l] of iov) { data.set(p.bytes.subarray(b, b + l), off); off += l; }
  const to = nameAt && nameLen && d.sock.type === SOCK.DGRAM ? readName(p, BigInt(nameAt), BigInt(nameLen)) : null;
  return transmit(p, d, data, N(flags), to, rights);
}

function recvmsg(p, fd, msg, flags) {
  const d = socketOf(p, fd), at = N(msg), v = p.view, f = N(flags);
  const iov = vectors(p, Number(v.getBigUint64(at + 16, true)), Number(v.getBigUint64(at + 24, true)));
  const total = iov.reduce((n, [, l]) => n + l, 0), buf = new Uint8Array(total);
  const r = receive(p, d, buf, 0, total, f & ~MSG.WAITALL);
  let off = 0;
  for (const [b, l] of iov) { if (off >= r.n) break; const k = Math.min(l, r.n - off); p.bytes.set(buf.subarray(off, off + k), b); off += k; }
  const nameAt = Number(v.getBigUint64(at, true));
  if (nameAt) {
    const full = r.from ? 2 + r.from.length + (r.from[0] === 0 ? 0 : 1) : 2, have = v.getUint32(at + 8, true);
    const bytes = new Uint8Array(full);
    bytes[0] = AF.UNIX;
    if (r.from) bytes.set(r.from, 2);
    p.bytes.set(bytes.subarray(0, Math.min(have, full)), nameAt);
    v.setUint32(at + 8, full, true);
  }
  // Control data: the descriptors that came (each now one of this process's), and the sender's credentials if asked.
  const control = Number(v.getBigUint64(at + 32, true)), room = Number(v.getBigUint64(at + 40, true));
  let used = 0, outFlags = r.size > r.n && !d.sock.stream ? MSG.TRUNC : 0;
  const put = (type, words, size) => {
    const len = 16 + size, space = (len + 7) & ~7;
    if (!control || used + len > room) { outFlags |= MSG.CTRUNC; return false; }
    v.setBigUint64(control + used, BigInt(len), true);
    v.setInt32(control + used + 8, SOL_SOCKET, true);
    v.setInt32(control + used + 12, type, true);
    words(control + used + 16);
    used += Math.min(space, room - used);
    return true;
  };
  if (r.rights.length) {
    const fds = r.rights.map((x) => p.fds.install(x, {cloexec: !!(f & MSG.CMSG_CLOEXEC)}));
    for (const x of r.rights) x.release();
    if (!put(SCM.RIGHTS, (w) => fds.forEach((n, k) => v.setInt32(w + 4 * k, n, true)), 4 * fds.length)) for (const n of fds) p.fds.close(n);
  }
  if (d.sock.passcred && r.creds) {
    put(SCM.CREDENTIALS, (w) => { v.setInt32(w, r.creds.pid, true); v.setUint32(w + 4, r.creds.uid, true); v.setUint32(w + 8, r.creds.gid, true); }, 12);
  }
  v.setBigUint64(at + 40, BigInt(used), true);
  v.setInt32(at + 48, outFlags, true);
  return f & MSG.TRUNC && !d.sock.stream ? r.size : r.n;
}

export const NET_CALLS = {
  41(domain, type, protocol) { // socket
    if (N(domain) !== AF.UNIX) fail(E.AFNOSUPPORT);
    const t = typeOf(N(type));
    if (N(protocol) !== 0 && N(protocol) !== AF.UNIX) fail(ERR.PROTONOSUPPORT);
    return install(this, new Endpoint(this.kernel, t, this), N(type));
  },
  53(domain, type, protocol, sv) { // socketpair
    if (N(domain) !== AF.UNIX) fail(E.AFNOSUPPORT);
    const t = typeOf(N(type));
    if (N(protocol) !== 0 && N(protocol) !== AF.UNIX) fail(ERR.PROTONOSUPPORT);
    const a = new Endpoint(this.kernel, t, this), b = new Endpoint(this.kernel, t, this);
    link(a, b);
    const fa = install(this, a, N(type)), fb = install(this, b, N(type));
    this.view.setInt32(N(sv), fa, true);
    this.view.setInt32(N(sv) + 4, fb, true);
    return 0;
  },
  49(fd, address, length) { // bind
    const s = socketOf(this, fd).sock;
    if (s.name) fail(E.INVAL);
    const name = readName(this, address, length);
    if (name.abstract !== undefined) {
      const all = (this.kernel.abstractSockets ??= new Map());
      if (all.has(name.abstract)) fail(ERR.ADDRINUSE);
      all.set(name.abstract, s);
      s.abstract = name.abstract;
    } else {
      const r = this.kernel.vfs.resolve(name.path, this.cwd, false);
      if (r.node) fail(ERR.ADDRINUSE);
      if (!r.parent?.isDir) fail(E.NOENT);
      const node = new SocketName(0o777 & ~this.umask);
      node.endpoint = s;
      r.parent.entries.set(r.name, node);
      s.node = node;
    }
    s.name = name.bytes;
    return 0;
  },
  50(fd, backlog) { // listen
    const s = socketOf(this, fd).sock;
    if (s.type === SOCK.DGRAM) fail(E.OPNOTSUPP);
    if (s.state === 'connected') fail(E.INVAL);
    if (!s.name) fail(E.INVAL);
    s.state = 'listening';
    s.backlogMost = Math.max(1, Math.min(4096, N(backlog) + 1));
    s.events++;
    return 0;
  },
  42(fd, address, length) { // connect
    const d = socketOf(this, fd), s = d.sock;
    const target = boundTo(this, readName(this, address, length));
    if (target.type !== s.type) fail(ERR.PROTOTYPE);
    if (s.type === SOCK.DGRAM) {
      s.peer = target;
      s.peerName = target.name;
      s.state = 'connected';
      s.events++;
      return 0;
    }
    if (s.state === 'connected') fail(ERR.ISCONN);
    if (target.state !== 'listening' || target.closed) fail(ERR.CONNREFUSED);
    if (target.backlog.length >= target.backlogMost) { if (d.flags & O_NONBLOCK) fail(E.AGAIN); throw new Wait(); }
    // Its other end, as the listener will accept it: named as the listener is, its peer's credentials the caller's.
    const server = new Endpoint(this.kernel, s.type, this);
    server.creds = target.creds;
    server.name = target.name;
    link(s, server);
    s.peerName = target.name;
    server.peerName = s.name;
    target.backlog.push(server);
    target.events++;
    return 0;
  },
  43(fd, address, lengthAt) { return NET_CALLS[288].call(this, fd, address, lengthAt, 0n); }, // accept
  288(fd, address, lengthAt, flags) { // accept4
    const d = socketOf(this, fd), s = d.sock;
    if (s.state !== 'listening') fail(E.INVAL);
    if (!s.backlog.length) { if (d.flags & O_NONBLOCK) fail(E.AGAIN); throw new Wait(); }
    const server = s.backlog.shift();
    s.events++;
    const n = install(this, server, N(flags));
    writeName(this, address, lengthAt, server.peerName);
    return n;
  },
  44(fd, buf, len, flags, address, length) { // sendto
    const d = socketOf(this, fd);
    const to = N(address) && d.sock.type === SOCK.DGRAM ? readName(this, address, length) : null;
    return transmit(this, d, this.bytes.subarray(N(buf), N(buf) + N(len)), N(flags), to);
  },
  45(fd, buf, len, flags, address, lengthAt) { // recvfrom
    const d = socketOf(this, fd), f = N(flags);
    const r = receive(this, d, this.bytes, N(buf), N(len), f);
    for (const x of r.rights) x.release();
    writeName(this, address, lengthAt, r.from);
    return f & MSG.TRUNC && !d.sock.stream ? r.size : r.n;
  },
  46(fd, msg, flags) { return sendmsg(this, fd, msg, flags); },
  47(fd, msg, flags) { return recvmsg(this, fd, msg, flags); },
  48(fd, how) { // shutdown
    const s = socketOf(this, fd).sock, h = N(how);
    if (h < 0 || h > 2) fail(E.INVAL);
    if (s.state !== 'connected') fail(ERR.NOTCONN);
    if (h !== 1 && !s.shut.rd) { s.shut.rd = true; s.rx.readers--; s.rx.changes++; }
    if (h !== 0 && !s.shut.wr) {
      s.shut.wr = true;
      if (s.peer && s.type !== SOCK.DGRAM) { s.peer.rx.writers--; s.peer.rx.changes++; }
    }
    s.events++;
    return 0;
  },
  51(fd, address, lengthAt) { writeName(this, address, lengthAt, socketOf(this, fd).sock.name); return 0; }, // getsockname
  52(fd, address, lengthAt) { // getpeername
    const s = socketOf(this, fd).sock;
    if (s.state !== 'connected') fail(ERR.NOTCONN);
    writeName(this, address, lengthAt, s.peerName);
    return 0;
  },
  54(fd, level, name, value, length) { // setsockopt
    const s = socketOf(this, fd).sock;
    if (N(level) !== SOL_SOCKET) fail(ERR.NOPROTOOPT);
    if (N(name) === SO.PASSCRED && N(length) >= 4) s.passcred = this.view.getInt32(N(value), true) !== 0;
    // The rest (buffer sizes, SO_REUSEADDR, SO_KEEPALIVE, SO_LINGER, timeouts) are taken and change nothing here.
    return 0;
  },
  55(fd, level, name, value, lengthAt) { // getsockopt
    const s = socketOf(this, fd).sock, v = this.view;
    if (N(level) !== SOL_SOCKET) fail(ERR.NOPROTOOPT);
    const have = v.getUint32(N(lengthAt), true);
    let bytes;
    const int = (x) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, x, true); return b; };
    switch (N(name)) {
      case SO.TYPE: bytes = int(s.type); break;
      case SO.ERROR: bytes = int(0); break;
      case SO.DOMAIN: bytes = int(AF.UNIX); break;
      case SO.PROTOCOL: bytes = int(0); break;
      case SO.ACCEPTCONN: bytes = int(s.state === 'listening' ? 1 : 0); break;
      case SO.PASSCRED: bytes = int(s.passcred ? 1 : 0); break;
      case SO.SNDBUF: case SO.RCVBUF: bytes = int(s.stream ? STREAM_ROOM : MESSAGE_ROOM); break;
      case SO.PEERCRED: {
        const c = s.peer?.creds ?? {pid: 0, uid: -1 >>> 0, gid: -1 >>> 0};
        bytes = new Uint8Array(12);
        const w = new DataView(bytes.buffer);
        w.setInt32(0, c.pid, true); w.setUint32(4, c.uid, true); w.setUint32(8, c.gid, true);
        break;
      }
      default: fail(ERR.NOPROTOOPT);
    }
    this.bytes.set(bytes.subarray(0, Math.min(have, bytes.length)), N(value));
    v.setUint32(N(lengthAt), Math.min(have, bytes.length), true);
    return 0;
  },
};
