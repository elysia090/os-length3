// An in-memory POSIX tree: directories, regular files, symlinks and
// character devices. Files may be lazy: their bytes arrive from a loader
// (a host directory, an archive, browser storage) on first read.
import {epoch, random} from '../host.ts';

export const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFCHR = 0o020000,
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
  /** Where it was last found to lie (Vfs.where), and the count of placings that was found at. */
  declare at?: string | null;
  declare seen?: number;
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
  readonly size = 0;
  constructor(rdev: number, read: (n: number) => Uint8Array, write: (bytes: Uint8Array) => number) {
    super(S_IFCHR | 0o666);
    this.rdev = rdev;
    this.readDevice = read;
    this.writeDevice = write;
  }
}

/** Any node of the tree. */
export type Entry = File | Dir | Link | Fifo | SocketName | Device;

export const E = {PERM: 1, NOENT: 2, IO: 5, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, EXIST: 17,
  XDEV: 18, NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOTTY: 25, FBIG: 27, NOSPC: 28, SPIPE: 29, RANGE: 34, NOSYS: 38,
  NOTEMPTY: 39, LOOP: 40, NAMETOOLONG: 36, PIPE: 32, NOEXEC: 8, SRCH: 3, INTR: 4, AFNOSUPPORT: 97, NXIO: 6, TIMEDOUT: 110,
  OPNOTSUPP: 95, BUSY: 16, NODEV: 19, NODATA: 61, TOOBIG: 7};

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

/** Where `resolve` found a path: its node (null when only its last part is missing), its directory and its name. */
export interface Resolved { node: Entry | null; parent: Dir; name: string }

const SLASH = 47, DOT = 46;
/** Whether `path` from `at` on holds no component but empty ones and "." (the one before `at` is its last). */
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

function onlyDots(path: string, at: number): boolean {
  for (let i = at; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c === SLASH) continue;
    if (c === DOT && (i + 1 === path.length || path.charCodeAt(i + 1) === SLASH)) continue;
    return false;
  }
  return true;
}

export class Vfs {
  declare readonly root: Dir;
  declare readonly terminal: Device;
  /** What it holds of its files' bytes that their loaders can give again, and who keeps some of them (Loaded). */
  declare readonly loaded: Loaded;
  constructor() {
    this.root = new Dir();
    this.loaded = this.root.loaded = {files: new Set(), keepers: new Set()};
    const dev = this.mkdirp('/dev');
    dev.entries.set('null', new Device(0x103, () => new Uint8Array(0), (b) => b.length));
    dev.entries.set('zero', new Device(0x105, (n) => new Uint8Array(n), (b) => b.length));
    dev.entries.set('urandom', new Device(0x109, (n) => random(Math.min(n, 65536)), (b) => b.length));
    dev.entries.set('random', dev.entries.get('urandom')!);
    // The controlling terminal: the console, where it is one (sys-file.ts opens it as such).
    dev.entries.set('tty', new Device(0x500, () => new Uint8Array(0), (b) => b.length));
    // The terminal the console is (its own name, as ttyname finds it: /proc/self/fd/0's link, the same file): opened,
    // the console again; the console's stat is its.
    this.terminal = new Device(0x8800, () => new Uint8Array(0), (b) => b.length);
    this.terminal.mode = S_IFCHR | 0o620;
    this.mkdirp('/dev/pts').entries.set('0', this.terminal);
    for (const d of ['/tmp', '/root', '/proc', '/etc']) this.mkdirp(d);
  }

  /**
   * Where `dir` lies now, by what it is (not by a path it was once reached by): its names from the root. Null once it
   * lies nowhere (removed, written over, or under one that was); undefined where the tree keeps no place for it (one
   * made as it is looked at: /proc's). Found again only after a directory was put somewhere or taken out.
   */
  where(dir: Dir): string | null | undefined {
    if (dir.seen === counted.placed) return dir.at;
    let at: string | null | undefined;
    if (dir === this.root) at = '/';
    else if (dir.lies === undefined) at = undefined;
    else if (!dir.lies) at = null;
    else {
      const up = this.where(dir.parent!);
      at = up == null ? up : up === '/' ? `/${dir.name}` : `${up}/${dir.name}`;
    }
    dir.seen = counted.placed;
    dir.at = at;
    return at;
  }

  /** What a directory is called where its place is shown (/proc's links): where it lies, or where it lay, "(deleted)". */
  shown(dir: Dir): string | undefined {
    const at = this.where(dir);
    if (at !== null) return at;
    const up = dir.parent ? this.shown(dir.parent) : undefined;
    return up === undefined ? undefined : `${up.replace(/ \(deleted\)$/, '')}${up === '/' ? '' : '/'}${dir.name} (deleted)`;
  }

  /**
   * Resolve `path` from `cwd` (a path, or the directory itself: where it lies now is where the walk starts). Returns
   * {node, parent, name}; node is null when only the last component is missing (useful for creation).
   */
  resolve(path: string, cwd: string | Dir = '/', follow = true): Resolved {
    const r = this.walk(path, cwd, follow);
    return typeof r === 'number' ? fail(r) : r;
  }

  /**
   * The node at `path`, or the errno its lookup fails with, given back, not thrown: a name that is not there is most of
   * what a shell's PATH search and a compiler's include path ask, and the throw cost more than the lookup.
   */
  find(path: string, cwd: string | Dir, follow = true): Entry | number {
    const r = this.walk(path, cwd, follow);
    return typeof r === 'number' ? r : r.node ?? E.NOENT;
  }

  lookup(path: string, cwd: string | Dir, follow = true): Entry {
    const r = this.find(path, cwd, follow);
    return typeof r === 'number' ? fail(r) : r;
  }

  /**
   * As resolve, its errno given back (find). Given `names`, it leaves there the names it went down by to what it
   * found (links followed, "." and ".." gone; to its parent, where only its last name is missing): its canonical path,
   * which an open keeps, with no second walk (realpath).
   */
  walk(path: string, from: string | Dir = '/', follow = true, depth = 0, names: string[] | null = null): Resolved | number {
    if (depth > 40) return E.LOOP;
    if (path === '') return E.NOENT;
    if (names) names.length = 0;
    let cwd: string;
    if (typeof from === 'string') cwd = from;
    else {
      const at = this.where(from);
      if (at == null) {
        if (path.charCodeAt(0) !== SLASH) return at === null ? this.#fromGone(path, from, follow, depth, names) : E.NOENT;
        cwd = '/';
      } else cwd = at;
    }
    // Its components read in place, one after another (not split into an array, filtered and joined again: a stat or
    // an open of a short path spent most of its time there). Empty components and "." are none.
    const full = path.charCodeAt(0) === SLASH ? path : cwd + '/' + path, n = full.length;
    const stack: Entry[] = [this.root];
    let name = '/';
    for (let i = 0; i < n;) {
      if (full.charCodeAt(i) === SLASH) { i++; continue; }
      const start = i;
      let end = full.indexOf('/', i);
      if (end < 0) end = n;
      i = end;
      if (end - start === 1 && full.charCodeAt(start) === DOT) continue;
      const part = full.slice(start, end), dir = stack[stack.length - 1];
      name = part;
      // (".." is asked of a folder as any name is: through a file it is ENOTDIR, not the folder the file lies in.)
      if (!(dir instanceof Dir)) return E.NOTDIR;
      if (part === '..') { if (stack.length > 1) { stack.pop(); names?.pop(); } continue; }
      const node = dir.entries.get(part);
      const last = onlyDots(full, end);
      // Its last name with more of the path after it (a slash, "." or ".."): the path goes through what it names,
      // which must then be a folder (ENOTDIR for a file, as Linux says to "file/" and "file/."), and a link there
      // is followed whoever asks.
      const through = last && end < n;
      if (!node) {
        if (last) return {node: null, parent: dir, name: part};
        return E.NOENT;
      }
      if (node instanceof Link && (!last || follow || through)) {
        // The link's target from the directory it is in (what came before it), then what comes after it.
        const target = node.target.startsWith('/') ? node.target : full.slice(0, start) + '/' + node.target;
        return this.walk(last && !through ? target : target + full.slice(end), '/', follow, depth + 1, names);
      }
      if (through && !(node instanceof Dir)) return E.NOTDIR;
      stack.push(node);
      names?.push(part);
    }
    const node = stack[stack.length - 1];
    return {node, parent: (stack[stack.length - 2] as Dir | undefined) ?? this.root, name};
  }

  /**
   * A path asked from a directory that lies nowhere (removed while it was held open, or worked in): it is still itself
   * ("."), ".." is where it lay, and no name is in it or can be made in it (ENOENT), as Linux has it.
   */
  #fromGone(path: string, dir: Dir, follow: boolean, depth: number, names: string[] | null): Resolved | number {
    for (let i = 0; i < path.length;) {
      if (path.charCodeAt(i) === SLASH) { i++; continue; }
      let end = path.indexOf('/', i);
      if (end < 0) end = path.length;
      const part = path.slice(i, end);
      i = end;
      if (part === '.') continue;
      if (part === '..' && dir.parent) return this.walk(path.slice(end) || '.', dir.parent, follow, depth + 1, names);
      return E.NOENT;
    }
    return {node: dir, parent: dir.parent ?? dir, name: '.'};
  }

  /** Canonical absolute path of an existing directory. */
  realpath(path: string, from: string | Dir): string {
    const cwd = typeof from === 'string' ? from : path.startsWith('/') ? '/' : this.where(from) ?? fail(E.NOENT);
    // One walk down the tree, each component looked up in the directory reached (not the whole path again from the
    // root for each: an open of a file five deep looked up fifteen names), a link's target walked where it is.
    const parts: string[] = [], nodes: Entry[] = [this.root];
    let links = 0;
    const walk = (p: string): void => {
      for (let i = 0; i < p.length;) {
        if (p.charCodeAt(i) === SLASH) { i++; continue; }
        let end = p.indexOf('/', i);
        if (end < 0) end = p.length;
        const part = p.slice(i, end);
        i = end;
        if (part === '.') continue;
        if (part === '..') { if (parts.length) { parts.pop(); nodes.pop(); } continue; }
        const dir = nodes[nodes.length - 1];
        if (!(dir instanceof Dir)) fail(E.NOTDIR);
        const node = (dir as Dir).entries.get(part) ?? fail(E.NOENT);
        if (node instanceof Link) {
          if (++links > 40) fail(E.LOOP);
          if (node.target.startsWith('/')) { parts.length = 0; nodes.length = 1; }
          walk(node.target);
          continue;
        }
        parts.push(part);
        nodes.push(node);
      }
    };
    walk(path.startsWith('/') ? path : cwd + '/' + path);
    return '/' + parts.join('/');
  }

  mkdirp(path: string): Dir {
    let dir = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      let next = dir.entries.get(part);
      if (!next) { next = new Dir(); dir.entries.set(part, next); dir.nlink++; }
      if (!(next instanceof Dir)) return fail(E.NOTDIR);
      dir = next;
    }
    return dir;
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
