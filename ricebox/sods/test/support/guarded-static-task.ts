// Standalone, opt-in Task integration proof. Neither the ordinary runtime's
// application launch path nor its installed/exported JS graph admits it.
import {sha256} from '../../runtime/host.ts';
import {MAY, may} from '../../runtime/linux/cred.ts';
import {type ExecutableSource, executableSourceFor, unchangedExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Exit, randomBytes} from '../../runtime/linux/flow.ts';
import {E, type File, FsError, MNT, Vfs, WALK, walk} from '../../runtime/linux/fs.ts';
import {GuardedFault, GuardedInlineMemory, type GuardedOwner} from '../../runtime/linux/guarded-inline-memory.ts';
import {type Call} from '../../runtime/linux/parts.ts';
import {type Image, Kernel, Process, Task, type Translation, trapOrPreempt} from '../../runtime/linux/process.ts';
import {SIG} from '../../runtime/linux/signal.ts';
import {interpreterElf, INTERPRETER_ELF_LIMIT, type ElfEntryPlan} from './guarded-interpreter-elf.ts';

const P = 4096, LIMIT = 16 << 20, SP_END = LIMIT - P, SP_START = SP_END - P;
const RX = 5, RO = 1, RW = 3, RSP = 4, RFLAGS = 17;
const PT_STACK_RW = 6; // ELF p_flags, not mmap PROT_* values
const INPUT_LIMIT = 4 * P, STEPS = 4096;
const syscallRoute = Symbol('guarded Task syscall route');
const EXPECTED_IMPORTS = ['read64','write64','reg','set','syscall','target'];
const VECTOR_IMPORTS = [...EXPECTED_IMPORTS,'xmmLow','setXmm','storeAligned128'];
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
    const expected = ins.length === EXPECTED_IMPORTS.length ? EXPECTED_IMPORTS : VECTOR_IMPORTS;
    if (ins.length !== expected.length || ins.some((it, i) => it.module !== 'guard' || it.kind !== 'function'
      || it.name !== expected[i]) || outs.length !== 1 || outs[0]!.kind !== 'function' || outs[0]!.name !== 'step')
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

interface FileInput {
  readonly path: string;
  readonly source: ExecutableSource;
  readonly elfSha256: string;
}
interface CompanionInput extends FileInput { readonly bias: number }
interface InterpreterInput extends CompanionInput { readonly mainBias: number }
interface InterpreterPlans { readonly main: ElfEntryPlan; readonly ld: ElfEntryPlan }
type ResolvedFile = Exclude<ReturnType<typeof walk>, number>;
interface FilePlan {
  readonly input: FileInput;
  readonly file: File;
  readonly at: ResolvedFile;
  readonly bytes: Uint8Array<ArrayBuffer>;
  current(): void;
}
interface CodePlan {
  readonly file: FilePlan;
  readonly fd: number;
  readonly start: number;
  readonly offset: number;
  readonly length: number;
  current(): void;
}
interface CompanionLayout {
  readonly ro: number;
  readonly rx: number;
  readonly rw: number;
}

/** Deliberately exact second-object cut. A relocation-free ET_DYN with
 * exactly three disjoint one-page LOADs (R, RX, RW) and NX stack. No
 * PT_INTERP/DYNAMIC, BSS, permissive overlaps or guesses from section names.
 * Both data pages contain one complete aligned file page. */
function companionLayout(bytes: Uint8Array<ArrayBuffer>, bias: number, primary: Layout): CompanionLayout {
  const bad = (): never => { throw new FsError(E.NOEXEC); };
  if (!Number.isSafeInteger(bias) || bias < 65536 || bias % P || bias + 4 * P > SP_START
    || (primary.start >= bias && primary.start < bias + 3 * P)
    || bytes.length < 3 * P || bytes.length > INPUT_LIMIT) return bad();
  const v = new DataView(bytes.buffer), q = (p: number) => v.getBigUint64(p,true);
  const h = (p: number) => v.getUint16(p,true), u = (p: number) => v.getUint32(p,true);
  if (u(0) !== 0x464c457f || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
    || h(16) !== 3 || h(18) !== 62 || u(20) !== 1 || q(32) !== 64n || h(52) !== 64 || h(54) !== 56 || h(56) !== 4
    || u(232) !== 0x6474e551 || u(236) !== PT_STACK_RW || q(264) !== 0n || q(272) !== 0n) return bad();
  for (const [n, flags] of [4,5,6].entries()) { // ELF PF_R, PF_R|PF_X, PF_R|PF_W
    const at = 64 + n * 56, off = BigInt(n * P), size = q(at + 32);
    if (u(at) !== 1 || u(at+4) !== flags || q(at+8) !== off || q(at+16) !== off
      || q(at+40) !== size || q(at+48) !== BigInt(P) || !size || size > BigInt(P)
      || (n !== 1 && size !== BigInt(P)) || (n === 1 && (q(24) < off || q(24) >= off + size))) return bad();
  }
  return {ro:bias, rx:bias+P, rw:bias+2*P};
}

/** Bind both content and the legitimate executable VFS object. Recheck at
 * each async return and before commit, not just after the first path walk. */
async function filePlan(p: Process, input: FileInput, max = INPUT_LIMIT): Promise<FilePlan> {
  if (input.path.length > 128 || !/^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(input.path)) throw new FsError(E.NOEXEC);
  const source = executableSourceFor(input.source,p.kernel.vfs), at = walk(p,input.path,p.fs.pwd,WALK.NO_SYMLINKS | WALK.NO_MAGICLINKS);
  if (typeof at === 'number') throw new FsError(at);
  const owner = p.readIdentity(), mountFlags = at.mnt.flags, fdTable = p.fds;
  const allowed = () => !!(source.node.mode & 0o111) && !(source.node.mode & 0o6000)
    && may(p.cred,source.node,MAY.EXEC) && may(p.cred,source.node,MAY.READ) && !(at.mnt.flags & MNT.NOEXEC);
  if (at.node !== source.node || !allowed() || source.size > max) throw new FsError(E.ACCES);
  const current = () => {
    owner();
    const live = walk(p,input.path,p.fs.pwd,WALK.NO_SYMLINKS | WALK.NO_MAGICLINKS);
    if (typeof live === 'number' || live.node !== source.node || live.mnt !== at.mnt || at.mnt.flags !== mountFlags
      || p.fds !== fdTable || !allowed() || !unchangedExecutableSource(source)) throw new FsError(E.NOEXEC);
  };
  const bytes = new Uint8Array(source.node.read(0,source.size));
  if (!/^[0-9a-f]{64}$/.test(input.elfSha256) || await hexHash(bytes) !== input.elfSha256) throw new FsError(E.NOEXEC);
  current();
  return {input,file:source.node,at,bytes,current};
}

function codePlan(p: Process, file: FilePlan, start: number, offset: number, length = P): CodePlan {
  const table = p.fds, fd = table.install(new Description('file',{node:file.file,mnt:file.at.mnt,path:file.input.path}));
  if (fd < 0) throw new FsError(E.MFILE);
  const slot = table.slots.get(fd);
  return {file,fd,start,offset,length,current:() => {
    file.current();
    if (table !== p.fds || !slot || table.slots.get(fd) !== slot || slot.description.closed) throw new FsError(E.NOEXEC);
  }};
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

// Authentic startup pointer meanings. No vDSO, hardware features, or
// signal/rseq claims are borrowed from the native host (not implemented).
function interpreterStack(p: Process, program: string, plans: InterpreterPlans): {bytes: Uint8Array<ArrayBuffer>; sp: bigint} {
  const bytes = new Uint8Array(P), view = new DataView(bytes.buffer), {main,ld} = plans;
  let top=P;
  const put=(b:Uint8Array) => { top-=b.length; bytes.set(b,top); return SP_START+top; };
  const filename=put(enc.encode(program+'\0')), platform=put(enc.encode('x86_64\0')), random=put(randomBytes(16));
  const {uid,euid,gid,egid}=p.cred;
  const words=[1,filename,0,0, 6,P,17,100,3,main.phdr,4,main.phent,5,main.phnum,7,ld.bias,8,0,9,main.entry,
    11,uid,12,euid,13,gid,14,egid,23,0,25,random,31,filename,15,platform,0,0];
  top=(top-words.length*8)&~15;
  if(top<128)throw new FsError(E.TOOBIG);
  words.forEach((n,k)=>view.setBigUint64(top+8*k,BigInt(n),true));
  return {bytes,sp:BigInt(SP_START+top)};
}

function interpreterPlans(main: FilePlan, ld: FilePlan, cfg: InterpreterInput): InterpreterPlans {
  const a=interpreterElf(main.bytes,cfg.mainBias,SP_START,'main'), b=interpreterElf(ld.bytes,cfg.bias,SP_START,'interpreter');
  if (a.interpreter!==ld.input.path || main.file===ld.file
    || a.loads.some(x=>b.loads.some(y=>x.start<y.start+y.length && y.start<x.start+x.length))) throw new FsError(E.NOEXEC);
  return Object.freeze({main:a,ld:b});
}

type InterpreterTrace = Readonly<{rip: bigint; rsp: bigint; rdi: bigint; rsi: bigint; rax: bigint; rbp: bigint;
  flags: bigint; stackWord: bigint | null; frameArg: bigint | null; xmm2Low: bigint; xmm2High: bigint; xmm3Low: bigint; xmm3High: bigint}>;
type InterpreterStore = Readonly<{rip: bigint; address: bigint; low: bigint; high: bigint}>;

interface PreparedSpace {
  readonly guard: GuardedInlineMemory;
  readonly owner: GuardedOwner;
  readonly identity: () => void;
  readonly protections: Map<number,number>;
  readonly companionRx: number | undefined;
  readonly interpreter?: InterpreterPlans;
  readonly sp: bigint;
  readonly entry: bigint;
}

async function prepareSpace(p: Process, main: CodePlan, image: Layout, companion?: {code: CodePlan; layout: CompanionLayout}): Promise<PreparedSpace> {
  const identity = p.readIdentity(), fds = p.fds, codes = companion ? [main,companion.code] : [main];
  const guard = new GuardedInlineMemory(LIMIT / 65536), owner = guard.installOwner(p.kernel.vfs,fds);
  const protections = new Map<number,number>();
  try {
    // The proof and FD identities of the entire proposed address space
    // precede every mapping. No Task has been created or assigned a PID.
    const proofs = await Promise.all(codes.map(({file}) => guard.authenticate(owner,file.input.source,file.input.elfSha256)));
    identity();
    if (p.fds !== fds || p.memory !== null || proofs.some(p => !p)) throw new FsError(E.NOEXEC);
    codes.forEach(x => x.current());
    for (const [i,x] of codes.entries()) {
      if (!guard.installRx(owner, proofs[i]!, x.fd, {address:x.start,length:P,fileOffset:x.offset,flags:0x12,prot:RX}))
        throw new FsError(E.NOEXEC);
      protections.set(x.start,RX);
    }
    if (companion) {
      const {code:{file:{bytes}},layout:{ro,rw}} = companion;
      // Private copies from the same authenticated snapshot. Rights come
      // from the parsed PT_LOADs, never caller flags or an unverified alias.
      guard.installData(owner,ro,P,RO,bytes.subarray(0,P));
      guard.installData(owner,rw,P,RW,bytes.subarray(2*P,3*P));
      protections.set(ro,RO);
      protections.set(rw,RW);
    }
    const initial = stack(main.file.input.path,image);
    guard.installData(owner,SP_START,P,RW,initial.bytes);
    protections.set(SP_START,RW);
    return {guard,owner,identity,protections,companionRx:companion?.layout.rx,sp:initial.sp,entry:BigInt(image.entry)};
  } catch (e) {
    guard.retireOwner(owner);
    throw e;
  }
}

/** Prepare the actual main+interpreter file pages without relocating
 * anything or mapping a DSO. PT_GNU_RELRO starts RW, as at Linux exec. */
async function prepareInterpreterSpace(p: Process, files: readonly [CodePlan,CodePlan], plans: InterpreterPlans): Promise<PreparedSpace> {
  const identity=p.readIdentity(), fds=p.fds, guard=new GuardedInlineMemory(LIMIT/65536);
  const owner=guard.installOwner(p.kernel.vfs,fds), protections=new Map<number,number>();
  try {
    const proof=await Promise.all(files.map(x=>guard.authenticate(owner,x.file.input.source,x.file.input.elfSha256)));
    identity();
    if(proof.some(x=>!x) || p.fds!==fds || p.memory!==null) throw new FsError(E.NOEXEC);
    files.forEach(x=>x.current());
    const ordered=[plans.main,plans.ld];
    for(const [i,x] of files.entries()) {
      if(!guard.installRx(owner,proof[i]!,x.fd,{address:x.start,length:x.length,fileOffset:x.offset,flags:0x12,prot:RX}))
        throw new FsError(E.NOEXEC);
      for(const q of ordered[i]!.loads) {
        if(q.prot!==RX) guard.installData(owner,q.start,q.length,q.prot,x.file.bytes.subarray(q.fileOffset,q.fileOffset+q.copied));
        for(let page=q.start;page<q.start+q.length;page+=P)protections.set(page,q.prot);
      }
    }
    const initial=interpreterStack(p,files[0].file.input.path,plans);
    guard.installData(owner,SP_START,P,RW,initial.bytes);
    protections.set(SP_START,RW);
    return {guard,owner,identity,protections,interpreter:plans,companionRx:undefined,sp:initial.sp,entry:BigInt(plans.ld.entry)};
  } catch(e) { guard.retireOwner(owner); throw e; }
}

class StaticTask extends Task {
  #backing: GuardedInlineMemory | undefined;
  readonly #owner: GuardedOwner;
  readonly #compile: Compile;
  readonly #fds: Process['fds'];
  readonly #steps = new Map<bigint, Step>();
  readonly #protections: Map<number,number>;
  readonly #regs = new BigInt64Array(19);
  readonly #xmm = new BigInt64Array(16); // 8 closed-profile XMM registers, two private lanes each
  readonly #exports: Translation;
  #identity: (() => void) | undefined;
  #running = false;
  #retired = false;
  #remaining = STEPS;
  #fault: GuardedFault | undefined;
  readonly #companionRx: number | undefined;
  readonly #interpreter: InterpreterPlans | undefined;
  readonly #stepsSeen: InterpreterTrace[] = [];
  readonly #syscallsSeen: bigint[] = [];
  readonly #storesSeen: InterpreterStore[] = [];
  constructor(p: Process, compile: Compile, space: PreparedSpace) {
    super(p);
    this.#compile = compile;
    this.#fds = p.fds;
    this.#backing = space.guard;
    this.#owner = space.owner;
    this.#protections = space.protections;
    this.#companionRx = space.companionRx;
    this.#interpreter = space.interpreter;
    this.#identity = space.identity;
    this.setReg(RSP, space.sp);
    this.setReg(RFLAGS, 0x202n);
    this.resumeAt = space.entry;
    const table = new WebAssembly.Table({initial:0, maximum:0, element:'anyfunc'});
    this.#exports = Object.freeze({table, run:(rip: bigint) => this.#run(rip)});
  }
  get #guard(): GuardedInlineMemory {
    if (!this.#backing) throw new GuardedFault('owner', this.resumeAt);
    return this.#backing;
  }
  get memoryFault(): Readonly<GuardedFault> | undefined { return this.#fault; }
  interpreterTrace() { return {steps:this.#stepsSeen.slice(),syscalls:this.#syscallsSeen.slice(),stores:this.#storesSeen.slice()}; }
  /** Inspect only the actual starting image facts before any guest effect.
   * These are bounded reads through the guard, not an exported guest view. */
  entryReceipt(mainWord?: number) {
    const plans=this.#interpreter;
    if(!plans || this.state!=='ready') throw new Error('No guarded interpreter entry to inspect');
    this.#alive(this.resumeAt);
    const read=(at:bigint,n=8)=>this.#guard.read(this.#owner,at,n), sp=this.reg(RSP);
    const cstring=(at:bigint) => {
      let out='';
      for(let i=0;i<128;i++) {
        const v=read(at+BigInt(i),1);
        if(!v)return out;
        out+=String.fromCharCode(Number(v));
      }
      throw new Error('Unterminated guarded entry string');
    };
    const aux=new Map<number,bigint>();
    for(let i=0;i<32;i++) {
      const at=sp+32n+16n*BigInt(i), tag=Number(read(at)), value=read(at+8n);
      if(!tag) { if(value)throw new Error('Invalid guarded AT_NULL'); break; }
      if(aux.has(tag))throw new Error('Duplicate guarded auxv tag');
      aux.set(tag,value);
      if(i===31)throw new Error('No guarded AT_NULL');
    }
    const random=aux.get(25)!;
    read(random); read(random+8n); // exact span, contents never belong in the receipt
    const bss=plans.ld.loads.filter(x=>x.memoryBytes>x.dataBytes).map(x=>{
      let zero=true;
      for(let i=x.dataBytes;i<x.memoryBytes;i++)if(read(BigInt(x.segment+i),1)!==0n)zero=false;
      return {first:x.segment+x.dataBytes,length:x.memoryBytes-x.dataBytes,zero};
    });
    const addr=mainWord===undefined ? undefined : plans.main.bias+mainWord;
    if(addr!==undefined && (!Number.isSafeInteger(addr) || !plans.main.loads.some(x=>x.prot!==RX
        && addr>=x.segment && addr+8<=x.segment+x.memoryBytes))) throw new Error('Requested receipt lies outside main data');
    return {plans,entry:this.resumeAt,sp,argc:read(sp),argv0:cstring(read(sp+8n)),argvEnd:read(sp+16n),envEnd:read(sp+24n),
      aux,platform:cstring(aux.get(15)!),execfn:cstring(aux.get(31)!),randomReadable:true,ldBss:bss,
      mainFirstPhdr:read(aux.get(3)!,4),mainWord:addr===undefined?undefined:read(BigInt(addr)),
      entryBytes:this.#guard.bindCode(this.#owner,this.resumeAt,3)?.bytes};
  }
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
    this.#xmm.fill(0n);
    this.#protections.clear();
    const backing = this.#backing;
    this.#backing = undefined; // never pooled, even while a dead Task handle is retained
    backing?.retireOwner(this.#owner);
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
  #lane(n: number): number {
    if (!Number.isInteger(n) || n<0 || n>=this.#xmm.length/2) throw new Error('Invalid guarded XMM register');
    return n*2;
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
        xmmLow:(n:number) => { permit(); return this.#xmm[this.#lane(n)]!; },
        setXmm:(n:number,low:bigint,high:bigint) => {
          permit();
          const k=this.#lane(n);
          this.#xmm[k]=low;
          this.#xmm[k+1]=high;
        },
        storeAligned128:(at:bigint,n:number) => {
          permit();
          const k=this.#lane(n);
          this.#guard.writeAligned128(this.#owner,at,this.#xmm[k]!,this.#xmm[k+1]!);
          if(this.#interpreter && this.#storesSeen.length<8) this.#storesSeen.push(Object.freeze({
            rip,address:at,low:this.#guard.read(this.#owner,at,8),high:this.#guard.read(this.#owner,at+8n,8),
          }));
        },
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
        if(this.#interpreter && this.#stepsSeen.length<32) {
          const rsp=this.reg(RSP);
          const observed=(at:bigint)=>{
            try { return this.#guard.read(this.#owner,at,8); } catch(e) { if(!(e instanceof GuardedFault))throw e; return null; }
          };
          const rbp=this.reg(5);
          this.#stepsSeen.push(Object.freeze({rip,rsp,rdi:this.reg(7),rsi:this.reg(6),rax:this.reg(0),rbp,
            flags:this.reg(RFLAGS),stackWord:observed(rsp),frameArg:observed(rbp-0x88n),
            xmm2Low:this.#xmm[4]!,xmm2High:this.#xmm[5]!,xmm3Low:this.#xmm[6]!,xmm3High:this.#xmm[7]!}));
        }
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
    if(this.#interpreter && this.#syscallsSeen.length<32)this.#syscallsSeen.push(nr);
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
    if (call.nr === 11 && this.#companionRx !== undefined) {
      // Exact one-page companion RX munmap only. No path to remap, expand,
      // or reopen a stale execution lease. Leave the primary, data, stack.
      if (a !== BigInt(this.#companionRx) || b !== BigInt(P)) return minus(E.INVAL);
      const start = this.#companionRx;
      if (this.#protections.has(start)) {
        this.#guard.unmap(this.#owner,start,P);
        this.#protections.delete(start);
      }
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

  async begin(input: FileInput, compile: Compile, extra?: CompanionInput, loader?: InterpreterInput): Promise<StaticTask> {
    if (this.#used || this.shared || extra && loader) throw new FsError(E.NOEXEC);
    this.#used = true;
    const p = new Process(this, null);
    let staging: PreparedSpace | undefined;
    try {
      const main = await filePlan(p,input,loader && INTERPRETER_ELF_LIMIT);
      const image = loader ? undefined : layout(main.bytes);
      const interpreter = loader && await filePlan(p,loader,INTERPRETER_ELF_LIMIT);
      const plans = loader && interpreter && interpreterPlans(main,interpreter,loader);
      const auxiliary = extra && await filePlan(p,extra);
      if (auxiliary?.file === main.file) throw new FsError(E.NOEXEC);
      const shape = extra && auxiliary && image && companionLayout(auxiliary.bytes,extra.bias,image);
      main.current();
      auxiliary?.current();
      interpreter?.current();
      p.stackLow = SP_START;
      p.stackTop = SP_END;
      p.mapBase = p.mapEnd = LIMIT;
      p.fixed = [];
      p.free = [];
      p.exe = input.path;
      p.exeAt = {mnt:main.at.mnt, node:main.file, dir:main.at.parent, name:main.at.name};
      for (const [fd,path] of ['stdin','stdout','stderr'].entries()) p.fds.install(new Description('console', {path}), {fd});
      let codes: readonly CodePlan[];
      if(plans && interpreter) {
        const code=(f:FilePlan,plan:ElfEntryPlan) => {
          const rx=plan.loads.find(x=>x.prot===RX)!;
          return codePlan(p,f,rx.start,rx.fileOffset,rx.length);
        };
        const pair=[code(main,plans.main),code(interpreter,plans.ld)] as const;
        codes=pair;
        staging=await prepareInterpreterSpace(p,pair,plans);
      } else if (image) {
        const mainCode=codePlan(p,main,image.start,0);
        const companion=shape && auxiliary && {code:codePlan(p,auxiliary,shape.rx,P),layout:shape};
        codes=companion?[mainCode,companion.code]:[mainCode];
        staging=await prepareSpace(p,mainCode,image,companion);
      } else throw new FsError(E.NOEXEC);
      // Await completion is not commit: recheck exact FD/VFS/owner identity.
      codes.forEach(x=>x.current());
      staging.identity();
      codes.forEach(x=>p.fds.close(x.fd));
      const t = new StaticTask(p,compile,staging);
      staging = undefined; // the actual Task now owns this same sealed memory
      p.pid = p.pgid = p.sid = t.tid;
      p.argv = [input.path];
      p.env = [];
      p.task = t;
      p.tasks.add(t);
      // The only publication boundary: the prepared Task becomes runnable.
      this.#task = t;
      this.procs.set(p.pid,p);
      this.tasks.set(t.tid,t);
      this.tty = {sid:p.sid, fg:p.pgid};
      this.ready(t);
      return t;
    } catch (e) {
      if (staging) staging.guard.retireOwner(staging.owner);
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
  readonly companion?: CompanionInput;
  readonly interpreter?: InterpreterInput;
}) {
  // Seal primitive configuration before the first await. The VFS/source are
  // checked again on use; a callback cannot change the admitted digest.
  const {compiler:bytes,compilerSha256,vfs,path,source,elfSha256,write,companion,interpreter} = input;
  const extra = companion && {path:companion.path,source:companion.source,elfSha256:companion.elfSha256,bias:companion.bias};
  const boot = interpreter && {path:interpreter.path,source:interpreter.source,elfSha256:interpreter.elfSha256,
    bias:interpreter.bias,mainBias:interpreter.mainBias};
  const compile = await compiler(bytes, compilerSha256);
  const kernel = new StaticKernel({vfs,console:{write,read:() => null}});
  const task = await kernel.begin({path,source,elfSha256}, compile, extra, boot);
  return {kernel:kernel as Kernel,task:task as Task,fault:() => task.memoryFault,
    entryReceipt:(off?:number)=>task.entryReceipt(off),interpreterTrace:()=>task.interpreterTrace()};
}
