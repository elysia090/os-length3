// Terminals made by programs: a devpts file system, and the pairs it holds. Opening its ptmx makes a pair: the end
// that was opened (the master: what a terminal emulator, or whoever was given it, reads and writes) and a device
// by its number in the file system (the slave: what the program at the terminal reads and writes). Between them is
// Linux's line discipline (N_TTY): what is typed is echoed, gathered into lines that can be taken back, and turned
// into signals; what is written has its line ends made a terminal's.
//
// The console (the one terminal whose other end is the host) is sys-file.ts's still: its lines are edited by what
// shows them.

import {Description} from './fd.ts';
import {Device, E, FsError, S_IFCHR, Super} from './fs.ts';
import type {Dir, Entry, Mount} from './fs.ts';
import {idOf} from './cred.ts';
import {Wait} from './flow.ts';
import {steady} from '../host.ts';
import {Lazy, Listing} from './made.ts';
import type {Proc, Termios} from './parts.ts';
import {SI, SIG, actionOf, bit, send} from './signal.ts';
import {byNr, nrIn} from './space.ts';

const fail = (errno: number): never => { throw new FsError(errno); };

declare module './fd.ts' {
  interface Description {
    /** The pair it is an end of (kind 'pty-m', 'pty-s'). */
    pty?: Pty;
  }
}

/** termios's flags that are read here. */
const I = {IGNCR: 0x80, ICRNL: 0x100, INLCR: 0x40, ISTRIP: 0x20, IXON: 0x400};
const O = {OPOST: 1, ONLCR: 4, OCRNL: 8, ONOCR: 0x10, ONLRET: 0x20};
const L = {ISIG: 1, ICANON: 2, ECHO: 8, ECHOE: 0x10, ECHOK: 0x20, ECHONL: 0x40, NOFLSH: 0x80, TOSTOP: 0x100, ECHOCTL: 0x200, IEXTEN: 0x8000};
/** The places of the special characters (c_cc). */
const CC = {INTR: 0, QUIT: 1, ERASE: 2, KILL: 3, EOF: 4, TIME: 5, MIN: 6, START: 8, STOP: 9, SUSP: 10, EOL: 11, WERASE: 14, LNEXT: 15, EOL2: 16};
/** How a terminal is set when it is made, as Linux sets one. */
const fresh = (): Termios => ({iflag: 0x500, oflag: 0x5, cflag: 0xbf, lflag: 0x8a3b, echo: 8, cc: new Uint8Array([3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0])});
/** The most that waits to be read at either end before what writes there waits. */
const ROOM = 65536;

/** Bytes waiting to be read, in the order they came. */
class Queue {
  #chunks: Uint8Array[] = [];
  size = 0;
  put(bytes: Uint8Array | number[]): void { if (bytes.length) { this.#chunks.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)); this.size += bytes.length; } }
  take(n: number): Uint8Array {
    const out = new Uint8Array(Math.min(n, this.size));
    for (let at = 0; at < out.length;) {
      const c = this.#chunks[0], k = Math.min(c.length, out.length - at);
      out.set(c.subarray(0, k), at);
      at += k;
      if (k === c.length) this.#chunks.shift(); else this.#chunks[0] = c.subarray(k);
    }
    this.size -= out.length;
    return out;
  }
  clear(): void { this.#chunks = []; this.size = 0; }
}

/** One devpts file system: its options, and the terminals in it by number. */
export class Instance {
  readonly ptys = new Map<number, Pty>();
  /** Names in it that are not its own terminals (the console, as /dev/pts/0 of the first one). */
  readonly others = new Map<string, Entry>();
  mode = 0o600;
  ptmxmode = 0o000;
  uid = -1;
  gid = -1;
  max = 4096;
  /** The lowest number it gives a terminal (the first one's 0 is the console's). */
  first = 0;
  declare readonly ptmx: Device;
  declare sb: Super;
  constructor() {
    this.ptmx = new Device(0x502, () => fail(E.IO), () => fail(E.IO));
  }
}

/** A terminal pair. */
export class Pty {
  termios = fresh();
  rows = 0;
  cols = 0;
  /** Not to be opened by its name yet (until TIOCSPTLCK says so). */
  locked = true;
  /** What the slave wrote, for the master to read; what was typed, ready for the slave to read; the line being typed. */
  readonly shown = new Queue();
  readonly typed = new Queue();
  line: number[] = [];
  /** A line's end that nothing came before (VEOF on an empty line): the next read of the slave reads nothing, once. */
  ends = 0;
  /** How many descriptions have each end open; and whether the master is gone (the terminal is hung up). */
  masters = 0;
  slaves = 0;
  opened = false;
  hung = false;
  /** The session it is the controlling terminal of, and the group in front (the kernel's own ids; 0: none). */
  sid = 0;
  fg = 0;
  /** Moves whenever what can be read or written at either end may have changed (poll, epoll). */
  changes = 0;
  declare readonly node: Device;
  declare readonly index: number;
  declare readonly of: Instance;
  constructor(of: Instance, index: number, uid: number, gid: number) {
    this.of = of;
    this.index = index;
    this.node = new Device(0x8800 + index, () => fail(E.IO), () => fail(E.IO));
    this.node.mode = S_IFCHR | of.mode;
    this.node.uid = uid;
    this.node.gid = gid;
  }
}

/**
 * A devpts for `p`'s asking (mount -t devpts): a file system of its own each time, as Linux gives one. Its options:
 * the mode its terminals are made with and its ptmx has, the group (and user) its terminals are given to, and the
 * most terminals it holds.
 */
export function devpts(p: Proc | null, source: string, data: string, first = 0): Super {
  const inst = new Instance();
  inst.first = first;
  for (const word of data.split(',')) {
    if (!word) continue;
    const at = word.indexOf('='), key = at < 0 ? word : word.slice(0, at), v = at < 0 ? '' : word.slice(at + 1);
    const octal = (): number => (/^[0-7]+$/.test(v) ? parseInt(v, 8) & 0o7777 : fail(E.INVAL));
    const id = (group: boolean): number => { const k = /^\d+$/.test(v) && p ? idOf(p.cred.ns, Number(v), group) : -1; return k < 0 ? fail(E.INVAL) : k; };
    if (key === 'mode') inst.mode = octal();
    else if (key === 'ptmxmode') inst.ptmxmode = octal();
    else if (key === 'gid') inst.gid = id(true);
    else if (key === 'uid') inst.uid = id(false);
    else if (key === 'max') { if (!/^\d+$/.test(v)) fail(E.INVAL); inst.max = Math.min(Number(v), 1 << 20); }
    else if (key !== 'newinstance') fail(E.INVAL);
  }
  inst.ptmx.mode = S_IFCHR | inst.ptmxmode;
  const whole = (): Map<string, Entry> => {
    const m = new Map<string, Entry>(inst.others);
    m.set('ptmx', inst.ptmx);
    for (const [n, t] of inst.ptys) m.set(String(n), t.node);
    return m;
  };
  const entries = new Lazy((name) => (name === 'ptmx' ? inst.ptmx : inst.others.get(name) ?? (/^\d+$/.test(name) ? inst.ptys.get(Number(name))?.node : undefined)), whole);
  const root = new Listing(() => entries, 0o755);
  const sb = new Super('devpts', 0x1cd1, root, source || 'devpts');
  sb.data = inst;
  inst.sb = sb;
  sb.options = [inst.uid >= 0 ? `uid=${inst.uid}` : '', inst.gid >= 0 ? `gid=${inst.gid}` : '', `mode=${inst.mode.toString(8).padStart(3, '0')}`,
    `ptmxmode=${inst.ptmxmode.toString(8).padStart(3, '0')}`, inst.max < 4096 ? `max=${inst.max}` : ''].filter(Boolean).join(',');
  return sb;
}

/** The devpts a ptmx node opened in `mnt` belongs to, and a mount of it: its own file system's; or, for the /dev/ptmx beside a /dev/pts, what is mounted there. */
export function instanceOf(mnt: Mount, dir: Dir | null): {inst: Instance; mnt: Mount} | null {
  if (mnt.sb.kind === 'devpts') return {inst: mnt.sb.data as Instance, mnt};
  const pts = dir?.entries.get('pts');
  for (const m of pts?.covered ?? []) if (m.parent === mnt && m.sb.kind === 'devpts') return {inst: m.sb.data as Instance, mnt: m};
  return null;
}

/** The master of a new pair in `inst`, opened by `p` with `flags`: where the pair's slave is, by number, in `mnt` (a mount of that devpts). */
export function openMaster(p: Proc, inst: Instance, mnt: Mount | null, flags: number): Description {
  let index = inst.first;
  while (inst.ptys.has(index)) index++;
  if (inst.ptys.size >= inst.max) fail(E.NOSPC);
  const c = p.cred, t = new Pty(inst, index, inst.uid >= 0 ? inst.uid : c.fsuid, inst.gid >= 0 ? inst.gid : c.fsgid);
  inst.ptys.set(index, t);
  const d = new Description('pty-m', {flags, node: inst.ptmx, mnt, dir: inst.sb.root as Dir, name: 'ptmx'});
  d.pty = t;
  d.gone = () => closed(p.kernel, d);
  t.masters++;
  return d;
}

/** The slave of `t`, opened by `p` with `flags` (by its name, or through the master: TIOCGPTPEER); `mnt`: the devpts mount it is named in. */
export function openSlave(p: Proc, t: Pty, mnt: Mount | null, flags: number): Description {
  if (t.locked || t.hung) fail(E.IO);
  const d = new Description('pty-s', {flags, node: t.node, mnt, dir: t.of.sb.root as Dir, name: String(t.index)});
  d.pty = t;
  d.gone = () => closed(p.kernel, d);
  t.slaves++;
  t.opened = true;
  // A session's first process with no terminal of its own takes the one it opens, unless it says not (O_NOCTTY).
  if (!(flags & 0x100) && p.sid === p.pid && !t.sid && !controlling(p)) { t.sid = p.sid; t.fg = p.pgid; ttys(p.kernel).add(t); }
  t.changes++;
  return d;
}

/** The pty that is the controlling terminal of `p`'s session, if one is. */
export function controlling(p: Proc): Pty | null {
  for (const t of ttys(p.kernel)) if (t.sid === p.sid) return t;
  return null;
}
/** Every pair of kernel `k` that is some session's terminal. */
const all = new WeakMap<object, Set<Pty>>();
const ttys = (k: object): Set<Pty> => { let s = all.get(k); if (!s) all.set(k, s = new Set()); return s; };

/** An end closed for good. The master's: the terminal is hung up, its session told. The last slave's: the master reads no more. */
export function closed(k: Proc['kernel'], d: Description): void {
  const t = d.pty!;
  if (d.kind === 'pty-m') {
    if (--t.masters > 0) return;
    t.hung = true;
    t.of.ptys.delete(t.index);
    if (t.sid) {
      const leader = k.procs.get(t.sid);
      if (leader?.state === 'live') { send(k, leader, SIG.HUP, {code: SI.KERNEL}); send(k, leader, SIG.CONT, {code: SI.KERNEL}); }
    }
    ttys(k).delete(t);
    t.sid = t.fg = 0;
  } else t.slaves--;
  t.changes++;
  k.dirty = true;
}

/** `sig` to the group in front of `t`. */
function signal(p: Proc, t: Pty, sig: number): void {
  const k = p.kernel;
  if (t.fg) for (const q of k.group(t.fg)) send(k, q, sig, {code: SI.KERNEL});
}

/** What the slave wrote, as the master reads it: with OPOST, a line feed a carriage return and a line feed. */
function output(t: Pty, bytes: Uint8Array): void {
  const o = t.termios.oflag;
  if (!(o & O.OPOST)) { t.shown.put(bytes.slice()); return; }
  const out: number[] = [];
  for (const c of bytes) {
    if (c === 10 && o & O.ONLCR) out.push(13, 10);
    else if (c === 13 && o & O.OCRNL) out.push(10);
    else out.push(c);
  }
  t.shown.put(out);
}
/** A typed byte shown back: itself, or as ^X where it is a control character and that is asked. */
function echo(t: Pty, c: number): void {
  const l = t.termios.lflag;
  if (!(l & L.ECHO)) { if (c === 10 && l & L.ECHONL) output(t, Uint8Array.of(10)); return; }
  if (l & L.ECHOCTL && c < 32 && c !== 9 && c !== 10 && c !== 17 && c !== 19) t.shown.put([94, c + 64]);
  else if (l & L.ECHOCTL && c === 127) t.shown.put([94, 63]);
  else output(t, Uint8Array.of(c));
}

/** What the master wrote: typed at the terminal. Through the line discipline to what the slave reads. */
function input(p: Proc, t: Pty, bytes: Uint8Array): void {
  const tio = t.termios, i = tio.iflag, l = tio.lflag, cc = tio.cc;
  // Set to pass every byte as it is (raw): nothing is looked at, and all of it is there to be read at once.
  if (!(i & (I.ISTRIP | I.IGNCR | I.ICRNL | I.INLCR | I.IXON)) && !(l & (L.ISIG | L.ICANON | L.ECHO | L.ECHONL))) { t.typed.put(bytes.slice()); return; }
  const is = (c: number, at: number): boolean => cc[at] !== 0 && c === cc[at];
  for (let c of bytes) {
    if (i & I.ISTRIP) c &= 0x7f;
    if (c === 13) { if (i & I.IGNCR) continue; if (i & I.ICRNL) c = 10; }
    else if (c === 10 && i & I.INLCR) c = 13;
    if (l & L.ISIG) {
      const sig = is(c, CC.INTR) ? SIG.INT : is(c, CC.QUIT) ? SIG.QUIT : is(c, CC.SUSP) ? SIG.TSTP : 0;
      if (sig) {
        if (!(l & L.NOFLSH)) { t.line = []; t.typed.clear(); t.shown.clear(); }
        echo(t, c);
        signal(p, t, sig);
        continue;
      }
    }
    if (i & I.IXON && (is(c, CC.START) || is(c, CC.STOP))) continue;
    if (!(l & L.ICANON)) { t.typed.put([c]); echo(t, c); continue; }
    if (is(c, CC.ERASE) || (l & L.IEXTEN && is(c, CC.WERASE))) {
      const word = !is(c, CC.ERASE);
      let n = 0;
      if (word) { while (t.line.length - n > 0 && t.line[t.line.length - 1 - n] === 32) n++; while (t.line.length - n > 0 && t.line[t.line.length - 1 - n] !== 32) n++; }
      else if (t.line.length) n = 1;
      t.line.length -= n;
      if (l & L.ECHO && l & L.ECHOE) for (let k = 0; k < n; k++) t.shown.put([8, 32, 8]);
      continue;
    }
    if (is(c, CC.KILL)) {
      if (l & L.ECHO && l & L.ECHOE) for (let k = 0; k < t.line.length; k++) t.shown.put([8, 32, 8]);
      t.line = [];
      if (l & L.ECHO && l & L.ECHOK && !(l & L.ECHOE)) output(t, Uint8Array.of(10));
      continue;
    }
    if (is(c, CC.EOF)) {
      // The line so far is given as it is; none so far, and what reads next reads nothing: the end.
      if (t.line.length) { t.typed.put(t.line); t.line = []; } else t.ends++;
      continue;
    }
    t.line.push(c);
    echo(t, c);
    if (c === 10 || is(c, CC.EOL) || is(c, CC.EOL2)) { t.typed.put(t.line); t.line = []; }
  }
}

/**
 * A read or a write of the terminal by a process of a group behind the one in front: stopped for it (SIGTTIN, or
 * SIGTTOU where TOSTOP asks), or EIO where that signal is ignored or blocked or its group is orphaned.
 */
function behind(p: Proc, t: Pty, sig: number): boolean {
  if (!t.sid || p.sid !== t.sid || p.pgid === t.fg) return false;
  if (actionOf(p, sig).handler === 1n || p.task.mask & bit(sig)) { if (sig === SIG.TTIN) fail(E.IO); return false; }
  for (const q of p.kernel.group(p.pgid)) send(p.kernel, q, sig, {code: SI.KERNEL});
  return true;
}

/** Bytes read at an end of a pair into `into` at `at`. */
export function read(p: Proc, d: Description, into: Uint8Array, at: number, length: number): number {
  const t = d.pty!, nonblock = d.flags & 0x800;
  const wait = (): never => { if (nonblock) fail(E.AGAIN); throw new Wait(); };
  if (d.kind === 'pty-m') {
    if (t.shown.size) { const b = t.shown.take(length); into.set(b, at); t.changes++; p.kernel.dirty = true; return b.length; }
    // Nothing shown, and no one left to show anything: an error at this end, as Linux's.
    if (t.opened && !t.slaves) fail(E.IO);
    return wait();
  }
  if (t.hung) return 0;
  if (behind(p, t, SIG.TTIN)) throw new Wait();
  const tio = t.termios;
  if (tio.lflag & L.ICANON) {
    if (!t.typed.size) { if (t.ends) { t.ends--; return 0; } return wait(); }
    // A line at a time: no more than its end is given, however much is asked for.
    const b = t.typed.take(length);
    let end = b.length;
    for (let k = 0; k < b.length; k++) if (b[k] === 10 || (tio.cc[CC.EOL] && b[k] === tio.cc[CC.EOL])) { end = k + 1; break; }
    if (end < b.length) { const rest = b.subarray(end), later = t.typed.take(t.typed.size); t.typed.put(rest.slice()); t.typed.put(later); }
    into.set(b.subarray(0, end), at);
    t.changes++;
    p.kernel.dirty = true;
    return end;
  }
  // Key by key: as soon as there are VMIN of them (none wanted: whatever is there, at once).
  const min = tio.cc[CC.MIN];
  if (t.typed.size >= Math.max(1, Math.min(min, length)) || (min === 0 && t.typed.size)) { const b = t.typed.take(length); into.set(b, at); t.changes++; p.kernel.dirty = true; return b.length; }
  if (min === 0) {
    const tenths = tio.cc[CC.TIME], s = p.call!.state;
    if (!tenths) return 0;
    s.deadline ??= steady() + tenths * 100;
    if (steady() >= s.deadline) return 0;
  }
  return wait();
}

/** Bytes written at an end of a pair. */
export function write(p: Proc, d: Description, data: Uint8Array): number {
  const t = d.pty!, nonblock = d.flags & 0x800;
  if (d.kind === 'pty-m') {
    if (t.typed.size + t.line.length > ROOM) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
    input(p, t, data);
  } else {
    if (t.hung) fail(E.IO);
    if (t.termios.lflag & L.TOSTOP && behind(p, t, SIG.TTOU)) throw new Wait();
    if (t.shown.size > ROOM) { if (nonblock) fail(E.AGAIN); throw new Wait(); }
    output(t, data);
  }
  t.changes++;
  p.kernel.dirty = true;
  return data.length;
}

const POLL = {IN: 1, OUT: 4, ERR: 8, HUP: 0x10};
/** What can be done at an end now (poll's bits). */
export function ready(d: Description): number {
  const t = d.pty!;
  if (d.kind === 'pty-m') return (t.shown.size ? POLL.IN : 0) | (t.typed.size + t.line.length <= ROOM ? POLL.OUT : 0) | (t.opened && !t.slaves ? POLL.HUP : 0);
  if (t.hung) return POLL.IN | POLL.HUP;
  const readable = t.termios.lflag & L.ICANON ? t.typed.size > 0 || t.ends > 0 : t.typed.size >= Math.max(1, t.termios.cc[CC.MIN]) || (t.termios.cc[CC.MIN] === 0 && t.typed.size > 0);
  return (readable ? POLL.IN : 0) | (t.shown.size <= ROOM ? POLL.OUT : 0);
}

/**
 * An ioctl of a pair's end; undefined where it is not a terminal's to answer (the caller says what then). `open`:
 * how a description made here is given a descriptor (TIOCGPTPEER).
 */
export function control(p: Proc, d: Description, request: number, arg: number, install: (d: Description, cloexec: boolean) => number): number | undefined {
  const t = d.pty!, k = p.kernel, v = p.view, tio = t.termios, master = d.kind === 'pty-m';
  switch (request) {
    case 0x5401: // TCGETS
      p.bytes.fill(0, arg, arg + 36);
      v.setUint32(arg, tio.iflag, true); v.setUint32(arg + 4, tio.oflag, true); v.setUint32(arg + 8, tio.cflag, true); v.setUint32(arg + 12, tio.lflag, true);
      p.bytes.set(tio.cc, arg + 17);
      return 0;
    case 0x5402: case 0x5403: case 0x5404: // TCSETS, TCSETSW, TCSETSF
      tio.iflag = v.getUint32(arg, true); tio.oflag = v.getUint32(arg + 4, true); tio.cflag = v.getUint32(arg + 8, true); tio.lflag = v.getUint32(arg + 12, true);
      tio.cc = p.bytes.slice(arg + 17, arg + 36);
      if (request === 0x5404) { t.typed.clear(); t.line = []; }
      // (set to read key by key, the line being typed is there to be read)
      if (!(tio.lflag & L.ICANON) && t.line.length) { t.typed.put(t.line); t.line = []; }
      t.changes++;
      k.dirty = true;
      return 0;
    case 0x5413: // TIOCGWINSZ
      p.bytes.fill(0, arg, arg + 8);
      v.setUint16(arg, t.rows, true); v.setUint16(arg + 2, t.cols, true);
      return 0;
    case 0x5414: { // TIOCSWINSZ: the group in front is told, where it changed
      const rows = v.getUint16(arg, true), cols = v.getUint16(arg + 2, true);
      if (rows !== t.rows || cols !== t.cols) { t.rows = rows; t.cols = cols; signal(p, t, SIG.WINCH); }
      return 0;
    }
    case 0x540f: // TIOCGPGRP
      if (!master && p.sid !== t.sid) fail(E.NOTTY);
      v.setInt32(arg, nrIn(k.numbers, p.pidns, t.fg), true);
      return 0;
    case 0x5410: { // TIOCSPGRP: a group of the terminal's session
      const asked = v.getInt32(arg, true), g = byNr(p.pidns, asked);
      if (!t.sid || p.sid !== t.sid) fail(E.NOTTY);
      if (asked < 0) fail(E.INVAL);
      if (!k.hasGroup(g, p.sid)) fail(E.PERM);
      t.fg = g;
      return 0;
    }
    case 0x5429: // TIOCGSID
      if (!t.sid) fail(E.NOTTY);
      v.setInt32(arg, nrIn(k.numbers, p.pidns, t.sid), true);
      return 0;
    case 0x540e: // TIOCSCTTY: the terminal of the caller's session, which it leads and which has none
      if (p.sid === t.sid && p.sid === p.pid) return 0;
      if (p.sid !== p.pid || controlling(p) || (k.tty.sid === p.sid && k.console.interactive)) fail(E.PERM);
      if (t.sid) fail(E.PERM);
      t.sid = p.sid;
      t.fg = p.pgid;
      ttys(k).add(t);
      return 0;
    case 0x5422: // TIOCNOTTY: given up, by the session's leader for all of it
      if (p.sid !== t.sid) fail(E.NOTTY);
      if (p.sid === p.pid) { ttys(k).delete(t); t.sid = t.fg = 0; }
      return 0;
    case 0x80045430: if (!master) fail(E.NOTTY); v.setUint32(arg, t.index, true); return 0; // TIOCGPTN
    case 0x40045431: if (!master) fail(E.NOTTY); t.locked = v.getInt32(arg, true) !== 0; return 0; // TIOCSPTLCK
    case 0x80045439: if (!master) fail(E.NOTTY); v.setInt32(arg, t.locked ? 1 : 0, true); return 0; // TIOCGPTLCK
    case 0x5441: { // TIOCGPTPEER: the other end, opened (its flags the argument)
      if (!master) fail(E.NOTTY);
      const was = t.locked;
      t.locked = false;
      try { return install(openSlave(p, t, d.mnt, arg & ~0x80000), (arg & 0x80000) !== 0); } finally { t.locked = was; }
    }
    case 0x541b: v.setInt32(arg, master ? t.shown.size : t.typed.size, true); return 0; // FIONREAD
    case 0x5411: v.setInt32(arg, master ? t.typed.size : t.shown.size, true); return 0; // TIOCOUTQ
    case 0x540b: // TCFLSH: what waits to be read (0), to be shown (1), or both
      if (arg === 0 || arg === 2) { t.typed.clear(); t.line = []; }
      if (arg === 1 || arg === 2) t.shown.clear();
      t.changes++;
      return 0;
    case 0x5424: v.setInt32(arg, 0, true); return 0; // TIOCGETD: N_TTY
    case 0x5409: case 0x540a: case 0x5425: case 0x540c: case 0x540d: return 0; // TCSBRK, TCXONC, TCSBRKP, TIOCEXCL, TIOCNXCL
    case 0x5420: return arg && v.getInt32(arg, true) ? fail(E.INVAL) : 0; // TIOCPKT: packet mode is not made
  }
  return undefined;
}
