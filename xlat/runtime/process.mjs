// Processes for translated programs. There is no machine to boot: a process
// starts at its ELF entry with a SysV stack and its system calls land in
// the tables of sys-file.mjs and sys-proc.mjs.
//
// System calls are restartable: a call that has to wait (input that has
// not arrived, a child that has not finished) throws Wait, which unwinds the
// wasm stack; the process later resumes by executing the same syscall
// instruction again. No wasm frame is ever suspended, so neither threads
// nor shared memory are needed.
//
// fork() makes the child the running process; the parent waits in its fork
// call and, once the child has exited, the restarted fork returns the
// child's pid. A pipeline therefore runs left to right, each child to
// completion, and readers find their writers' whole output.

import {Fpu} from './fpu.mjs';
import {Description, FdTable} from './fd.mjs';
import {E, FsError, Vfs} from './fs.mjs';
import {FILE_CALLS} from './sys-file.mjs';
import {PROC_CALLS} from './sys-proc.mjs';

const PAGE = 4096;
const WASM_PAGE = 65536;
const STACK_BYTES = 8 << 20;
const GUARD = 1 << 16;

const CALLS = {...FILE_CALLS, ...PROC_CALLS};
const dec = new TextDecoder(), enc = new TextEncoder();

export class GuestTrap extends Error {
  constructor(address, code) {
    const kind = {1: 'jump to untranslated code', 2: 'undecodable code', 3: 'unsupported instruction', 4: 'divide error'}[code] ?? `trap ${code}`;
    super(`${kind} at 0x${address.toString(16)}`);
    this.address = address;
    this.code = code;
  }
}

/** Thrown through wasm frames to end a process image. */
export class Exit { constructor(status) { this.status = status; } }
/** Thrown through wasm frames after execve replaced the image. */
export class Exec {}
/** Thrown by a system call that must wait; the call is restarted later. */
export class Wait {}

/** A loaded program: compiled module plus its loader facts. */
export class Image {
  constructor(module) {
    this.module = module;
    const section = (name) => dec.decode(WebAssembly.Module.customSections(module, name)[0]);
    this.facts = JSON.parse(section('xlat.facts'));
    this.fpuOps = section('xlat.fpu').split(',');
  }
}

export class Kernel {
  /**
   * vfs: the filesystem. translate(bytes) -> wasm bytes for an ELF.
   * console: {write(fd, bytes), read(n) -> Uint8Array}.
   */
  constructor({vfs = new Vfs(), translate, console}) {
    this.vfs = vfs;
    this.translate = translate;
    this.console = console;
    this.nextPid = 1;
    this.images = new WeakMap(); // File node -> {size, mtime, image}
    this.chain = []; // running process last; each one's parent before it
    this.status = null;
  }

  /** The image for an executable file, translating it once per version. */
  image(node) {
    const cached = this.images.get(node);
    if (cached && cached.size === node.size && cached.mtime === node.mtime) return cached.image;
    const bytes = node.bytes();
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new FsError(E.NOEXEC);
    const image = new Image(new WebAssembly.Module(this.translate(bytes)));
    this.images.set(node, {size: node.size, mtime: node.mtime, image});
    return image;
  }

  /** Create the first process, attached to the console. */
  start(path, argv, env, cwd = '/') {
    const p = new Process(this, null);
    p.cwd = cwd;
    ['stdin', 'stdout', 'stderr'].forEach((name, fd) => p.fds.install(new Description('console', {path: name}), {fd}));
    p.execve(path, argv, env);
    this.chain = [p];
  }

  /**
   * Run until every process has exited or the running one waits for input.
   * Returns {waiting: true} or {status} of the first process.
   */
  pump() {
    while (this.chain.length) {
      const p = this.chain.at(-1);
      const status = p.run();
      if (status === null) {
        if (this.chain.at(-1) === p) return {waiting: true};
        continue; // it forked: the child runs now
      }
      this.chain.pop();
      if (!this.chain.length) { this.status = status; return {status}; }
    }
    return {status: this.status};
  }

  /** Start and run to the end; for hosts whose input is all known up front. */
  spawn(path, argv, env, cwd = '/') {
    this.start(path, argv, env, cwd);
    const r = this.pump();
    if (r.waiting) throw new Error('process waits for input that will never come');
    return r.status;
  }
}

export class Process {
  constructor(kernel, parent) {
    this.kernel = kernel;
    this.pid = kernel.nextPid++;
    this.ppid = parent?.pid ?? 0;
    this.pgid = parent?.pgid ?? this.pid;
    this.fds = parent ? parent.fds.fork() : new FdTable();
    this.cwd = parent?.cwd ?? '/';
    this.umask = parent?.umask ?? 0o022;
    this.zombies = new Map(); // child pid -> wait status
    this.children = new Set();
    this.signals = new Map(parent?.signals ?? []);
    this.resumeAt = 0n;
    this.trail = null;
  }

  // ---- memory ----

  get bytes() { return new Uint8Array(this.memory.buffer); }
  get view() { return new DataView(this.memory.buffer); }

  cstring(address) {
    const b = this.bytes;
    let end = address;
    while (b[end]) end++;
    return dec.decode(b.subarray(address, end));
  }

  /** NULL-terminated array of string pointers. */
  strings(address) {
    const out = [];
    if (!address) return out;
    for (let at = address; ; at += 8) {
      const p = Number(this.view.getBigUint64(at, true));
      if (!p) return out;
      out.push(this.cstring(p));
    }
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

  release(start, length) {
    if (start >= this.mapBase) this.free.push({start, length: Math.ceil(length / PAGE) * PAGE});
  }

  // ---- images ----

  imports() {
    return {env: {
      memory: this.memory,
      syscall: (nr, a, b, c, d, e, f, next) => this.syscall(nr, a, b, c, d, e, f, next),
      trap: (address, code) => { throw new GuestTrap(address, code); },
      div128: (hi, lo, d, signed) => div128(hi, lo, d, signed),
      clock: () => BigInt(Math.round(performance.now() * 1e6)),
      fpu: (op, size, address, a, b) => this.fpu.call(op, size, address, a, b),
      trace: (address) => { if (this.trail) this.trail[this.trailAt++ & 255] = address; },
    }};
  }

  /** Replace the image. Throws FsError; on success the old image is gone. */
  execve(path, argv, env) {
    let node = this.kernel.vfs.lookup(path, this.cwd);
    if (!node.isFile) throw new FsError(node.isDir ? E.ACCES : E.NOEXEC);
    const head = node.read(0, 128);
    if (head[0] === 0x23 && head[1] === 0x21) {
      // #!interpreter [arg]
      const line = dec.decode(head).split('\n')[0].slice(2).trim();
      const [interpreter, ...rest] = line.split(/\s+/);
      return this.execve(interpreter, [interpreter, ...rest.slice(0, 1), path, ...argv.slice(1)], env);
    }
    const image = this.kernel.image(node);
    const f = image.facts;
    this.image = image;
    this.stackLow = Math.ceil((f.imageEnd + GUARD) / PAGE) * PAGE;
    this.stackTop = this.stackLow + STACK_BYTES;
    this.mapBase = Math.ceil((this.stackTop + GUARD) / WASM_PAGE) * WASM_PAGE;
    this.mapEnd = this.mapBase;
    this.free = [];
    this.memory = new WebAssembly.Memory({initial: this.mapBase / WASM_PAGE, maximum: 65536});
    this.fpu = new Fpu(() => this.bytes, image.fpuOps);
    this.instance = new WebAssembly.Instance(image.module, this.imports());
    this.argv = argv;
    this.fds.exec();
    for (const [sig, h] of this.signals) if (h.handler > 1n) this.signals.delete(sig);
    this.instance.exports.r4.value = BigInt(this.stack(argv, env));
    this.resumeAt = BigInt(f.entry);
  }

  /** SysV entry stack: argc, argv, envp, auxv, then the strings. */
  stack(argv, env) {
    let top = this.stackTop;
    const put = (bytes) => { top -= bytes.length; this.bytes.set(bytes, top); return top; };
    const strings = (list) => list.map((s) => put(enc.encode(s + '\0')));
    const random = put(crypto.getRandomValues(new Uint8Array(16)));
    const execfn = put(enc.encode((argv[0] ?? '') + '\0'));
    const envp = strings(env), args = strings(argv);
    const f = this.image.facts;
    const aux = [[3, f.phdr], [4, f.phent], [5, f.phnum], [6, PAGE], [9, f.entry], [11, 0], [12, 0], [13, 0], [14, 0],
      [23, 0], [25, random], [31, execfn], [0, 0]];
    const words = [args.length, ...args, 0, ...envp, 0, ...aux.flat()];
    top = (top - words.length * 8) & ~15;
    words.forEach((w, k) => this.view.setBigUint64(top + k * 8, BigInt(w), true));
    return top;
  }

  /** Run until the process exits (its wait status) or waits (null). */
  run() {
    for (;;) {
      try {
        this.instance.exports.run(this.resumeAt);
      } catch (e) {
        if (e instanceof Exec) continue;
        if (e instanceof Exit) return this.finish(e.status);
        if (e instanceof Wait) return null;
        throw e;
      }
    }
  }

  finish(status) {
    this.fds.closeAll();
    this.exitStatus = status;
    return status;
  }

  // ---- fork ----

  /**
   * fork, first call: copy this process, make the copy the running one
   * (starting at `resume`) and wait. Restarted after the child exited:
   * return its pid.
   */
  fork(resume, stack = 0n) {
    const pending = this.pendingFork;
    if (pending) {
      if (pending.exitStatus === undefined) throw new Wait();
      this.pendingFork = null;
      this.children.delete(pending.pid);
      this.zombies.set(pending.pid, pending.exitStatus);
      return pending.pid;
    }
    const child = new Process(this.kernel, this);
    child.image = this.image;
    for (const k of ['stackLow', 'stackTop', 'mapBase', 'mapEnd', 'argv']) child[k] = this[k];
    child.free = this.free.map((r) => ({...r}));
    child.memory = new WebAssembly.Memory({initial: this.memory.buffer.byteLength / WASM_PAGE, maximum: 65536});
    child.bytes.set(this.bytes);
    child.fpu = this.fpu.clone(() => child.bytes);
    child.instance = new WebAssembly.Instance(this.image.module, child.imports());
    const from = this.instance.exports, to = child.instance.exports;
    for (let n = 0; n < 16; n++) to[`r${n}`].value = from[`r${n}`].value;
    to.fs.value = from.fs.value;
    to.r0.value = 0n; // fork returns 0 in the child
    if (stack) to.r4.value = stack;
    child.resumeAt = resume;
    this.children.add(child.pid);
    this.pendingFork = child;
    this.kernel.chain.push(child);
    throw new Wait();
  }

  // ---- system calls ----

  syscall(nr, a, b, c, d, e, f, next) {
    this.resumeAt = next;
    const handler = CALLS[Number(nr)];
    if (TRACE_SYSCALLS) console.error(`[${this.pid}] syscall ${nr}${handler ? '' : ' (none)'} ${[a, b, c].map((x) => '0x' + BigInt.asUintN(64, x).toString(16)).join(' ')}`);
    if (!handler) return BigInt(-E.NOSYS);
    try {
      const r = handler.call(this, a, b, c, d, e, f);
      return typeof r === 'bigint' ? r : BigInt(r);
    } catch (error) {
      if (error instanceof FsError) return BigInt(-error.errno);
      // Restart at the syscall instruction itself (2 bytes before `next`);
      // its registers are still in the globals saved before this call.
      if (error instanceof Wait) this.resumeAt = next - 2n;
      throw error;
    }
  }
}

/** XLAT_SYSCALLS=1 lists every system call on stderr (node only). */
const TRACE_SYSCALLS = typeof process !== 'undefined' && !!process.env?.XLAT_SYSCALLS;

function div128(hi, lo, d, signed) {
  let n = (BigInt.asUintN(64, hi) << 64n) | BigInt.asUintN(64, lo);
  let divisor = BigInt.asUintN(64, d);
  if (signed) { n = BigInt.asIntN(128, n); divisor = BigInt.asIntN(64, divisor); }
  if (divisor === 0n) throw new GuestTrap(0n, 4);
  const q = n / divisor, r = n % divisor;
  if (signed ? BigInt.asIntN(64, q) !== q : BigInt.asUintN(64, q) !== q) throw new GuestTrap(0n, 4);
  return [BigInt.asIntN(64, q), BigInt.asIntN(64, r)];
}
