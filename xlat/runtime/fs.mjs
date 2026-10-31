// An in-memory POSIX tree: directories, regular files, symlinks and
// character devices. Files may be lazy: their bytes arrive from a loader
// (a host directory, an archive, browser storage) on first read.

export const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFCHR = 0o020000,
  S_IFIFO = 0o010000;

let inodes = 1;

/** Files whose bytes came from their loader and can go back to it (unchanged since). */
const LOADED = new Set();
/** Each such file still holding its bytes. */
export const loadedFiles = () => LOADED;

export class Node {
  constructor(mode) {
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

export class File extends Node {
  constructor(data = new Uint8Array(0), mode = 0o644, load = null) {
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
  get data() {
    if (this.load) {
      this._data = this.load();
      this.size = this._data.length;
      this.load = null;
      if (this.reload) LOADED.add(this);
    }
    return this._data;
  }
  /** Bytes [start, end) — a view, not a copy. */
  read(start, end) {
    if (this.maps) this.settle(start, end);
    return this.data.subarray(start, Math.min(end, this.size));
  }
  /** The exact contents as a view, not a copy: a later write changes a copy, never what was handed out. */
  share() {
    if (this.maps) this.settle();
    const data = this.data;
    this.shared = true;
    return data.subarray(0, this.size);
  }
  /** About to change the bytes: from here on they are this file's own. */
  own() {
    if (this.shared) { this._data = this.data.slice(0, this.size); this.shared = false; }
    LOADED.delete(this);
    this.reload = null;
  }
  /** Let go of bytes its loader can give again (unchanged since); returns how many. */
  release() {
    if (this.load || !this.reload || this.version !== 0) return 0;
    const n = this._data.length;
    this._data = new Uint8Array(0);
    this.shared = false;
    this.load = this.reload;
    LOADED.delete(this);
    return n;
  }
  write(at, bytes) {
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
    if (this.maps) this.#show(at, need);
  }
  truncate(length) {
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
    if (this.maps) this.#show(Math.min(was, length), Math.max(was, length));
  }
  /** The exact contents as an independent array. */
  bytes() {
    if (this.maps) this.settle();
    return this.data.slice(0, this.size);
  }

  /**
   * A MAP_SHARED mapping of it begins: {proc, start, length, off}, bytes [off, off + length) of it at `start` in that
   * process's memory, which holds them already. Each mapping keeps what it last had in common with the file (`seen`),
   * so what changed in its memory since is told from what changed elsewhere: only that goes to the file, and from
   * the file to every other mapping (another process's memory: fork, or the same file mapped twice).
   */
  map(m) {
    m.seen = m.proc.bytes.slice(m.start, m.start + m.length);
    (this.maps ??= new Set()).add(m);
  }
  /** It ends: what was written through it stays. */
  unmap(m) {
    this.settle(m.off, m.off + m.length, m);
    this.maps.delete(m);
    if (!this.maps.size) this.maps = null;
  }
  /** What was written through the mappings (all, or `only`) into [start, end) goes to the bytes and the other mappings. */
  settle(start = 0, end = this.size, only = null) {
    for (const m of only ? [only] : [...this.maps]) {
      const a = Math.max(start, m.off), b = Math.min(end, m.off + m.length, this.size);
      if (a >= b) continue;
      const memory = m.proc.bytes, base = m.start - m.off, seen = m.seen;
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
      }
    }
  }
  /** Bytes [start, end) are these now (`bytes`, or the file's own; zero past its end, as a new page is) in every mapping. */
  #show(start, end, bytes = null) {
    for (const m of this.maps) {
      const a = Math.max(start, m.off), b = Math.min(end, m.off + m.length);
      if (a >= b) continue;
      const part = bytes ? bytes.subarray(a - start, b - start) : this.data.subarray(a, Math.max(a, Math.min(b, this.size)));
      for (const [into, at] of [[m.proc.bytes, m.start + a - m.off], [m.seen, a - m.off]]) {
        into.set(part, at);
        into.fill(0, at + part.length, at + b - a);
      }
    }
  }
}

const PAGE = 4096;

/** Two byte ranges of one length alike: compared a word at a time where both are aligned. */
function same(x, y) {
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
  constructor(mode = 0o755) {
    super(S_IFDIR | mode);
    this.entries = new Map();
    this.nlink = 2;
  }
}

export class Link extends Node {
  constructor(target) {
    super(S_IFLNK | 0o777);
    this.target = target;
  }
  get size() { return new TextEncoder().encode(this.target).length; }
}

/** A named pipe (mkfifo): what its opens share is one pipe, made afresh once every end of the last is closed. */
export class Fifo extends Node {
  constructor(mode = 0o644) { super(S_IFIFO | mode); this.pipe = null; this.size = 0; }
}

export class Device extends Node {
  constructor(rdev, read, write) {
    super(S_IFCHR | 0o666);
    this.rdev = rdev;
    this.readDevice = read;
    this.writeDevice = write;
    this.size = 0;
  }
}

export const E = {PERM: 1, NOENT: 2, IO: 5, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, EXIST: 17,
  XDEV: 18, NOTDIR: 20, ISDIR: 21, INVAL: 22, MFILE: 24, NOTTY: 25, NOSPC: 28, SPIPE: 29, RANGE: 34, NOSYS: 38,
  NOTEMPTY: 39, LOOP: 40, NAMETOOLONG: 36, PIPE: 32, NOEXEC: 8, SRCH: 3, INTR: 4, AFNOSUPPORT: 97, NXIO: 6, TIMEDOUT: 110,
  OPNOTSUPP: 95, BUSY: 16};

export class FsError extends Error {
  constructor(errno) {
    super(`errno ${errno}`);
    this.errno = errno;
  }
}

const fail = (errno) => { throw new FsError(errno); };

export class Vfs {
  constructor() {
    this.root = new Dir();
    const dev = this.mkdirp('/dev');
    dev.entries.set('null', new Device(0x103, () => new Uint8Array(0), (b) => b.length));
    dev.entries.set('zero', new Device(0x105, (n) => new Uint8Array(n), (b) => b.length));
    dev.entries.set('urandom', new Device(0x109, (n) => crypto.getRandomValues(new Uint8Array(Math.min(n, 65536))), (b) => b.length));
    dev.entries.set('random', dev.entries.get('urandom'));
    // The controlling terminal: the console, where it is one (sys-file.mjs opens it as such).
    dev.entries.set('tty', new Device(0x500, () => new Uint8Array(0), (b) => b.length));
    for (const d of ['/tmp', '/root', '/proc', '/etc']) this.mkdirp(d);
  }

  /**
   * Resolve `path` from `cwd`. Returns {node, parent, name}; node is null
   * when only the last component is missing (useful for creation).
   */
  resolve(path, cwd = '/', follow = true, depth = 0) {
    if (depth > 40) fail(E.LOOP);
    if (path === '') fail(E.NOENT);
    const parts = (path.startsWith('/') ? path : cwd + '/' + path).split('/').filter((p) => p && p !== '.');
    const stack = [this.root];
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k], dir = stack[stack.length - 1];
      if (part === '..') { if (stack.length > 1) stack.pop(); continue; }
      if (!dir.isDir) fail(E.NOTDIR);
      const node = dir.entries.get(part);
      const last = k === parts.length - 1;
      if (!node) {
        if (last) return {node: null, parent: dir, name: part};
        fail(E.NOENT);
      }
      if (node.isLink && (!last || follow)) {
        const base = '/' + parts.slice(0, k).join('/');
        const rest = parts.slice(k + 1).join('/');
        const target = node.target.startsWith('/') ? node.target : base + '/' + node.target;
        return this.resolve(rest ? target + '/' + rest : target, '/', follow, depth + 1);
      }
      stack.push(node);
    }
    const node = stack[stack.length - 1];
    return {node, parent: stack[stack.length - 2] ?? this.root, name: parts.at(-1) ?? '/'};
  }

  lookup(path, cwd, follow = true) {
    const r = this.resolve(path, cwd, follow);
    if (!r.node) fail(E.NOENT);
    return r.node;
  }

  /** Canonical absolute path of an existing directory. */
  realpath(path, cwd) {
    const parts = [];
    const walk = (p) => {
      for (const part of p.split('/').filter((x) => x && x !== '.')) {
        if (part === '..') { parts.pop(); continue; }
        parts.push(part);
        const node = this.lookup('/' + parts.join('/'), '/', false);
        if (node.isLink) {
          parts.pop();
          walk(node.target.startsWith('/') ? (parts.length = 0, node.target) : node.target);
        }
      }
    };
    walk(path.startsWith('/') ? path : cwd + '/' + path);
    return '/' + parts.join('/');
  }

  mkdirp(path) {
    let dir = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      let next = dir.entries.get(part);
      if (!next) { next = new Dir(); dir.entries.set(part, next); dir.nlink++; }
      dir = next;
    }
    return dir;
  }

  writeFile(path, bytes, mode = 0o644) {
    const at = path.lastIndexOf('/');
    const dir = this.mkdirp(path.slice(0, at));
    const file = new File(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, mode);
    dir.entries.set(path.slice(at + 1), file);
    return file;
  }

  readFile(path, cwd = '/') {
    const node = this.lookup(path, cwd);
    if (!node.isFile) fail(node.isDir ? E.ISDIR : E.INVAL);
    return node.bytes();
  }

  symlink(target, path) {
    const at = path.lastIndexOf('/');
    this.mkdirp(path.slice(0, at)).entries.set(path.slice(at + 1), new Link(target));
  }
}
