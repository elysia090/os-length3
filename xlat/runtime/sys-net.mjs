// Sockets, as a machine with no network but its loopback has them, all of them in this kernel (nothing goes out):
//
//   local (AF_UNIX)      socketpair, a name on a path (a socket node in the files) or in the abstract namespace;
//                        stream, datagram and sequenced packets; descriptors passed (SCM_RIGHTS), credentials
//                        (SCM_CREDENTIALS, SO_PEERCRED)
//   loopback (AF_INET,   TCP and UDP between this machine's own processes: bound to 127.0.0.0/8, ::1 or any
//   AF_INET6)            address (which here is those), ports taken as Linux takes them (an ephemeral one when none
//                        is given, EADDRINUSE, SO_REUSEPORT, IPV6_V6ONLY); any other address is no one's
//                        (EADDRNOTAVAIL to bind) and not reachable (ENETUNREACH), as on a machine with only `lo`
//
// That is what a Prompt on the device has with its network off (its own namespace, `lo` alone), and what a browser
// can give a page: no packet leaves it. Netlink, packet and raw sockets are not here (EAFNOSUPPORT, EPERM).
//
// A connected stream (local, or TCP) is two pipes (fd.mjs), one each way: each end reads its own and writes its
// peer's. So what a pipe does, a stream does as Linux's: a full one makes the writer wait and an empty one the reader,
// the last writer gone is the end of the data and the last reader gone EPIPE (and SIGPIPE, unless MSG_NOSIGNAL).
// Datagrams and packets keep their bounds in a queue of messages (Messages), each read whole or cut (MSG_TRUNC).
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
const ERR = {PROTOTYPE: 91, NOPROTOOPT: 92, PROTONOSUPPORT: 93, SOCKTNOSUPPORT: 94, ADDRINUSE: 98, ADDRNOTAVAIL: 99,
  NOTSOCK: 88, DESTADDRREQ: 89, MSGSIZE: 90, NETUNREACH: 101, ISCONN: 106, NOTCONN: 107, CONNREFUSED: 111, INPROGRESS: 115};

const AF = {UNSPEC: 0, UNIX: 1, INET: 2, INET6: 10};
const SOCK = {STREAM: 1, DGRAM: 2, RAW: 3, SEQPACKET: 5, NONBLOCK: 0x800, CLOEXEC: 0x80000};
const IPPROTO = {IP: 0, ICMP: 1, TCP: 6, UDP: 17, IPV6: 41, ICMPV6: 58};
const MSG = {PEEK: 2, CTRUNC: 8, TRUNC: 0x20, DONTWAIT: 0x40, WAITALL: 0x100, NOSIGNAL: 0x4000, CMSG_CLOEXEC: 0x40000000};
const SOL_SOCKET = 1, SCM = {RIGHTS: 1, CREDENTIALS: 2};
const SO = {REUSEADDR: 2, TYPE: 3, ERROR: 4, SNDBUF: 7, RCVBUF: 8, REUSEPORT: 15, PASSCRED: 16, PEERCRED: 17,
  ACCEPTCONN: 30, PROTOCOL: 38, DOMAIN: 39};
const TCP_NODELAY = 1, IPV6_V6ONLY = 26;
const O_NONBLOCK = 0x800;
const POLL = {IN: 1, OUT: 4, ERR: 8, HUP: 0x10, RDHUP: 0x2000};

/** What one end of a stream may have on its way to it (Linux's default socket buffer is about this), in pipe pages. */
const STREAM_ROOM = 256 << 10;
/** What a datagram or packet queue holds before a sender waits, in bytes and in messages. */
const MESSAGE_ROOM = 212992, MESSAGES = 512;
/** Descriptors one message may carry (SCM_MAX_FD). */
const RIGHTS_MOST = 253;
/** The ports given when none is asked for (Linux's ip_local_port_range). */
const EPHEMERAL = [32768, 60999];

let inodes = 1;

/** Datagrams or packets one way, each whole: what a stream's pipe is to its bytes. */
class Messages {
  constructor() {
    this.list = []; // {bytes, from (the sender's address, or null), rights: [Description], creds}
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

// ---- loopback addresses: 16 bytes each, an IPv4 one as IPv6 has it (::ffff:a.b.c.d) ----

const MAPPED = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const mapped = (ip) => MAPPED.every((b, k) => ip[k] === b);
const same = (a, b) => a.every((x, k) => x === b[k]);
const isAny = (ip) => ip.every((b) => b === 0) || (mapped(ip) && ip.subarray(12).every((b) => b === 0));
const isLoopback = (ip) => (mapped(ip) && ip[12] === 127) || (ip.subarray(0, 15).every((b) => b === 0) && ip[15] === 1);
/** A group's or everyone's address (multicast, the limited broadcast): one a socket may bind to, as on Linux. */
const isGroup = (ip) => (mapped(ip) ? (ip[12] >= 224 && ip[12] <= 239) || ip.subarray(12).every((b) => b === 255) : ip[0] === 0xff);
const v4 = (a, b, c, d) => new Uint8Array([...MAPPED, a, b, c, d]);
const ANY4 = v4(0, 0, 0, 0), ANY6 = new Uint8Array(16), LOOPBACK4 = v4(127, 0, 0, 1), LOOPBACK6 = ANY6.map((_, k) => (k === 15 ? 1 : 0));

/** One socket: its family and kind, its address, what comes to it, and the end it is connected to. */
class Endpoint {
  constructor(kernel, family, type, proc) {
    this.kernel = kernel;
    this.family = family;
    this.type = type;
    this.protocol = family === AF.UNIX ? 0 : type === SOCK.STREAM ? IPPROTO.TCP : IPPROTO.UDP;
    this.state = 'unconnected'; // | 'listening' | 'connected'
    this.rx = type === SOCK.STREAM ? new Pipe(STREAM_ROOM) : new Messages();
    this.rx.readers = 1;
    this.peer = null;
    // Its address and its peer's: a local socket's name ({bytes}: sockaddr_un's path, or null when it has none);
    // a loopback socket's {ip, port}.
    this.local = null;
    this.remote = null;
    this.node = null; // the SocketName on the path it is bound to
    this.abstract = null; // its key in the abstract namespace
    this.port = null; // the port it holds in the kernel's table ({table, port})
    this.backlog = []; // connections a listener has not accepted yet: their server ends
    this.backlogMost = 0;
    this.shut = {rd: false, wr: false};
    this.creds = {pid: proc.pid, uid: 0, gid: 0};
    this.options = {passcred: false, reuseaddr: false, reuseport: false, v6only: false, nodelay: false};
    this.events = 0; // what else moves its readiness (a connection to accept, its peer closing)
    this.error = 0; // a connected UDP socket's pending error (its datagram refused), SO_ERROR's
    this.connecting = false; // a TCP connect that did not wait, not yet told its end
    this.closed = false;
    this.ino = inodes++;
    // A stream's descriptors in flight (SCM_RIGHTS), each with the byte of the stream it came with.
    this.rights = [];
    this.arrived = 0; // bytes of the stream written to it so far
    this.consumed = 0; // and read
  }
  get stream() { return this.type === SOCK.STREAM; }
  get inet() { return this.family !== AF.UNIX; }
  /** Moves whenever its readiness may have (epoll's edge). */
  get changes() { return this.rx.changes + this.events + (this.peer ? this.peer.rx.changes : 0); }

  /** Its last descriptor closed: its peer sees the end, what it held in flight is let go, its name and port are free. */
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
    if (this.port) this.port.table.get(this.port.port)?.delete(this);
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

/** The kind of socket (SOCK_*) a family makes for `raw` with `protocol`, or the error Linux gives. */
function kindOf(family, raw, protocol) {
  const type = raw & ~(SOCK.NONBLOCK | SOCK.CLOEXEC);
  if (family === AF.UNIX) {
    if (type !== SOCK.STREAM && type !== SOCK.DGRAM && type !== SOCK.SEQPACKET) fail(ERR.SOCKTNOSUPPORT);
    if (protocol !== 0 && protocol !== AF.UNIX) fail(ERR.PROTONOSUPPORT);
    return type;
  }
  if (family !== AF.INET && family !== AF.INET6) fail(E.AFNOSUPPORT);
  // Raw sockets want a capability the Prompt's root has not; an ICMP datagram one, a group allowed to ping (none is).
  if (type === SOCK.RAW) fail(E.PERM);
  if (type === SOCK.DGRAM && (protocol === IPPROTO.ICMP || protocol === IPPROTO.ICMPV6)) fail(E.ACCES);
  if (type === SOCK.STREAM && protocol !== 0 && protocol !== IPPROTO.TCP) fail(ERR.PROTONOSUPPORT);
  if (type === SOCK.DGRAM && protocol !== 0 && protocol !== IPPROTO.UDP) fail(ERR.PROTONOSUPPORT);
  if (type !== SOCK.STREAM && type !== SOCK.DGRAM) fail(ERR.SOCKTNOSUPPORT);
  return type;
}

// ---- addresses ----

/**
 * The address at `address` (`length` bytes) for socket `s`: a local name ({path} or {abstract}, and its bytes), a
 * loopback one ({ip, port}), or {unspec} (AF_UNSPEC: a datagram socket's connect undoes its connection).
 */
function readAddress(p, s, address, length) {
  const len = N(length), at = N(address), v = p.view;
  if (len < 2) fail(E.INVAL);
  const family = v.getUint16(at, true);
  if (family === AF.UNSPEC && s.inet) return {unspec: true};
  if (s.family === AF.UNIX) {
    if (family !== AF.UNIX || len > 110) fail(E.INVAL);
    const raw = p.bytes.slice(at + 2, at + len);
    if (!raw.length) fail(E.INVAL);
    if (raw[0] === 0) return {abstract: [...raw.subarray(1)].join(','), bytes: raw};
    const end = raw.indexOf(0);
    const bytes = end < 0 ? raw : raw.subarray(0, end);
    return {path: new TextDecoder().decode(bytes), bytes};
  }
  if (family === AF.INET && s.family === AF.INET) {
    if (len < 16) fail(E.INVAL);
    return {ip: v4(...p.bytes.subarray(at + 4, at + 8)), port: v.getUint16(at + 2, false)};
  }
  if (family === AF.INET6 && s.family === AF.INET6) {
    if (len < 24) fail(E.INVAL);
    return {ip: p.bytes.slice(at + 8, at + 24), port: v.getUint16(at + 2, false)};
  }
  fail(E.AFNOSUPPORT);
}

/** sockaddr for an address of socket `s`'s family (a local name, or {ip, port}; null: unnamed). */
function encode(s, a) {
  if (s.family === AF.UNIX) {
    const name = a?.bytes ?? null;
    const out = new Uint8Array(2 + (name ? name.length + (name[0] === 0 ? 0 : 1) : 0));
    out[0] = AF.UNIX;
    if (name) out.set(name, 2);
    return out;
  }
  const ip = a?.ip ?? new Uint8Array(16), port = a?.port ?? 0;
  const out = new Uint8Array(s.family === AF.INET ? 16 : 28), v = new DataView(out.buffer);
  v.setUint16(0, s.family, true);
  v.setUint16(2, port, false);
  if (s.family === AF.INET) out.set(ip.subarray(12), 4);
  else out.set(ip, 8);
  return out;
}

/** Write sockaddr `bytes` at `address`, as much as its length at `lengthAt` says there is room for, then its length. */
function writeName(p, address, lengthAt, bytes) {
  if (!N(address) || !N(lengthAt)) return;
  const have = p.view.getUint32(N(lengthAt), true);
  if (bytes) p.bytes.set(bytes.subarray(0, Math.min(have, bytes.length)), N(address));
  p.view.setUint32(N(lengthAt), bytes?.length ?? 0, true);
}

/** The local socket bound to `name`, or the error connecting to it gives. */
function namedBy(p, name) {
  if (name.abstract !== undefined) {
    const s = p.kernel.abstractSockets?.get(name.abstract);
    if (!s) fail(ERR.CONNREFUSED);
    return s;
  }
  const node = p.kernel.vfs.lookup(name.path, p.cwd);
  if (!(node instanceof SocketName) || !node.endpoint) fail(ERR.CONNREFUSED);
  return node.endpoint;
}

// ---- loopback ports ----

/** The kernel's ports for a protocol: port -> the sockets bound to it. */
function portsOf(kernel, protocol) {
  kernel.inetPorts ??= {[IPPROTO.TCP]: new Map(), [IPPROTO.UDP]: new Map()};
  return kernel.inetPorts[protocol];
}

/** Whether a socket bound to `ip` is reached at `target` (an exact address, or the wildcard of a family that takes it). */
function reachedAt(s, ip, target) {
  if (same(ip, target)) return true;
  if (!isAny(ip)) return false;
  return s.family === AF.INET ? mapped(target) : !mapped(target) || !s.options.v6only;
}

/** Whether two sockets' bindings to one port overlap (what makes the second EADDRINUSE, unless both share it). */
function overlap(a, ip, b) {
  const bip = b.local.ip;
  if (same(ip, bip)) return true;
  return (isAny(ip) && reachedAt(a, ip, bip)) || (isAny(bip) && reachedAt(b, bip, ip));
}

/** Bind loopback socket `s` to `ip` and `port` (0: an ephemeral one). */
function bindInet(s, ip, port) {
  if (!isAny(ip) && !isLoopback(ip) && !isGroup(ip)) fail(ERR.ADDRNOTAVAIL);
  if (s.family === AF.INET6 && mapped(ip) && s.options.v6only) fail(ERR.ADDRNOTAVAIL);
  const table = portsOf(s.kernel, s.protocol);
  // Two may share a port that both say so of: SO_REUSEPORT; SO_REUSEADDR, for UDP, or for TCP while the other does
  // not listen (as Linux's inet_csk_bind_conflict).
  const shared = (o) => (s.options.reuseport && o.options.reuseport)
    || (s.options.reuseaddr && o.options.reuseaddr && (s.type === SOCK.DGRAM || o.state !== 'listening'));
  const free = (n) => [...(table.get(n) ?? [])].every((o) => o.closed || !overlap(s, ip, o) || shared(o));
  if (!port) {
    const [lo, hi] = EPHEMERAL, span = hi - lo + 1;
    s.kernel.inetNext ??= lo;
    for (let k = 0; k < span && !port; k++) {
      const n = lo + ((s.kernel.inetNext - lo + k) % span);
      if (free(n)) port = n;
    }
    if (!port) fail(ERR.ADDRINUSE);
    s.kernel.inetNext = port + 1 > hi ? lo : port + 1;
  } else if (!free(port)) fail(ERR.ADDRINUSE);
  if (!table.has(port)) table.set(port, new Set());
  table.get(port).add(s);
  s.port = {table, port};
  s.local = {ip, port};
}

/** Where a loopback socket's connection or datagram to `target` goes: this machine's own address, or nowhere. */
function reachable(s, target) {
  // To any address is to this machine's (Linux connects to its own).
  const ip = isAny(target.ip) ? (mapped(target.ip) || s.family === AF.INET ? LOOPBACK4 : LOOPBACK6) : target.ip;
  if (!isLoopback(ip)) fail(ERR.NETUNREACH);
  if (s.family === AF.INET6 && mapped(ip) && s.options.v6only) fail(ERR.NETUNREACH);
  return {ip, port: target.port};
}

/**
 * The socket that takes what comes to `target`: a listener (TCP), or one bound there (UDP: one connected takes only
 * what comes `from` its peer); an exact address first.
 */
function boundAt(kernel, protocol, target, listening, from = null) {
  let wild = null;
  for (const s of portsOf(kernel, protocol).get(target.port) ?? []) {
    if (s.closed || (listening && s.state !== 'listening')) continue;
    if (from && s.remote && !(same(s.remote.ip, from.ip) && s.remote.port === from.port)) continue;
    if (same(s.local.ip, target.ip)) return s;
    if (reachedAt(s, s.local.ip, target.ip)) wild ??= s;
  }
  return wild;
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
 * sender's address, as sockaddr bytes, or null), rights, creds}. Waits (Wait) as a read of a pipe does; MSG_WAITALL
 * waits for all of `length` on a stream, what came so far kept in the call's state.
 */
function receive(p, d, into, at, length, flags) {
  const s = d.sock, none = {n: 0, size: 0, from: null, rights: [], creds: null};
  if (s.state === 'listening' || (s.type !== SOCK.DGRAM && s.state !== 'connected')) fail(ERR.NOTCONN);
  if (s.shut.rd) return none;
  const wait = () => { if (nonblocking(d, flags)) fail(E.AGAIN); throw new Wait(); };
  if (s.stream) {
    const pipe = s.rx, state = p.call?.state ?? {};
    const done = state.got ?? 0;
    if (!pipe.size) {
      if (!pipe.writers || done) return {...none, n: done, size: done};
      wait();
    }
    // A read stops where descriptors came with a later part of the stream (as Linux keeps each send's apart).
    const next = s.rights.find((r) => r.at > s.consumed);
    const most = Math.min(length - done, next ? next.at - s.consumed : Infinity);
    if (flags & MSG.PEEK) return {...none, n: done + peek(pipe, into, at + done, most)};
    const k = pipe.readInto(into, at + done, most);
    const from = s.consumed;
    s.consumed += k;
    const rights = [];
    for (const r of s.rights.filter((x) => x.at >= from && x.at < s.consumed)) { rights.push(...r.descs); s.rights.splice(s.rights.indexOf(r), 1); }
    const got = done + k;
    if ((flags & MSG.WAITALL) && got < length && pipe.writers && !rights.length) { state.got = got; p.kernel.dirty = true; wait(); }
    // (A stream's sender is its peer: a local one's name; a TCP one's is not said, as Linux leaves it.)
    return {n: got, size: got, from: s.inet ? null : encode(s, s.remote), rights, creds: s.peer?.creds ?? null};
  }
  const q = s.rx;
  if (s.inet) pendingError(s);
  if (!q.list.length) {
    // A packet socket's peer gone is its end; a datagram socket waits on.
    if (s.type === SOCK.SEQPACKET && !q.writers) return none;
    wait();
  }
  const m = flags & MSG.PEEK ? q.list[0] : q.shift();
  const n = Math.min(length, m.bytes.length);
  into.set(m.bytes.subarray(0, n), at);
  return {n, size: m.bytes.length, from: encode(s, m.from), rights: flags & MSG.PEEK ? [] : m.rights, creds: m.creds};
}

/** A peer that is gone: SIGPIPE (unless MSG_NOSIGNAL), and EPIPE; what was sent before it counts. */
function broken(p, flags, done) {
  if (!(flags & MSG.NOSIGNAL)) send(p.kernel, p, SIG.PIPE, {code: SI.USER, pid: p.pid, uid: 0}, p.task);
  if (done) return done;
  fail(E.PIPE);
}

/**
 * A datagram from loopback socket `s` to `target`, as UDP's: to the socket bound there, or lost. None there, a
 * connected sender is told (ECONNREFUSED at its next call, as the port-unreachable that comes back tells it on
 * Linux); a receiver with no room drops it (a UDP sender never waits on its receiver).
 */
function datagram(p, s, data, target) {
  if (data.length > (s.family === AF.INET ? 65507 : 65527)) fail(ERR.MSGSIZE);
  const to = reachable(s, target);
  if (!s.local) bindInet(s, s.family === AF.INET ? ANY4 : ANY6, 0);
  const from = {ip: isAny(s.local.ip) ? (mapped(to.ip) ? LOOPBACK4 : LOOPBACK6) : s.local.ip, port: s.local.port};
  const r = boundAt(p.kernel, IPPROTO.UDP, to, false, from);
  if (!r) {
    if (s.remote) { s.error = ERR.CONNREFUSED; s.events++; }
    return data.length;
  }
  if (r.rx.fits(data.length) && !r.shut.rd) r.rx.push({bytes: data.slice(), from, rights: [], creds: s.creds});
  return data.length;
}

/** A UDP socket's pending error, taken (it is said once). */
function pendingError(s) {
  const e = s.error;
  s.error = 0;
  if (e) { s.events++; fail(e); }
}

/** Send `data` from `d` (to `to`, an address, for a datagram socket not connected), with descriptors `rights`: how much went. */
function transmit(p, d, data, flags, to = null, rights = []) {
  const s = d.sock, wait = () => { if (nonblocking(d, flags)) fail(E.AGAIN); throw new Wait(); };
  if (rights.length && s.inet) fail(E.INVAL);
  const own = () => rights.map((r) => r.retain());
  if (s.type === SOCK.DGRAM) {
    if (s.inet) {
      pendingError(s);
      if (s.shut.wr) return broken(p, flags, 0);
      const target = to ?? s.remote;
      if (!target) fail(ERR.DESTADDRREQ);
      return datagram(p, s, data, target);
    }
    const target = to ? namedBy(p, to) : s.peer;
    if (!target) fail(ERR.NOTCONN);
    if (target.closed) fail(ERR.CONNREFUSED);
    if (target.type !== SOCK.DGRAM) fail(ERR.PROTOTYPE);
    // Connected to another, it takes nothing from this one.
    if (target.peer && target.peer !== s) fail(E.PERM);
    if (data.length > MESSAGE_ROOM) fail(ERR.MSGSIZE);
    if (!target.rx.fits(data.length)) wait();
    target.rx.push({bytes: data.slice(), from: s.local, rights: own(), creds: s.creds});
    return data.length;
  }
  // A local stream or packet socket takes no address to send to; TCP's is not looked at.
  if (to && !s.inet) fail(s.state === 'connected' ? ERR.ISCONN : E.OPNOTSUPP);
  if (s.state !== 'connected') return s.inet ? broken(p, flags, 0) : fail(ERR.NOTCONN);
  const state = p.call?.state ?? {}, done = state.done ?? 0;
  if (s.shut.wr) return broken(p, flags, done);
  const peer = s.peer;
  if (!peer || !peer.rx.readers) return broken(p, flags, done);
  if (s.type === SOCK.SEQPACKET) {
    if (data.length > MESSAGE_ROOM) fail(ERR.MSGSIZE);
    if (!peer.rx.fits(data.length)) wait();
    peer.rx.push({bytes: data.slice(), from: s.local, rights: own(), creds: s.creds});
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
    return s.error ? r | POLL.ERR : r;
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

/** The address a datagram is sent to, when one is given (TCP's is not looked at; a local stream's is an error). */
function destination(p, s, address, length) {
  if (!N(address) || !N(length) || (s.inet && s.stream)) return null;
  const a = readAddress(p, s, address, length);
  return a.unspec ? null : a;
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
  return transmit(p, d, data, N(flags), destination(p, d.sock, BigInt(nameAt), BigInt(nameLen)), rights);
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
    const have = v.getUint32(at + 8, true);
    if (r.from) p.bytes.set(r.from.subarray(0, Math.min(have, r.from.length)), nameAt);
    v.setUint32(at + 8, r.from?.length ?? 0, true);
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
  if (d.sock.options.passcred && r.creds) {
    put(SCM.CREDENTIALS, (w) => { v.setInt32(w, r.creds.pid, true); v.setUint32(w + 4, r.creds.uid, true); v.setUint32(w + 8, r.creds.gid, true); }, 12);
  }
  v.setBigUint64(at + 40, BigInt(used), true);
  v.setInt32(at + 48, outFlags, true);
  return f & MSG.TRUNC && !d.sock.stream ? r.size : r.n;
}

/** connect of a stream socket to a listener: its other end queued for accept (named as the listener, its peer's credentials the caller's). */
function connectStream(p, d, s, target) {
  // AF_UNSPEC: a TCP socket not connected stays so.
  if (target.unspec) { if (s.state !== 'connected') return 0; fail(ERR.ISCONN); }
  // A connect it did not wait for is told its end once (0), as Linux's next connect tells it; then: connected.
  if (s.connecting) { s.connecting = false; return 0; }
  if (s.state === 'connected') fail(ERR.ISCONN);
  if (s.state === 'listening') fail(E.INVAL);
  let listener, at = null;
  if (s.inet) {
    at = reachable(s, target);
    listener = boundAt(p.kernel, IPPROTO.TCP, at, true);
    if (!listener) fail(ERR.CONNREFUSED);
  } else {
    listener = namedBy(p, target);
    if (listener.type !== s.type) fail(ERR.PROTOTYPE);
    if (listener.state !== 'listening' || listener.closed) fail(ERR.CONNREFUSED);
  }
  if (listener.backlog.length >= listener.backlogMost) { if (d.flags & O_NONBLOCK) fail(E.AGAIN); throw new Wait(); }
  // A client not bound takes a port of its own, at its family's loopback address (the source Linux's `lo` gives).
  if (s.inet && !s.local) bindInet(s, mapped(at.ip) ? LOOPBACK4 : LOOPBACK6, 0);
  const server = new Endpoint(p.kernel, listener.family, s.type, p);
  server.creds = listener.creds;
  server.options = {...listener.options};
  server.local = s.inet ? {ip: at.ip, port: at.port} : listener.local;
  server.remote = s.local;
  s.remote = server.local;
  link(s, server);
  listener.backlog.push(server);
  listener.events++;
  s.events++;
  // A TCP connect that does not wait says it is under way (it is done already: the connection is this machine's own).
  if (s.inet && (d.flags & O_NONBLOCK)) { s.connecting = true; fail(ERR.INPROGRESS); }
  return 0;
}

export const NET_CALLS = {
  41(domain, type, protocol) { // socket
    const family = N(domain);
    const t = kindOf(family, N(type), N(protocol));
    return install(this, new Endpoint(this.kernel, family, t, this), N(type));
  },
  53(domain, type, protocol, sv) { // socketpair: the local family's alone
    const family = N(domain);
    if (family === AF.INET || family === AF.INET6) { kindOf(family, N(type), N(protocol)); fail(E.OPNOTSUPP); }
    if (family !== AF.UNIX) fail(E.AFNOSUPPORT);
    const t = kindOf(family, N(type), N(protocol));
    const a = new Endpoint(this.kernel, family, t, this), b = new Endpoint(this.kernel, family, t, this);
    link(a, b);
    const fa = install(this, a, N(type)), fb = install(this, b, N(type));
    this.view.setInt32(N(sv), fa, true);
    this.view.setInt32(N(sv) + 4, fb, true);
    return 0;
  },
  49(fd, address, length) { // bind
    const s = socketOf(this, fd).sock;
    if (s.local && (s.inet || s.local.bytes)) fail(E.INVAL);
    const a = readAddress(this, s, address, length);
    if (a.unspec) fail(E.AFNOSUPPORT);
    if (s.inet) { bindInet(s, a.ip, a.port); return 0; }
    if (a.abstract !== undefined) {
      const all = (this.kernel.abstractSockets ??= new Map());
      if (all.has(a.abstract)) fail(ERR.ADDRINUSE);
      all.set(a.abstract, s);
      s.abstract = a.abstract;
    } else {
      const r = this.kernel.vfs.resolve(a.path, this.cwd, false);
      if (r.node) fail(ERR.ADDRINUSE);
      if (!r.parent?.isDir) fail(E.NOENT);
      const node = new SocketName(0o777 & ~this.umask);
      node.endpoint = s;
      r.parent.entries.set(r.name, node);
      s.node = node;
    }
    s.local = {bytes: a.bytes};
    return 0;
  },
  50(fd, backlog) { // listen
    const s = socketOf(this, fd).sock;
    if (s.type === SOCK.DGRAM) fail(E.OPNOTSUPP);
    if (s.state === 'connected') fail(E.INVAL);
    // A loopback socket not bound yet takes a port of its own; a local one must be named.
    if (!s.local) { if (!s.inet) fail(E.INVAL); bindInet(s, s.family === AF.INET ? ANY4 : ANY6, 0); }
    s.state = 'listening';
    s.backlogMost = Math.max(1, Math.min(4096, N(backlog) + 1));
    s.events++;
    return 0;
  },
  42(fd, address, length) { // connect
    const d = socketOf(this, fd), s = d.sock;
    const a = readAddress(this, s, address, length);
    if (s.type !== SOCK.DGRAM) return connectStream(this, d, s, a);
    if (s.inet) {
      // A datagram socket's peer: the one address it sends to and takes from (AF_UNSPEC: none again).
      if (a.unspec) { s.remote = null; s.state = 'unconnected'; s.events++; return 0; }
      const to = reachable(s, a);
      if (!s.local) bindInet(s, to.ip, 0);
      s.remote = to;
      s.state = 'connected';
      s.events++;
      return 0;
    }
    const target = namedBy(this, a);
    if (target.type !== s.type) fail(ERR.PROTOTYPE);
    s.peer = target;
    s.remote = target.local;
    s.state = 'connected';
    s.events++;
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
    writeName(this, address, lengthAt, encode(server, server.remote));
    return n;
  },
  44(fd, buf, len, flags, address, length) { // sendto
    const d = socketOf(this, fd);
    return transmit(this, d, this.bytes.subarray(N(buf), N(buf) + N(len)), N(flags), destination(this, d.sock, address, length));
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
  51(fd, address, lengthAt) { const s = socketOf(this, fd).sock; writeName(this, address, lengthAt, encode(s, s.local)); return 0; }, // getsockname
  52(fd, address, lengthAt) { // getpeername
    const s = socketOf(this, fd).sock;
    if (s.state !== 'connected') fail(ERR.NOTCONN);
    writeName(this, address, lengthAt, encode(s, s.remote));
    return 0;
  },
  54(fd, level, name, value, length) { // setsockopt
    const s = socketOf(this, fd).sock, l = N(level), n = N(name);
    const on = N(length) >= 4 && this.view.getInt32(N(value), true) !== 0;
    if (l === SOL_SOCKET) {
      if (n === SO.PASSCRED) s.options.passcred = on;
      if (n === SO.REUSEADDR) s.options.reuseaddr = on;
      if (n === SO.REUSEPORT) s.options.reuseport = on;
      // The rest (buffer sizes, SO_KEEPALIVE, SO_LINGER, timeouts) are taken and change nothing here.
      return 0;
    }
    if (!s.inet) fail(ERR.NOPROTOOPT);
    if (l === IPPROTO.TCP && s.stream) { if (n === TCP_NODELAY) s.options.nodelay = on; return 0; }
    if (l === IPPROTO.IPV6 && s.family === AF.INET6) {
      if (n === IPV6_V6ONLY) { if (s.local) fail(E.INVAL); s.options.v6only = on; }
      return 0;
    }
    if (l === IPPROTO.IP || l === IPPROTO.IPV6 || (l === IPPROTO.UDP && !s.stream)) return 0;
    fail(ERR.NOPROTOOPT);
  },
  55(fd, level, name, value, lengthAt) { // getsockopt
    const s = socketOf(this, fd).sock, v = this.view, l = N(level), n = N(name);
    const have = v.getUint32(N(lengthAt), true);
    let bytes;
    const int = (x) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, x, true); return b; };
    if (l === SOL_SOCKET) {
      switch (n) {
        case SO.TYPE: bytes = int(s.type); break;
        case SO.ERROR: bytes = int(s.error); s.error = 0; break;
        case SO.DOMAIN: bytes = int(s.family); break;
        case SO.PROTOCOL: bytes = int(s.protocol); break;
        case SO.ACCEPTCONN: bytes = int(s.state === 'listening' ? 1 : 0); break;
        case SO.PASSCRED: bytes = int(s.options.passcred ? 1 : 0); break;
        case SO.REUSEADDR: bytes = int(s.options.reuseaddr ? 1 : 0); break;
        case SO.REUSEPORT: bytes = int(s.options.reuseport ? 1 : 0); break;
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
    } else if (s.inet && l === IPPROTO.TCP && s.stream && n === TCP_NODELAY) bytes = int(s.options.nodelay ? 1 : 0);
    else if (s.family === AF.INET6 && l === IPPROTO.IPV6 && n === IPV6_V6ONLY) bytes = int(s.options.v6only ? 1 : 0);
    else fail(ERR.NOPROTOOPT);
    this.bytes.set(bytes.subarray(0, Math.min(have, bytes.length)), N(value));
    v.setUint32(N(lengthAt), Math.min(have, bytes.length), true);
    return 0;
  },
};
