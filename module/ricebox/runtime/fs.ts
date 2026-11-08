// An in-memory POSIX tree: directories, regular files, symlinks and
// character devices. Files may be lazy: their bytes arrive from a loader
// (a host directory, an archive, browser storage) on first read.

export const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFCHR = 0o020000,
  S_IFIFO = 0o010000, S_IFSOCK = 0o140000;

let inodes = 1;

/** Files whose bytes came from their loader and can go back to it (unchanged since). */
const LOADED = new Set<File>();
/** Each such file still holding its bytes. */
export const loadedFiles = () => LOADED;

/**
 * Every change to what a directory holds or to a file's bytes, counted, and how many files are mapped shared now. One
 * that compares what it saw before (mirror.ts) knows nothing changed while the count is the same and no file is mapped
 * (what is written through a mapping reaches its file only when it settles).
 */
export const counted = {changes: 0, mapped: 0};

/** A directory's entries, each change counted. */
class Entries extends Map<string, Entry> {
  override set(name: string, e: Entry): this { counted.changes++; return super.set(name, e); }
  override delete(name: string): boolean { const had = super.delete(name); if (had) counted.changes++; return had; }
  override clear(): void { if (this.size) counted.changes++; super.clear(); }
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
    this.mtime = Date.now();
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

export class File extends Node {
  declare _data: Uint8Array;
  declare size: number;
  declare load: (() => Uint8Array) | null;
  declare reload: (() => Uint8Array) | null;
  declare shared: boolean;
  declare version: number;
  declare maps: Set<Mapping> | null;
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
  }
  get data(): Uint8Array {
    if (this.load) {
      // Its bytes not to be had (its pack gave other bytes than its table names, or nothing): the call that wanted
      // them fails as a read of a disk's bad block does (EIO), said once here, and a later call asks again.
      try { this._data = this.load(); } catch (e) { console.warn(e instanceof Error ? e.message : String(e)); throw new FsError(E.IO); }
      this.size = this._data.length;
      this.load = null;
      if (this.reload) LOADED.add(this);
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
    if (this.reload) LOADED.add(this);
  }
  /** About to change the bytes: from here on they are this file's own. */
  own(): void {
    if (this.shared) { this._data = this.data.slice(0, this.size); this.shared = false; }
    LOADED.delete(this);
    this.reload = null;
  }
  /** Let go of bytes its loader can give again (unchanged since); returns how many. */
  release(): number {
    if (this.load || !this.reload || this.version !== 0) return 0;
    const n = this._data.length;
    this._data = new Uint8Array(0);
    this.shared = false;
    this.load = this.reload;
    LOADED.delete(this);
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
    this.mtime = Date.now();
    this.version++;
    counted.changes++;
    if (this.maps) this.#show(at, need);
  }
  truncate(length: number): void {
    if (this.maps) this.settle();
    const was = this.size;
    this.own();
    const data = this.data;
    if (length > data.length) {
      const grown = new Uint8Array(length);
      grown.set(data.subarray(0, this.size));
      this._data = grown;
    } else {
      data.fill(0, length, this.size);
    }
    this.size = length;
    this.mtime = Date.now();
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
        this.mtime = Date.now();
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
  readonly #entries = new Entries();
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
  XDEV: 18, NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOTTY: 25, NOSPC: 28, SPIPE: 29, RANGE: 34, NOSYS: 38,
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
  constructor() {
    this.root = new Dir();
    const dev = this.mkdirp('/dev');
    dev.entries.set('null', new Device(0x103, () => new Uint8Array(0), (b) => b.length));
    dev.entries.set('zero', new Device(0x105, (n) => new Uint8Array(n), (b) => b.length));
    dev.entries.set('urandom', new Device(0x109, (n) => crypto.getRandomValues(new Uint8Array(Math.min(n, 65536))), (b) => b.length));
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
   * Resolve `path` from `cwd`. Returns {node, parent, name}; node is null
   * when only the last component is missing (useful for creation).
   */
  resolve(path: string, cwd = '/', follow = true): Resolved {
    const r = this.walk(path, cwd, follow);
    return typeof r === 'number' ? fail(r) : r;
  }

  /**
   * The node at `path`, or the errno its lookup fails with, given back, not thrown: a name that is not there is most of
   * what a shell's PATH search and a compiler's include path ask, and the throw cost more than the lookup.
   */
  find(path: string, cwd: string, follow = true): Entry | number {
    const r = this.walk(path, cwd, follow);
    return typeof r === 'number' ? r : r.node ?? E.NOENT;
  }

  lookup(path: string, cwd: string, follow = true): Entry {
    const r = this.find(path, cwd, follow);
    return typeof r === 'number' ? fail(r) : r;
  }

  /** As resolve, its errno given back (find). */
  walk(path: string, cwd = '/', follow = true, depth = 0): Resolved | number {
    if (depth > 40) return E.LOOP;
    if (path === '') return E.NOENT;
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
      if (part === '..') { if (stack.length > 1) stack.pop(); continue; }
      if (!(dir instanceof Dir)) return E.NOTDIR;
      const node = dir.entries.get(part);
      const last = onlyDots(full, end);
      if (!node) {
        if (last) return {node: null, parent: dir, name: part};
        return E.NOENT;
      }
      if (node instanceof Link && (!last || follow)) {
        // The link's target from the directory it is in (what came before it), then what comes after it.
        const target = node.target.startsWith('/') ? node.target : full.slice(0, start) + '/' + node.target;
        return this.walk(last ? target : target + full.slice(end), '/', follow, depth + 1);
      }
      stack.push(node);
    }
    const node = stack[stack.length - 1];
    return {node, parent: (stack[stack.length - 2] as Dir | undefined) ?? this.root, name};
  }

  /** Canonical absolute path of an existing directory. */
  realpath(path: string, cwd: string): string {
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
  file(path: string, cwd = '/'): File {
    const node = this.lookup(path, cwd);
    return node instanceof File ? node : fail(node.isDir ? E.ISDIR : E.INVAL);
  }

  /** The directory at `path`. */
  dir(path: string, cwd = '/'): Dir {
    const node = this.lookup(path, cwd);
    return node instanceof Dir ? node : fail(E.NOTDIR);
  }

  readFile(path: string, cwd = '/'): Uint8Array {
    return this.file(path, cwd).bytes();
  }

  symlink(target: string, path: string): void {
    const at = path.lastIndexOf('/');
    this.mkdirp(path.slice(0, at)).entries.set(path.slice(at + 1), new Link(target));
  }
}
