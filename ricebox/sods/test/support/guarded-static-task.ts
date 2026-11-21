// Standalone, opt-in Task integration proof. Neither the ordinary runtime's
// application launch path nor its installed/exported JS graph admits it.
import {sha256} from '../../runtime/host.ts';
import {MAY, may} from '../../runtime/linux/cred.ts';
import {type ExecutableSource, executableSourceFor, unchangedExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Exit, randomBytes} from '../../runtime/linux/flow.ts';
import {E, type File, FsError, MNT, Vfs, walk} from '../../runtime/linux/fs.ts';
import {GuardedFault, GuardedInlineMemory, type GuardedOwner} from '../../runtime/linux/guarded-inline-memory.ts';
import {type Call} from '../../runtime/linux/parts.ts';
import {type Image, Kernel, Process, Task, type Translation, trapOrPreempt} from '../../runtime/linux/process.ts';
import {SIG} from '../../runtime/linux/signal.ts';

const P = 4096, LIMIT = 16 << 20, SP_END = LIMIT - P, SP_START = SP_END - P;
const RX = 5, RW = 3, RSP = 4, RFLAGS = 17;
const PT_STACK_RW = 6; // ELF p_flags, not mmap PROT_* values
const INPUT_LIMIT = 4 * P, STEPS = 4096;
const syscallRoute = Symbol('guarded Task syscall route');
const EXPECTED_IMPORTS = ['read64','write64','reg','set','syscall','target'];
const enc = new TextEncoder();
const minus = (errno: number): bigint => BigInt(-errno);
const hexHash = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(await sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');

type Code = {readonly bytes: Uint8Array<ArrayBuffer>; current(): boolean};
type Step = {readonly code: Code; run(rip: bigint): bigint};
type Compile = (bytes: Uint8Array<ArrayBuffer>) => WebAssembly.Module | 'more' | null;

async function compiler(bytes: Uint8Array, expected: string): Promise<Compile> {
  if (!/^[0-9a-f]{64}$/.test(expected) || bytes.length > 64 << 20) throw new TypeError('Expected an admitted Task compiler');
  const stable = new Uint8Array(bytes);
  if (await hexHash(stable) !== expected) throw new Error('Unexpected guarded Task compiler SHA-256');
  const x = new WebAssembly.Instance(await WebAssembly.compile(stable), {}).exports;
  const {memory, sods_alloc, sods_translate_guarded_task_step: translate, sods_output_ptr, sods_output_len} = x;
  if (!(memory instanceof WebAssembly.Memory) || typeof sods_alloc !== 'function' || typeof translate !== 'function'
    || typeof sods_output_ptr !== 'function' || typeof sods_output_len !== 'function') throw new Error('Missing guarded Task compiler export');
  return span => {
    const at = sods_alloc(span.length) >>> 0;
    new Uint8Array(memory.buffer, at, span.length).set(span);
    const status = translate(at, span.length);
    if (status === 1 || status === 2) return status === 2 ? 'more' : null;
    const n = sods_output_len() >>> 0;
    if (status !== 0 || !n || n > 1024) throw new Error('Invalid guarded Task compiler output');
    const m = new WebAssembly.Module(new Uint8Array(memory.buffer, sods_output_ptr() >>> 0, n).slice());
    const ins = WebAssembly.Module.imports(m), outs = WebAssembly.Module.exports(m);
    if (ins.length !== EXPECTED_IMPORTS.length || ins.some((it, i) => it.module !== 'guard' || it.kind !== 'function'
      || it.name !== EXPECTED_IMPORTS[i]) || outs.length !== 1 || outs[0]!.kind !== 'function' || outs[0]!.name !== 'step')
      throw new Error('Invalid guarded Task Wasm ABI');
    return m;
  };
}

interface Layout { readonly start: number; readonly entry: number }
/** Exact static profile: ELF64 x86-64 ET_EXEC, one complete RX initial page,
 * no relocations/load interpreter by PHDR, and mandatory nonexec stack. */
function layout(bytes: Uint8Array<ArrayBuffer>): Layout {
  const refuse = (): never => { throw new FsError(E.NOEXEC); };
  if (bytes.length < 176 || bytes.length > INPUT_LIMIT || bytes[0] !== 0x7f || bytes[1] !== 0x45
    || bytes[2] !== 0x4c || bytes[3] !== 0x46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) return refuse();
  const v = new DataView(bytes.buffer);
  const h = (p: number) => v.getUint16(p, true), u = (p: number) => v.getUint32(p, true), q = (p: number) => v.getBigUint64(p, true);
  if (h(16) !== 2 || h(18) !== 62 || u(20) !== 1 || q(32) !== 64n || h(52) !== 64 || h(54) !== 56 || h(56) !== 2
    || u(64) !== 1 || u(68) !== RX || q(72) !== 0n || q(112) !== BigInt(P)
    || u(120) !== 0x6474e551 || u(124) !== PT_STACK_RW || q(152) !== 0n || q(160) !== 0n) return refuse();
  const start = q(80), entry = q(24), file = q(96);
  if (start < 65536n || start % BigInt(P) || start + BigInt(2 * P) > BigInt(SP_START) || file <= 176n
    || file > BigInt(Math.min(P, bytes.length)) || file !== q(104)
    || entry < start + 176n || entry >= start + file) return refuse();
  return {start:Number(start), entry:Number(entry)};
}

/** Bounded AMD64 initial stack. This single process has one argv, no env,
 * no vDSO or interpreter. These words are not raw-writable after install. */
function stack(program: string, layout: Layout): {bytes: Uint8Array<ArrayBuffer>; sp: bigint} {
  const bytes = new Uint8Array(P), v = new DataView(bytes.buffer), name = enc.encode(program + '\0');
  const nameAt = P - name.byteLength, randomAt = (nameAt - 16) & ~15;
  const at = (k: number) => SP_START + k;
  const words = [1,at(nameAt),0,0, 3,layout.start+64,4,56,5,2,6,P,7,0,9,layout.entry,
    11,0,12,0,13,0,14,0,23,0,25,at(randomAt),31,at(nameAt),0,0];
  const start = (randomAt - words.length * 8) & ~15;
  if (start < 128) throw new FsError(E.TOOBIG);
  bytes.set(name, nameAt);
  bytes.set(randomBytes(16), randomAt);
  words.forEach((w, n) => v.setBigUint64(start + 8*n, BigInt(w), true));
  return {bytes, sp:BigInt(at(start))};
}

class StaticTask extends Task {
  #backing: GuardedInlineMemory | undefined = new GuardedInlineMemory(LIMIT / 65536);
  readonly #owner: GuardedOwner;
  readonly #compile: Compile;
  readonly #fds: Process['fds'];
  readonly #steps = new Map<bigint, Step>();
  readonly #protections = new Map<number, number>();
  readonly #regs = new BigInt64Array(19);
  readonly #exports: Translation;
  #identity: (() => void) | undefined;
  #running = false;
  #retired = false;
  #remaining = STEPS;
  #fault: GuardedFault | undefined;
  constructor(p: Process, compile: Compile) {
    super(p);
    this.#compile = compile;
    this.#fds = p.fds;
    this.#owner = this.#guard.installOwner(p.kernel.vfs, p.fds);
    const table = new WebAssembly.Table({initial:0, maximum:0, element:'anyfunc'});
    this.#exports = Object.freeze({table, run:(rip: bigint) => this.#run(rip)});
  }
  get #guard(): GuardedInlineMemory {
    if (!this.#backing) throw new GuardedFault('owner', this.resumeAt);
    return this.#backing;
  }
  get memoryFault(): Readonly<GuardedFault> | undefined { return this.#fault; }
  override get exports(): Translation { return this.#exports; }
  override get bytes(): never { throw new Error('Guarded Task exports no raw guest bytes'); }
  override load(): never { throw new FsError(E.NOEXEC); }
  override attach(): void {} // this ABI never instantiates the ordinary table or memory
  override reg(n: number): bigint { return this.#regs[n] ?? 0n; }
  override setReg(n: number, v: bigint | number): void { if (!this.dead) this.#regs[n] = BigInt(v); }
  override end(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#identity = undefined;
    this.#steps.clear();
    this.#protections.clear();
    const backing = this.#backing;
    this.#backing = undefined; // never pooled, even while a dead Task handle is retained
    backing?.retireOwner(this.#owner);
  }
  async prepare(source: ExecutableSource, digest: string, fd: number, image: Layout, program: string): Promise<void> {
    if (this.#identity || this.#retired || this.#running) throw new Error('Guarded Task admits one image only');
    const identity = this.proc.readIdentity();
    const proof = await this.#guard.authenticate(this.#owner, source, digest);
    identity();
    if (!proof || this.#retired || this.#fds !== this.proc.fds || this.proc.memory !== null
      || !this.#guard.installRx(this.#owner, proof, fd, {address:image.start, length:P, fileOffset:0, flags:0x12, prot:RX}))
      throw new FsError(E.NOEXEC);
    const initial = stack(program, image);
    this.#guard.installData(this.#owner, SP_START, P, RW, initial.bytes);
    this.#protections.set(image.start,RX);
    this.#protections.set(SP_START,RW);
    this.setReg(RSP, initial.sp);
    this.setReg(RFLAGS, 0x202n);
    this.resumeAt = BigInt(image.entry);
    this.#identity = identity;
  }

  #alive(at: bigint): void {
    const {proc:p,kernel:k} = this;
    if (!this.#identity || this.#retired || this.dead || p.state !== 'live' || p.memory !== null || this.#fds !== p.fds
      || p.maps.length || p.task !== this || p.tasks.size !== 1 || !p.tasks.has(this) || k.tasks.get(this.tid) !== this || k.shared)
      throw new GuardedFault('owner', at);
    try { this.#identity(); } catch { throw new GuardedFault('owner', at); }
  }
  #next(address: bigint): bigint {
    if (BigInt.asIntN(48,address) !== address) throw new GuardedFault('unmapped', address);
    return address; // mapping and execute checks have not yet happened
  }
  #step(rip: bigint): Step {
    const hit = this.#steps.get(rip);
    if (hit) {
      if (!hit.code.current()) throw new GuardedFault('permission', rip);
      return hit;
    }
    for (let length = 1; length <= 15; length++) {
      const code = this.#guard.bindCode(this.#owner, rip, length);
      if (!code) throw new GuardedFault('permission', rip);
      const module = this.#compile(code.bytes);
      if (module === 'more') continue;
      if (!module) return trapOrPreempt(rip, 3);
      const permit = () => {
        this.#alive(rip);
        if (!code.current()) throw new GuardedFault('permission', rip);
      };
      permit();
      const instance = new WebAssembly.Instance(module, {guard:{
        read64:(addr: bigint) => { permit(); return this.#guard.read(this.#owner, addr, 8); },
        write64:(addr: bigint, word: bigint) => { permit(); this.#guard.write(this.#owner, addr, 8, word); },
        reg:(n: number) => { permit(); return this.reg(n); },
        set:(n: number, value: bigint) => { permit(); this.setReg(n, value); },
        target:(addr: bigint) => { permit(); return this.#next(addr); },
        syscall:(next: bigint) => { permit(); this.#syscall(next); },
      }});
      const entry = instance.exports.step as (rip: bigint) => bigint;
      const step = {code, run:entry};
      this.#steps.set(rip, step);
      return step;
    }
    return trapOrPreempt(rip, 3);
  }
  #run(start: bigint): never {
    if (this.kernel.current !== this || this.state !== 'running') throw new GuardedFault('owner', start);
    if (this.#running) throw new Error('Guarded Task reentry');
    this.#running = true;
    try {
      let rip = start;
      while (this.#remaining > 0) {
        --this.#remaining;
        this.resumeAt = rip;
        this.#alive(rip);
        // An entire step is synchronous. A syscall is its last guest action,
        // and even a successful protection change cannot run its next step
        // without a fresh lease check before any memory/register effect.
        rip = this.#step(rip).run(rip);
      }
      return trapOrPreempt(rip, 3);
    } catch (error) {
      if (!(error instanceof GuardedFault)) throw error;
      this.#fault = Object.freeze(error);
      this.kernel.exitProcess(this.proc, SIG.SEGV);
      throw new Exit(SIG.SEGV);
    } finally { this.#running = false; }
  }
  #syscall(next: bigint): void {
    this.setReg(1, next); // RCX and R11 are clobbered by SYSCALL
    this.setReg(11, this.reg(RFLAGS) & ~0x10000n);
    const nr = BigInt.asIntN(32, this.reg(0)), args = [7,6,2,10,8,9].map(n => this.reg(n));
    this.setReg(0, this.kernel.enter(this, nr, args, next));
  }
  /** Only the profile's small memory-effect handlers. Stock exit (no user
   * pointers) is delegated separately by the kernel, not through this. */
  bounded(route: symbol, call: Call): bigint {
    if (route !== syscallRoute) throw new Error('Not the guarded Task syscall route');
    this.#alive(call.next);
    const [a = 0n, b = 0n, c = 0n] = call.args;
    if (call.nr === 1) {
      const fd = Number(BigInt.asUintN(32,a)), d = this.#fds.get(fd);
      if ((fd !== 1 && fd !== 2) || d?.kind !== 'console' || d.closed
        || d.path !== (fd === 1 ? 'stdout' : 'stderr')) return minus(E.BADF);
      if (c < 0n || c > BigInt(P)) return minus(E.INVAL);
      const count = Number(c);
      if (!count) return 0n; // nothing uses the possibly bad pointer
      // Validate and copy before any writer/callback, and never lend a view.
      const copy = new Uint8Array(count);
      try {
        for (let n = 0; n < count; n += 8) {
          const width = Math.min(count - n, 8);
          let word = this.#guard.read(this.#owner, b + BigInt(n), width);
          for (let i = 0; i < width; i++, word >>= 8n) copy[n + i] = Number(word & 255n);
        }
      } catch (e) { if (e instanceof GuardedFault) return minus(E.FAULT); throw e; }
      this.kernel.say(fd, copy);
      // The host sink may synchronously halt or reenter. Never return to
      // guest effects if it altered the admitted profile.
      if (!this.dead && this.proc.state === 'live') {
        this.#alive(call.next);
        if (this.proc.actions.size || this.filters || this.strict) {
          this.kernel.exitProcess(this.proc, SIG.KILL);
          throw new Exit(SIG.KILL);
        }
      }
      return c;
    }
    if (call.nr === 10) {
      // Dedicated one-page, rights-lowering-only mprotect cut. No W+X,
      // writable file-backed code, permission growth or stale code fallback.
      if (b !== BigInt(P) || a < 65536n || a % BigInt(P) || a > BigInt(LIMIT - P)) return minus(E.INVAL);
      if (c !== 0n && c !== 1n) return minus(E.ACCES);
      const start = Number(a), prot = Number(c), before = this.#protections.get(start);
      if (before === undefined) return minus(E.NOMEM);
      if (prot & ~before) return minus(E.ACCES);
      if (!this.#guard.protect(this.#owner, start, P, prot)) return minus(E.ACCES);
      this.#protections.set(start,prot);
      return 0n;
    }
    return minus(E.NOSYS);
  }
}

class StaticKernel extends Kernel {
  #used = false;
  #task: StaticTask | undefined;
  override start(): never { throw new FsError(E.NOEXEC); }
  override newTask(): never { throw new FsError(E.NOEXEC); }
  override image(_file: File): Image { throw new FsError(E.NOEXEC); } // no stock exec or automatic fallback
  override run(t: Task): void {
    if (t !== this.#task || t.dead) return;
    if (this.current) throw new Error('Guarded kernel reentry');
    if (t.filters || t.strict || t.proc.actions.size) { this.exitProcess(t.proc, SIG.KILL); return; }
    super.run(t);
  }
  override pump(): ReturnType<Kernel['pump']> {
    if (this.current) throw new Error('Guarded kernel reentry');
    return super.pump();
  }
  override enter(t: Task, nr: bigint, args: bigint[], next: bigint): bigint {
    if (t !== this.#task || t !== this.current || t.dead || t.state !== 'running') return minus(E.NOSYS);
    return super.enter(t,nr,args,next);
  }
  override endTask(t: Task): void {
    super.endTask(t);
    if (t === this.#task) this.#task = undefined;
  }
  override attempt(t: Parameters<Kernel['attempt']>[0], call: Call): ReturnType<Kernel['attempt']> {
    const task = this.#task;
    if (!task || t !== task || task.dead) return minus(E.NOSYS);
    // Reject outside entry/retry and do not use raw-memory signal frames.
    if (task !== this.current && task.call !== call) return minus(E.NOSYS);
    if (task.filters || task.strict || task.proc.actions.size) throw new Error('Signal handlers and seccomp are out of profile');
    const result = task.bounded(syscallRoute,call); // lifetime check applies even to the real exit handlers
    return call.nr === 60 || call.nr === 231 ? super.attempt(task, call) : result;
  }

  async begin(input: {path: string; source: ExecutableSource; elfSha256: string}, compile: Compile): Promise<Task> {
    if (this.#used || this.shared || !/^\/[a-zA-Z0-9/_-]{1,80}$/.test(input.path)) throw new FsError(E.NOEXEC);
    this.#used = true;
    const p = new Process(this, null), t = this.#task = new StaticTask(p, compile);
    p.pid = p.pgid = p.sid = t.tid;
    p.argv = [input.path];
    p.env = [];
    p.task = t;
    p.tasks.add(t);
    this.procs.set(p.pid, p);
    this.tasks.set(t.tid, t);
    this.tty = {sid:p.sid, fg:p.pgid};
    try {
      const captured = executableSourceFor(input.source, this.vfs), at = walk(p, input.path, p.fs.pwd);
      if (typeof at === 'number') throw new FsError(at);
      if (at.node !== captured.node || at.mnt.flags & MNT.NOEXEC || !may(p.cred, captured.node, MAY.EXEC)
        || captured.node.mode & 0o6000 || !(captured.node.mode & 0o111) || captured.size > INPUT_LIMIT)
        throw new FsError(E.ACCES);
      const stable = p.readIdentity();
      const bytes = new Uint8Array(captured.node.read(0, captured.size));
      if (!/^[0-9a-f]{64}$/.test(input.elfSha256) || await hexHash(bytes) !== input.elfSha256
        || !unchangedExecutableSource(captured) || at.mnt.flags & MNT.NOEXEC) throw new FsError(E.NOEXEC);
      stable();
      const image = layout(bytes);
      p.stackLow = SP_START;
      p.stackTop = SP_END;
      p.mapBase = p.mapEnd = LIMIT;
      p.fixed = [];
      p.free = [];
      p.exe = input.path;
      p.exeAt = {mnt:at.mnt, node:captured.node, dir:at.parent, name:at.name};
      for (const [fd,path] of ['stdin','stdout','stderr'].entries()) p.fds.install(new Description('console', {path}), {fd});
      const fd = p.fds.install(new Description('file', {node:captured.node, mnt:at.mnt, path:input.path}));
      await t.prepare(input.source, input.elfSha256, fd, image, input.path);
      p.fds.close(fd);
      this.ready(t);
      return t;
    } catch (e) {
      this.exitProcess(p, SIG.KILL);
      throw e;
    }
  }
}

export async function guardedStaticTask(input: {
  readonly compiler: Uint8Array;
  readonly compilerSha256: string;
  readonly vfs: Vfs;
  readonly path: string;
  readonly source: ExecutableSource;
  readonly elfSha256: string;
  readonly write: (fd: number, bytes: Uint8Array) => void;
}): Promise<{kernel: Kernel; task: Task; fault(): Readonly<GuardedFault> | undefined}> {
  // Seal primitive configuration before the first await. The VFS/source are
  // checked again on use; a callback cannot change the admitted digest.
  const {compiler:bytes,compilerSha256,vfs,path,source,elfSha256,write} = input;
  const compile = await compiler(bytes, compilerSha256);
  const kernel = new StaticKernel({vfs,console:{write,read:() => null}});
  const task = await kernel.begin({path,source,elfSha256}, compile) as StaticTask;
  return {kernel,task,fault:() => task.memoryFault};
}
