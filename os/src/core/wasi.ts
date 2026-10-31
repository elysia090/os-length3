// WASI preview1 over files kept in memory: what the core built for the browser (core/web) calls where the
// app's core calls the system. One directory is preopened, `/` as fd 3; core/worker.ts keeps the files in
// IndexedDB through snapshot/restore and the changes since the last flush.

/** The errors preview1 names, by its numbers. */
export const E = {
  SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, BUSY: 10, EXIST: 20, FAULT: 21, INVAL: 28, IO: 29, ISDIR: 31,
  LOOP: 32, NAMETOOLONG: 37, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, SPIPE: 67, XDEV: 72,
} as const;

const TYPE = {unknown: 0, char: 2, dir: 3, file: 4, link: 7} as const;
const O = {CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8} as const;
const APPEND = 1;
const FOLLOW = 1;
const T = {ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8} as const;
const FD_WRITE = 1n << 6n;
// Every right preview1 has: rights are the host's to refuse, and this host refuses by what is there instead.
const ALL_RIGHTS = (1n << 30n) - 1n;
// Links followed in one lookup before it is a loop, as Linux counts.
const MAX_HOPS = 40;

/**
 * A failure said by its preview1 number, thrown from deep in the files to the call that answers with it: a plain
 * value, not an Error, as it is an answer and not a fault. An Error takes the stack each time it is made (through the
 * core's wasm frames), which was two thirds of what the worker spent reading a repo's files for a search.
 */
class Errno {
  readonly code: number;
  constructor(code: number) { this.code = code; }
  get message() { return `errno ${this.code}`; }
  toString() { return this.message; }
}

/** The module asked to end (proc_exit): its instance is done with. */
export class Exit extends Error {
  code: number;
  constructor(code: number) { super(`the core exited with ${code}`); this.code = code; }
}

interface Times { ino: number; nlink: number; atime: bigint; mtime: bigint; ctime: bigint }
interface Dir extends Times { kind: 'dir'; entries: Map<string, Node>; parent: Dir; name: string }
/**
 * A file: its bytes, or (`data` null) where they are kept, read in the first time they are wanted (MemoryFS.bytes),
 * so what a page never opens is never read.
 */
export interface File extends Times { kind: 'file'; data: Uint8Array | null; size: number; kept?: string }
export interface Link extends Times { kind: 'link'; target: string }
export type Node = Dir | File | Link;

/** One node as it is kept: by its path from `/`; a file kept with its bytes, or only its `size` (its bytes kept apart). */
export interface Entry {
  path: string; kind: Node['kind']; data?: Uint8Array; size?: number; target?: string;
  atime: bigint; mtime: bigint; ctime: bigint;
}

/** What changed since the last flush: what to keep (as it is now) and what is gone. */
export interface Changes { put: Entry[]; removed: string[] }

/** Where a path led: the directory it ends in, the last name there, and what is at that name. */
interface Found { dir: Dir; name: string; node: Node | undefined; slash: boolean }

const realtime = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
const fail = (code: number): never => { throw new Errno(code); };
const join = (dir: string, name: string) => dir === '/' ? `/${name}` : `${dir}/${name}`;

export class MemoryFS {
  root: Dir;
  private ino = 0;
  private last = 0n;
  private changed = new Set<Node>();
  private gone = new Set<string>();
  /** The files not read in yet, by where their bytes are kept. */
  private unread = new Map<string, File>();
  /** Reads the bytes kept at a path, there and then (core/worker.ts: from IndexedDB); null when none are. */
  loader: ((kept: string) => Uint8Array | null) | null = null;
  /** How many times a name came into a folder or went from one: what `folder` was found in. */
  private moved = 0;
  /**
   * The folder the last path's parts before its name led to, from where, while no name has come or gone since: a
   * walk asks of each file of a folder by its whole path in turn (a lstat each), and the folder is found once.
   */
  private folder: {start: Dir; head: string; dir: Dir; moved: number} | null = null;

  constructor() {
    this.root = this.makeDir();
    this.root.parent = this.root;
  }

  /** Now in ns, never twice the same: a change is always later than the one before, as a cache keyed by mtime needs. */
  now(): bigint {
    const t = realtime();
    this.last = t > this.last ? t : this.last + 1n;
    return this.last;
  }

  private times() { const t = this.now(); return {ino: ++this.ino, nlink: 1, atime: t, mtime: t, ctime: t}; }
  private makeDir(parent?: Dir, name = ''): Dir {
    const d: Dir = {kind: 'dir', entries: new Map(), parent: parent!, name, ...this.times()};
    if (!parent) d.parent = d;
    return d;
  }
  private makeFile(): File { return {kind: 'file', data: new Uint8Array(0), size: 0, ...this.times()}; }

  /** The bytes of `file`, read in from where they are kept the first time they are wanted. */
  bytes(file: File): Uint8Array {
    if (file.data) return file.data;
    const got = file.kept !== undefined && this.loader ? this.loader(file.kept) : null;
    // Gone from where it was kept (another tab let it go meanwhile): no bytes to give, and none made up.
    if (!got) return fail(E.IO);
    this.readIn(file, got);
    return got;
  }

  /** `bytes` are the file kept at `kept`, read in ahead of its being wanted (a repo's files before a call on it). */
  fill(kept: string, bytes: Uint8Array) {
    const file = this.unread.get(kept);
    if (file && !file.data) this.readIn(file, bytes);
  }

  /** Where files not read in yet are kept, under `prefix`. */
  unreadUnder(prefix: string): string[] {
    return [...this.unread.keys()].filter((k) => k.startsWith(prefix));
  }

  private readIn(file: File, bytes: Uint8Array) {
    if (file.kept !== undefined) this.unread.delete(file.kept);
    file.data = bytes;
    file.size = bytes.length;
    file.kept = undefined;
  }

  /** The path of `dir` from `/`. */
  pathOf(dir: Dir): string {
    const names: string[] = [];
    for (let d = dir; d !== this.root; d = d.parent) names.push(d.name);
    return '/' + names.reverse().join('/');
  }

  /** Mark `node` as changed, so the next flush keeps it. */
  touch(node: Node, data = true) {
    const t = this.now();
    if (data) node.mtime = t;
    node.ctime = t;
    this.changed.add(node);
  }

  /** `path` from `start` (from `/` when it begins with one); a link at the end is followed when `follow`. */
  resolve(start: Dir, path: string, follow: boolean, hops = {n: 0}): Found {
    if (path === '') fail(E.NOENT);
    // One name in a folder (what a walk asks of each entry it lists): looked up at once; or in the folder the last
    // path led to.
    const cut = path.lastIndexOf('/');
    if (cut < 0 && path !== '.' && path !== '..') {
      const node = start.entries.get(path);
      if (node?.kind !== 'link' || !follow) return {dir: start, name: path, node, slash: false};
    }
    const f = this.folder, name = path.slice(cut + 1);
    if (f && f.moved === this.moved && f.start === start && name && name !== '.' && name !== '..' && path.length - name.length - 1 === f.head.length && path.startsWith(f.head)) {
      const node = f.dir.entries.get(name);
      if (node?.kind !== 'link' || !follow) return {dir: f.dir, name, node, slash: false};
    }
    let dir = path.startsWith('/') ? this.root : start;
    const parts = path.split('/').filter((p) => p !== '');
    const slash = path.endsWith('/') || parts.length === 0;
    const last = parts.pop() ?? '.';
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') { dir = dir.parent; continue; }
      let n = dir.entries.get(part);
      if (!n) return fail(E.NOENT);
      if (n.kind === 'link') {
        if (++hops.n > MAX_HOPS) fail(E.LOOP);
        n = this.resolve(dir, n.target, true, hops).node;
        if (!n) return fail(E.NOENT);
      }
      if (n.kind !== 'dir') return fail(E.NOTDIR);
      dir = n;
    }
    if (cut > 0 && !slash) this.folder = {start, head: path.slice(0, cut), dir, moved: this.moved};
    const node = last === '.' ? dir : last === '..' ? dir.parent : dir.entries.get(last);
    if (node?.kind === 'link' && (follow || slash)) {
      if (++hops.n > MAX_HOPS) fail(E.LOOP);
      return this.resolve(dir, node.target + (slash ? '/' : ''), true, hops);
    }
    if (slash && node && node.kind !== 'dir') fail(E.NOTDIR);
    return {dir, name: last, node, slash};
  }

  /** A name that can be made or taken away (never `.` or `..`). */
  private named(f: Found): Found {
    if (f.name === '.' || f.name === '..') fail(f.node === this.root ? E.BUSY : E.INVAL);
    return f;
  }

  private place(dir: Dir, name: string, node: Node) {
    this.moved++;
    dir.entries.set(name, node);
    if (node.kind === 'dir') { node.parent = dir; node.name = name; }
    this.touch(dir);
    this.changed.add(node);
  }

  /** Take `name` out of `dir`; what was kept under it is gone at the next flush. */
  private takeOut(dir: Dir, name: string, node: Node) {
    this.moved++;
    dir.entries.delete(name);
    this.touch(dir);
    const forget = (path: string, n: Node) => {
      this.gone.add(path);
      if (n.kind === 'dir') for (const [k, c] of n.entries) forget(join(path, k), c);
    };
    forget(join(this.pathOf(dir), name), node);
  }

  /** Open `path` as path_open does: made (O_CREAT), refused if there (O_EXCL), emptied (O_TRUNC). */
  open(start: Dir, path: string, oflags: number, follow: boolean, write: boolean): Node {
    const excl = (oflags & O.CREAT) && (oflags & O.EXCL);
    const f = this.resolve(start, path, follow && !excl);
    let node = f.node;
    if (!node) {
      if (!(oflags & O.CREAT)) return fail(E.NOENT);
      if (oflags & O.DIRECTORY) fail(E.INVAL);
      if (f.slash) fail(E.ISDIR);
      this.named(f);
      node = this.makeFile();
      this.place(f.dir, f.name, node);
      return node;
    }
    if (excl) fail(E.EXIST);
    if (node.kind === 'link') fail(E.LOOP);
    if ((oflags & O.DIRECTORY) && node.kind !== 'dir') fail(E.NOTDIR);
    if (node.kind === 'dir' && (write || (oflags & (O.TRUNC | O.CREAT)))) fail(E.ISDIR);
    if (node.kind === 'file' && (oflags & O.TRUNC) && node.size) this.truncate(node, 0);
    return node;
  }

  mkdir(start: Dir, path: string) {
    const f = this.named(this.resolve(start, path, false));
    if (f.node) fail(E.EXIST);
    this.place(f.dir, f.name, this.makeDir(f.dir, f.name));
  }

  rmdir(start: Dir, path: string) {
    const f = this.named(this.resolve(start, path, false));
    if (!f.node) return fail(E.NOENT);
    if (f.node.kind !== 'dir') fail(E.NOTDIR);
    if ((f.node as Dir).entries.size) fail(E.NOTEMPTY);
    this.takeOut(f.dir, f.name, f.node);
  }

  unlink(start: Dir, path: string) {
    const f = this.named(this.resolve(start, path, false));
    if (!f.node) return fail(E.NOENT);
    if (f.node.kind === 'dir') fail(E.ISDIR);
    this.takeOut(f.dir, f.name, f.node);
    f.node.nlink--;
  }

  /** Move as rename(2): over a file, or over an empty directory; never over one that holds something. */
  rename(fromStart: Dir, from: string, toStart: Dir, to: string) {
    const a = this.named(this.resolve(fromStart, from, false));
    const b = this.named(this.resolve(toStart, to, false));
    const node = a.node;
    if (!node) return fail(E.NOENT);
    if (b.node === node) return;
    if (node.kind === 'dir') {
      for (let d = b.dir; ; d = d.parent) { if (d === node) fail(E.INVAL); if (d === this.root) break; }
    } else if (b.slash) fail(E.NOTDIR);
    if (b.node) {
      if (b.node.kind === 'dir' && node.kind !== 'dir') fail(E.ISDIR);
      if (b.node.kind !== 'dir' && node.kind === 'dir') fail(E.NOTDIR);
      if (b.node.kind === 'dir' && b.node.entries.size) fail(E.NOTEMPTY);
      this.takeOut(b.dir, b.name, b.node);
      b.node.nlink--;
    }
    this.takeOut(a.dir, a.name, node);
    this.place(b.dir, b.name, node);
    this.touch(node, false);
    // A directory's whole tree is under another path now.
    const again = (n: Node) => { this.changed.add(n); if (n.kind === 'dir') for (const c of n.entries.values()) again(c); };
    again(node);
  }

  symlink(target: string, start: Dir, path: string) {
    const f = this.named(this.resolve(start, path, false));
    if (f.node) fail(E.EXIST);
    if (f.slash) fail(E.NOENT);
    this.place(f.dir, f.name, {kind: 'link', target, ...this.times()});
  }

  link(fromStart: Dir, from: string, follow: boolean, toStart: Dir, to: string) {
    const node = this.resolve(fromStart, from, follow).node;
    if (!node) return fail(E.NOENT);
    if (node.kind === 'dir') fail(E.PERM);
    const b = this.named(this.resolve(toStart, to, false));
    if (b.node) fail(E.EXIST);
    node.nlink++;
    this.place(b.dir, b.name, node);
    this.touch(node, false);
  }

  readlink(start: Dir, path: string): string {
    const n = this.resolve(start, path, false).node;
    if (!n) return fail(E.NOENT);
    if (n.kind !== 'link') fail(E.INVAL);
    return (n as Link).target;
  }

  setTimes(node: Node, atim: bigint, mtim: bigint, flags: number) {
    if ((flags & T.ATIM && flags & T.ATIM_NOW) || (flags & T.MTIM && flags & T.MTIM_NOW)) fail(E.INVAL);
    const t = this.now();
    if (flags & T.ATIM) node.atime = atim; else if (flags & T.ATIM_NOW) node.atime = t;
    if (flags & T.MTIM) node.mtime = mtim; else if (flags & T.MTIM_NOW) node.mtime = t;
    node.ctime = t;
    this.changed.add(node);
  }

  private room(file: File, size: number) {
    const was = this.bytes(file);
    if (size <= was.length) return;
    const data = new Uint8Array(Math.max(size, was.length * 2, 64));
    data.set(was.subarray(0, file.size));
    file.data = data;
  }

  truncate(file: File, size: number) {
    // Emptied, what it held is never read in to be thrown away.
    if (size === 0 && !file.data) { if (file.kept !== undefined) this.unread.delete(file.kept); file.data = new Uint8Array(0); file.kept = undefined; }
    else if (size < file.size) this.bytes(file).fill(0, size, file.size); else this.room(file, size);
    file.size = size;
    this.touch(file);
  }

  writeAt(file: File, at: number, bytes: Uint8Array) {
    this.room(file, at + bytes.length);
    this.bytes(file).set(bytes, at);
    file.size = Math.max(file.size, at + bytes.length);
    this.touch(file);
  }

  // ---- for the host: a file by its path, everything kept, and what changed ----

  /** The bytes at `path`, if a file is there. */
  read(path: string): Uint8Array | undefined {
    try {
      const n = this.resolve(this.root, path, true).node;
      return n?.kind === 'file' ? this.bytes(n).slice(0, n.size) : undefined;
    } catch { return undefined; }
  }

  /** Put `bytes` at `path`, making the directories it is in. */
  write(path: string, bytes: Uint8Array) {
    const parts = path.split('/').filter((p) => p);
    const name = parts.pop();
    if (!name) fail(E.INVAL);
    let dir = this.root;
    for (const p of parts) {
      let d = dir.entries.get(p);
      if (!d) { d = this.makeDir(dir, p); this.place(dir, p, d); }
      if (d.kind !== 'dir') fail(E.NOTDIR);
      dir = d as Dir;
    }
    let file = dir.entries.get(name!);
    if (!file) { file = this.makeFile(); this.place(dir, name!, file); }
    if (file.kind !== 'file') fail(E.ISDIR);
    this.truncate(file as File, 0);
    this.writeAt(file as File, 0, bytes);
  }

  private walk(dir: Dir, path: string, each: (path: string, node: Node) => void) {
    for (const [name, node] of dir.entries) {
      const p = join(path, name);
      each(p, node);
      if (node.kind === 'dir') this.walk(node, p, each);
    }
  }

  private entry(path: string, n: Node): Entry {
    const e: Entry = {path, kind: n.kind, atime: n.atime, mtime: n.mtime, ctime: n.ctime};
    if (n.kind === 'file') e.data = this.bytes(n).slice(0, n.size);
    if (n.kind === 'link') e.target = n.target;
    return e;
  }

  /** Everything kept, parents before what is in them. */
  snapshot(): Entry[] {
    const out: Entry[] = [];
    this.walk(this.root, '/', (p, n) => out.push(this.entry(p, n)));
    return out;
  }

  /** Everything as `entries` say, and nothing else; nothing counts as changed after. */
  restore(entries: Entry[]) {
    this.moved++;
    this.root = this.makeDir();
    this.changed.clear();
    this.gone.clear();
    this.unread.clear();
    for (const e of [...entries].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
      const parts = e.path.split('/').filter((p) => p);
      const name = parts.pop();
      if (!name) continue;
      let dir = this.root;
      // A parent never kept is made: what is under it is not lost for it.
      for (const p of parts) {
        let d = dir.entries.get(p);
        if (d?.kind !== 'dir') { d = this.makeDir(dir, p); dir.entries.set(p, d); }
        dir = d as Dir;
      }
      const t = {ino: ++this.ino, nlink: 1, atime: e.atime, mtime: e.mtime, ctime: e.ctime};
      const old = dir.entries.get(name);
      const node: Node = e.kind === 'dir'
        ? (old?.kind === 'dir' ? Object.assign(old, {atime: e.atime, mtime: e.mtime, ctime: e.ctime}) : {kind: 'dir', entries: new Map(), parent: dir, name, ...t})
        : e.kind === 'file'
          ? (e.data ? {kind: 'file', data: new Uint8Array(e.data), size: e.data.length, ...t} : this.keptAt(e.path, e.size ?? 0, t))
          : {kind: 'link', target: e.target ?? '', ...t};
      dir.entries.set(name, node);
      if (e.mtime > this.last) this.last = e.mtime;
    }
    this.changed.clear();
  }

  private keptAt(path: string, size: number, t: Times): File {
    const file: File = {kind: 'file', data: null, size, kept: path, ...t};
    this.unread.set(path, file);
    return file;
  }

  /** Whether anything changed since the last flush. */
  get dirty(): boolean { return this.changed.size > 0 || this.gone.size > 0; }

  /** What changed since the last flush, by path; it counts as kept after. */
  flush(): Changes {
    const put: Entry[] = [];
    if (this.changed.size) this.walk(this.root, '/', (p, n) => { if (this.changed.has(n)) put.push(this.entry(p, n)); });
    const kept = new Set(put.map((e) => e.path));
    const removed = [...this.gone].filter((p) => !kept.has(p));
    this.changed.clear();
    this.gone.clear();
    return {put, removed};
  }
}

interface Open {
  node?: Node;
  pos: number;
  append: boolean;
  /** Its name as preopened. */
  preopen?: string;
  /** The names fd_readdir hands out, read when a listing starts (cookie 0). */
  listing?: [string, Node][];
}

interface WasiOptions {
  fs: MemoryFS;
  env?: Record<string, string>;
  args?: string[];
  /** Where a line the module prints goes (fd 1, fd 2). */
  out?: (line: string, fd: number) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Wait `ms`, in a worker without spinning when memory can be shared. */
function block(ms: number) {
  if (ms <= 0) return;
  try {
    if (typeof SharedArrayBuffer === 'function') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return; }
  } catch { /* a page's main thread may not wait */ }
  const end = performance.now() + ms;
  while (performance.now() < end) { /* only ever a short sleep */ }
}

/** One module's view of a MemoryFS through preview1: its fds, its environment, its output. */
export class WASI {
  fs: MemoryFS;
  env: Record<string, string>;
  args: string[];
  memory?: WebAssembly.Memory;
  private fds = new Map<number, Open>();
  private nextFd = 4;
  private lines = new Map<number, string>();
  private out: (line: string, fd: number) => void;
  /** The preview1 functions, as `wasi_snapshot_preview1` imports them. */
  imports: Record<string, (...a: never[]) => number>;

  constructor(options: WasiOptions) {
    this.fs = options.fs;
    this.env = options.env ?? {};
    this.args = options.args ?? ['length3-core'];
    this.out = options.out ?? ((line, fd) => (fd === 2 ? console.error : console.log)(line));
    for (const fd of [0, 1, 2]) this.fds.set(fd, {pos: 0, append: false});
    this.fds.set(3, {pos: 0, append: false, preopen: '/'});
    const calls = this.calls();
    this.imports = {};
    for (const [name, f] of Object.entries(calls)) {
      this.imports[name] = (...a: never[]) => {
        try { return (f as (...a: never[]) => number)(...a) ?? E.SUCCESS; } catch (e) {
          if (e instanceof Errno) return e.code;
          if (e instanceof RangeError) return E.FAULT;
          throw e;
        }
      };
    }
  }

  /** Use `instance`'s memory from now on. */
  bind(instance: WebAssembly.Instance) {
    this.memory = instance.exports.memory as WebAssembly.Memory;
    this.seen = undefined;
  }

  /** What is still waiting for its end of line goes out. */
  flushOutput() {
    for (const [fd, rest] of this.lines) if (rest) this.out(rest, fd);
    this.lines.clear();
  }

  /**
   * The module's memory as a DataView, made again only when the memory grew, not at each word: growing detaches the
   * buffer before (its length 0 then).
   */
  private seen?: DataView<ArrayBuffer>;
  private get view() {
    if (!this.seen || this.seen.buffer.byteLength === 0) this.seen = new DataView(this.memory!.buffer);
    return this.seen;
  }
  private bytes(ptr: number, len: number) { return new Uint8Array(this.view.buffer, ptr >>> 0, len >>> 0); }
  private str(ptr: number, len: number) { return decoder.decode(this.bytes(ptr, len)); }
  private u8(ptr: number, v: number) { this.view.setUint8(ptr >>> 0, v); }
  private u16(ptr: number, v: number) { this.view.setUint16(ptr >>> 0, v, true); }
  private u32(ptr: number, v: number) { this.view.setUint32(ptr >>> 0, v, true); }
  private u64(ptr: number, v: bigint | number) { this.view.setBigUint64(ptr >>> 0, BigInt(v), true); }

  private fd(fd: number): Open { return this.fds.get(fd) ?? fail(E.BADF); }
  private dirOf(fd: number): Dir {
    const o = this.fd(fd);
    const d = o.preopen ? this.fs.root : o.node;
    if (!d) return fail(E.BADF);
    if (d.kind !== 'dir') fail(E.NOTDIR);
    return d as Dir;
  }
  private nodeOf(o: Open): Node | undefined { return o.preopen ? this.fs.root : o.node; }

  private iovs(ptr: number, n: number): Uint8Array[] {
    const v = this.view;
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const at = (ptr >>> 0) + i * 8;
      out.push(this.bytes(v.getUint32(at, true), v.getUint32(at + 4, true)));
    }
    return out;
  }

  private stat(ptr: number, n: Node) {
    const v = this.view, at = ptr >>> 0;
    // A number (never past 2^53) as a u64 in two words: no BigInt made for each.
    const u64 = (to: number, x: number) => { v.setUint32(to, x >>> 0, true); v.setUint32(to + 4, Math.floor(x / 0x100000000), true); };
    this.bytes(at, 64).fill(0);
    u64(at + 8, n.ino);
    v.setUint8(at + 16, TYPE[n.kind]);
    u64(at + 24, n.nlink);
    u64(at + 32, n.kind === 'file' ? n.size : n.kind === 'link' ? encoder.encode(n.target).length : 4096);
    v.setBigUint64(at + 40, n.atime, true);
    v.setBigUint64(at + 48, n.mtime, true);
    v.setBigUint64(at + 56, n.ctime, true);
  }

  private print(fd: number, bytes: Uint8Array) {
    const text = (this.lines.get(fd) ?? '') + decoder.decode(bytes, {stream: true});
    const parts = text.split('\n');
    this.lines.set(fd, parts.pop()!);
    for (const line of parts) this.out(line, fd);
  }

  private sized(list: string[], countPtr: number, sizePtr: number) {
    this.u32(countPtr, list.length);
    this.u32(sizePtr, list.reduce((n, s) => n + encoder.encode(s).length + 1, 0));
  }

  private strings(list: string[], ptrs: number, buf: number) {
    let at = buf >>> 0;
    list.forEach((s, i) => {
      const b = encoder.encode(s);
      this.u32(ptrs + i * 4, at);
      this.bytes(at, b.length + 1).set([...b, 0]);
      at += b.length + 1;
    });
  }

  private environ() { return Object.entries(this.env).map(([k, v]) => `${k}=${v}`); }

  private clock(id: number): bigint {
    if (id === 0) return realtime();
    if (id >= 1 && id <= 3) return BigInt(Math.round(performance.now() * 1e6));
    return fail(E.INVAL);
  }

  private calls() {
    const fs = this.fs;
    return {
      args_get: (argv: number, buf: number) => this.strings(this.args, argv, buf),
      args_sizes_get: (count: number, size: number) => this.sized(this.args, count, size),
      environ_get: (env: number, buf: number) => this.strings(this.environ(), env, buf),
      environ_sizes_get: (count: number, size: number) => this.sized(this.environ(), count, size),

      clock_res_get: (id: number, res: number) => { this.clock(id); this.u64(res, 1000); },
      clock_time_get: (id: number, _precision: bigint, time: number) => this.u64(time, this.clock(id)),

      random_get: (ptr: number, len: number) => {
        const b = this.bytes(ptr, len);
        // getRandomValues gives at most 64 KiB at a time.
        for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
      },
      sched_yield: () => E.SUCCESS,
      proc_exit: (code: number) => { this.flushOutput(); throw new Exit(code); },

      fd_advise: (fd: number) => { this.fd(fd); },
      fd_allocate: (fd: number, offset: bigint, len: bigint) => {
        const n = this.nodeOf(this.fd(fd));
        if (n?.kind !== 'file') return E.BADF;
        const end = Number(offset + len);
        if (end > n.size) fs.truncate(n, end);
      },
      fd_close: (fd: number) => {
        this.fd(fd);
        if (fd <= 3) return;
        this.fds.delete(fd);
      },
      fd_datasync: (fd: number) => { this.fd(fd); },
      fd_sync: (fd: number) => { this.fd(fd); },
      fd_fdstat_get: (fd: number, ptr: number) => {
        const o = this.fd(fd);
        const n = this.nodeOf(o);
        this.u8(ptr, n ? TYPE[n.kind] : TYPE.char);
        this.u16(ptr + 2, o.append ? APPEND : 0);
        this.u64(ptr + 8, ALL_RIGHTS);
        this.u64(ptr + 16, ALL_RIGHTS);
      },
      fd_fdstat_set_flags: (fd: number, flags: number) => { this.fd(fd).append = !!(flags & APPEND); },
      fd_filestat_get: (fd: number, ptr: number) => {
        const n = this.nodeOf(this.fd(fd));
        if (!n) {
          for (let i = 0; i < 64; i += 8) this.u64(ptr + i, 0);
          this.u8(ptr + 16, TYPE.char);
          return;
        }
        this.stat(ptr, n);
      },
      fd_filestat_set_size: (fd: number, size: bigint) => {
        const n = this.nodeOf(this.fd(fd));
        if (n?.kind !== 'file') return n ? E.ISDIR : E.BADF;
        fs.truncate(n, Number(size));
      },
      fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, flags: number) => {
        const n = this.nodeOf(this.fd(fd));
        if (!n) return E.BADF;
        fs.setTimes(n, atim, mtim, flags);
      },
      fd_prestat_get: (fd: number, ptr: number) => {
        const p = this.fds.get(fd)?.preopen;
        if (p === undefined) return E.BADF;
        this.u8(ptr, 0);
        this.u32(ptr + 4, encoder.encode(p).length);
      },
      fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
        const p = this.fds.get(fd)?.preopen;
        if (p === undefined) return E.BADF;
        const b = encoder.encode(p);
        if (len < b.length) return E.NAMETOOLONG;
        this.bytes(ptr, b.length).set(b);
      },
      fd_read: (fd: number, iovs: number, n: number, nread: number) => this.u32(nread, this.readv(this.fd(fd), iovs, n, undefined)),
      fd_pread: (fd: number, iovs: number, n: number, offset: bigint, nread: number) =>
        this.u32(nread, this.readv(this.fd(fd), iovs, n, Number(offset))),
      fd_write: (fd: number, iovs: number, n: number, nwritten: number) => this.u32(nwritten, this.writev(fd, iovs, n, undefined)),
      fd_pwrite: (fd: number, iovs: number, n: number, offset: bigint, nwritten: number) =>
        this.u32(nwritten, this.writev(fd, iovs, n, Number(offset))),
      fd_readdir: (fd: number, buf: number, len: number, cookie: bigint, used: number) => this.readdir(fd, buf, len, Number(cookie), used),
      fd_renumber: (from: number, to: number) => {
        const o = this.fd(from);
        this.fd(to);
        this.fds.set(to, o);
        this.fds.delete(from);
      },
      fd_seek: (fd: number, offset: bigint, whence: number, ptr: number) => {
        const o = this.fd(fd);
        const n = this.nodeOf(o);
        if (!n) return E.SPIPE;
        const base = whence === 0 ? 0 : whence === 1 ? o.pos : whence === 2 ? (n.kind === 'file' ? n.size : 0) : fail(E.INVAL);
        const at = base + Number(offset);
        if (at < 0) return E.INVAL;
        o.pos = at;
        this.u64(ptr, at);
      },
      fd_tell: (fd: number, ptr: number) => this.u64(ptr, this.fd(fd).pos),

      path_create_directory: (fd: number, path: number, len: number) => fs.mkdir(this.dirOf(fd), this.str(path, len)),
      path_filestat_get: (fd: number, flags: number, path: number, len: number, ptr: number) => {
        const n = fs.resolve(this.dirOf(fd), this.str(path, len), !!(flags & FOLLOW)).node;
        if (!n) return E.NOENT;
        this.stat(ptr, n);
      },
      path_filestat_set_times: (fd: number, flags: number, path: number, len: number, atim: bigint, mtim: bigint, fst: number) => {
        const n = fs.resolve(this.dirOf(fd), this.str(path, len), !!(flags & FOLLOW)).node;
        if (!n) return E.NOENT;
        fs.setTimes(n, atim, mtim, fst);
      },
      path_link: (from: number, flags: number, a: number, alen: number, to: number, b: number, blen: number) =>
        fs.link(this.dirOf(from), this.str(a, alen), !!(flags & FOLLOW), this.dirOf(to), this.str(b, blen)),
      path_open: (fd: number, dirflags: number, path: number, len: number, oflags: number, base: bigint, _inheriting: bigint,
        fdflags: number, out: number) => {
        const node = fs.open(this.dirOf(fd), this.str(path, len), oflags, !!(dirflags & FOLLOW), (BigInt(base) & FD_WRITE) !== 0n);
        const n = this.nextFd++;
        this.fds.set(n, {node, pos: 0, append: !!(fdflags & APPEND)});
        this.u32(out, n);
      },
      path_readlink: (fd: number, path: number, len: number, buf: number, buflen: number, used: number) => {
        const b = encoder.encode(fs.readlink(this.dirOf(fd), this.str(path, len)));
        const n = Math.min(b.length, buflen);
        this.bytes(buf, n).set(b.subarray(0, n));
        this.u32(used, n);
      },
      path_remove_directory: (fd: number, path: number, len: number) => fs.rmdir(this.dirOf(fd), this.str(path, len)),
      path_rename: (fd: number, a: number, alen: number, to: number, b: number, blen: number) =>
        fs.rename(this.dirOf(fd), this.str(a, alen), this.dirOf(to), this.str(b, blen)),
      path_symlink: (a: number, alen: number, fd: number, b: number, blen: number) => fs.symlink(this.str(a, alen), this.dirOf(fd), this.str(b, blen)),
      path_unlink_file: (fd: number, path: number, len: number) => fs.unlink(this.dirOf(fd), this.str(path, len)),

      poll_oneoff: (subs: number, events: number, n: number, nevents: number) => this.poll(subs, events, n, nevents),
    };
  }

  private readv(o: Open, iovs: number, n: number, offset: number | undefined): number {
    const node = this.nodeOf(o);
    if (!node) return 0;
    if (node.kind === 'dir') return fail(E.ISDIR);
    if (node.kind !== 'file') return fail(E.BADF);
    let at = offset ?? o.pos;
    let read = 0;
    for (const iov of this.iovs(iovs, n)) {
      const k = Math.max(0, Math.min(iov.length, node.size - at));
      iov.set(this.fs.bytes(node).subarray(at, at + k));
      at += k;
      read += k;
      if (k < iov.length) break;
    }
    if (offset === undefined) o.pos = at;
    return read;
  }

  private writev(fd: number, iovs: number, n: number, offset: number | undefined): number {
    const o = this.fd(fd);
    const chunks = this.iovs(iovs, n);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const node = this.nodeOf(o);
    if (!node) {
      if (fd === 0) return fail(E.BADF);
      for (const c of chunks) this.print(fd, c);
      return total;
    }
    if (node.kind === 'dir') return fail(E.ISDIR);
    if (node.kind !== 'file') return fail(E.BADF);
    let at = offset ?? (o.append ? node.size : o.pos);
    const all = new Uint8Array(total);
    let k = 0;
    for (const c of chunks) { all.set(c, k); k += c.length; }
    this.fs.writeAt(node, at, all);
    at += total;
    if (offset === undefined) o.pos = at;
    return total;
  }

  // A dirent is d_next u64, d_ino u64, d_namlen u32, d_type u8, padded to 24 bytes, then the name; what does
  // not fit is cut, and a full buffer tells the reader to ask again from the last whole entry's cookie.
  private readdir(fd: number, buf: number, len: number, cookie: number, used: number) {
    const o = this.fd(fd);
    const dir = this.nodeOf(o);
    if (!dir) return E.BADF;
    if (dir.kind !== 'dir') return E.NOTDIR;
    if (cookie === 0 || !o.listing) o.listing = [['.', dir], ['..', dir.parent], ...dir.entries];
    // Each entry written where the module wants it; the last one that does not fit whole is cut, as preview1 has it
    // (the module asks again with more room).
    const v = this.view, mem = this.bytes(buf, len), base = buf >>> 0;
    let at = 0;
    for (let i = cookie; i < o.listing.length && at < len; i++) {
      const [name, node] = o.listing[i];
      if (len - at >= 24) {
        const wrote = encoder.encodeInto(name, mem.subarray(at + 24));
        if (wrote.read === name.length) {
          v.setBigUint64(base + at, BigInt(i + 1), true);
          v.setBigUint64(base + at + 8, BigInt(node.ino), true);
          v.setUint32(base + at + 16, wrote.written, true);
          v.setUint32(base + at + 20, TYPE[node.kind], true);
          at += 24 + wrote.written;
          continue;
        }
      }
      const b = encoder.encode(name);
      const whole = new Uint8Array(24 + b.length), head = new DataView(whole.buffer);
      head.setBigUint64(0, BigInt(i + 1), true);
      head.setBigUint64(8, BigInt(node.ino), true);
      head.setUint32(16, b.length, true);
      head.setUint32(20, TYPE[node.kind], true);
      whole.set(b, 24);
      const k = Math.min(whole.length, len - at);
      mem.set(whole.subarray(0, k), at);
      at += k;
    }
    this.u32(used, at);
  }

  // Only clocks are waited on (the core sleeps a little between tries); a file or stdin is always ready.
  private poll(subs: number, events: number, n: number, nevents: number) {
    if (n === 0) return E.INVAL;
    const v = this.view;
    const clocks: {userdata: bigint; deadline: bigint; id: number}[] = [];
    const ready: {userdata: bigint; type: number; error: number}[] = [];
    for (let i = 0; i < n; i++) {
      const at = (subs >>> 0) + i * 48;
      const userdata = v.getBigUint64(at, true);
      const tag = v.getUint8(at + 8);
      if (tag === 0) {
        const id = v.getUint32(at + 16, true);
        const timeout = v.getBigUint64(at + 24, true);
        const abs = v.getUint16(at + 40, true) & 1;
        let now: bigint;
        try { now = this.clock(id); } catch { ready.push({userdata, type: 0, error: E.INVAL}); continue; }
        clocks.push({userdata, id, deadline: abs ? timeout : now + timeout});
      } else {
        const fd = v.getUint32(at + 16, true);
        ready.push({userdata, type: tag, error: this.fds.has(fd) ? E.SUCCESS : E.BADF});
      }
    }
    const left = (c: {deadline: bigint; id: number}) => c.deadline - this.clock(c.id);
    const first = clocks.length ? clocks.reduce((a, b) => (left(b) < left(a) ? b : a)) : undefined;
    if (!ready.length && first) block(Number(left(first)) / 1e6);
    for (const c of clocks) if (left(c) <= 0n) ready.push({userdata: c.userdata, type: 0, error: E.SUCCESS});
    // A wait rounded to the millisecond may end just short: the nearest clock is the one that ran out.
    if (!ready.length && first) ready.push({userdata: first.userdata, type: 0, error: E.SUCCESS});
    ready.forEach((r, i) => {
      const at = events + i * 32;
      for (let j = 0; j < 32; j += 8) this.u64(at + j, 0);
      this.u64(at, r.userdata);
      this.u16(at + 8, r.error);
      this.u8(at + 10, r.type);
    });
    this.u32(nevents, ready.length);
  }
}
