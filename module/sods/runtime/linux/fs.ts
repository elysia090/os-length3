// An in-memory POSIX tree: directories, regular files, symlinks and
// character devices. Files may be lazy: their bytes arrive from a loader
// (a host directory, an archive, browser storage) on first read.
import {epoch, random} from '../host.ts';

export const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFCHR = 0o020000, S_IFBLK = 0o060000,
  S_IFIFO = 0o010000, S_IFSOCK = 0o140000;

let inodes = 1;

/**
 * What a tree holds of its files' bytes that came from their loaders and can go back to them (unchanged since):
 * `files`, each still holding its bytes; and `keepers`, who keep some of those from going (a kernel with translations,
 * until it ends: the files they read). A tree's own (Vfs.loaded): one tree's files are not another's to count or to
 * let go, and a kernel on the same tree is asked before one of them goes.
 */
export interface Loaded { readonly files: Set<File>; readonly keepers: Set<{sources(): Iterable<File>}> }

/**
 * Every change to what a directory holds or to a file's bytes, counted, and how many files are mapped shared now. One
 * that compares what it saw before (mirror.ts) knows nothing changed while the count is the same and no file is mapped
 * (what is written through a mapping reaches its file only when it settles).
 */
export const counted = {changes: 0, mapped: 0, placed: 0};

/**
 * A directory's entries, each change counted. A directory put in knows where it lies (the directory it is in and its
 * name there), and one taken out, or written over, that it lies nowhere: so what holds a directory open can find where
 * it is now, however it or what is above it was renamed since (Vfs.where). Each such change is counted (`placed`).
 */
class Entries extends Map<string, Entry> {
  declare readonly owner: Dir;
  constructor(owner: Dir) { super(); this.owner = owner; }
  override set(name: string, e: Entry): this {
    counted.changes++;
    const was = super.get(name);
    if (was !== e) {
      if (was instanceof Dir) this.#out(was, name);
      if (e instanceof Dir) { e.parent = this.owner; e.name = name; e.lies = true; counted.placed++; }
      // A file knows a folder it was put in: by it, the tree that holds its bytes once they are read (File.loaded).
      else if (e instanceof File) e.home = this.owner;
    }
    return super.set(name, e);
  }
  override delete(name: string): boolean {
    const was = super.get(name), had = super.delete(name);
    if (had) { counted.changes++; if (was instanceof Dir) this.#out(was, name); }
    return had;
  }
  override clear(): void {
    if (this.size) counted.changes++;
    for (const [name, e] of this) if (e instanceof Dir) this.#out(e, name);
    super.clear();
  }
  /** `dir` is no longer here as `name`: it lies nowhere, unless it was put elsewhere first (a rename puts before it takes out). */
  #out(dir: Dir, name: string): void {
    if (dir.parent === this.owner && dir.name === name) { dir.lies = false; counted.placed++; }
  }
}

export class Node {
  declare mode: number;
  declare ino: number;
  declare uid: number;
  declare gid: number;
  declare nlink: number;
  declare mtime: number;
  /** Times set (utimensat keeps nanoseconds): access, and the changes of its contents and of what it is. */
  declare atime?: number;
  declare atimeNs?: number;
  declare mtimeNs?: number;
  declare ctime?: number;
  /** Its extended attributes (sys-file.ts), as tmpfs keeps them. */
  declare xattrs?: Map<string, Uint8Array> | null;
  /** The mounts that cover it, in whatever mount each is (null, or not there: none). */
  declare covered?: Mount[] | null;
  constructor(mode: number) {
    this.mode = mode;
    this.ino = inodes++;
    this.uid = 0;
    this.gid = 0;
    this.nlink = 1;
    this.mtime = epoch();
  }
  get type() { return this.mode & S_IFMT; }
  get isDir() { return this.type === S_IFDIR; }
  get isFile() { return this.type === S_IFREG; }
  get isLink() { return this.type === S_IFLNK; }
}

/**
 * A MAP_SHARED mapping of a file (File.map): bytes [off, off + length) of it at `start` in `proc`'s memory, and what it
 * last had in common with the file (`seen`).
 */
export interface Mapping { proc: {readonly bytes: Uint8Array}; start: number; length: number; off: number; seen?: Uint8Array }

/**
 * The most a file holds here: its bytes are one array, with no holes kept, and 2 GiB less a byte is what every engine
 * this runs on gives one array. A length past it is EFBIG (Linux's tmpfs keeps the holes, and takes any length).
 */
export const FILE_MOST = 2 ** 31 - 1;

export class File extends Node {
  declare _data: Uint8Array;
  declare size: number;
  declare load: (() => Uint8Array) | null;
  declare reload: (() => Uint8Array) | null;
  declare shared: boolean;
  declare version: number;
  declare maps: Set<Mapping> | null;
  /** The folder it was last put in (Entries), and the files its tree holds read (Loaded.files) while it is one of them. */
  declare home: Dir | null;
  declare pool: Set<File> | null;
  /** Where its bytes are in the root's packs (pack.ts), while it is the root's own: what a kept translation is for. */
  declare origin?: string;
  constructor(data: Uint8Array = new Uint8Array(0), mode = 0o644, load: (() => Uint8Array) | null = null) {
    super(S_IFREG | mode);
    this._data = data;
    this.size = data.length;
    this.load = load; // () => Uint8Array, called once on first access
    this.reload = load; // the same, kept: unchanged bytes can be let go and read again
    this.shared = false; // a view of the bytes was handed out (share): change a copy
    // Counts every change to the contents; times can repeat within a millisecond.
    this.version = 0;
    // MAP_SHARED mappings of it (map below): while one lasts, its memory is the file's bytes there (Linux's page
    // cache), so a read takes what was written through it and a write shows in it.
    this.maps = null;
    this.home = null;
    this.pool = null;
  }
  /**
   * Its bytes came from its loader, which can give them again: the tree it lies in holds them, found from the folder
   * it was last put in up to the tree's root (one in no tree is held by none: it is not counted, and not let go).
   */
  #loaded(): void {
    if (!this.reload) return;
    let dir = this.home ?? undefined;
    while (dir && !dir.loaded) dir = dir.parent;
    this.pool = dir?.loaded?.files ?? null;
    this.pool?.add(this);
  }
  /** Its bytes are its own now, or gone back to its loader: its tree holds them no longer. */
  #unheld(): void { this.pool?.delete(this); this.pool = null; }
  get data(): Uint8Array {
    if (this.load) {
      // Its bytes not to be had (its pack gave other bytes than its table names, or nothing): the call that wanted
      // them fails as a read of a disk's bad block does (EIO), said once here, and a later call asks again.
      try { this._data = this.load(); } catch (e) { console.warn(e instanceof Error ? e.message : String(e)); throw new FsError(E.IO); }
      this.size = this._data.length;
      this.load = null;
      this.#loaded();
    }
    return this._data;
  }
  /** Bytes [start, end) — a view, not a copy. */
  read(start: number, end: number): Uint8Array {
    if (this.maps) this.settle(start, end);
    return this.data.subarray(start, Math.min(end, this.size));
  }
  /** The exact contents as a view, not a copy: a later write changes a copy, never what was handed out. */
  share(): Uint8Array {
    if (this.maps) this.settle();
    const data = this.data;
    this.shared = true;
    return data.subarray(0, this.size);
  }
  /**
   * Its bytes, given (a hot program's, sent with its translation, checked against the root's digest of it): the very
   * bytes its loader would read, so they are not read.
   */
  given(bytes: Uint8Array): void {
    if (!this.load) return;
    this._data = bytes;
    this.size = bytes.length;
    this.load = null;
    this.#loaded();
  }
  /** About to change the bytes: from here on they are this file's own. */
  own(): void {
    if (this.shared) { this._data = this.data.slice(0, this.size); this.shared = false; }
    this.#unheld();
    this.reload = null;
  }
  /** Let go of bytes its loader can give again (unchanged since); returns how many. */
  release(): number {
    if (this.load || !this.reload || this.version !== 0) return 0;
    const n = this._data.length;
    this._data = new Uint8Array(0);
    this.shared = false;
    this.load = this.reload;
    this.#unheld();
    return n;
  }
  write(at: number, bytes: Uint8Array): void {
    this.own();
    const need = at + bytes.length;
    let data = this.data;
    if (need > data.length) {
      const grown = new Uint8Array(Math.max(need, data.length * 2, 64));
      grown.set(data.subarray(0, this.size));
      data = this._data = grown;
    }
    data.set(bytes, at);
    this.size = Math.max(this.size, need);
    this.mtime = epoch();
    this.version++;
    counted.changes++;
    if (this.maps) this.#show(at, need);
  }
  /**
   * Its length made `length`: cut there, or grown to it with zeros. A whole number from 0 to FILE_MOST: one that is not
   * is refused here whoever asks (EINVAL, EFBIG), and one there is no room for is ENOSPC; refused, nothing of the file
   * is changed. (Before: any number became its size, a negative one too.)
   */
  truncate(length: number): void {
    if (!Number.isInteger(length) || length < 0) fail(E.INVAL);
    if (length > FILE_MOST) fail(E.FBIG);
    if (this.maps) this.settle();
    const was = this.size;
    this.own();
    const data = this.data;
    if (length > data.length) {
      let grown: Uint8Array;
      try { grown = new Uint8Array(length); } catch { return fail(E.NOSPC); }
      grown.set(data.subarray(0, this.size));
      this._data = grown;
    } else {
      data.fill(0, length, this.size);
    }
    this.size = length;
    this.mtime = epoch();
    this.version++;
    counted.changes++;
    if (this.maps) this.#show(Math.min(was, length), Math.max(was, length));
  }
  /** The exact contents as an independent array. */
  bytes(): Uint8Array {
    if (this.maps) this.settle();
    return this.data.slice(0, this.size);
  }

  /**
   * A MAP_SHARED mapping of it begins: {proc, start, length, off}, bytes [off, off + length) of it at `start` in that
   * process's memory, which holds them already. Each mapping keeps what it last had in common with the file (`seen`),
   * so what changed in its memory since is told from what changed elsewhere: only that goes to the file, and from
   * the file to every other mapping (another process's memory: fork, or the same file mapped twice).
   */
  map(m: Mapping): void {
    m.seen = m.proc.bytes.slice(m.start, m.start + m.length);
    if (!this.maps) { this.maps = new Set(); counted.mapped++; }
    this.maps.add(m);
  }
  /** It ends: what was written through it stays. */
  unmap(m: Mapping): void {
    if (!this.maps) return;
    this.settle(m.off, m.off + m.length, m);
    this.maps.delete(m);
    if (!this.maps.size) { this.maps = null; counted.mapped--; }
  }
  /** What was written through the mappings (all, or `only`) into [start, end) goes to the bytes and the other mappings. */
  settle(start = 0, end = this.size, only: Mapping | null = null): void {
    for (const m of only ? [only] : [...this.maps ?? []]) {
      const a = Math.max(start, m.off), b = Math.min(end, m.off + m.length, this.size);
      if (a >= b) continue;
      const memory = m.proc.bytes, base = m.start - m.off, seen = m.seen!;
      // A page at a time; within a page that changed, each run of changed bytes.
      for (let page = a; page < b; page = (Math.floor(page / PAGE) + 1) * PAGE) {
        const to = Math.min(b, (Math.floor(page / PAGE) + 1) * PAGE);
        if (same(memory.subarray(base + page, base + to), seen.subarray(page - m.off, to - m.off))) continue;
        for (let k = page; k < to;) {
          if (memory[base + k] === seen[k - m.off]) { k++; continue; }
          let e = k + 1;
          while (e < to && memory[base + e] !== seen[e - m.off]) e++;
          const run = memory.slice(base + k, base + e);
          this.own();
          this.data.set(run, k);
          this.#show(k, e, run);
          k = e;
        }
        this.mtime = epoch();
        this.version++;
        counted.changes++;
      }
    }
  }
  /** Bytes [start, end) are these now (`bytes`, or the file's own; zero past its end, as a new page is) in every mapping. */
  #show(start: number, end: number, bytes: Uint8Array | null = null): void {
    for (const m of this.maps ?? []) {
      const a = Math.max(start, m.off), b = Math.min(end, m.off + m.length);
      if (a >= b) continue;
      const part = bytes ? bytes.subarray(a - start, b - start) : this.data.subarray(a, Math.max(a, Math.min(b, this.size)));
      for (const [into, at] of [[m.proc.bytes, m.start + a - m.off], [m.seen!, a - m.off]] as const) {
        into.set(part, at);
        into.fill(0, at + part.length, at + b - a);
      }
    }
  }
}

const PAGE = 4096;

/** Two byte ranges of one length alike: compared a word at a time where both are aligned. */
function same(x: Uint8Array, y: Uint8Array): boolean {
  let k = 0;
  if (x.byteOffset % 4 === 0 && y.byteOffset % 4 === 0) {
    const n = x.length >> 2, u = new Uint32Array(x.buffer, x.byteOffset, n), v = new Uint32Array(y.buffer, y.byteOffset, n);
    for (; k < n; k++) if (u[k] !== v[k]) return false;
    k = n << 2;
  }
  for (; k < x.length; k++) if (x[k] !== y[k]) return false;
  return true;
}

export class Dir extends Node {
  readonly #entries = new Entries(this);
  /**
   * Where it lies, as the directory it is in keeps it (Entries): that directory, its name there, and whether it still
   * lies there (false once taken out or written over: where it lay is kept, for ".." and for what /proc says of it).
   * `lies` undefined: no directory keeps it (the root, and one made as it is looked at: /proc's).
   */
  declare parent?: Dir;
  declare name?: string;
  declare lies?: boolean;
  /** A tree's root alone: what the tree holds of its files' bytes (Vfs.loaded). */
  declare loaded?: Loaded;
  constructor(mode = 0o755) {
    super(S_IFDIR | mode);
    this.nlink = 2;
  }
  /** What is in it, by name (procfs.ts's are made as they are looked at). */
  get entries(): Map<string, Entry> { return this.#entries; }
}

export class Link extends Node {
  readonly #target: string;
  constructor(target: string) {
    super(S_IFLNK | 0o777);
    this.#target = target;
  }
  /** Where it points (procfs.ts's are made as they are followed). */
  get target(): string { return this.#target; }
  /**
   * One that leads to what something holds, not along a path (/proc's links to a descriptor, to where a process
   * works, to a namespace): where a walk through it goes on, a place, or what holds no node (`held`); or the errno.
   */
  declare leap?: () => {mnt?: Mount; node?: Entry; held?: unknown} | number;
  get size(): number { return new TextEncoder().encode(this.target).length; }
}

/** A named pipe (mkfifo): what its opens share is one pipe, made afresh once every end of the last is closed. */
export class Fifo extends Node {
  // (pipe: what its opens share, fd.ts says it.)
  readonly size = 0;
  constructor(mode = 0o644) { super(S_IFIFO | mode); this.pipe = null; }
}

/** A local socket's name (bind on a path): what connect finds there is the socket bound to it, while it is open. */
export class SocketName extends Node {
  // (endpoint: the socket bound to it, sys-net.ts says it.)
  readonly size = 0;
  constructor(mode = 0o755) { super(S_IFSOCK | mode); this.endpoint = null; }
}

export class Device extends Node {
  declare readonly rdev: number;
  declare readonly readDevice: (n: number) => Uint8Array;
  declare readonly writeDevice: (bytes: Uint8Array) => number;
  /** No driver is behind its number here: opened, there is no such device (ENXIO). */
  declare readonly none?: boolean;
  readonly size = 0;
  constructor(rdev: number, read: (n: number) => Uint8Array, write: (bytes: Uint8Array) => number, type = S_IFCHR) {
    super(type | 0o666);
    this.rdev = rdev;
    this.readDevice = read;
    this.writeDevice = write;
  }
}

const nothing = (): Uint8Array => new Uint8Array(0), taken = (b: Uint8Array): number => b.length;
/** What stands behind a character device's number (major << 8 | minor), where something does. */
const DRIVERS: Record<number, [(n: number) => Uint8Array, (b: Uint8Array) => number]> = {
  0x103: [nothing, taken], // null
  0x105: [(n) => new Uint8Array(n), taken], // zero
  0x107: [(n) => new Uint8Array(n), () => fail(E.NOSPC)], // full
  0x108: [(n) => random(Math.min(n, 65536)), taken], // random
  0x109: [(n) => random(Math.min(n, 65536)), taken], // urandom
  0x500: [nothing, taken], // tty: the controlling terminal (sys-file.ts opens it as such)
  0x502: [nothing, taken], // ptmx: a new terminal of the devpts beside it (sys-file.ts opens it as such)
};
/** A device node for number `rdev` (mknod's): a character device, or (`block`) a block device, which none here stands behind. */
export function device(rdev: number, mode: number, block = false): Device {
  const driver = block ? undefined : DRIVERS[rdev];
  const d = new Device(rdev, driver?.[0] ?? (() => fail(E.NXIO)), driver?.[1] ?? (() => fail(E.NXIO)), block ? S_IFBLK : S_IFCHR);
  d.mode = (d.mode & S_IFMT) | (mode & 0o7777);
  if (!driver) (d as {none?: boolean}).none = true;
  return d;
}

/** Any node of the tree. */
export type Entry = File | Dir | Link | Fifo | SocketName | Device;

export const E = {PERM: 1, NOENT: 2, IO: 5, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, EXIST: 17,
  XDEV: 18, NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOTTY: 25, FBIG: 27, NOSPC: 28, SPIPE: 29, RANGE: 34, NOSYS: 38,
  NOTEMPTY: 39, LOOP: 40, NAMETOOLONG: 36, PIPE: 32, NOEXEC: 8, SRCH: 3, INTR: 4, AFNOSUPPORT: 97, NXIO: 6, TIMEDOUT: 110,
  OPNOTSUPP: 95, BUSY: 16, NODEV: 19, NODATA: 61, TOOBIG: 7, ROFS: 30, MLINK: 31, USERS: 87, NOTBLK: 15};

/**
 * A call's failure, as the errno it answers (thrown where it cannot go on; the call's value, Kernel.attempt). Not an
 * Error: it is what a call says, not a fault, and the stack an Error takes cost more than the call (2.6 µs a failure,
 * where a shell's PATH search and a compiler's include path fail by the hundred).
 */
export class FsError {
  declare readonly errno: number;
  constructor(errno: number) { this.errno = errno; }
  get message(): string { return `errno ${this.errno}`; }
  toString(): string { return `FsError: ${this.message}`; }
}

const fail = (errno: number): never => { throw new FsError(errno); };

// ---- What is mounted. A file system is a tree with what it is (`Super`: its kind, where it came from, how it was
// asked for); a mount is one look at such a tree, or a part of one, from a place in another mount (`Mount`), with
// what that look allows (read-only, no devices, no programs run from it). A place is a mount and a node in it
// (`Place`): a process's root, where it works, what a descriptor holds. One tree is reached by as many mounts as
// there are (a bind is a second mount of the same nodes), and a namespace is the mounts under its root. What makes
// and moves them is mount.ts; here is what a path is walked by.

/** A mount's flags, as mount_setattr(2) numbers them (the three times of access are one field, ATIME). */
export const MNT = {RDONLY: 1, NOSUID: 2, NODEV: 4, NOEXEC: 8, ATIME: 0x70, NOATIME: 0x10, STRICTATIME: 0x20, NODIRATIME: 0x80, NOSYMFOLLOW: 0x200000};

let supers = 0;
/** A file system: one tree, however often it is mounted. */
export class Super {
  /** Its device number (st_dev; mountinfo's major:minor): no disk's, so major 0. */
  readonly dev = ((n: number): number => (n & 0xff) | ((n & ~0xff) << 12))(++supers + 19);
  /** Read-only as a whole (every mount of it), and what else was asked of it, as mountinfo says after rw or ro. */
  readonly = false;
  options = '';
  /** No device node in it is a device (one mounted by a user namespace that is not the first: a device is the machine's). */
  nodev = false;
  /** Whose it is: the user namespace it was mounted in (cred.ts), and what its kind keeps of it (a devpts's terminals, a proc's processes). */
  owner: object | null = null;
  data: unknown = null;
  declare readonly kind: string;
  declare readonly magic: number;
  declare source: string;
  declare readonly root: Entry;
  constructor(kind: string, magic: number, root: Entry, source = kind) { this.kind = kind; this.magic = magic; this.root = root; this.source = source; }
}

let mounts = 0;
export class Mount {
  readonly id = ++mounts + 20;
  /** The mount it is in and the node there it covers; that node's directory and name there (a file's has no other way up). */
  parent: Mount | null = null;
  point: Entry | null = null;
  pointDir: Dir | null = null;
  pointName = '';
  /** Where its root lies in its file system, where that root is no directory (a file bound): its directory and name. */
  rootDir: Dir | null = null;
  rootName = '';
  readonly children = new Set<Mount>();
  flags = 0;
  /** How what is mounted under it spreads: to its peers (`group`), from its master (`master`), or neither; `unbindable`: nor copied. */
  group = 0;
  master = 0;
  unbindable = false;
  /** The namespace it is in (mount.ts Space); null once taken out, or not yet put in (open_tree's copy). */
  space: object | null = null;
  /** What holds it: descriptors, where processes work and their roots (a mount held is busy to umount). */
  refs = 0;
  /** It, and the flags it has, came with a namespace from a more privileged one: not taken away, nor loosened (mount.ts). */
  locked = false;
  lockedFlags = 0;
  declare readonly sb: Super;
  declare readonly root: Entry;
  constructor(sb: Super, root: Entry = sb.root, flags = 0) { this.sb = sb; this.root = root; this.flags = flags; }
}

/** A mount and a node in it. */
export interface Place { mnt: Mount; node: Entry }
/**
 * Where a walk came to: its node (null when only its last name is missing: what a creation wants) in `mnt`, and the
 * directory and name it was found by, in `up` (the mount of that directory: another, where the node is what is
 * mounted there). `held`: it was reached through what something holds open (/proc's fd links), which may have no
 * node at all (a pipe, a socket).
 */
export interface Found { mnt: Mount; node: Entry | null; parent: Dir; name: string; up: Mount; held?: unknown }
/** Who walks: its root, and who it is (cred.ts: null, one that is asked nothing). */
export interface Walker { root: Place; cred: object | null }
/** Whether one who is `cred` may look a name up in `dir` (cred.ts sets it: here nothing is known of users). */
export const guard: {search: ((cred: object, dir: Dir) => boolean) | null} = {search: null};

/** How a path is walked: its last link followed; openat2's rules (RESOLVE_*); `DOWN`: what is mounted on what it comes to is entered (umount's). */
export const WALK = {NO_XDEV: 1, NO_MAGICLINKS: 2, NO_SYMLINKS: 4, BENEATH: 8, IN_ROOT: 16, FOLLOW: 0x100, DOWN: 0x200};

const SLASH = 47, DOT = 46;
/**
 * How a path ends: `slash`, with a slash after its last name (what it names must be a folder); `dot`, with "." (1)
 * or ".." (2) as that name, which names no entry to take away or to move; `bare`, the path without the slashes at
 * its end. A call that changes a folder's entries (unlink, rmdir, rename) asks, since the walk goes through both.
 */
export function ending(path: string): {slash: boolean; dot: 0 | 1 | 2; bare: string} {
  let n = path.length;
  while (n > 1 && path.charCodeAt(n - 1) === SLASH) n--;
  const bare = path.slice(0, n), last = bare.slice(bare.lastIndexOf('/') + 1);
  return {slash: n < path.length, dot: last === '.' ? 1 : last === '..' ? 2 : 0, bare};
}

/** Whether `path` from `at` on holds no component but empty ones and "." (the one before `at` is its last). */
function onlyDots(path: string, at: number): boolean {
  for (let i = at; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c === SLASH) continue;
    if (c === DOT && (i + 1 === path.length || path.charCodeAt(i + 1) === SLASH)) continue;
    return false;
  }
  return true;
}

/** What is mounted on `node` of `mnt`, and on that, to the last: where a walk that comes to `node` is. */
export function down(mnt: Mount, node: Entry): Place {
  for (let over = node.covered; over; over = node.covered) {
    let top: Mount | undefined;
    for (const m of over) if (m.parent === mnt) top = m;
    if (!top) break;
    mnt = top;
    node = top.root;
  }
  return {mnt, node};
}

/**
 * `path` walked from `from` by `who`, a name at a time, in place (no array of its names made: a stat or an open of
 * a short path would spend most of its time there). A link is followed from the directory it is in; ".." is the
 * directory a directory lies in, the one a mount covers where it is a mount's root, and nothing above who's root;
 * a name that something is mounted on is what is mounted there. The errno where it fails, given back, not thrown:
 * a name that is not there is most of what a shell's PATH search and a compiler's include path ask.
 *
 * `how` (WALK): FOLLOW its last link; BENEATH: it leads nowhere out of where it starts (a path or a link from the
 * root, ".." past the start: EXDEV); IN_ROOT: where it starts is its root; NO_SYMLINKS, NO_MAGICLINKS: no link is
 * followed (ELOOP), none that leads to what something holds; NO_XDEV: it stays in the mount it starts in.
 */
export function walk(who: Walker, path: string, from: Place, how = WALK.FOLLOW, scope: Place | null = how & (WALK.BENEATH | WALK.IN_ROOT) ? from : null, depth = 0): Found | number {
  if (depth > 40) return E.LOOP;
  if (path === '') return E.NOENT;
  const n = path.length, root = scope ?? who.root, cred = who.cred, search = cred ? guard.search : null;
  let mnt: Mount, node: Entry;
  if (path.charCodeAt(0) === SLASH) {
    if (how & WALK.BENEATH) return E.XDEV;
    if (how & WALK.NO_XDEV && from.mnt !== root.mnt) return E.XDEV;
    ({mnt, node} = root);
  } else ({mnt, node} = from);
  let parent: Dir | null = null, name = '', up = mnt, held: unknown;
  for (let i = 0; i < n;) {
    if (path.charCodeAt(i) === SLASH) { i++; continue; }
    const start = i;
    let end = path.indexOf('/', i);
    if (end < 0) end = n;
    i = end;
    if (end - start === 1 && path.charCodeAt(start) === DOT) continue;
    // (".." is asked of a folder as any name is: through a file it is ENOTDIR, not the folder the file lies in.)
    if (!(node instanceof Dir)) return E.NOTDIR;
    if (search && !search(cred!, node)) return E.ACCES;
    held = undefined;
    if (end - start === 2 && path.charCodeAt(start) === DOT && path.charCodeAt(start + 1) === DOT) {
      if (mnt === root.mnt && node === root.node) { if (how & WALK.BENEATH) return E.XDEV; continue; }
      // Out of a mount's root: the directory the mount covers lies in (and so on up, where that is a root too).
      let m = mnt, d: Entry = node, top = false;
      while (d === m.root) {
        if (!m.parent || !m.point) { top = true; break; }
        d = m.point;
        m = m.parent;
        if (m === root.mnt && d === root.node) { top = true; break; }
      }
      if (top) continue;
      if (m !== mnt && how & WALK.NO_XDEV) return E.XDEV;
      const above = d instanceof Dir ? d.parent : m.pointDir;
      if (!above) continue;
      ({mnt, node} = down(m, above));
      if (mnt !== m && how & WALK.NO_XDEV) return E.XDEV;
      parent = null;
      continue;
    }
    const part = path.slice(start, end), child = node.entries.get(part);
    // Its last name with more of the path after it (a slash, "." or ".."): the path goes through what it names,
    // which must then be a folder (ENOTDIR for a file, as Linux says to "file/" and "file/."), and a link there
    // is followed whoever asks.
    const last = onlyDots(path, end), through = last && end < n;
    if (!child) return last ? {mnt, node: null, parent: node, name: part, up: mnt} : E.NOENT;
    if (child instanceof Link && (!last || how & WALK.FOLLOW || through)) {
      if (how & WALK.NO_SYMLINKS || mnt.flags & MNT.NOSYMFOLLOW) return E.LOOP;
      const leap = child.leap;
      if (leap) {
        // It leads to what something holds, not along a path: the walk goes on from there.
        if (how & WALK.NO_MAGICLINKS) return E.LOOP;
        const to = leap();
        if (typeof to === 'number') return to;
        if (how & WALK.NO_XDEV && to.mnt && to.mnt !== mnt) return E.XDEV;
        if (!to.node || !to.mnt) return last && !through ? {mnt, node: null, parent: node, name: part, up: mnt, held: to.held} : E.NOTDIR;
        if (scope) return E.XDEV;
        up = mnt, parent = node, name = part;
        ({mnt, node} = to as Place);
        held = to.held;
        continue;
      }
      const target = child.target;
      if (target === '') return E.NOENT;
      // The link's target from the directory it is in, then what comes after it.
      return walk(who, last && !through ? target : target + path.slice(end), {mnt, node}, last ? how | WALK.FOLLOW : how, scope, depth + 1);
    }
    if (through && !(child instanceof Dir)) return E.NOTDIR;
    up = mnt, parent = node, name = part;
    if (child.covered) {
      ({mnt, node} = down(mnt, child));
      if (mnt !== up && how & WALK.NO_XDEV) return E.XDEV;
    } else node = child;
    // (One made as it is looked at, /proc's, lies where it was found.)
    if (node instanceof Dir && node.parent === undefined && node !== mnt.root) { node.parent = parent; node.name = part; }
  }
  if (how & WALK.DOWN) ({mnt, node} = down(mnt, node));
  if (!parent) {
    // It came to no name in a directory ("/", ".", ".."): what it lies in, as far as that is known.
    const d = node === mnt.root ? mnt.point ?? node : node;
    parent = (d instanceof Dir ? d.parent : mnt.pointDir) ?? (node instanceof Dir ? node : mnt.pointDir!);
    name = (d instanceof Dir ? d.name : mnt.pointName) ?? '/';
    up = node === mnt.root ? mnt.parent ?? mnt : mnt;
  }
  return held === undefined ? {mnt, node, parent, name, up} : {mnt, node, parent, name, up, held};
}

/**
 * Where `node` of `mnt` is, as one whose root is `root` names it: its names up to that root, through each mount to
 * what it covers. One that is not a directory is named by the directory and the name it was reached by (`dir`,
 * `name`). What was removed since is said to be ("(deleted)"); what lies under no name `root` can reach (another
 * namespace's, a mount taken out) is named from as far up as it goes, after `beyond`.
 */
export function pathOf(root: Place, mnt: Mount, node: Entry, dir: Dir | null = null, name = '', beyond = ''): string {
  const names: string[] = [];
  let gone = false, reached = false, d: Entry | null = node;
  if (!(d instanceof Dir) && d !== mnt.root) {
    if (!dir) return beyond + '/';
    names.push(name);
    gone = dir.entries.get(name) !== node;
    d = dir;
  }
  for (let hops = 0; d && hops < 4096; hops++) {
    if (mnt === root.mnt && d === root.node) { reached = true; break; }
    if (d === mnt.root) {
      if (!mnt.parent || !mnt.point) break;
      if (mnt.point instanceof Dir) d = mnt.point;
      else { names.push(mnt.pointName); d = mnt.pointDir; }
      mnt = mnt.parent;
      continue;
    }
    if (!(d instanceof Dir) || !d.parent) break;
    if (d.lies === false) gone = true;
    names.push(d.name ?? '');
    d = d.parent;
  }
  return `${reached ? '' : beyond}/${names.reverse().join('/')}${gone ? ' (deleted)' : ''}`;
}

/**
 * A tree and the first look at it: the root file system as its host fills it, before any process runs, and reads it
 * after (by paths from its root, through whatever the kernel mounted there). With /dev, the devices every program
 * looks for, a file system of its own mounted on it.
 */
export class Vfs {
  declare readonly root: Dir;
  /** The mount of the root tree: the first namespace's root (mount.ts), and where a path here is walked from. */
  declare readonly mount: Mount;
  declare readonly devices: Mount;
  declare readonly terminal: Device;
  /** What it holds of its files' bytes that their loaders can give again, and who keeps some of them (Loaded). */
  declare readonly loaded: Loaded;
  declare readonly who: Walker;
  constructor() {
    this.root = new Dir();
    this.loaded = this.root.loaded = {files: new Set(), keepers: new Set()};
    this.mount = new Mount(new Super('overlay', 0x794c7630, this.root));
    this.who = {root: {mnt: this.mount, node: this.root}, cred: null};
    for (const d of ['/dev', '/tmp', '/root', '/proc', '/sys', '/etc']) this.mkdirp(d);
    const dev = new Dir();
    const devices = new Super('devtmpfs', 0x01021994, dev);
    devices.options = 'mode=755';
    this.devices = new Mount(devices, dev, MNT.NOSUID);
    attach(this.devices, this.mount, this.root.entries.get('dev')!, this.root, 'dev');
    for (const [name, rdev] of [['null', 0x103], ['zero', 0x105], ['full', 0x107], ['random', 0x108], ['urandom', 0x109], ['tty', 0x500], ['ptmx', 0x502]] as const) dev.entries.set(name, device(rdev, 0o666));
    // The terminal the console is (its own name, as ttyname finds it: /proc/self/fd/0's link, the same file): opened,
    // the console again; the console's stat is its.
    this.terminal = new Device(0x8800, () => new Uint8Array(0), (b) => b.length);
    this.terminal.mode = S_IFCHR | 0o620;
    dev.entries.set('pts', new Dir());
    dev.nlink++;
  }

  /** The place `from` is: a path from the root, or a directory of the root's tree. */
  #place(from: string | Dir): Place | number {
    if (typeof from !== 'string') return {mnt: this.mount, node: from};
    const r = walk(this.who, from, this.who.root);
    return typeof r === 'number' ? r : r.node ? {mnt: r.mnt, node: r.node} : E.NOENT;
  }

  /** As `walk`, from the root's tree: `from` a path from the root, or a directory of that tree. */
  walk(path: string, from: string | Dir = '/', follow = true): Found | number {
    const at = from === '/' ? this.who.root : this.#place(from);
    return typeof at === 'number' ? at : walk(this.who, path, at, follow ? WALK.FOLLOW : 0);
  }

  /** `walk`, its errno thrown: {node, parent, name}, node null when only the last name is missing (useful for creation). */
  resolve(path: string, cwd: string | Dir = '/', follow = true): Found {
    const r = this.walk(path, cwd, follow);
    return typeof r === 'number' ? fail(r) : r;
  }

  /** The node at `path`, or the errno its lookup fails with, given back. */
  find(path: string, cwd: string | Dir = '/', follow = true): Entry | number {
    const r = this.walk(path, cwd, follow);
    return typeof r === 'number' ? r : r.node ?? E.NOENT;
  }

  lookup(path: string, cwd: string | Dir = '/', follow = true): Entry {
    const r = this.find(path, cwd, follow);
    return typeof r === 'number' ? fail(r) : r;
  }

  mkdirp(path: string): Dir {
    let at: Place = this.who.root;
    for (const part of path.split('/').filter(Boolean)) {
      const dir = at.node as Dir;
      let next = dir.entries.get(part);
      if (!next) { next = new Dir(); dir.entries.set(part, next); dir.nlink++; }
      at = down(at.mnt, next);
      if (!(at.node instanceof Dir)) return fail(E.NOTDIR);
    }
    return at.node as Dir;
  }

  writeFile(path: string, bytes: Uint8Array | string, mode = 0o644): File {
    const at = path.lastIndexOf('/');
    const dir = this.mkdirp(path.slice(0, at));
    const file = new File(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, mode);
    dir.entries.set(path.slice(at + 1), file);
    return file;
  }

  /** The file at `path` (as readFile fails where something else is). */
  file(path: string, cwd: string | Dir = '/'): File {
    const node = this.lookup(path, cwd);
    return node instanceof File ? node : fail(node.isDir ? E.ISDIR : E.INVAL);
  }

  /** The directory at `path`. */
  dir(path: string, cwd: string | Dir = '/'): Dir {
    const node = this.lookup(path, cwd);
    return node instanceof Dir ? node : fail(E.NOTDIR);
  }

  readFile(path: string, cwd: string | Dir = '/'): Uint8Array {
    return this.file(path, cwd).bytes();
  }

  symlink(target: string, path: string): void {
    const at = path.lastIndexOf('/');
    this.mkdirp(path.slice(0, at)).entries.set(path.slice(at + 1), new Link(target));
  }
}

/** `m` put on `point` of `parent` (which lies in `dir` as `name`): a walk that comes there is in `m` from now on. */
export function attach(m: Mount, parent: Mount, point: Entry, dir: Dir | null, name: string): void {
  m.parent = parent;
  m.point = point;
  m.pointDir = dir;
  m.pointName = name;
  m.space = parent.space;
  parent.children.add(m);
  (point.covered ??= []).push(m);
}

/** `m` taken off what it covers (what is mounted in it stays in it). */
export function detach(m: Mount): void {
  const over = m.point?.covered;
  if (over) {
    over.splice(over.indexOf(m), 1);
    if (!over.length) m.point!.covered = null;
  }
  m.parent?.children.delete(m);
  m.parent = m.point = m.pointDir = null;
}

/** Image mounting through ordinary file operations, supplied by the caller to an image reader. */
export function mountTarget(vfs: Vfs) {
  const place = (path: string): [Dir, string] => {
    const at = path.lastIndexOf('/');
    return [vfs.mkdirp(path.slice(0, at) || '/'), path.slice(at + 1)];
  };
  return {
    directory(path: string, mode: number): void {
      const dir = vfs.mkdirp(path);
      dir.mode = (dir.mode & ~0o7777) | mode;
    },
    has(path: string): boolean { const [dir, name] = place(path); return dir.entries.has(name); },
    symlink(target: string, path: string): void { vfs.symlink(target, path); },
    file(path: string, mode: number, size: number, read: () => Uint8Array, origin: string): File {
      const [dir, name] = place(path);
      const file = new File(new Uint8Array(0), mode, read);
      file.size = size;
      file.origin = origin;
      dir.entries.set(name, file);
      return file;
    },
    hardlink(file: File, path: string): void {
      const [dir, name] = place(path);
      dir.entries.set(name, file);
      file.nlink++;
    },
  };
}

/**
 * A file of the root given with its bytes (`root`: a hot program, its bytes the root's own, checked against the
 * root's digest of them): put in the root's node, so every name of it (a hard link) is still the one file, and its
 * bytes are not read from its pack. Anything else given is written over the root, as it is given.
 */
export function provide(vfs: Vfs, {path, bytes, mode = 0o644, root = false}: {path: string; bytes: Uint8Array; mode?: number; root?: boolean}): File {
  if (root) {
    let node = null;
    try { node = vfs.lookup(path, '/', false); } catch { /* not in the root: written */ }
    if (node instanceof File && node.origin && node.version === 0 && node.size === bytes.length) { node.given(bytes); return node; }
  }
  return vfs.writeFile(path, bytes, mode);
}
