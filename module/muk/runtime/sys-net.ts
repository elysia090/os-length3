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
//   ICMP (raw sockets)   echo over loopback, as ping sends it: each raw ICMP socket sees what comes in, and the
//                        kernel answers an echo request
//   netlink              what the kernel says of its network (net-view.ts): lo, its addresses and routes
//                        (NETLINK_ROUTE, as `ip` reads them), its sockets (NETLINK_SOCK_DIAG, as `ss` does)
//
// That is what a Prompt on the device has with its network off (its own namespace, `lo` alone), and what a browser
// can give a page: no packet leaves it. Packet sockets and the other families are not here (EAFNOSUPPORT).
//
// A connected stream (local, or TCP) is two pipes (fd.ts), one each way: each end reads its own and writes its
// peer's. So what a pipe does, a stream does as Linux's: a full one makes the writer wait and an empty one the reader,
// the last writer gone is the end of the data and the last reader gone EPIPE (and SIGPIPE, unless MSG_NOSIGNAL).
// Datagrams and packets keep their bounds in a queue of messages (Messages), each read whole or cut (MSG_TRUNC).
//
// Read, write, readv, writev, poll, select and epoll reach a socket through sys-file.ts (read, write, ready,
// changes, below); its last descriptor closed, Description.release closes it.

import {Description, Pipe} from './fd.ts';
import {E, FsError, SocketName, S_IFSOCK} from './fs.ts';
import {answer, interfaceControl, traffic, type Address} from './net-view.ts';
import {Wait, utf8} from './flow.ts';
import type {Calls, Kern, Proc} from './parts.ts';
import {SIG, SI, send} from './signal.ts';
import {epoch} from '../../sods/runtime/host.ts';

declare module './fd.ts' {
  interface Description {
    /** A socket's: its end (sys-net.ts). */
    sock?: Endpoint;
  }
}
declare module './fs.ts' {
  interface SocketName {
    /** The socket bound to its path, while it is open. */
    endpoint: Endpoint | null;
  }
}
declare module './parts.ts' {
  interface Kern {
    /** Every socket (net-view.ts lists them), the abstract names and netlink ports taken, the loopback ports. */
    sockets?: Set<Endpoint>;
    abstractSockets?: Map<string, Endpoint>;
    netlinkPorts?: Map<number, Endpoint>;
    inetPorts?: Record<number, Map<number, Set<Endpoint>>>;
    inetNext?: number;
    /** A socket's descriptor was passed over a socket (SCM_RIGHTS): only then can sockets hold one another (collect). */
    socketsPassed?: boolean;
    /** collect is looking: what it lets go does not start it again. */
    collecting?: boolean;
  }
}

/** What a socket's credentials are (SO_PEERCRED, SCM_CREDENTIALS). */
interface Creds { pid: number; uid: number; gid: number }
/** A datagram or packet: its bytes, its sender's address, the descriptors and credentials it carries. */
interface Message { bytes: Uint8Array; from: Address | null; rights: Description[]; creds: Creds | null }
/** An address a call names (readAddress): a socket's of its family, a local one's name ({path} or {abstract}), or none (AF_UNSPEC). */
interface Given extends Address { path?: string; abstract?: string; unspec?: boolean }

const N = (x: bigint): number => Number(BigInt.asIntN(64, x));
const fail = (errno: number): never => { throw new FsError(errno); };
// (Those fs.ts does not name, as Linux numbers them.)
const ERR = {PROTOTYPE: 91, NOPROTOOPT: 92, PROTONOSUPPORT: 93, SOCKTNOSUPPORT: 94, ADDRINUSE: 98, ADDRNOTAVAIL: 99,
  NOTSOCK: 88, DESTADDRREQ: 89, MSGSIZE: 90, NETUNREACH: 101, ISCONN: 106, NOTCONN: 107, CONNREFUSED: 111, INPROGRESS: 115};

const AF = {UNSPEC: 0, UNIX: 1, INET: 2, INET6: 10, NETLINK: 16};
const NETLINK = {ROUTE: 0, SOCK_DIAG: 4};
const SOCK = {STREAM: 1, DGRAM: 2, RAW: 3, SEQPACKET: 5, NONBLOCK: 0x800, CLOEXEC: 0x80000};
const IPPROTO = {IP: 0, ICMP: 1, TCP: 6, UDP: 17, IPV6: 41, ICMPV6: 58};
const MSG = {PEEK: 2, CTRUNC: 8, TRUNC: 0x20, DONTWAIT: 0x40, WAITALL: 0x100, NOSIGNAL: 0x4000, CMSG_CLOEXEC: 0x40000000};
const SOL_SOCKET = 1, SCM = {RIGHTS: 1, CREDENTIALS: 2};
const SO = {REUSEADDR: 2, TYPE: 3, ERROR: 4, SNDBUF: 7, RCVBUF: 8, REUSEPORT: 15, PASSCRED: 16, PEERCRED: 17,
  ACCEPTCONN: 30, PROTOCOL: 38, DOMAIN: 39};
const TCP_NODELAY = 1, IPV6_V6ONLY = 26;
const SOL = {IP: 0, IPV6: 41, ICMPV6: 58, RAW: 255, NETLINK: 270};
const IP_TTL = 2, IP_RECVTTL = 12, IPV6_RECVHOPLIMIT = 51, IPV6_HOPLIMIT = 52, ICMP_FILTER = 1, ICMP6_FILTER = 1;
/** The hops a packet on lo is said to have left (Linux's default TTL and hop limit). */
const HOPS = 64;
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
  readonly list: Message[] = [];
  size = 0;
  readers = 0;
  writers = 0;
  changes = 0;
  get capacity() { return MESSAGE_ROOM; }
  /** One of `n` bytes goes in now (one always does into an empty queue). */
  fits(n: number): boolean { return !this.list.length || (this.list.length < MESSAGES && this.size + n <= MESSAGE_ROOM); }
  get writable() { return this.fits(1); }
  push(m: Message): void { this.list.push(m); this.size += m.bytes.length; this.changes++; }
  shift(): Message { const m = this.list.shift()!; this.size -= m.bytes.length; this.changes++; return m; }
}

// ---- loopback addresses: 16 bytes each, an IPv4 one as IPv6 has it (::ffff:a.b.c.d) ----

const MAPPED = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const mapped = (ip: Uint8Array): boolean => MAPPED.every((b, k) => ip[k] === b);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.every((x, k) => x === b[k]);
const isAny = (ip: Uint8Array): boolean => ip.every((b) => b === 0) || (mapped(ip) && ip.subarray(12).every((b) => b === 0));
const isLoopback = (ip: Uint8Array): boolean => (mapped(ip) && ip[12] === 127) || (ip.subarray(0, 15).every((b) => b === 0) && ip[15] === 1);
/** A group's or everyone's address (multicast, the limited broadcast): one a socket may bind to, as on Linux. */
const isGroup = (ip: Uint8Array): boolean => (mapped(ip) ? (ip[12] >= 224 && ip[12] <= 239) || ip.subarray(12).every((b) => b === 255) : ip[0] === 0xff);
const v4 = (a: number, b: number, c: number, d: number): Uint8Array => new Uint8Array([...MAPPED, a, b, c, d]);
const ANY4 = v4(0, 0, 0, 0), ANY6 = new Uint8Array(16), LOOPBACK4 = v4(127, 0, 0, 1), LOOPBACK6 = ANY6.map((_, k) => (k === 15 ? 1 : 0));

/** One socket: its family and kind, its address, what comes to it, and the end it is connected to. */
class Endpoint {
  declare readonly kernel: Kern;
  declare readonly family: number;
  declare readonly type: number;
  declare readonly protocol: number;
  declare state: 'unconnected' | 'listening' | 'connected';
  declare readonly rx: Pipe | Messages;
  declare peer: Endpoint | null;
  declare local: Address | null;
  declare remote: Address | null;
  declare node: SocketName | null;
  declare abstract: string | null;
  declare port: {table: Map<number, Set<Endpoint>>; port: number} | null;
  declare backlog: Endpoint[];
  declare backlogMost: number;
  declare backlogAsked: number;
  declare readonly shut: {rd: boolean; wr: boolean};
  declare creds: Creds;
  declare options: {passcred: boolean; reuseaddr: boolean; reuseport: boolean; v6only: boolean; nodelay: boolean; recvttl: boolean; recvhops: boolean};
  declare filter: number | Uint8Array | null;
  declare events: number;
  declare error: number;
  declare connecting: boolean;
  declare closed: boolean;
  declare readonly ino: number;
  declare rights: {at: number; descs: Description[]}[];
  declare arrived: number;
  declare consumed: number;
  constructor(kernel: Kern, family: number, type: number, proc: Proc, protocol: number | null = null) {
    this.kernel = kernel;
    this.family = family;
    this.type = type;
    // A raw or netlink socket's is the one asked for; the others', their family's and type's.
    this.protocol = protocol ?? (family === AF.UNIX ? 0 : type === SOCK.STREAM ? IPPROTO.TCP : IPPROTO.UDP);
    this.state = 'unconnected'; // | 'listening' | 'connected'
    this.rx = type === SOCK.STREAM ? new Pipe(STREAM_ROOM) : new Messages();
    this.rx.readers = 1;
    this.peer = null;
    // Its address and its peer's: a local socket's name ({bytes}: sockaddr_un's path, or null when it has none);
    // a loopback socket's {ip, port}; a netlink socket's {portid, groups}.
    this.local = null;
    this.remote = null;
    this.node = null; // the SocketName on the path it is bound to
    this.abstract = null; // its key in the abstract namespace
    this.port = null; // the port it holds in the kernel's table ({table, port})
    this.backlog = []; // connections a listener has not accepted yet: their server ends
    this.backlogMost = 0;
    this.backlogAsked = 0; // listen's, as ss says it
    this.shut = {rd: false, wr: false};
    this.creds = {pid: proc.pid, uid: 0, gid: 0};
    this.options = {passcred: false, reuseaddr: false, reuseport: false, v6only: false, nodelay: false, recvttl: false, recvhops: false};
    this.filter = null; // a raw ICMP socket's types not wanted (ICMP_FILTER's mask, ICMP6_FILTER's bits)
    this.events = 0; // what else moves its readiness (a connection to accept, its peer closing)
    this.error = 0; // a connected UDP socket's pending error (its datagram refused), SO_ERROR's
    this.connecting = false; // a TCP connect that did not wait, not yet told its end
    this.closed = false;
    this.ino = inodes++;
    // A stream's descriptors in flight (SCM_RIGHTS), each with the byte of the stream it came with.
    this.rights = [];
    this.arrived = 0; // bytes of the stream written to it so far
    this.consumed = 0; // and read
    // Every socket the kernel has, as its diagnostics list them (net-view.ts).
    (kernel.sockets ??= new Set()).add(this);
  }
  get stream(): boolean { return this.type === SOCK.STREAM; }
  get inet(): boolean { return this.family === AF.INET || this.family === AF.INET6; }
  get netlink(): boolean { return this.family === AF.NETLINK; }
  /** Whether it is connected to read or write (a stream's, a packet socket's); a datagram one is not. */
  get connectionWanted(): boolean { return this.type === SOCK.STREAM || this.type === SOCK.SEQPACKET; }
  /** Moves whenever its readiness may have (epoll's edge). */
  get changes(): number { return this.rx.changes + this.events + (this.peer ? this.peer.rx.changes : 0); }

  /** One of its descriptors was let go and others are left: perhaps only ones in flight that no one can receive (collect). */
  released(): void { if (this.kernel.socketsPassed) collect(this.kernel); }

  /** Its last descriptor closed: its peer sees the end, what it held in flight is let go, its name and port are free. */
  close(): void {
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
    if (this.rx instanceof Messages) for (const m of this.rx.list) for (const d of m.rights) d.release();
    for (const s of this.backlog) s.close();
    this.backlog = [];
    if (this.abstract !== null && this.kernel.abstractSockets?.get(this.abstract) === this) this.kernel.abstractSockets.delete(this.abstract);
    // The path stays (as on Linux: unlinked by whoever made it), and connecting to it is refused.
    if (this.node?.endpoint === this) this.node.endpoint = null;
    if (this.port) this.port.table.get(this.port.port)?.delete(this);
    const portid = this.local?.portid;
    if (this.netlink && portid !== undefined && this.kernel.netlinkPorts?.get(portid) === this) this.kernel.netlinkPorts.delete(portid);
    this.kernel.sockets?.delete(this);
  }
}

/** The descriptors in flight to `e`: those that came with a stream's bytes, and with its messages. */
const flying = (e: Endpoint): Description[] =>
  [...e.rights.flatMap((r) => r.descs), ...(e.rx instanceof Messages ? e.rx.list.flatMap((m) => m.rights) : [])];

/**
 * Sockets held only by descriptors in flight that no one can receive any more are let go, as Linux's unix_gc lets
 * them go. A socket's descriptor passed over a socket is held by the queue it lies in; passed to itself, or round a
 * ring of sockets, each queue holds the next and none counts down to its close once the last descriptor a process
 * has is closed. So: the sockets every reference to which lies in a queue are looked at; those in the queue of a
 * socket someone still holds can be received, and are kept, with what lies in their queues in turn; what is left no
 * one can reach, and what lies in its queues is let go, which closes it.
 */
function collect(kernel: Kern): void {
  if (kernel.collecting) return;
  const count = new Map<Description, number>();
  for (const e of kernel.sockets ?? []) for (const d of flying(e)) if (d.kind === 'socket' && d.sock) count.set(d, (count.get(d) ?? 0) + 1);
  // Held by queues alone.
  const lost = new Set<Description>();
  for (const [d, n] of count) if (d.refs === n) lost.add(d);
  if (!lost.size) return;
  // Every other socket is someone's (a process's descriptor, a listener's connection not yet accepted): what lies in
  // its queue can still be received. A connection waiting on a listener is the listener's to give.
  const ends = (d: Description): Endpoint[] => [d.sock as Endpoint, ...(d.sock as Endpoint).backlog];
  const perhaps = new Set<Endpoint>([...lost].flatMap(ends));
  const kept = [...kernel.sockets ?? []].filter((e) => !perhaps.has(e));
  for (let e = kept.pop(); e; e = kept.pop()) for (const d of flying(e)) if (lost.delete(d)) kept.push(...ends(d));
  if (!lost.size) return;
  const freed: Description[] = [];
  for (const d of lost) for (const e of ends(d)) {
    freed.push(...flying(e));
    e.rights = [];
    if (e.rx instanceof Messages) for (const m of e.rx.list) m.rights = [];
  }
  kernel.collecting = true;
  try { for (const d of freed) d.release(); } finally { kernel.collecting = false; }
}

/** Two ends of a connection, each reading what the other writes. */
function link(a: Endpoint, b: Endpoint): void {
  a.peer = b;
  b.peer = a;
  a.state = b.state = 'connected';
  if (a.type !== SOCK.DGRAM) { a.rx.writers++; b.rx.writers++; }
}

/** The socket of descriptor `fd`. */
function socketOf(p: Proc, fd: bigint): Description & {sock: Endpoint} {
  const d = p.fds.get(N(fd));
  if (!d) return fail(E.BADF);
  if (d.kind !== 'socket' || !d.sock) return fail(ERR.NOTSOCK);
  return d as Description & {sock: Endpoint};
}

/** A new descriptor for `sock`, as its type's flags say (SOCK_NONBLOCK, SOCK_CLOEXEC). */
function install(p: Proc, sock: Endpoint, flags: number): number {
  const d = new Description('socket', {flags: flags & SOCK.NONBLOCK ? O_NONBLOCK : 0});
  d.sock = sock;
  const fd = p.fds.install(d, {cloexec: !!(flags & SOCK.CLOEXEC)});
  if (fd < 0) { sock.close(); fail(E.MFILE); }
  return fd;
}

/** The kind of socket (SOCK_*) a family makes for `raw` with `protocol`, or the error Linux gives. */
function kindOf(family: number, raw: number, protocol: number): number {
  const type = raw & ~(SOCK.NONBLOCK | SOCK.CLOEXEC);
  if (family === AF.UNIX) {
    if (type !== SOCK.STREAM && type !== SOCK.DGRAM && type !== SOCK.SEQPACKET) fail(ERR.SOCKTNOSUPPORT);
    if (protocol !== 0 && protocol !== AF.UNIX) fail(ERR.PROTONOSUPPORT);
    return type;
  }
  if (family === AF.NETLINK) {
    if (type !== SOCK.RAW && type !== SOCK.DGRAM) fail(ERR.SOCKTNOSUPPORT);
    if (protocol !== NETLINK.ROUTE && protocol !== NETLINK.SOCK_DIAG) fail(ERR.PROTONOSUPPORT);
    return type;
  }
  if (family !== AF.INET && family !== AF.INET6) fail(E.AFNOSUPPORT);
  // Raw sockets are root's in its own network (ping's): ICMP's, and ICMPv6's; an ICMP datagram one wants a group
  // allowed to ping (none is, as Linux's ping_group_range has it).
  if (type === SOCK.RAW) {
    if (protocol !== (family === AF.INET ? IPPROTO.ICMP : IPPROTO.ICMPV6)) fail(ERR.PROTONOSUPPORT);
    return type;
  }
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
function readAddress(p: Proc, s: Endpoint, address: bigint, length: bigint): Given {
  const len = N(length), at = N(address), v = p.view;
  if (len < 2) fail(E.INVAL);
  const family = v.getUint16(at, true);
  if (family === AF.UNSPEC && s.inet) return {unspec: true};
  if (s.netlink) {
    if (family !== AF.NETLINK || len < 12) fail(E.INVAL);
    return {portid: v.getUint32(at + 4, true), groups: v.getUint32(at + 8, true)};
  }
  if (s.family === AF.UNIX) {
    if (family !== AF.UNIX || len > 110) fail(E.INVAL);
    const raw = p.bytes.slice(at + 2, at + len);
    if (!raw.length) fail(E.INVAL);
    if (raw[0] === 0) return {abstract: [...raw.subarray(1)].join(','), bytes: raw};
    const end = raw.indexOf(0);
    const bytes = end < 0 ? raw : raw.subarray(0, end);
    return {path: utf8(bytes), bytes};
  }
  if (family === AF.INET && s.family === AF.INET) {
    if (len < 16) fail(E.INVAL);
    const [a, b, c, d] = p.bytes.subarray(at + 4, at + 8);
    return {ip: v4(a, b, c, d), port: v.getUint16(at + 2, false)};
  }
  if (family === AF.INET6 && s.family === AF.INET6) {
    if (len < 24) fail(E.INVAL);
    return {ip: p.bytes.slice(at + 8, at + 24), port: v.getUint16(at + 2, false)};
  }
  return fail(E.AFNOSUPPORT);
}

/** sockaddr for an address of socket `s`'s family (a local name, or {ip, port}; null: unnamed). */
function encode(s: Endpoint, a: Address | null): Uint8Array {
  if (s.netlink) {
    const out = new Uint8Array(12), v = new DataView(out.buffer);
    v.setUint16(0, AF.NETLINK, true);
    v.setUint32(4, a?.portid ?? 0, true);
    v.setUint32(8, a?.groups ?? 0, true);
    return out;
  }
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
function writeName(p: Proc, address: bigint, lengthAt: bigint, bytes: Uint8Array | null): void {
  if (!N(address) || !N(lengthAt)) return;
  const have = p.view.getUint32(N(lengthAt), true);
  if (bytes) p.bytes.set(bytes.subarray(0, Math.min(have, bytes.length)), N(address));
  p.view.setUint32(N(lengthAt), bytes?.length ?? 0, true);
}

/** The local socket bound to `name`, or the error connecting to it gives. */
function namedBy(p: Proc, name: Given): Endpoint {
  if (name.abstract !== undefined) return p.kernel.abstractSockets?.get(name.abstract) ?? fail(ERR.CONNREFUSED);
  const node = p.kernel.vfs.lookup(name.path ?? '', p.here);
  return (node instanceof SocketName && node.endpoint) || fail(ERR.CONNREFUSED);
}

// ---- loopback ports ----

/** The kernel's ports for a protocol: port -> the sockets bound to it. */
function portsOf(kernel: Kern, protocol: number): Map<number, Set<Endpoint>> {
  kernel.inetPorts ??= {[IPPROTO.TCP]: new Map(), [IPPROTO.UDP]: new Map()};
  return kernel.inetPorts[protocol];
}

/** Whether a socket bound to `ip` is reached at `target` (an exact address, or the wildcard of a family that takes it). */
function reachedAt(s: Endpoint, ip: Uint8Array, target: Uint8Array): boolean {
  if (same(ip, target)) return true;
  if (!isAny(ip)) return false;
  return s.family === AF.INET ? mapped(target) : !mapped(target) || !s.options.v6only;
}

/** Whether two sockets' bindings to one port overlap (what makes the second EADDRINUSE, unless both share it). */
function overlap(a: Endpoint, ip: Uint8Array, b: Endpoint): boolean {
  const bip = ipOf(b.local);
  if (same(ip, bip)) return true;
  return (isAny(ip) && reachedAt(a, ip, bip)) || (isAny(bip) && reachedAt(b, bip, ip));
}

/** Bind loopback socket `s` to `ip` and `port` (0: an ephemeral one). */
function bindInet(s: Endpoint, ip: Uint8Array, port: number): void {
  if (!isAny(ip) && !isLoopback(ip) && !isGroup(ip)) fail(ERR.ADDRNOTAVAIL);
  if (s.family === AF.INET6 && mapped(ip) && s.options.v6only) fail(ERR.ADDRNOTAVAIL);
  const table = portsOf(s.kernel, s.protocol);
  // Two may share a port that both say so of: SO_REUSEPORT; SO_REUSEADDR, for UDP, or for TCP while the other does
  // not listen (as Linux's inet_csk_bind_conflict).
  const shared = (o: Endpoint): boolean => (s.options.reuseport && o.options.reuseport)
    || (s.options.reuseaddr && o.options.reuseaddr && (s.type === SOCK.DGRAM || o.state !== 'listening'));
  const free = (n: number): boolean => [...(table.get(n) ?? [])].every((o) => o.closed || !overlap(s, ip, o) || shared(o));
  if (!port) {
    const [lo, hi] = EPHEMERAL, span = hi - lo + 1;
    const next = s.kernel.inetNext ?? lo;
    for (let k = 0; k < span && !port; k++) {
      const n = lo + ((next - lo + k) % span);
      if (free(n)) port = n;
    }
    if (!port) fail(ERR.ADDRINUSE);
    s.kernel.inetNext = port + 1 > hi ? lo : port + 1;
  } else if (!free(port)) fail(ERR.ADDRINUSE);
  let at = table.get(port);
  if (!at) table.set(port, (at = new Set()));
  at.add(s);
  s.port = {table, port};
  s.local = {ip, port};
}

/** Where a loopback socket's connection or datagram to `target` goes: this machine's own address, or nowhere. */
function reachable(s: Endpoint, target: Address): {ip: Uint8Array; port: number} {
  const given = ipOf(target);
  // To any address is to this machine's (Linux connects to its own).
  const ip = isAny(given) ? (mapped(given) || s.family === AF.INET ? LOOPBACK4 : LOOPBACK6) : given;
  if (!isLoopback(ip)) fail(ERR.NETUNREACH);
  if (s.family === AF.INET6 && mapped(ip) && s.options.v6only) fail(ERR.NETUNREACH);
  return {ip, port: target.port ?? 0};
}

/**
 * The socket that takes what comes to `target`: a listener (TCP), or one bound there (UDP: one connected takes only
 * what comes `from` its peer); an exact address first.
 */
function boundAt(kernel: Kern, protocol: number, target: {ip: Uint8Array; port: number}, listening: boolean, from: {ip: Uint8Array; port: number} | null = null): Endpoint | null {
  let wild: Endpoint | null = null;
  for (const s of portsOf(kernel, protocol).get(target.port) ?? []) {
    if (s.closed || (listening && s.state !== 'listening')) continue;
    if (from && s.remote && !(same(ipOf(s.remote), from.ip) && s.remote.port === from.port)) continue;
    const ip = ipOf(s.local);
    if (same(ip, target.ip)) return s;
    if (reachedAt(s, ip, target.ip)) wild ??= s;
  }
  return wild;
}

// ---- moving bytes ----

const nonblocking = (d: Description, flags: number): boolean => !!(d.flags & O_NONBLOCK) || !!(flags & MSG.DONTWAIT);

/** What a pipe holds, copied without taking it (MSG_PEEK). */
function peek(pipe: Pipe, into: Uint8Array, at: number, n: number): number {
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
/** What a receive took: how much, the message's whole, the sender's address, descriptors and credentials. */
interface Received { n: number; size: number; from: Uint8Array | null; rights: Description[]; creds: Creds | null }

function receive(p: Proc, d: Description & {sock: Endpoint}, into: Uint8Array, at: number, length: number, flags: number): Received {
  const s = d.sock, none: Received = {n: 0, size: 0, from: null, rights: [], creds: null};
  if (s.state === 'listening' || (s.connectionWanted && s.state !== 'connected')) fail(ERR.NOTCONN);
  if (s.shut.rd) return none;
  const wait = (): never => { if (nonblocking(d, flags)) fail(E.AGAIN); throw new Wait(); };
  if (s.rx instanceof Pipe) {
    const pipe = s.rx, state = p.call?.state ?? {};
    const done = state.done ?? 0;
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
    const rights: Description[] = [];
    for (const r of s.rights.filter((x) => x.at >= from && x.at < s.consumed)) { rights.push(...r.descs); s.rights.splice(s.rights.indexOf(r), 1); }
    const got = done + k;
    if ((flags & MSG.WAITALL) && got < length && pipe.writers && !rights.length) { state.done = got; p.kernel.dirty = true; wait(); }
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
function broken(p: Proc, flags: number, done: number): number {
  if (!(flags & MSG.NOSIGNAL)) send(p.kernel, p, SIG.PIPE, {code: SI.USER, pid: p.pid, uid: 0}, p.task);
  if (done) return done;
  return fail(E.PIPE);
}

/**
 * A datagram from loopback socket `s` to `target`, as UDP's: to the socket bound there, or lost. None there, a
 * connected sender is told (ECONNREFUSED at its next call, as the port-unreachable that comes back tells it on
 * Linux); a receiver with no room drops it (a UDP sender never waits on its receiver).
 */
function datagram(p: Proc, s: Endpoint, data: Uint8Array, target: Address): number {
  if (data.length > (s.family === AF.INET ? 65507 : 65527)) fail(ERR.MSGSIZE);
  const to = reachable(s, target);
  if (!s.local) bindInet(s, s.family === AF.INET ? ANY4 : ANY6, 0);
  const own = ipOf(s.local);
  const from = {ip: isAny(own) ? (mapped(to.ip) ? LOOPBACK4 : LOOPBACK6) : own, port: s.local?.port ?? 0};
  const r = boundAt(p.kernel, IPPROTO.UDP, to, false, from);
  if (!r) {
    if (s.remote) { s.error = ERR.CONNREFUSED; s.events++; }
    return data.length;
  }
  const t = traffic(p.kernel);
  t.bytes += data.length;
  t.packets++;
  if (r.rx instanceof Messages && r.rx.fits(data.length) && !r.shut.rd) r.rx.push({bytes: data.slice(), from, rights: [], creds: s.creds});
  return data.length;
}

/** A UDP socket's pending error, taken (it is said once). */
function pendingError(s: Endpoint): void {
  const e = s.error;
  s.error = 0;
  if (e) { s.events++; fail(e); }
}

// ---- ICMP over loopback ----

/** The Internet checksum of `bytes` (and `sum` so far): ones' complement of the ones' complement sum of its words. */
function checksum(bytes: Uint8Array, sum = 0): number {
  for (let k = 0; k + 1 < bytes.length; k += 2) sum += (bytes[k] << 8) | bytes[k + 1];
  if (bytes.length & 1) sum += bytes[bytes.length - 1] << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}
/** ICMPv6's checksum of `icmp` from `src` to `dst`: over its pseudo-header too. */
function checksum6(src: Uint8Array, dst: Uint8Array, icmp: Uint8Array): number {
  const pseudo = new Uint8Array(40 + icmp.length);
  pseudo.set(src, 0);
  pseudo.set(dst, 16);
  new DataView(pseudo.buffer).setUint32(32, icmp.length, false);
  pseudo[39] = IPPROTO.ICMPV6;
  pseudo.set(icmp, 40);
  pseudo[42] = pseudo[43] = 0;
  return checksum(pseudo);
}
let packetIds = 1;
/** An IPv4 header for `icmp` from `src` to `dst` (both 16-byte, v4-mapped), as a raw socket reads it before. */
function ipv4(src: Uint8Array, dst: Uint8Array, icmp: Uint8Array, dontFragment: boolean): Uint8Array {
  const h = new Uint8Array(20), v = new DataView(h.buffer);
  h[0] = 0x45;
  v.setUint16(2, 20 + icmp.length, false);
  v.setUint16(4, packetIds++ & 0xffff, false);
  if (dontFragment) h[6] = 0x40;
  h[8] = HOPS;
  h[9] = IPPROTO.ICMP;
  h.set(src.subarray(12), 12);
  h.set(dst.subarray(12), 16);
  v.setUint16(10, checksum(h), false);
  const out = new Uint8Array(20 + icmp.length);
  out.set(h);
  out.set(icmp, 20);
  return out;
}

/** An ICMP message of `family` arriving on lo from `src` for `dst`: to each raw socket that takes it (as Linux's raw_v4_input). */
function arrive(kernel: Kern, family: number, icmp: Uint8Array, src: Uint8Array, dst: Uint8Array, request: boolean): void {
  const t = traffic(kernel);
  t.packets++;
  t.bytes += icmp.length + (family === AF.INET ? 20 : 40);
  const wire = family === AF.INET ? ipv4(src, dst, icmp, request) : null;
  for (const r of kernel.sockets ?? []) {
    if (r.closed || r.type !== SOCK.RAW || r.family !== family || r.shut.rd || !(r.rx instanceof Messages)) continue;
    if (r.local && !isAny(ipOf(r.local)) && !same(ipOf(r.local), dst)) continue;
    if (r.remote && !same(ipOf(r.remote), src)) continue;
    const type = icmp[0];
    if (r.filter && (typeof r.filter === 'number' ? type < 32 && r.filter & (1 << type) : r.filter[type >> 3] & (1 << (type & 7)))) continue;
    const bytes = wire ?? icmp.slice();
    if (r.rx.fits(bytes.length)) r.rx.push({bytes, from: {ip: src, port: 0}, rights: [], creds: null});
  }
}

/** ICMP sent by raw socket `s` to `target`: it arrives on lo, and an echo request is answered (as icmp_echo). */
function icmp(s: Endpoint, data: Uint8Array, target: Address | null): number {
  if (!target) return fail(ERR.DESTADDRREQ);
  const to = reachable(s, target), v4 = s.family === AF.INET;
  const src = s.local && !isAny(ipOf(s.local)) ? ipOf(s.local) : v4 ? LOOPBACK4 : LOOPBACK6;
  const message = data.slice();
  // ICMPv6's checksum is the kernel's to make; ICMP's, the sender's.
  if (!v4 && message.length >= 4) new DataView(message.buffer).setUint16(2, checksum6(src, to.ip, message), false);
  arrive(s.kernel, s.family, message, src, to.ip, true);
  const ECHO = v4 ? 8 : 128;
  if (message.length >= 8 && message[0] === ECHO && message[1] === 0) {
    const reply = message.slice();
    reply[0] = v4 ? 0 : 129;
    reply[2] = reply[3] = 0;
    new DataView(reply.buffer).setUint16(2, v4 ? checksum(reply) : checksum6(to.ip, src, reply), false);
    arrive(s.kernel, s.family, reply, to.ip, src, false);
  }
  return data.length;
}

// ---- netlink ----

/** A netlink socket's port: the one asked for, or (0) its process's pid if free, else one of the kernel's own. */
function bindNetlink(p: Proc, s: Endpoint, portid: number, groups: number): void {
  const ports = (p.kernel.netlinkPorts ??= new Map());
  if (!portid) {
    portid = p.pid;
    for (let n = 0xfffff000; ports.has(portid); n--) portid = n >>> 0;
  } else if (ports.has(portid)) fail(ERR.ADDRINUSE);
  ports.set(portid, s);
  s.local = {portid, groups};
}

/** A netlink request from `s`: the kernel's answers come back to it at once (nothing changes, so none is an event). */
function netlinkSend(p: Proc, s: Endpoint, data: Uint8Array, to: Address | null): number {
  if (!s.local) bindNetlink(p, s, 0, 0);
  const target = to ?? s.remote;
  // To another socket rather than the kernel: none takes it here.
  if (target?.portid) fail(ERR.CONNREFUSED);
  for (const bytes of answer(p.kernel, s.protocol, s.local?.portid ?? 0, data)) {
    if (s.rx instanceof Messages && s.rx.fits(bytes.length)) s.rx.push({bytes, from: {portid: 0, groups: 0}, rights: [], creds: null});
  }
  return data.length;
}

/** Send `data` from `d` (to `to`, an address, for a datagram socket not connected), with descriptors `rights`: how much went. */
function transmit(p: Proc, d: Description & {sock: Endpoint}, data: Uint8Array, flags: number, to: Given | null = null, rights: Description[] = []): number {
  const s = d.sock, wait = (): never => { if (nonblocking(d, flags)) fail(E.AGAIN); throw new Wait(); };
  if (rights.length && !(s.family === AF.UNIX)) fail(E.INVAL);
  if (s.netlink) return netlinkSend(p, s, data, to);
  if (s.type === SOCK.RAW) { pendingError(s); return icmp(s, data, to ?? s.remote); }
  const own = () => rights.map((r) => { if (r.kind === 'socket') p.kernel.socketsPassed = true; return r.retain(); });
  if (s.type === SOCK.DGRAM) {
    if (s.inet) {
      pendingError(s);
      if (s.shut.wr) return broken(p, flags, 0);
      const target = to ?? s.remote;
      if (!target) return fail(ERR.DESTADDRREQ);
      return datagram(p, s, data, target);
    }
    const target = to ? namedBy(p, to) : s.peer;
    if (!target) return fail(ERR.NOTCONN);
    if (target.closed) fail(ERR.CONNREFUSED);
    if (target.type !== SOCK.DGRAM) fail(ERR.PROTOTYPE);
    // Connected to another, it takes nothing from this one.
    if (target.peer && target.peer !== s) fail(E.PERM);
    if (data.length > MESSAGE_ROOM) fail(ERR.MSGSIZE);
    if (!(target.rx instanceof Messages)) return fail(ERR.PROTOTYPE);
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
    if (!(peer.rx instanceof Messages)) return fail(ERR.PROTOTYPE);
    if (!peer.rx.fits(data.length)) wait();
    peer.rx.push({bytes: data.slice(), from: s.local, rights: own(), creds: s.creds});
    return data.length;
  }
  // A stream: what fits, then the rest once there is room (all of it unless it does not wait).
  if (!(peer.rx instanceof Pipe)) return fail(ERR.PROTOTYPE);
  const wrote = done + peer.rx.write(data.subarray(done));
  // Its descriptors go with the first byte it takes, where that byte lies, and once: a send that took none (the
  // peer full, nothing to send) passes none, however often it is asked again, and one that waited and goes on
  // has passed them already (kept in the call's own state, not read off how much went).
  if (rights.length && wrote > done && !state.passed) {
    peer.rights.push({at: peer.arrived, descs: own()});
    state.passed = true;
  }
  peer.arrived += wrote - done;
  if (s.inet && wrote > done) { const t = traffic(p.kernel); t.bytes += wrote - done; t.packets++; }
  if (wrote === data.length) return wrote;
  if (nonblocking(d, flags)) return wrote || fail(E.AGAIN);
  if (wrote > done) p.kernel.dirty = true;
  state.done = wrote;
  throw new Wait();
}

// ---- for sys-file.ts ----

/** read and readv of a socket: recv without flags. */
export function read(p: Proc, d: Description, into: Uint8Array, at: number, length: number): number {
  const r = receive(p, d as Description & {sock: Endpoint}, into, at, length, 0);
  // Descriptors that came with what a plain read took are let go (as Linux drops them).
  for (const x of r.rights) x.release();
  return r.n;
}
/** write and writev of a socket: send without flags. */
export const write = (p: Proc, d: Description, data: Uint8Array): number => transmit(p, d as Description & {sock: Endpoint}, data, 0);

/** What a socket is ready for, as poll's bits. */
export function ready(d: Description): number {
  const s = d.sock!;
  if (s.state === 'listening') return s.backlog.length ? POLL.IN : 0;
  let r = 0;
  const has = s.rx instanceof Pipe ? s.rx.size > 0 : s.rx.list.length > 0;
  if (has) r |= POLL.IN;
  if (!s.connectionWanted) {
    const target = s.peer;
    if (!target || target.closed || target.rx.writable) r |= POLL.OUT;
    return s.error ? r | POLL.ERR : r;
  }
  if (s.state !== 'connected') return r | POLL.OUT | POLL.HUP;
  const ended = !s.rx.writers || s.shut.rd;
  if (ended) r |= POLL.IN | POLL.RDHUP;
  const gone = !s.peer || !s.peer.rx.readers || s.shut.wr;
  if (gone || s.peer?.rx.writable) r |= POLL.OUT;
  if (ended && gone) r |= POLL.HUP;
  return r;
}

export const changes = (d: Description): number => d.sock?.changes ?? 0;

/** fstat of a socket. */
export const stat = (d: Description) => ({mode: S_IFSOCK | 0o777, ino: d.sock?.ino ?? 0, nlink: 1, uid: 0, gid: 0, mtime: epoch(), isFile: false, isDir: false, isLink: false});

/** A socket's ioctl (FIONREAD aside, sys-file.ts's): SIOCOUTQ, and what an interface is (net-view.ts). */
export function control(p: Proc, _d: Description, request: number, arg: number): number {
  if (request === 0x5411) { p.view.setInt32(arg, 0, true); return 0; } // SIOCOUTQ: lo has taken it all
  const r = interfaceControl(p, request, arg);
  if (r === true) return 0;
  return fail(r === false ? E.NOTTY : -r);
}

/** FIONREAD (SIOCINQ): a stream's bytes waiting, or the next datagram's size. */
export const pending = (d: Description): number => {
  const rx = d.sock?.rx;
  return !rx ? 0 : rx instanceof Pipe ? rx.size : rx.list[0]?.bytes.length ?? 0;
};

// ---- the calls ----

/** The iovecs at `address`: [[base, length]]. */
function vectors(p: Proc, address: number, count: number): [number, number][] {
  if (count < 0 || count > 1024) fail(E.INVAL);
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) out.push([Number(p.view.getBigUint64(address + k * 16, true)), Number(p.view.getBigUint64(address + k * 16 + 8, true))]);
  return out;
}

/** The descriptors and credentials a msghdr's control data carries (SCM_RIGHTS, SCM_CREDENTIALS). */
function controls(p: Proc, at: number, length: number): Description[] {
  const rights: Description[] = [];
  for (let off = 0; off + 16 <= length;) {
    const len = Number(p.view.getBigUint64(at + off, true)), level = p.view.getInt32(at + off + 8, true), type = p.view.getInt32(at + off + 12, true);
    if (len < 16 || off + len > length) fail(E.INVAL);
    if (level === SOL_SOCKET && type === SCM.RIGHTS) {
      for (let k = 16; k + 4 <= len; k += 4) {
        const d = p.fds.get(p.view.getInt32(at + off + k, true));
        rights.push(d ?? fail(E.BADF));
      }
      if (rights.length > RIGHTS_MOST) fail(E.INVAL);
    } else if (!(level === SOL_SOCKET && type === SCM.CREDENTIALS)) fail(E.INVAL);
    off += (len + 7) & ~7;
  }
  return rights;
}

/** The address a datagram is sent to, when one is given (TCP's is not looked at; a local stream's is an error). */
function destination(p: Proc, s: Endpoint, address: bigint, length: bigint): Given | null {
  if (!N(address) || !N(length) || (s.inet && s.stream)) return null;
  const a = readAddress(p, s, address, length);
  return a.unspec ? null : a;
}

function sendmsg(p: Proc, fd: bigint, msg: bigint, flags: bigint): number {
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

/** `length` bytes at `at` are the guest's own memory, or EFAULT: asked before anything is taken that would be lost with it. */
function within(p: Proc, at: number, length: number): void {
  if (!(at >= 0 && length >= 0 && at + length <= p.bytes.length)) fail(E.FAULT);
}

function recvmsg(p: Proc, fd: bigint, msg: bigint, flags: bigint): number {
  const d = socketOf(p, fd), at = N(msg), v = p.view, f = N(flags);
  // Where it is to be put is looked at before anything is taken: a message taken off its queue and then not
  // written out (a place outside the guest's memory) would be gone, and the descriptors that came with it kept by
  // no one. The header, the places for its bytes, for who sent it and for its control data: each the guest's, or EFAULT.
  within(p, at, 56);
  const iovAt = Number(v.getBigUint64(at + 16, true)), iovCount = Number(v.getBigUint64(at + 24, true));
  if (iovCount < 0 || iovCount > 1024) fail(E.INVAL);
  within(p, iovAt, iovCount * 16);
  const iov = vectors(p, iovAt, iovCount);
  for (const [b, l] of iov) within(p, b, l);
  const nameAt = Number(v.getBigUint64(at, true)), nameRoom = nameAt ? v.getUint32(at + 8, true) : 0;
  within(p, nameAt, nameRoom);
  const control = Number(v.getBigUint64(at + 32, true)), room = control ? Number(v.getBigUint64(at + 40, true)) : 0;
  within(p, control, room);
  const total = iov.reduce((n, [, l]) => n + l, 0), buf = new Uint8Array(total);
  const r = receive(p, d, buf, 0, total, f & ~MSG.WAITALL);
  // What came is this call's to hand on or to let go, whatever happens from here: the descriptors still held for
  // the message, and those made this process's already.
  let held = r.rights;
  const made: number[] = [];
  try {
    return received(p, d, r, at, f, iov, buf, nameAt, nameRoom, control, room, made, () => { held = []; });
  } catch (e) {
    for (const x of held) x.release();
    for (const n of made) p.fds.close(n);
    throw e;
  }
}

/** recvmsg's second half: what `receive` took (`r`) written out to the guest (`made`: the descriptors installed; `handed`: called once the message's own hold on them is let go). */
function received(p: Proc, d: Description & {sock: Endpoint}, r: Received, at: number, f: number, iov: [number, number][], buf: Uint8Array,
  nameAt: number, nameRoom: number, control: number, room: number, made: number[], handed: () => void): number {
  const v = p.view;
  let off = 0;
  for (const [b, l] of iov) { if (off >= r.n) break; const k = Math.min(l, r.n - off); p.bytes.set(buf.subarray(off, off + k), b); off += k; }
  if (nameAt) {
    if (r.from) p.bytes.set(r.from.subarray(0, Math.min(nameRoom, r.from.length)), nameAt);
    v.setUint32(at + 8, r.from?.length ?? 0, true);
  }
  // Control data: the descriptors that came (each now one of this process's), and the sender's credentials if asked.
  let used = 0, outFlags = r.size > r.n && !d.sock.stream ? MSG.TRUNC : 0;
  const put = (type: number, words: (at: number) => void, size: number, level = SOL_SOCKET): boolean => {
    const len = 16 + size, space = (len + 7) & ~7;
    if (!control || used + len > room) { outFlags |= MSG.CTRUNC; return false; }
    v.setBigUint64(control + used, BigInt(len), true);
    v.setInt32(control + used + 8, level, true);
    v.setInt32(control + used + 12, type, true);
    words(control + used + 16);
    used += Math.min(space, room - used);
    return true;
  };
  if (r.rights.length) {
    for (const x of r.rights) made.push(p.fds.install(x, {cloexec: !!(f & MSG.CMSG_CLOEXEC)}));
    for (const x of r.rights) x.release();
    handed();
    if (!put(SCM.RIGHTS, (w) => made.forEach((n, k) => v.setInt32(w + 4 * k, n, true)), 4 * made.length)) { for (const n of made) p.fds.close(n); made.length = 0; }
  }
  const creds = r.creds;
  if (d.sock.options.passcred && creds) {
    put(SCM.CREDENTIALS, (w) => { v.setInt32(w, creds.pid, true); v.setUint32(w + 4, creds.uid, true); v.setUint32(w + 8, creds.gid, true); }, 12);
  }
  // Over lo a packet has gone no hop: the TTL and hop limit it was sent with.
  if (d.sock.inet && !d.sock.stream && d.sock.options.recvttl && d.sock.family === AF.INET) put(IP_TTL, (w) => v.setInt32(w, HOPS, true), 4, SOL.IP);
  if (d.sock.inet && !d.sock.stream && d.sock.options.recvhops) put(IPV6_HOPLIMIT, (w) => v.setInt32(w, HOPS, true), 4, SOL.IPV6);
  v.setBigUint64(at + 40, BigInt(used), true);
  v.setInt32(at + 48, outFlags, true);
  return f & MSG.TRUNC && !d.sock.stream ? r.size : r.n;
}

/** A loopback address's IP (an address of another family has none: EINVAL, as Linux says to a mismatch). */
const ipOf = (a: Address | null): Uint8Array => a?.ip ?? fail(E.INVAL);

/** accept4: the next connection waiting, a descriptor of its own, its peer's name told. */
function accept(p: Proc, fd: bigint, address: bigint, lengthAt: bigint, flags: bigint): number {
  const d = socketOf(p, fd), s = d.sock;
  if (s.state !== 'listening') fail(E.INVAL);
  const server = s.backlog.shift();
  if (!server) { if (d.flags & O_NONBLOCK) fail(E.AGAIN); throw new Wait(); }
  s.events++;
  const n = install(p, server, N(flags));
  writeName(p, address, lengthAt, encode(server, server.remote));
  return n;
}

/** connect of a stream socket to a listener: its other end queued for accept (named as the listener, its peer's credentials the caller's). */
function connectStream(p: Proc, d: Description, s: Endpoint, target: Given): number {
  // AF_UNSPEC: a TCP socket not connected stays so.
  if (target.unspec) return s.state !== 'connected' ? 0 : fail(ERR.ISCONN);
  // A connect it did not wait for is told its end once (0), as Linux's next connect tells it; then: connected.
  if (s.connecting) { s.connecting = false; return 0; }
  if (s.state === 'connected') fail(ERR.ISCONN);
  if (s.state === 'listening') fail(E.INVAL);
  let listener: Endpoint, at: {ip: Uint8Array; port: number} | null = null;
  if (s.inet) {
    at = reachable(s, target);
    listener = boundAt(p.kernel, IPPROTO.TCP, at, true) ?? fail(ERR.CONNREFUSED);
  } else {
    listener = namedBy(p, target);
    if (listener.type !== s.type) fail(ERR.PROTOTYPE);
    if (listener.state !== 'listening' || listener.closed) fail(ERR.CONNREFUSED);
  }
  if (listener.backlog.length >= listener.backlogMost) { if (d.flags & O_NONBLOCK) fail(E.AGAIN); throw new Wait(); }
  // A client not bound takes a port of its own, at its family's loopback address (the source Linux's `lo` gives).
  if (at && !s.local) bindInet(s, mapped(at.ip) ? LOOPBACK4 : LOOPBACK6, 0);
  const server = new Endpoint(p.kernel, listener.family, s.type, p);
  server.creds = listener.creds;
  server.options = {...listener.options};
  server.local = at ? {ip: at.ip, port: at.port} : listener.local;
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

export const NET_CALLS: Calls = {
  41(domain, type, protocol) { // socket
    const family = N(domain);
    const t = kindOf(family, N(type), N(protocol));
    return install(this, new Endpoint(this.kernel, family, t, this, t === SOCK.RAW || family === AF.NETLINK ? N(protocol) : null), N(type));
  },
  53(domain, type, protocol, sv) { // socketpair: the local family's alone
    const family = N(domain);
    if (family === AF.INET || family === AF.INET6 || family === AF.NETLINK) { kindOf(family, N(type), N(protocol)); fail(E.OPNOTSUPP); }
    if (family !== AF.UNIX) fail(E.AFNOSUPPORT);
    const t = kindOf(family, N(type), N(protocol));
    // Where the pair is told, and room for both its descriptors, are looked at before anything is made: one refused
    // here (EFAULT, EMFILE) leaves no socket in the kernel and no descriptor behind, not one end of two.
    within(this, N(sv), 8);
    const first = this.fds.lowest();
    if (first < 0 || this.fds.lowest(first + 1) < 0) fail(E.MFILE);
    const a = new Endpoint(this.kernel, family, t, this), b = new Endpoint(this.kernel, family, t, this);
    link(a, b);
    const fa = install(this, a, N(type)), fb = install(this, b, N(type));
    this.view.setInt32(N(sv), fa, true);
    this.view.setInt32(N(sv) + 4, fb, true);
    return 0;
  },
  49(fd, address, length) { // bind
    const s = socketOf(this, fd).sock;
    const a = readAddress(this, s, address, length);
    // A netlink socket bound again keeps its port and takes the groups it names (none of which says anything here).
    if (s.netlink) {
      if (!s.local) bindNetlink(this, s, a.portid ?? 0, a.groups ?? 0);
      else if (a.portid && a.portid !== s.local.portid) fail(E.INVAL);
      else s.local.groups = a.groups;
      return 0;
    }
    if (s.local && (s.inet || s.local.bytes)) fail(E.INVAL);
    if (a.unspec) fail(E.AFNOSUPPORT);
    // A raw socket's address is what it takes packets for; it holds no port.
    if (s.type === SOCK.RAW) {
      const ip = ipOf(a);
      if (!isAny(ip) && !isLoopback(ip)) fail(ERR.ADDRNOTAVAIL);
      s.local = {ip, port: 0};
      return 0;
    }
    if (s.inet) { bindInet(s, ipOf(a), a.port ?? 0); return 0; }
    if (a.abstract !== undefined) {
      const all = (this.kernel.abstractSockets ??= new Map());
      if (all.has(a.abstract)) fail(ERR.ADDRINUSE);
      all.set(a.abstract, s);
      s.abstract = a.abstract;
    } else {
      const r = this.kernel.vfs.resolve(a.path ?? '', this.here, false);
      if (r.node) fail(ERR.ADDRINUSE);
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
    if (!s.connectionWanted) fail(E.OPNOTSUPP);
    if (s.state === 'connected') fail(E.INVAL);
    // A loopback socket not bound yet takes a port of its own; a local one must be named.
    if (!s.local) { if (!s.inet) fail(E.INVAL); bindInet(s, s.family === AF.INET ? ANY4 : ANY6, 0); }
    s.state = 'listening';
    // As Linux: at most somaxconn (4096, or that for a negative one), and one more waits than it says.
    const b = N(backlog);
    s.backlogAsked = b < 0 || b > 4096 ? 4096 : b;
    s.backlogMost = s.backlogAsked + 1;
    s.events++;
    return 0;
  },
  42(fd, address, length) { // connect
    const d = socketOf(this, fd), s = d.sock;
    const a = readAddress(this, s, address, length);
    if (s.netlink) {
      if (!s.local) bindNetlink(this, s, 0, 0);
      s.remote = {portid: a.portid, groups: a.groups};
      return 0;
    }
    if (s.connectionWanted) return connectStream(this, d, s, a);
    if (s.inet) {
      // A datagram socket's peer: the one address it sends to and takes from (AF_UNSPEC: none again).
      if (a.unspec) { s.remote = null; s.state = 'unconnected'; s.events++; return 0; }
      const to = reachable(s, a);
      // Bound, if it was not, at its family's loopback address (a raw socket holds no port).
      if (!s.local && s.type !== SOCK.RAW) bindInet(s, mapped(to.ip) ? LOOPBACK4 : LOOPBACK6, 0);
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
  43(fd, address, lengthAt) { return accept(this, fd, address, lengthAt, 0n); }, // accept
  288(fd, address, lengthAt, flags) { return accept(this, fd, address, lengthAt, flags); }, // accept4
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
    // Netlink's own (NETLINK_EXT_ACK, NETLINK_GET_STRICT_CHK, a group joined): taken, none changes an answer here.
    if (s.netlink) return l === SOL.NETLINK ? 0 : fail(ERR.NOPROTOOPT);
    if (!s.inet) fail(ERR.NOPROTOOPT);
    if (s.type === SOCK.RAW) {
      // The ICMP types a raw socket does not want: ICMP_FILTER's mask, ICMP6_FILTER's 256 bits.
      if (l === SOL.RAW && n === ICMP_FILTER && s.family === AF.INET) { s.filter = N(length) >= 4 ? this.view.getUint32(N(value), true) : 0; return 0; }
      if (l === SOL.ICMPV6 && n === ICMP6_FILTER && s.family === AF.INET6) { s.filter = this.bytes.slice(N(value), N(value) + Math.min(32, N(length))); return 0; }
    }
    // What comes with a datagram: its TTL (IP_RECVTTL), its hop limit (IPV6_RECVHOPLIMIT).
    if (l === SOL.IP && n === IP_RECVTTL) { s.options.recvttl = on; return 0; }
    if (l === SOL.IPV6 && n === IPV6_RECVHOPLIMIT && s.family === AF.INET6) { s.options.recvhops = on; return 0; }
    if (l === IPPROTO.TCP && s.stream) { if (n === TCP_NODELAY) s.options.nodelay = on; return 0; }
    if (l === IPPROTO.IPV6 && s.family === AF.INET6) {
      if (n === IPV6_V6ONLY) { if (s.local) fail(E.INVAL); s.options.v6only = on; }
      return 0;
    }
    if (l === IPPROTO.IP || l === IPPROTO.IPV6 || (l === IPPROTO.UDP && !s.stream)) return 0;
    return fail(ERR.NOPROTOOPT);
  },
  55(fd, level, name, value, lengthAt) { // getsockopt
    const s = socketOf(this, fd).sock, v = this.view, l = N(level), n = N(name);
    const have = v.getUint32(N(lengthAt), true);
    let bytes: Uint8Array;
    const int = (x: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, x, true); return b; };
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
        default: return fail(ERR.NOPROTOOPT);
      }
    } else if (s.inet && l === IPPROTO.TCP && s.stream && n === TCP_NODELAY) bytes = int(s.options.nodelay ? 1 : 0);
    else if (s.family === AF.INET6 && l === IPPROTO.IPV6 && n === IPV6_V6ONLY) bytes = int(s.options.v6only ? 1 : 0);
    else return fail(ERR.NOPROTOOPT);
    this.bytes.set(bytes.subarray(0, Math.min(have, bytes.length)), N(value));
    v.setUint32(N(lengthAt), Math.min(have, bytes.length), true);
    return 0;
  },
};
