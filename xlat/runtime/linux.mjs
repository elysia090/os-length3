// A Linux x86-64 user-mode personality for programs translated by xlat.
// There is no kernel to boot: the program starts at its ELF entry with a
// SysV stack, and its system calls land here. Runs the same in a browser
// Worker and in Node.

import {Fpu} from './fpu.mjs';

const PAGE = 4096;
const WASM_PAGE = 65536;
const STACK_BYTES = 8 << 20;
const GUARD = 1 << 16;

const E = {PERM: 1, NOENT: 2, BADF: 9, CHILD: 10, AGAIN: 11, NOMEM: 12, ACCES: 13, FAULT: 14, EXIST: 17,
  NOTDIR: 20, ISDIR: 21, INVAL: 22, NOTTY: 25, SPIPE: 29, RANGE: 34, NOSYS: 38, NOTEMPTY: 39};

class Exit {
  constructor(code) { this.code = code; }
}

export class GuestTrap extends Error {
  constructor(address, code) {
    const kind = {1: 'jump to untranslated code', 2: 'undecodable code', 3: 'unsupported instruction', 4: 'divide error'}[code] ?? `trap ${code}`;
    super(`${kind} at 0x${address.toString(16)}`);
    this.address = address;
    this.code = code;
  }
}

/** Read the loader facts the translator embedded in the module. */
export function facts(module) {
  const [section] = WebAssembly.Module.customSections(module, 'xlat.facts');
  return JSON.parse(new TextDecoder().decode(section));
}

/** A tiny in-memory filesystem: path -> Uint8Array, directories implied. */
export class MemoryFiles {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v]));
  }
  read(path) { return this.files.get(path) ?? null; }
  write(path, bytes) { this.files.set(path, bytes); }
  isDirectory(path) {
    const prefix = path.endsWith('/') ? path : path + '/';
    return path === '/' || [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
  remove(path) { return this.files.delete(path); }
}

export class Linux {
  constructor({argv = ['program'], env = [], files = new MemoryFiles(), stdout, stderr, stdin = new Uint8Array(0), cwd = '/'} = {}) {
    this.argv = argv;
    this.env = env;
    this.files = files;
    this.out = stdout ?? (() => {});
    this.err = stderr ?? this.out;
    this.stdin = stdin;
    this.stdinAt = 0;
    this.cwd = cwd;
    this.fds = new Map([[0, {kind: 'stdin'}], [1, {kind: 'stdout'}], [2, {kind: 'stderr'}]]);
    this.syscalls = 0;
    this.trail = new Array(256).fill(0n);
    this.trailAt = 0;
  }

  /** The most recent block entries, oldest first (with --trace). */
  recent(n = 32) {
    const out = [];
    for (let k = n; k > 0; k--) out.push(this.trail[(this.trailAt - k) & 255]);
    return out.filter((a) => a).map((a) => '0x' + a.toString(16));
  }

  async load(module) {
    this.facts = facts(module);
    const f = this.facts;
    this.stackLow = Math.ceil((f.imageEnd + GUARD) / PAGE) * PAGE;
    this.stackTop = this.stackLow + STACK_BYTES;
    this.mapBase = Math.ceil((this.stackTop + GUARD) / WASM_PAGE) * WASM_PAGE;
    this.mapEnd = this.mapBase;
    this.free = [];
    this.memory = new WebAssembly.Memory({initial: this.mapBase / WASM_PAGE, maximum: 65536});
    const [ops] = WebAssembly.Module.customSections(module, 'xlat.fpu');
    this.fpu = new Fpu(() => this.bytes, new TextDecoder().decode(ops).split(','));
    this.instance = await WebAssembly.instantiate(module, {env: {
      memory: this.memory,
      syscall: (...args) => this.syscall(...args),
      trap: (address, code) => { throw new GuestTrap(address, code); },
      div128: (hi, lo, d, signed) => this.div128(hi, lo, d, signed),
      clock: () => BigInt(Math.round(performance.now() * 1e6)),
      fpu: (op, size, address, a, b) => this.fpu.call(op, size, address, a, b),
      trace: (address) => { this.trail[this.trailAt++ & 255] = address; },
    }});
    return this;
  }

  get bytes() { return new Uint8Array(this.memory.buffer); }
  get view() { return new DataView(this.memory.buffer); }

  /** Build the SysV entry stack: argc, argv, envp, auxv, then strings. */
  stack() {
    const enc = new TextEncoder();
    let top = this.stackTop;
    const put = (bytes) => { top -= bytes.length; this.bytes.set(bytes, top); return top; };
    const strings = (list) => list.map((s) => put(enc.encode(s + '\0')));
    const random = put(crypto.getRandomValues(new Uint8Array(16)));
    const envp = strings(this.env), argv = strings(this.argv);
    const f = this.facts;
    const aux = [[3, f.phdr], [4, f.phent], [5, f.phnum], [6, PAGE], [9, f.entry], [11, 0], [12, 0], [13, 0], [14, 0],
      [23, 0], [25, random], [0, 0]];
    const words = [argv.length, ...argv, 0, ...envp, 0, ...aux.flat()];
    top = (top - words.length * 8) & ~15;
    words.forEach((w, k) => this.view.setBigUint64(top + k * 8, BigInt(w), true));
    return top;
  }

  run() {
    const g = this.instance.exports;
    g.r4.value = BigInt(this.stack());
    try {
      g.run(BigInt(this.facts.entry));
    } catch (e) {
      if (e instanceof Exit) return e.code;
      throw e;
    }
    return 0;
  }

  div128(hi, lo, d, signed) {
    let n = (BigInt.asUintN(64, hi) << 64n) | BigInt.asUintN(64, lo);
    let divisor = BigInt.asUintN(64, d);
    if (signed) { n = BigInt.asIntN(128, n); divisor = BigInt.asIntN(64, divisor); }
    if (divisor === 0n) throw new GuestTrap(0n, 4);
    const q = n / divisor, r = n % divisor;
    if (signed ? BigInt.asIntN(64, q) !== q : BigInt.asUintN(64, q) !== q) throw new GuestTrap(0n, 4);
    return [BigInt.asIntN(64, q), BigInt.asIntN(64, r)];
  }

  // ---- memory helpers ----

  cstring(address) {
    const b = this.bytes;
    let end = address;
    while (b[end]) end++;
    return new TextDecoder().decode(b.subarray(address, end));
  }

  path(address, dirfd = -100) {
    const p = this.cstring(address);
    if (p.startsWith('/')) return normalize(p);
    const base = dirfd === -100 ? this.cwd : this.fds.get(dirfd)?.path ?? this.cwd;
    return normalize(base + '/' + p);
  }

  reserve(length) {
    length = Math.ceil(length / PAGE) * PAGE;
    const k = this.free.findIndex((r) => r.length >= length);
    if (k >= 0) {
      const r = this.free[k];
      this.free.splice(k, 1);
      if (r.length > length) this.free.push({start: r.start + length, length: r.length - length});
      this.bytes.fill(0, r.start, r.start + length);
      return r.start;
    }
    const start = this.mapEnd;
    const need = start + length - this.memory.buffer.byteLength;
    if (need > 0) this.memory.grow(Math.ceil(need / WASM_PAGE));
    this.mapEnd += length;
    return start;
  }

  // ---- system calls ----

  syscall(nr, a, b, c, d, e, f) {
    this.syscalls++;
    const n = Number(nr);
    const handler = CALLS[n];
    if (!handler) return BigInt(-E.NOSYS);
    const r = handler.call(this, a, b, c, d, e, f);
    return typeof r === 'bigint' ? r : BigInt(r);
  }

  write(fd, address, length) {
    const entry = this.fds.get(fd);
    if (!entry) return -E.BADF;
    const data = this.bytes.slice(address, address + length);
    if (entry.kind === 'stdout' || entry.kind === 'stderr') {
      (entry.kind === 'stdout' ? this.out : this.err)(data);
      return length;
    }
    if (entry.kind !== 'file' || !entry.writable) return -E.BADF;
    const old = this.files.read(entry.path) ?? new Uint8Array(0);
    const at = entry.append ? old.length : entry.offset;
    const next = new Uint8Array(Math.max(old.length, at + length));
    next.set(old); next.set(data, at);
    this.files.write(entry.path, next);
    entry.offset = at + length;
    return length;
  }

  read(fd, address, length) {
    const entry = this.fds.get(fd);
    if (!entry) return -E.BADF;
    let source, at;
    if (entry.kind === 'stdin') { source = this.stdin; at = this.stdinAt; }
    else if (entry.kind === 'file') { source = this.files.read(entry.path) ?? new Uint8Array(0); at = entry.offset; }
    else return -E.BADF;
    const n = Math.max(0, Math.min(length, source.length - at));
    this.bytes.set(source.subarray(at, at + n), address);
    if (entry.kind === 'stdin') this.stdinAt += n; else entry.offset += n;
    return n;
  }

  stat(path, address) {
    const data = this.files.read(path);
    const directory = !data && this.files.isDirectory(path);
    if (!data && !directory) return -E.NOENT;
    return this.fillStat(address, directory ? 0o040755 : 0o100644, data?.length ?? 0);
  }

  fillStat(address, mode, size) {
    this.bytes.fill(0, address, address + 144);
    const v = this.view;
    v.setBigUint64(address + 8, 1n, true); // ino
    v.setBigUint64(address + 16, 1n, true); // nlink
    v.setUint32(address + 24, mode, true);
    v.setBigInt64(address + 48, BigInt(size), true);
    v.setBigInt64(address + 56, 4096n, true); // blksize
    v.setBigInt64(address + 64, BigInt(Math.ceil(size / 512)), true);
    return 0;
  }
}

function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

const N = (x) => Number(BigInt.asIntN(64, x));

const CALLS = {
  0(fd, buf, len) { return this.read(N(fd), N(buf), N(len)); },
  1(fd, buf, len) { return this.write(N(fd), N(buf), N(len)); },
  2(path, flags, mode) { return CALLS[257].call(this, -100n, path, flags, mode); },
  3(fd) { return this.fds.delete(N(fd)) ? 0 : -E.BADF; },
  4(path, st) { return this.stat(this.path(N(path)), N(st)); },
  5(fd, st) {
    const entry = this.fds.get(N(fd));
    if (!entry) return -E.BADF;
    if (entry.kind !== 'file') return this.fillStat(N(st), 0o020620, 0);
    return this.stat(entry.path, N(st));
  },
  6(path, st) { return this.stat(this.path(N(path)), N(st)); },
  8(fd, offset, whence) {
    const entry = this.fds.get(N(fd));
    if (!entry || entry.kind !== 'file') return entry ? -E.SPIPE : -E.BADF;
    const size = (this.files.read(entry.path) ?? []).length;
    const base = [0, entry.offset, size][N(whence)];
    if (base === undefined) return -E.INVAL;
    entry.offset = base + N(offset);
    return entry.offset;
  },
  9(addr, len, prot, flags, fd, off) {
    const length = N(len), fixed = N(flags) & 0x10, anonymous = N(flags) & 0x20;
    const start = fixed ? N(addr) : this.reserve(length);
    if (fixed) this.bytes.fill(0, start, start + length);
    if (!anonymous) {
      const entry = this.fds.get(N(fd));
      const data = entry?.kind === 'file' ? this.files.read(entry.path) : null;
      if (!data) return -E.BADF;
      this.bytes.set(data.subarray(N(off), N(off) + length), start);
    }
    return start;
  },
  10() { return 0; },
  11(addr, len) {
    const start = N(addr), length = Math.ceil(N(len) / PAGE) * PAGE;
    if (start >= this.mapBase) this.free.push({start, length});
    return 0;
  },
  12() { return this.mapBase; }, // brk never grows: libc falls back to mmap
  13() { return 0; },
  14() { return 0; },
  16(fd, request) { return N(request) === 0x5413 ? -E.NOTTY : -E.NOTTY; },
  19(fd, iov, count) {
    let total = 0;
    for (let k = 0; k < N(count); k++) {
      const base = N(this.view.getBigUint64(N(iov) + k * 16, true)), length = N(this.view.getBigUint64(N(iov) + k * 16 + 8, true));
      const r = this.read(N(fd), base, length);
      if (r < 0) return total || r;
      total += r;
      if (r < length) break;
    }
    return total;
  },
  20(fd, iov, count) {
    let total = 0;
    for (let k = 0; k < N(count); k++) {
      const base = N(this.view.getBigUint64(N(iov) + k * 16, true)), length = N(this.view.getBigUint64(N(iov) + k * 16 + 8, true));
      const r = this.write(N(fd), base, length);
      if (r < 0) return total || r;
      total += r;
    }
    return total;
  },
  21(path) { const p = this.path(N(path)); return this.files.read(p) || this.files.isDirectory(p) ? 0 : -E.NOENT; },
  25(old, oldLength, newLength) {
    const start = this.reserve(N(newLength));
    this.bytes.copyWithin(start, N(old), N(old) + Math.min(N(oldLength), N(newLength)));
    CALLS[11].call(this, old, oldLength);
    return start;
  },
  28() { return 0; },
  39() { return 1; },
  60(code) { throw new Exit(N(code) & 0xff); },
  63(buf) {
    const fields = ['Linux', 'length3', '6.1.0-xlat', '#1', 'x86_64', ''];
    this.bytes.fill(0, N(buf), N(buf) + 390);
    fields.forEach((s, k) => this.bytes.set(new TextEncoder().encode(s), N(buf) + k * 65));
    return 0;
  },
  72() { return 0; },
  79(buf, size) {
    const bytes = new TextEncoder().encode(this.cwd + '\0');
    if (bytes.length > N(size)) return -E.RANGE;
    this.bytes.set(bytes, N(buf));
    return N(buf);
  },
  80(path) { const p = this.path(N(path)); if (!this.files.isDirectory(p)) return -E.NOENT; this.cwd = p; return 0; },
  87(path) { return this.files.remove(this.path(N(path))) ? 0 : -E.NOENT; },
  96(tv) {
    const ms = Date.now();
    this.view.setBigInt64(N(tv), BigInt(Math.floor(ms / 1000)), true);
    this.view.setBigInt64(N(tv) + 8, BigInt((ms % 1000) * 1000), true);
    return 0;
  },
  102() { return 0; }, 104() { return 0; }, 107() { return 0; }, 108() { return 0; },
  110() { return 0; },
  131() { return 0; },
  158(code, addr) {
    if (N(code) === 0x1002) { this.instance.exports.fs.value = addr; return 0; }
    return -E.INVAL;
  },
  186() { return 1; },
  201(t) { const s = BigInt(Math.floor(Date.now() / 1000)); if (N(t)) this.view.setBigInt64(N(t), s, true); return s; },
  202() { return 0; }, // futex: single thread
  218() { return 1; },
  228(clock, ts) {
    const ns = N(clock) === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
    this.view.setBigInt64(N(ts), ns / 1000000000n, true);
    this.view.setBigInt64(N(ts) + 8, ns % 1000000000n, true);
    return 0;
  },
  231(code) { throw new Exit(N(code) & 0xff); },
  257(dirfd, path, flags) {
    const p = this.path(N(path), N(dirfd)), f = N(flags);
    const create = f & 0x40, truncate = f & 0x200, append = f & 0x400, access = f & 3;
    let data = this.files.read(p);
    if (!data) {
      if (this.files.isDirectory(p)) {
        const fd = this.nextFd();
        this.fds.set(fd, {kind: 'dir', path: p});
        return fd;
      }
      if (!create) return -E.NOENT;
      data = new Uint8Array(0);
      this.files.write(p, data);
    } else if (create && (f & 0x80)) {
      return -E.EXIST;
    }
    if (truncate && access) this.files.write(p, new Uint8Array(0));
    const fd = this.nextFd();
    this.fds.set(fd, {kind: 'file', path: p, offset: 0, writable: access !== 0, append: !!append});
    return fd;
  },
  262(dirfd, path, st, flags) {
    const empty = (N(flags) & 0x1000) && !this.bytes[N(path)];
    if (empty) return CALLS[5].call(this, dirfd, st);
    return this.stat(this.path(N(path), N(dirfd)), N(st));
  },
  273() { return 0; },
  302(pid, resource, next, old) {
    if (N(old)) { this.view.setBigInt64(N(old), -1n, true); this.view.setBigInt64(N(old) + 8, -1n, true); }
    return 0;
  },
  318(buf, len) { crypto.getRandomValues(this.bytes.subarray(N(buf), N(buf) + N(len))); return N(len); },
  334() { return -E.NOSYS; },
};

Linux.prototype.nextFd = function () {
  let fd = 3;
  while (this.fds.has(fd)) fd++;
  return fd;
};
