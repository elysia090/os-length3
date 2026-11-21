// Narrow, test-only prepared Linux ELF entry. No code parsing via sections,
// relocation, symbol lookup, loader emulation, or authority to execute bytes.
import {E, FsError} from '../../runtime/linux/fs.ts';

export const PAGE = 4096, INTERPRETER_ELF_LIMIT = 512 << 10;
const PT_LOAD = 1, PT_DYNAMIC = 2, PT_INTERP = 3, PT_PHDR = 6, PT_GNU_STACK = 0x6474e551, PT_GNU_RELRO=0x6474e552;
const PT_NOTE=4, PT_GNU_EH_FRAME=0x6474e550;
const kinds = new Set([PT_LOAD,PT_DYNAMIC,PT_INTERP,PT_PHDR,PT_GNU_STACK,PT_GNU_RELRO,PT_NOTE,PT_GNU_EH_FRAME]);
const PF_R=4, PF_X=1, PF_W=2;
const NX_STACK = PF_R|PF_W;
const floor = (x: number) => Math.floor(x/PAGE)*PAGE, ceil = (x: number) => Math.ceil(x/PAGE)*PAGE;
const refuse = (): never => { throw new FsError(E.NOEXEC); };
const ascii = new TextDecoder('utf-8',{fatal:true});

export interface LoadPlan {
  readonly start: number;       // first guest page
  readonly length: number;      // rounded mapping, including any zero fill
  readonly fileOffset: number;  // first aligned byte in the authenticated file
  readonly copied: number;      // from fileOffset, then zero the remainder
  readonly dataBytes: number;   // p_filesz
  readonly memoryBytes: number; // p_memsz
  readonly segment: number;     // exact first guest byte of PT_LOAD
  readonly prot: 1 | 3 | 5;    // Linux PROT_READ, plus W or X
}
export interface ElfEntryPlan {
  readonly bias: number;
  readonly entry: number;
  readonly phdr: number;
  readonly phent: number;
  readonly phnum: number;
  readonly interpreter: string | undefined;
  readonly loads: readonly LoadPlan[];
}
type Header = {type:number; flags:number; off:number; at:number; file:number; mem:number; align:number};
const contains = (x: Header,y: Header) => y.off>=x.off && y.off+y.file<=x.off+x.file
  && y.at-x.at===y.off-x.off && y.mem<=x.mem-(y.at-x.at);

export function interpreterElf(bytes: Uint8Array<ArrayBuffer>, bias: number, ceiling: number, role: 'main'|'interpreter'): ElfEntryPlan {
  if (bytes.length < 120 || bytes.length > INTERPRETER_ELF_LIMIT || !Number.isSafeInteger(bias) || bias < 65536
    || !Number.isSafeInteger(ceiling) || bias%PAGE || ceiling<=bias || ceiling>16<<20) return refuse();
  const v = new DataView(bytes.buffer), u=(p:number)=>v.getUint32(p,true), h=(p:number)=>v.getUint16(p,true);
  const q=(p:number) => {
    const x = v.getBigUint64(p,true);
    if (x > BigInt(ceiling)) return refuse();
    return Number(x);
  };
  const phoff=q(32), n=h(56), m=h(54), entry=q(24);
  if (u(0)!==0x464c457f || bytes[4]!==2 || bytes[5]!==1 || bytes[6]!==1 || ![0,3].includes(bytes[7]!)
    || h(16)!==3 || h(18)!==62 || u(20)!==1 || u(48)!==0 || h(52)!==64 || phoff!==64 || m!==56
    || n<4 || n>32 || n*m>bytes.length-phoff) return refuse();
  const parsed: Header[]=[];
  for (let i=0,p=phoff;i<n;i++,p+=m) {
    const type=u(p), flags=u(p+4), off=q(p+8), at=q(p+16), file=q(p+32), mem=q(p+40), align=q(p+48);
    if (!kinds.has(type) || flags>7 || off>bytes.length || file>bytes.length-off || mem<file
      || at>ceiling-bias || mem>ceiling-bias-at || (align>1&&(align&(align-1))!==0)) return refuse();
    parsed.push({type,flags,off,at,file,mem,align});
  }
  const collect=(kind:number)=>parsed.filter(p=>p.type===kind);
  const stack=collect(PT_GNU_STACK), dyn=collect(PT_DYNAMIC), it=collect(PT_INTERP), relro=collect(PT_GNU_RELRO), ph=collect(PT_PHDR);
  if (stack.length!==1 || stack[0]!.flags!==NX_STACK || stack[0]!.file || stack[0]!.mem
    || dyn.length!==1 || dyn[0]!.file<16 || dyn[0]!.file%16 || relro.length>1 || ph.length>1
    || it.length!==(role==='main'?1:0)) return refuse();
  const raw=collect(PT_LOAD);
  if (raw.length<2 || raw.length>8 || raw[0]!.at!==0 || raw[0]!.off!==0
    || !raw.some(x=>x.flags===NX_STACK && contains(x,dyn[0]!))) return refuse();
  for (const r of relro) if (!raw.some(x=>x.flags===NX_STACK && contains(x,r))) return refuse();
  const out: LoadPlan[]=[];
  for (const x of raw) {
    if (![PF_R,NX_STACK,PF_R|PF_X].includes(x.flags) || !x.file || x.align!==PAGE
      || (x.at-x.off)%PAGE || (x.mem!==x.file && x.flags!==NX_STACK)) return refuse();
    const p=floor(x.at), off=floor(x.off), len=ceil(x.at+x.mem)-p, start=bias+p;
    if (!len || len>ceiling-start || out.some(y=>y.start+y.length>start)) return refuse();
    const copied=x.mem>x.file ? (x.at-p)+x.file : Math.min(len,bytes.length-off);
    const prot=x.flags===NX_STACK?3:x.flags===(PF_R|PF_X)?5:1;
    out.push(Object.freeze({start,length:len,fileOffset:off,copied,dataBytes:x.file,memoryBytes:x.mem,segment:bias+x.at,prot}));
  }
  const rx=out.filter(p=>p.prot===5);
  if (rx.length!==1 || bias+entry<rx[0]!.segment || bias+entry>=rx[0]!.segment+rx[0]!.dataBytes) return refuse();
  const where=raw.find(x=>x.flags===PF_R && x.off<=phoff && phoff+n*m<=x.off+x.file);
  if (!where) return refuse();
  const phdr=bias+where.at+(phoff-where.off);
  if (ph.length && (ph[0]!.at+bias!==phdr || ph[0]!.off!==phoff || ph[0]!.mem!==n*m || ph[0]!.file!==n*m)) return refuse();
  let interpreter: string | undefined;
  if (it.length) {
    const p=it[0]!;
    if (p.file<2 || p.file>256 || p.mem!==p.file || bytes[p.off+p.file-1]!==0 || !raw.some(x=>x.flags===PF_R && contains(x,p))) return refuse();
    try { interpreter=ascii.decode(bytes.subarray(p.off,p.off+p.file-1)); } catch { return refuse(); }
    if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]+$/.test(interpreter) || interpreter.includes('..')) return refuse();
  }
  return Object.freeze({bias,entry:bias+entry,phdr,phent:m,phnum:n,interpreter,loads:Object.freeze(out)});
}
