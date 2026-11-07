// What a program is told of the machine's network, as Linux tells it of a machine with only its loopback: one
// interface (lo, index 1, up, 127.0.0.1/8 and ::1/128), the routes the kernel makes for it, and the sockets on it.
//
//   netlink (NETLINK_ROUTE)      RTM_GETLINK, RTM_GETADDR, RTM_GETROUTE, RTM_GETRULE: what `ip` reads; a change
//                                (an address added, a route) is not made here (EOPNOTSUPP)
//   netlink (NETLINK_SOCK_DIAG)  the TCP, UDP and local sockets of this kernel: what `ss` reads
//   ioctl (SIOCGIF*)             an interface by its name or index: what if_nametoindex, getifaddrs's elders and
//                                ifconfig ask
//   /proc/net                    dev, if_inet6, route, tcp, tcp6, udp, udp6, unix, raw, sockstat, ...
//
// The sockets are sys-net.ts's (its Endpoint), read here and never changed: this module makes answers, no calls.

const enc = new TextEncoder();
const AF = {UNSPEC: 0, UNIX: 1, INET: 2, INET6: 10, NETLINK: 16};
const SOCK = {STREAM: 1, DGRAM: 2, RAW: 3, SEQPACKET: 5};
const IPPROTO = {TCP: 6, UDP: 17, ICMP: 1, ICMPV6: 58};
const E = {PERM: 1, NOENT: 2, NODEV: 19, INVAL: 22, OPNOTSUPP: 95, NETUNREACH: 101};

/**
 * A socket's address, as its family has one: a local socket's name (`bytes`: sockaddr_un's path, null when it has
 * none), a loopback socket's IP (16 bytes, an IPv4 one mapped) and port, a netlink socket's port and groups.
 */
export interface Address { bytes?: Uint8Array | null; ip?: Uint8Array; port?: number; portid?: number; groups?: number }
/** A loopback socket's address. */
export interface Inet { ip: Uint8Array; port: number }
const inet = (a: Address | null): Inet | null => (a?.ip ? {ip: a.ip, port: a.port ?? 0} : null);

/** A socket as the tables read it (sys-net.ts's Endpoint). */
export interface Seen {
  readonly state: 'unconnected' | 'listening' | 'connected';
  readonly type: number;
  readonly family: number;
  readonly protocol: number;
  readonly ino: number;
  readonly closed: boolean;
  readonly rx: {writers: number; size: number};
  readonly shut: {rd: boolean; wr: boolean};
  readonly backlog: readonly {peer: {ino: number} | null}[];
  readonly backlogAsked: number;
  readonly local: Address | null;
  readonly remote: Address | null;
  readonly peer: {ino: number} | null;
}
/** What the tables read of the kernel: its sockets, and what has moved over lo. */
export interface Net { sockets?: Iterable<Seen>; loopbackTraffic?: {bytes: number; packets: number} }

/** The one interface, as Linux has lo. */
const LO = {
  index: 1, name: 'lo', mtu: 65536, txqlen: 1000, type: 772, // ARPHRD_LOOPBACK
  flags: 0x1 | 0x8 | 0x40 | 0x10000, // IFF_UP, IFF_LOOPBACK, IFF_RUNNING, IFF_LOWER_UP
  ipv4: [127, 0, 0, 1], netmask: [255, 0, 0, 0], ipv6: [...Array(15).fill(0), 1],
};

/** What has moved over lo since the kernel began (each send a packet): /proc/net/dev's and IFLA_STATS64's. */
export const traffic = (kernel: Net): {bytes: number; packets: number} => (kernel.loopbackTraffic ??= {bytes: 0, packets: 0});

// ---- the sockets, as diagnostics name their states (TCP's numbers, which Linux gives every socket) ----

const TCP = {ESTABLISHED: 1, FIN_WAIT2: 5, CLOSE: 7, CLOSE_WAIT: 8, LISTEN: 10};

/** A socket's state as Linux's tables say it (a TCP one half closed: CLOSE_WAIT, FIN_WAIT2; a local one stays). */
function stateOf(s: Seen): number {
  if (s.state === 'listening') return TCP.LISTEN;
  if (s.state !== 'connected') return TCP.CLOSE;
  const tcp = s.type === SOCK.STREAM && s.family !== AF.UNIX;
  if (tcp && !s.rx.writers) return TCP.CLOSE_WAIT;
  if (tcp && s.shut.wr) return TCP.FIN_WAIT2;
  return TCP.ESTABLISHED;
}
/** What waits to be read on a socket (a listener's: connections not accepted yet). */
const queued = (s: Seen): number => (s.state === 'listening' ? s.backlog.length : s.rx.size);
/** A listener's backlog as asked (what ss says as its Send-Q); nothing else waits to be sent, lo has taken it. */
const room = (s: Seen): number => (s.state === 'listening' ? s.backlogAsked : 0);

const live = (kernel: Net): Seen[] => [...(kernel.sockets ?? [])].filter((s) => !s.closed);
/** The internet sockets of one family and protocol that a table lists: bound or connected (TCP: not just made). */
const inetOf = (kernel: Net, family: number, protocol: number): Seen[] => live(kernel).filter((s) => s.family === family && s.protocol === protocol
  && s.type !== SOCK.RAW && (s.local || s.remote) && (protocol !== IPPROTO.TCP || s.state !== 'unconnected'));

// ---- bytes ----

const u8 = (x: number): Uint8Array => Uint8Array.of(x & 0xff);
const u16 = (x: number): Uint8Array => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, x, true); return b; };
const be16 = (x: number): Uint8Array => Uint8Array.of((x >> 8) & 0xff, x & 0xff);
const u32 = (x: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x >>> 0, true); return b; };
const i32 = (x: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, x, true); return b; };
const zeros = (n: number): Uint8Array => new Uint8Array(n);
const cstr = (s: string): Uint8Array => { const b = enc.encode(s); const out = new Uint8Array(b.length + 1); out.set(b); return out; };
const pad4 = (n: number): number => (n + 3) & ~3;
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** A netlink attribute: its length and type, then its value, padded to four bytes. */
function attr(type: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(pad4(4 + value.length));
  out.set(u16(4 + value.length), 0);
  out.set(u16(type), 2);
  out.set(value, 4);
  return out;
}
/** A netlink message: nlmsghdr, then its body (padded). */
function message(type: number, flags: number, seq: number, portid: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(pad4(16 + body.length));
  const v = new DataView(out.buffer);
  v.setUint32(0, 16 + body.length, true);
  v.setUint16(4, type, true);
  v.setUint16(6, flags, true);
  v.setUint32(8, seq, true);
  v.setUint32(12, portid, true);
  out.set(body, 16);
  return out;
}
/** The attributes in `bytes` from `at`: type -> value. */
function attrs(bytes: Uint8Array, at: number): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>(), v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 4 <= bytes.length) {
    const len = v.getUint16(at, true);
    if (len < 4 || at + len > bytes.length) break;
    out.set(v.getUint16(at + 2, true) & 0x3fff, bytes.subarray(at + 4, at + len));
    at += pad4(len);
  }
  return out;
}
const textOf = (value: Uint8Array): string => new TextDecoder().decode(value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)));

// ---- NETLINK_ROUTE ----

const NLM = {REQUEST: 1, MULTI: 2, ACK: 4, DUMP: 0x300};
const NLMSG = {NOOP: 1, ERROR: 2, DONE: 3};
const RTM = {NEWLINK: 16, GETLINK: 18, NEWADDR: 20, GETADDR: 22, NEWROUTE: 24, GETROUTE: 26, NEWRULE: 32, GETRULE: 34};

function link(): Uint8Array {
  const info = concat([u8(AF.UNSPEC), u8(0), u16(LO.type), i32(LO.index), u32(LO.flags), u32(0)]);
  return concat([info,
    attr(3, cstr(LO.name)), // IFLA_IFNAME
    attr(13, u32(LO.txqlen)), // IFLA_TXQLEN
    attr(16, u8(0)), // IFLA_OPERSTATE: unknown, as lo's
    attr(17, u8(0)), // IFLA_LINKMODE
    attr(4, u32(LO.mtu)), // IFLA_MTU
    attr(50, u32(0)), attr(51, u32(0)), // IFLA_MIN_MTU, IFLA_MAX_MTU
    attr(27, u32(0)), // IFLA_GROUP
    attr(30, u32(0)), // IFLA_PROMISCUITY
    attr(31, u32(1)), attr(32, u32(1)), // IFLA_NUM_TX_QUEUES, IFLA_NUM_RX_QUEUES
    attr(33, u8(1)), // IFLA_CARRIER
    attr(6, cstr('noqueue')), // IFLA_QDISC
    attr(1, zeros(6)), attr(2, zeros(6)), // IFLA_ADDRESS, IFLA_BROADCAST
  ]);
}
function linkStats(kernel: Net): Uint8Array {
  // IFLA_STATS64: rx and tx packets and bytes (lo's are each other's), the rest none.
  const t = traffic(kernel), s = new BigUint64Array(25);
  s[0] = s[1] = BigInt(t.packets);
  s[2] = s[3] = BigInt(t.bytes);
  return attr(23, new Uint8Array(s.buffer));
}

const FOREVER = 0xffffffff;
function addresses(family: number): Uint8Array[] {
  const cache = concat([u32(FOREVER), u32(FOREVER), u32(0), u32(0)]); // IFA_CACHEINFO: preferred, valid, made, changed
  const out: Uint8Array[] = [];
  if (family === AF.UNSPEC || family === AF.INET) {
    out.push(concat([u8(AF.INET), u8(8), u8(0x80), u8(254), u32(LO.index), // permanent, scope host
      attr(1, Uint8Array.from(LO.ipv4)), attr(2, Uint8Array.from(LO.ipv4)), attr(3, cstr(LO.name)), attr(8, u32(0x80)), attr(6, cache)]));
  }
  if (family === AF.UNSPEC || family === AF.INET6) {
    out.push(concat([u8(AF.INET6), u8(128), u8(0x80), u8(254), u32(LO.index),
      attr(1, Uint8Array.from(LO.ipv6)), attr(6, cache), attr(8, u32(0x80 | 0x200))])); // permanent, noprefixroute
  }
  return out;
}

/** A route: rtmsg (family, prefix, table, protocol, scope, type) and its attributes. */
function route(family: number, prefix: number, table: number, scope: number, type: number, more: Uint8Array[]): Uint8Array {
  return concat([u8(family), u8(prefix), u8(0), u8(0), u8(table), u8(2), u8(scope), u8(type), u32(0), attr(15, u32(table)), ...more]);
}
const LOCAL = 255, MAIN = 254, DEFAULT = 253;
function routes(family: number): Uint8Array[] {
  const v4 = (...ip: number[]): Uint8Array => Uint8Array.from(ip), oif = attr(4, u32(LO.index)), src = attr(7, Uint8Array.from(LO.ipv4));
  const six = Uint8Array.from(LO.ipv6), out: Uint8Array[] = [];
  if (family === AF.UNSPEC || family === AF.INET) {
    // The local table's (lo's addresses, its broadcast); the main table has none.
    out.push(route(AF.INET, 8, LOCAL, 254, 2, [attr(1, v4(127, 0, 0, 0)), src, oif]));
    out.push(route(AF.INET, 32, LOCAL, 254, 2, [attr(1, v4(127, 0, 0, 1)), src, oif]));
    out.push(route(AF.INET, 32, LOCAL, 253, 3, [attr(1, v4(127, 255, 255, 255)), src, oif]));
  }
  if (family === AF.UNSPEC || family === AF.INET6) {
    out.push(route(AF.INET6, 128, MAIN, 0, 1, [attr(1, six), attr(6, u32(256)), oif, attr(20, u8(0))]));
    out.push(route(AF.INET6, 128, LOCAL, 0, 2, [attr(1, six), attr(6, u32(0)), oif, attr(20, u8(0))]));
  }
  return out;
}
function rules(family: number): Uint8Array[] {
  // fib_rule_hdr (family, lengths, tos, table, action: to a table, flags), its table and priority.
  const rule = (f: number, priority: number, table: number): Uint8Array => concat([u8(f), u8(0), u8(0), u8(0), u8(table), u8(0), u8(0), u8(1), u32(0), attr(15, u32(table)), attr(6, u32(priority))]);
  const out: Uint8Array[] = [];
  if (family === AF.UNSPEC || family === AF.INET) out.push(rule(AF.INET, 0, LOCAL), rule(AF.INET, 32766, MAIN), rule(AF.INET, 32767, DEFAULT));
  if (family === AF.UNSPEC || family === AF.INET6) out.push(rule(AF.INET6, 0, LOCAL), rule(AF.INET6, 32766, MAIN));
  return out;
}

/**
 * The route `ip route get` is told for `dst` (an address of `family`), or the error: a clone of the local route
 * (RTM_F_CLONED, and RTCF_LOCAL above it), in the main table unless the lookup's own was asked for (as Linux).
 */
function routeTo(family: number, dst: Uint8Array | undefined): Uint8Array | number {
  const oif = attr(4, u32(LO.index)), flags = u32((0x80000000 | 0x200) >>> 0);
  if (dst && family === AF.INET && dst.length === 4 && dst[0] === 127) {
    return concat([u8(AF.INET), u8(32), u8(0), u8(0), u8(MAIN), u8(0), u8(254), u8(2), flags,
      attr(15, u32(MAIN)), attr(1, dst), oif, attr(7, Uint8Array.from(LO.ipv4)), attr(25, u32(0))]); // RTA_UID
  }
  if (dst && family === AF.INET6 && dst.length === 16 && dst.every((b, k) => b === LO.ipv6[k])) {
    return concat([u8(AF.INET6), u8(128), u8(0), u8(0), u8(MAIN), u8(0), u8(0), u8(2), u32(0x200),
      attr(15, u32(MAIN)), attr(1, dst), oif, attr(6, u32(0)), attr(25, u32(0)), attr(20, u8(0))]);
  }
  return -E.NETUNREACH;
}

// ---- NETLINK_SOCK_DIAG ----

const SOCK_DIAG_BY_FAMILY = 20;

function inetDiag(kernel: Net, family: number, protocol: number, states: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const s of inetOf(kernel, family, protocol)) {
    const st = stateOf(s);
    if (!(states & (1 << st))) continue;
    const ip = (a: Inet | null): Uint8Array => { const b = zeros(16); if (a) b.set(family === AF.INET ? a.ip.subarray(12) : a.ip); return b; };
    const local = inet(s.local), remote = inet(s.remote);
    out.push(concat([u8(family), u8(st), u8(0), u8(0), be16(local?.port ?? 0), be16(remote?.port ?? 0), ip(local), ip(remote),
      u32(0), u32(s.ino), u32(0), u32(0), u32(queued(s)), u32(room(s)), u32(0), u32(s.ino), attr(8, u8((s.shut.rd ? 1 : 0) | (s.shut.wr ? 2 : 0)))]));
  }
  return out;
}
function unixDiag(kernel: Net, states: number, show: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const s of live(kernel).filter((x) => x.family === AF.UNIX)) {
    const st = stateOf(s);
    if (!(states & (1 << st))) continue;
    const more: Uint8Array[] = [], name = s.local?.bytes;
    if (show & 1 && name) more.push(attr(0, name[0] === 0 ? name : cstr(new TextDecoder().decode(name))));
    if (show & 4 && s.peer) more.push(attr(2, u32(s.peer.ino)));
    if (show & 8 && s.state === 'listening') more.push(attr(3, concat(s.backlog.map((x) => u32(x.peer?.ino ?? 0)))));
    if (show & 16) more.push(attr(4, concat([u32(queued(s)), u32(room(s))])));
    more.push(attr(6, u8((s.shut.rd ? 1 : 0) | (s.shut.wr ? 2 : 0))));
    out.push(concat([u8(AF.UNIX), u8(s.type), u8(st), u8(0), u32(s.ino), u32(s.ino), u32(0), ...more]));
  }
  return out;
}

/**
 * The kernel's answers to netlink request `bytes` from a socket of `protocol` with port `portid`: datagrams, each
 * one or more messages (a dump's items and its NLMSG_DONE together, as one read takes them).
 */
export function answer(kernel: Net, protocol: number, portid: number, bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [], v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 16 <= bytes.length;) {
    const len = v.getUint32(at, true);
    if (len < 16 || at + len > bytes.length) break;
    const errno = request(kernel, protocol, portid, bytes.subarray(at, at + len), out);
    const flags = v.getUint16(at + 6, true);
    // An error, or an ack asked for: NLMSG_ERROR (an ack carries the request's header alone, NLM_F_CAPPED).
    if (errno || (errno === 0 && flags & NLM.ACK)) {
      out.push(message(NLMSG.ERROR, errno ? 0 : 0x100, v.getUint32(at + 8, true), portid, concat([i32(errno), errno ? bytes.subarray(at, at + len) : bytes.subarray(at, at + 16)])));
    }
    at += pad4(len);
  }
  return out;
}

/** One request (`m`: its header and body): its answers pushed to `out`; 0, an errno to say, or null (nothing to say). */
function request(kernel: Net, protocol: number, portid: number, m: Uint8Array, out: Uint8Array[]): number | null {
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const type = v.getUint16(4, true), flags = v.getUint16(6, true), seq = v.getUint32(8, true), body = m.subarray(16);
  if (type < 16 || !(flags & NLM.REQUEST)) return null; // NOOP, DONE, ERROR, and what is not a request
  const word = (k: number): number => (body.length >= k + 4 ? v.getUint32(16 + k, true) : 0);
  const dump = (kind: number, items: Uint8Array[]): null => {
    out.push(concat([...items.map((b) => message(kind, NLM.MULTI, seq, portid, b)), message(NLMSG.DONE, NLM.MULTI, seq, portid, i32(0))]));
    return null;
  };
  const one = (kind: number, b: Uint8Array): number => { out.push(message(kind, 0, seq, portid, b)); return 0; };
  const family = body[0] ?? AF.UNSPEC, isDump = (flags & NLM.DUMP) === NLM.DUMP;
  if (protocol === 4) { // NETLINK_SOCK_DIAG
    if (type !== SOCK_DIAG_BY_FAMILY || !isDump) return -E.INVAL;
    if (family === AF.UNIX) return dump(type, unixDiag(kernel, word(4), word(12)));
    if ((family === AF.INET || family === AF.INET6) && (body[1] === IPPROTO.TCP || body[1] === IPPROTO.UDP)) return dump(type, inetDiag(kernel, family, body[1], word(4)));
    return -E.NOENT;
  }
  if ((type & 3) !== 2) return -E.OPNOTSUPP; // a change (a link set, an address or route added): not made here
  if (isDump) {
    // A link dump is the same whatever family it names (Linux keeps only PF_UNSPEC's).
    if (type === RTM.GETLINK) return dump(RTM.NEWLINK, [concat([link(), linkStats(kernel)])]);
    if (type === RTM.GETADDR) return dump(RTM.NEWADDR, addresses(family));
    if (type === RTM.GETROUTE) return dump(RTM.NEWROUTE, routes(family));
    if (type === RTM.GETRULE) return dump(RTM.NEWRULE, rules(family));
    return dump(type - 2, []); // neighbours, queues, the rest: none on lo
  }
  if (type === RTM.GETLINK) {
    const index = body.length >= 8 ? v.getInt32(20, true) : 0, a = attrs(body, 16), name = a.get(3) ?? a.get(53);
    if ((index && index !== LO.index) || (name && textOf(name) !== LO.name) || (!index && !name)) return -E.NODEV;
    return one(RTM.NEWLINK, concat([link(), linkStats(kernel)]));
  }
  if (type === RTM.GETROUTE) {
    const r = routeTo(family, attrs(body, 12).get(1));
    return typeof r === 'number' ? r : one(RTM.NEWROUTE, r);
  }
  return -E.OPNOTSUPP;
}

// ---- ioctl: an interface by name or index ----

const IFREQ = 40;
/** A socket ioctl about interfaces (`request`, its ifreq at `arg`): true when it was one, an errno when it fails. */
export function interfaceControl(p: {view: DataView; bytes: Uint8Array}, request: number, arg: number): boolean | number {
  const v = p.view, b = p.bytes;
  if (request === 0x8912) { // SIOCGIFCONF: each interface with an IPv4 address
    const len = v.getInt32(arg, true), buf = Number(v.getBigUint64(arg + 8, true));
    if (!buf) { v.setInt32(arg, IFREQ, true); return true; }
    if (len < IFREQ) { v.setInt32(arg, 0, true); return true; }
    b.fill(0, buf, buf + IFREQ);
    b.set(enc.encode(LO.name), buf);
    v.setUint16(buf + 16, AF.INET, true);
    b.set(LO.ipv4, buf + 20);
    v.setInt32(arg, IFREQ, true);
    return true;
  }
  const GETS = [0x8910, 0x8913, 0x8915, 0x8917, 0x8919, 0x891b, 0x891d, 0x8921, 0x8927, 0x8933, 0x8942, 0x8970];
  // The rest of SIOC*IF*: a change to lo is not made here.
  if (!GETS.includes(request)) return request >= 0x8910 && request < 0x8980 ? -E.OPNOTSUPP : false;
  const name = new TextDecoder().decode(b.subarray(arg, arg + 16)).replace(/\0[\s\S]*$/, '');
  if (request === 0x8910) { // SIOCGIFNAME: by its index
    if (v.getInt32(arg + 16, true) !== LO.index) return -E.NODEV;
    b.fill(0, arg, arg + 16);
    b.set(enc.encode(LO.name), arg);
    return true;
  }
  if (name !== LO.name) return -E.NODEV;
  const field = arg + 16, sin = (ip: number[]): void => { b.fill(0, field, field + 16); v.setUint16(field, AF.INET, true); b.set(ip, field + 4); };
  switch (request) {
    case 0x8913: v.setInt16(field, LO.flags & 0xffff, true); break; // SIOCGIFFLAGS
    case 0x8915: case 0x8917: sin(LO.ipv4); break; // SIOCGIFADDR, SIOCGIFDSTADDR
    case 0x8919: sin([0, 0, 0, 0]); break; // SIOCGIFBRDADDR
    case 0x891b: sin(LO.netmask); break; // SIOCGIFNETMASK
    case 0x891d: v.setInt32(field, 0, true); break; // SIOCGIFMETRIC
    case 0x8921: v.setInt32(field, LO.mtu, true); break; // SIOCGIFMTU
    case 0x8927: b.fill(0, field, field + 16); v.setUint16(field, LO.type, true); break; // SIOCGIFHWADDR
    case 0x8933: v.setInt32(field, LO.index, true); break; // SIOCGIFINDEX
    case 0x8942: v.setInt32(field, LO.txqlen, true); break; // SIOCGIFTXQLEN
    case 0x8970: b.fill(0, field, field + 24); break; // SIOCGIFMAP
  }
  return true;
}

// ---- /proc/net ----

const hex8 = (x: number): string => (x >>> 0).toString(16).toUpperCase().padStart(8, '0');
const hex4 = (x: number): string => x.toString(16).toUpperCase().padStart(4, '0');
/** An IPv4 address as /proc/net/tcp writes it: its four bytes as one host-order (little-endian) word. */
const word4 = (ip: Uint8Array): string => hex8(ip[0] | (ip[1] << 8) | (ip[2] << 16) | (ip[3] << 24));
const word16 = (ip: Uint8Array): string => [0, 4, 8, 12].map((k) => word4(ip.subarray(k, k + 4))).join('');
const padded = (line: string, width: number): string => line.padEnd(width);

/** /proc/net/tcp, tcp6, udp or udp6, as Linux formats them (IPv4's lines padded to a width, IPv6's not). */
function socketTable(kernel: Net, family: number, protocol: number): string {
  const tcp = protocol === IPPROTO.TCP, v6 = family === AF.INET6, width = v6 ? 0 : tcp ? 149 : 127;
  const header = v6
    ? `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode${tcp ? '' : ' ref pointer drops'}`
    : `${tcp ? '  sl' : '   sl'}  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode${tcp ? '' : ' ref pointer drops'}`;
  const lines = [padded(header, width)];
  inetOf(kernel, family, protocol).forEach((s, k) => {
    const addr = (address: Address | null): string => {
      const a = inet(address);
      return `${a ? (v6 ? word16(a.ip) : word4(a.ip.subarray(12))) : v6 ? '0'.repeat(32) : '00000000'}:${hex4(a?.port ?? 0)}`;
    };
    const head = `${String(k).padStart(tcp ? 4 : 5)}: ${addr(s.local)} ${addr(s.remote)} ${hex4(stateOf(s)).slice(2)} 00000000:${hex8(queued(s))} 00:00000000 00000000     0        0 ${s.ino}`;
    lines.push(padded(tcp ? `${head} 1 0000000000000000 100 0 0 10 0` : `${head} 2 0000000000000000 0`, width));
  });
  return lines.join('\n') + '\n';
}

function unixTable(kernel: Net): string {
  const lines = ['Num       RefCount Protocol Flags    Type St Inode Path'];
  for (const s of live(kernel).filter((x) => x.family === AF.UNIX)) {
    const st = s.state === 'listening' ? 1 : s.state === 'connected' ? 3 : 1; // SS_UNCONNECTED, SS_CONNECTED
    const bytes = s.local?.bytes;
    const name = bytes ? (bytes[0] === 0 ? '@' + new TextDecoder().decode(bytes.subarray(1)) : new TextDecoder().decode(bytes)) : '';
    lines.push(`0000000000000000: 00000002 00000000 ${s.state === 'listening' ? '00010000' : '00000000'} ${hex4(s.type)} ${hex4(st).slice(2)} ${String(s.ino).padStart(5)}${name ? ' ' + name : ''}`);
  }
  return lines.join('\n') + '\n';
}

/** /proc/net's files: name -> its text, made when read. */
export function procNet(kernel: Net): Record<string, () => string> {
  const count = (f: number, pr: number): number => inetOf(kernel, f, pr).length;
  return {
    dev: () => {
      const t = traffic(kernel), n = (x: number, w: number): string => String(x).padStart(w);
      return 'Inter-|   Receive                                                |  Transmit\n'
        + ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n'
        + `${LO.name.padStart(6)}:${n(t.bytes, 8)} ${n(t.packets, 7)}    0    0    0     0          0         0 ${n(t.bytes, 8)} ${n(t.packets, 7)}    0    0    0     0       0          0\n`;
    },
    if_inet6: () => `${LO.ipv6.map((x) => x.toString(16).padStart(2, '0')).join('')} ${hex4(LO.index).slice(2).toLowerCase()} 80 10 80 ${LO.name.padStart(8)}\n`,
    route: () => padded('Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT', 127) + '\n',
    ipv6_route: () => `${'0'.repeat(31)}1 80 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00000100 00000001 00000000 00000001       lo\n`,
    tcp: () => socketTable(kernel, AF.INET, IPPROTO.TCP),
    tcp6: () => socketTable(kernel, AF.INET6, IPPROTO.TCP),
    udp: () => socketTable(kernel, AF.INET, IPPROTO.UDP),
    udp6: () => socketTable(kernel, AF.INET6, IPPROTO.UDP),
    raw: () => padded('   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops', 127) + '\n',
    raw6: () => '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n',
    unix: () => unixTable(kernel),
    arp: () => 'IP address       HW type     Flags       HW address            Mask     Device\n',
    sockstat: () => `sockets: used ${live(kernel).length}\nTCP: inuse ${count(AF.INET, IPPROTO.TCP)} orphan 0 tw 0 alloc ${count(AF.INET, IPPROTO.TCP)} mem 0\nUDP: inuse ${count(AF.INET, IPPROTO.UDP)} mem 0\nUDPLITE: inuse 0\nRAW: inuse 0\nFRAG: inuse 0 memory 0\n`,
    snmp: () => {
      // Linux's counters, by name (ss and netstat read them so): Forwarding 2 is a host's, not a router's.
      const row = (name: string, fields: string, values: number[]): string => `${name}: ${fields}\n${name}: ${values.join(' ')}\n`;
      const none = (n: number): number[] => Array(n).fill(0);
      const established = inetOf(kernel, AF.INET, IPPROTO.TCP).concat(inetOf(kernel, AF.INET6, IPPROTO.TCP)).filter((x) => stateOf(x) === TCP.ESTABLISHED).length;
      const udp = 'InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors';
      return row('Ip', 'Forwarding DefaultTTL InReceives InHdrErrors InAddrErrors ForwDatagrams InUnknownProtos InDiscards InDelivers OutRequests OutDiscards OutNoRoutes ReasmTimeout ReasmReqds ReasmOKs ReasmFails FragOKs FragFails FragCreates OutTransmits', [2, 64, ...none(18)])
        + row('Icmp', 'InMsgs InErrors InCsumErrors InDestUnreachs InTimeExcds InParmProbs InSrcQuenchs InRedirects InEchos InEchoReps InTimestamps InTimestampReps InAddrMasks InAddrMaskReps OutMsgs OutErrors OutRateLimitGlobal OutRateLimitHost OutDestUnreachs OutTimeExcds OutParmProbs OutSrcQuenchs OutRedirects OutEchos OutEchoReps OutTimestamps OutTimestampReps OutAddrMasks OutAddrMaskReps', none(29))
        + row('Tcp', 'RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors', [1, 200, 120000, -1, 0, 0, 0, 0, established, 0, 0, 0, 0, 0, 0])
        + row('Udp', udp, none(9)) + row('UdpLite', udp, none(9));
    },
    sockstat6: () => `TCP6: inuse ${count(AF.INET6, IPPROTO.TCP)}\nUDP6: inuse ${count(AF.INET6, IPPROTO.UDP)}\nUDPLITE6: inuse 0\nRAW6: inuse 0\nFRAG6: inuse 0 memory 0\n`,
  };
}
