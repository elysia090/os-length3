// Evidence for the first, inline dynamic-linking profile. Not an execution
// permission check: stock Linux still has no enforced guest page protection.
// Nothing consumes these observations to fetch code or install dispatch targets.
import {sha256} from '../host.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from './executable-source.ts';
import {FdTable} from './fd.ts';
import {MNT, Mount, Vfs} from './fs.ts';

const PAGE = 4096, FLOOR = 65536, CEILING = 2 ** 32;
const RX = 5; // PROT_READ | PROT_EXEC and, in an ELF PT_LOAD, PF_R | PF_X
const PRIVATE = 2, FIXED = 0x10, IGNORE_HINTS = 0x1800; // Linux MAP_DENYWRITE / MAP_EXECUTABLE
const FD_PATH = 0x200000;
const ELF_LIMIT = 64 << 20, DYNAMIC_LIMIT = 64 << 10;
const page = (n: number) => Math.floor(n / PAGE) * PAGE;
const pageEnd = (n: number) => Math.ceil(n / PAGE) * PAGE;
const whole = (n: number, min = 0, max = CEILING) => Number.isSafeInteger(n) && n >= min && n <= max;
const aligned = (n: number, min = 0) => whole(n, min) && n % PAGE === 0;
const intersects = (a: number, b: number, c: number, d: number) => a < d && c < b;

declare const fileProof: unique symbol, mapTicket: unique symbol, codeObservation: unique symbol;
export interface ExecutableFileProof { readonly [fileProof]: true }
export interface ExecutableMapTicket { readonly [mapTicket]: true }
export interface MappedCodeObservation {
  readonly [codeObservation]: true;
  readonly address: number;
  readonly length: number;
  readonly epoch: bigint;
  readonly fileSha256: string;
  readonly fileOffset: number;
  readonly objectOffset: number;
  readonly loadBias: number;
}
export interface FileRxRequest {
  readonly address: number;
  readonly length: number;
  readonly fileOffset: number;
  readonly prot: number;
  readonly flags: number;
}
type Captured = ReturnType<typeof executableSourceFor>;
type Slot = NonNullable<ReturnType<FdTable['slots']['get']>>;
type Load = {flags: number; off: number; va: number; n: number; mem: number; align: number};
type RxLoad = Load & {bytes: Uint8Array};
interface Layout { readonly pie: boolean; readonly end: number; readonly align: number; readonly rx: readonly RxLoad[] }
interface FileRecord { readonly source: Captured; readonly digest: string; readonly layout: Layout }
interface Prepared {
  readonly at: number; readonly length: number; readonly off: number; readonly fixed: boolean;
  readonly file: FileRecord; readonly load: RxLoad;
  readonly fd: number; readonly slot: Slot; readonly mount: Mount; readonly mountFlags: number; readonly version: bigint;
}
interface Live {
  readonly mapLo: number; readonly mapHi: number;
  readonly lo: number; readonly hi: number; readonly bias: number;
  readonly epoch: bigint; readonly file: FileRecord; readonly load: RxLoad;
  readonly mount: Mount; readonly mountFlags: number;
}

/** Narrow checked ELF64 x86-64 descriptor; not the process loader or symbol resolver. */
function layout(bytes: Uint8Array<ArrayBuffer>): Layout | null {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 69 || bytes[2] !== 76 || bytes[3] !== 70
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getUint16(16, true);
  if ((type !== 2 && type !== 3) || v.getUint16(18, true) !== 62 || v.getUint32(20, true) !== 1
    || v.getUint16(52, true) !== 64 || v.getUint16(54, true) !== 56) return null;
  // The admitted address/file domain is wasm32, so these conversions are
  // exact for every value we allow. Out-of-domain rounded values are rejected.
  const q = (at: number) => Number(v.getBigUint64(at, true));
  const p = q(32), n = v.getUint16(56, true);
  if (!whole(p, 64, bytes.length) || !n || n > 128 || n * 56 > bytes.length - p) return null;
  const loads: Load[] = [];
  let dynamic: Load | null = null;
  for (let i = 0; i < n; ++i) {
    const a = p + 56 * i, kind = v.getUint32(a, true), flags = v.getUint32(a + 4, true);
    if (kind === 0x6474e551 && flags & 1) return null; // no executable GNU_STACK
    if (kind !== 1 && kind !== 2) continue;
    const s = {flags, off: q(a + 8), va: q(a + 16), n: q(a + 32), mem: q(a + 40), align: q(a + 48)};
    if (!whole(s.off, 0, bytes.length) || !whole(s.n, 0, bytes.length - s.off)
      || !whole(s.va, 0, CEILING - 1) || !whole(s.mem, s.n, CEILING - s.va)) return null;
    if (kind === 2) {
      if (dynamic || s.n < 16 || s.n > DYNAMIC_LIMIT || s.n % 16 !== 0) return null;
      dynamic = s;
      continue;
    }
    if (flags > 7 || (flags & 3) === 3 || (s.va - s.off) % PAGE !== 0 || !whole(s.align)) return null;
    if (s.align > 1 && ((BigInt(s.align) & (BigInt(s.align) - 1n)) || (s.va - s.off) % s.align)) return null;
    if (!s.mem) continue;
    if (loads.some(old => intersects(page(old.va), pageEnd(old.va + old.mem), page(s.va), pageEnd(s.va + s.mem)))) return null;
    loads.push(s);
  }
  if (dynamic) {
    const d = dynamic;
    if (!loads.some(s => d.off >= s.off && d.off + d.n <= s.off + s.n && d.va - s.va === d.off - s.off)) return null;
    let terminated = false;
    for (let at = d.off; at < d.off + d.n; at += 16) {
      const tag = v.getBigUint64(at, true);
      if (!tag) { terminated = true; break; }
      if (tag === 22n || (tag === 30n && v.getBigUint64(at + 8, true) & 4n)) return null; // DT_TEXTREL / DF_TEXTREL
    }
    if (!terminated) return null;
  }
  const rx = loads.filter(s => s.flags === RX && s.n > 0).map(s => ({...s, bytes: bytes.slice(s.off, s.off + s.n)}));
  if (!rx.length) return null;
  return {pie:type === 3, end:Math.max(...loads.map(s => pageEnd(s.va + s.mem))),
    align:Math.max(PAGE, ...loads.map(s => s.align)), rx};
}

// Initial profile does not admit any live MAP_SHARED alias of the file (the
// File revision may not yet reflect dirty writes). On a new prepare, a
// canonical hardlink may be used, but no lookup of a replacement name occurs.
const stable = (c: Captured) => c.node.maps === null && unchangedExecutableSource(c);
const token = <T extends object>(): T => Object.freeze(Object.create(null)) as T;

/** Explicitly attached to one unshared guest Memory and its currently owned FD table. */
export class ExecutableMappingModel {
  readonly #vfs: Vfs;
  readonly #memory: WebAssembly.Memory;
  readonly #fds: FdTable;
  #life = {};
  #epoch = 0n;
  #files = new WeakMap<ExecutableFileProof, FileRecord>();
  #pending = new WeakMap<ExecutableMapTicket, Prepared>();
  #checked = new WeakMap<MappedCodeObservation, Live>();
  readonly #live = new Map<bigint, Live>();
  constructor(vfs: Vfs, memory: WebAssembly.Memory, fds: FdTable) {
    if (!(vfs instanceof Vfs) || !(memory instanceof WebAssembly.Memory) || !(memory.buffer instanceof ArrayBuffer)
      || !(fds instanceof FdTable)) throw new TypeError('Expected one inline guest address space');
    this.#vfs = vfs; this.#memory = memory; this.#fds = fds;
  }

  /** Caller supplies the content digest from a trusted release, not a path or SONAME. */
  async authenticate(source: ExecutableSource, digest: string): Promise<ExecutableFileProof | null> {
    const c = executableSourceFor(source, this.#vfs), life = this.#life;
    if (!/^[0-9a-f]{64}$/.test(digest) || !stable(c) || !whole(c.size, 64, ELF_LIMIT)) return null;
    const bytes = c.node.read(0, c.size).slice();
    if (!stable(c) || bytes.length !== c.size || life !== this.#life) return null;
    const hash = await sha256(bytes);
    if (!stable(c) || life !== this.#life || Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') !== digest) return null;
    const parsed = layout(bytes);
    if (!parsed) return null;
    const proof = token<ExecutableFileProof>();
    this.#files.set(proof, {source:c, digest, layout:parsed});
    return proof;
  }

  /** Before mapping: keep the exact FD slot, not just its number or its current pathname. */
  stage(proof: ExecutableFileProof, fd: number, requested: FileRxRequest): ExecutableMapTicket | null {
    const file = this.#files.get(proof);
    const {address:at, length, fileOffset:off, prot, flags} = requested;
    const fixed = (flags & FIXED) !== 0;
    if (!file || !stable(file.source) || !whole(fd, 0) || prot !== RX || !whole(flags, 0, 0xffff_ffff)
      || (flags & ~(PRIVATE | FIXED | IGNORE_HINTS)) !== 0 || !(flags & PRIVATE)
      || !aligned(at, fixed ? FLOOR : 0) || !aligned(length, PAGE) || !aligned(off)
      || length > CEILING - off || (fixed && length > CEILING - at)) return null;
    const slot = this.#fds.slots.get(fd), d = slot?.description, mount = d?.mnt;
    if (!slot || !d || d.closed || d.refs <= 0 || d.kind !== 'file' || d.node !== file.source.node
      || (d.flags & FD_PATH) || (d.flags & 3) === 1 || (d.flags & 3) === 3
      || !(mount instanceof Mount) || mount.flags & MNT.NOEXEC) return null;
    const matches = file.layout.rx.filter(s => off >= page(s.off) && off + length <= pageEnd(s.off + s.n)
      && off < s.off + s.n && off + length > s.off);
    if (matches.length !== 1) return null;
    const t = token<ExecutableMapTicket>();
    this.#pending.set(t, {at, length, off, fixed, file, load:matches[0]!, fd, slot, mount,
      mountFlags:mount.flags, version:this.#epoch});
    return t;
  }

  /**
   * After a successful real mmap by this owner; its result is not made here.
   * Glue must stage and report from that same syscall. This checks only
   * provenance and actual bytes, not the runtime's enforcement of page rights.
   */
  recordMapped(ticket: ExecutableMapTicket, start: number): boolean {
    const p = this.#pending.get(ticket);
    if (!p) return false;
    this.#pending.delete(ticket); // linear: even a rejected report cannot be retried
    // A reported successful mapping that collided with a live claim can
    // never leave that claim valid (even byte-identical replacement is a new
    // lifetime). The real hook must retire before mutating memory; this is
    // a defensive second check, not permission to move the hook after mmap.
    if (!aligned(start, FLOOR) || (p.fixed && start !== p.at) || p.length > CEILING - start
      || start + p.length > this.#memory.buffer.byteLength) return false;
    const end = start + p.length, overlap = (i: Live) => intersects(i.mapLo, i.mapHi, start, end);
    if ([...this.#live.values()].some(overlap)) { this.#retire(overlap); return false; }
    const d = p.slot.description;
    if (p.version !== this.#epoch || this.#fds.slots.get(p.fd) !== p.slot || d.closed || d.refs <= 0 || d.kind !== 'file'
      || d.node !== p.file.source.node || d.mnt !== p.mount || p.mount.flags !== p.mountFlags || !stable(p.file.source)
      || d.flags & FD_PATH || (d.flags & 3) === 1 || (d.flags & 3) === 3) return false;
    const s = p.load;
    const bias = start - (page(s.va) + p.off - page(s.off));
    if (!aligned(bias) || bias % p.file.layout.align || (!p.file.layout.pie && bias !== 0) || bias + p.file.layout.end > CEILING) return false;
    const lo = Math.max(start, bias + s.va), hi = Math.min(end, bias + s.va + s.n);
    if (lo >= hi || !this.#matches(s, bias, lo, hi)) return false;
    const epoch = ++this.#epoch;
    this.#live.set(epoch, {mapLo:start, mapHi:end, lo, hi, bias, epoch, file:p.file, load:s, mount:p.mount, mountFlags:p.mountFlags});
    return true;
  }

  /** Before unmap, permissions or replacement can affect these pages. Drop the whole intersecting claim. */
  retireRange(start: number, length: number): number {
    if (!aligned(start, FLOOR) || !aligned(length, PAGE) || length > CEILING - start) throw new RangeError('Invalid guest page range');
    return this.#retire(i => intersects(i.mapLo, i.mapHi, start, start + length));
  }

  /** Before execute policy on a source mount changes. */
  retireMount(mount: Mount): number {
    if (!(mount instanceof Mount)) throw new TypeError('Invalid source mount');
    return this.#retire(i => i.mount === mount);
  }

  /** Before this memory/table is retired or recycled by the process. */
  clear(): void {
    ++this.#epoch;
    this.#life = {};
    this.#live.clear();
    this.#files = new WeakMap();
    this.#pending = new WeakMap();
    this.#checked = new WeakMap();
  }

  /** One x86 instruction's actual byte span, not page padding or zero-fill. No authority to execute. */
  inspect(address: number, length = 1): MappedCodeObservation | null {
    if (!whole(address, FLOOR, CEILING - 1) || !whole(length, 1, 15) || length > CEILING - address) return null;
    const i = [...this.#live.values()].find(x => address >= x.lo && address + length <= x.hi);
    if (!i || !this.#stillMatches(i, address, length)) return null;
    const objectOffset = address - i.bias;
    const out = Object.freeze({address, length, epoch:i.epoch, fileSha256:i.file.digest, loadBias:i.bias,
      fileOffset:i.load.off + objectOffset - i.load.va, objectOffset}) as MappedCodeObservation;
    this.#checked.set(out, i);
    return out;
  }

  /** A negative is sticky for that mapping if source/policy or observed code bytes failed. */
  confirm(observed: MappedCodeObservation): boolean {
    const i = this.#checked.get(observed);
    return !!i && this.#live.get(i.epoch) === i && this.#stillMatches(i, observed.address, observed.length);
  }

  #retire(test: (range: Live) => boolean): number {
    ++this.#epoch; // invalidates pending tickets even if no existing range intersected
    let n = 0;
    for (const [k, i] of this.#live) if (test(i)) { this.#live.delete(k); ++n; }
    return n;
  }

  #stillMatches(i: Live, at: number, length: number): boolean {
    if (stable(i.file.source) && i.mount.flags === i.mountFlags && this.#matches(i.load, i.bias, at, at + length)) return true;
    this.#live.delete(i.epoch); ++this.#epoch;
    return false;
  }

  #matches(s: RxLoad, bias: number, lo: number, hi: number): boolean {
    const buffer = this.#memory.buffer;
    if (!(buffer instanceof ArrayBuffer) || hi > buffer.byteLength) return false;
    const view = new Uint8Array(buffer, lo, hi - lo), off = lo - bias - s.va;
    for (let k = 0; k < view.length; ++k) if (view[k] !== s.bytes[off + k]) return false;
    return true;
  }
}
