// Linux's bounded inline mapped-memory profile. One fresh memory, no sharing
// or reuse by the static runtime. Records and executable authority are
// changed together. The same installed records authorize checked user
// copies and translated data accesses. It is not an exec entry.
import {DYNAMIC_FILE_LIMIT, type ElfLoadSpec} from '../translation/dynamic-load.ts';
import type {Translate} from '../translation/translator.ts';
import type {Description} from './fd.ts';
import {MappedCodeSpace, type ExecutableMapping, type MappedCodeView} from './exec/mapped-code-space.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from './executable-source.ts';
import {E, File, FsError, MNT, type Vfs} from './fs.ts';
import {utf8} from './flow.ts';
import {ReadLifetimeError, retireMemoryView} from './read-lifetime.ts';

export const MAPPED_VM_LIMIT = 256 << 20;
const PAGE = 4096, WASM_PAGE = 65536, LIMIT = MAPPED_VM_LIMIT, MAX_REGIONS = 4096, MAX_SOURCES = 4096;
const MIN = 65536, R = 1, W = 2, X = 4, RX = R | X;
export const MAPPED_COPY_LIMIT = 1 << 20;
export const MAPPED_STRING_LIMIT = 1 << 20;
const PATH_LIMIT = 4096;
const PRIVATE = 2, FIXED = 0x10, ANON = 0x20, NOREPLACE = 0x100000;
// glibc may supply the historical DENYWRITE/EXECUTABLE hints. Neither grants permission.
const FLAGS = PRIVATE | FIXED | ANON | NOREPLACE | 0x800 | 0x1000;
const up = (n: number, align = PAGE): number => Math.ceil(n / align) * align;
const down = (n: number): number => Math.floor(n / PAGE) * PAGE;
const fail = (errno: number): never => { throw new FsError(errno); };
function word(x: bigint, max = Number.MAX_SAFE_INTEGER): number {
  if (x < 0n || x > BigInt(max)) fail(E.INVAL);
  return Number(x);
}
function permissions(x: bigint): number {
  const p = word(x, 7);
  if (p & X && p !== RX) fail(E.ACCES);
  return p;
}

type Reader = Required<Pick<Translate, 'describeDynamic' | 'notProgram'>>;
interface Region { start: number; end: number; prot: number; entry?: number; initial?: InitialMappedRegion['kind'] }
const overlaps = (r: Region, a: number, b: number): boolean => a < r.end && r.start < b;
interface Caller {
  readonly kernel: {readonly vfs: Vfs};
  readonly memory: WebAssembly.Memory | null;
  readonly noNewPrivs: boolean;
  readonly state: 'live' | 'zombie';
  readonly fds: {get(fd: number): Description | null};
  readIdentity(): () => void;
}
interface MappedMemory extends WebAssembly.Memory {
  readonly mappedVm: MappedVm;
  imageOf: null;
  users: number;
  keeps: false;
  written: [number, number][];
  tainted: true;
}
interface MemorySpec {
  vfs: Vfs; base: number; pages: number; sources: readonly ExecutableSource[]; reader: Reader;
}

/** Initial PT_LOAD and stack rows stay distinct from the mmap arena. Writes
 * are initialized bytes; unwritten bytes begin zero in a fresh allocation. */
export type InitialMappedRegion = {
  readonly start: number;
  readonly end: number;
  readonly prot: number;
  readonly writes: readonly { readonly at: number; readonly bytes: Uint8Array }[];
} & ({readonly kind: 'load-text'; readonly text: ExecutableMapping} |
     {readonly kind: 'load-data' | 'stack'; readonly text?: never});

interface InitialLayout {
  readonly regions: readonly InitialMappedRegion[];
  readonly verify: () => void;
}

/** Inspection of a staged image, not an executable address-space
 * capability. Do not expose its memory, compiler handle or dispatcher. */
export interface DetachedMappedMemory {
  readonly permits: (address: number, length: number, access: DataAccess) => boolean;
  readonly read: (address: number, length: number) => Uint8Array<ArrayBuffer>;
  readonly hasText: (address: bigint) => boolean;
  check(): void;
  discard(): void;
}

export type DataAccess = 'read' | 'write';
export type MappedRunView = MappedCodeView & {
  readonly memory: WebAssembly.Memory;
  permits(address: bigint, length: bigint, access: DataAccess): boolean;
  string(dest: bigint, source: bigint, count: bigint, value: bigint, width: number, mode: number): bigint;
};

/** A closed data-access failure, not permission to retry old Wasm.
 * Signal delivery belongs to a future mapped task backend. */
export class MappedDataFault extends Error {
  readonly address: bigint;
  readonly length: number;
  readonly access: DataAccess;
  constructor(address: bigint, length: number, access: DataAccess) {
    super('Mapped guest data access was not permitted');
    this.name = 'MappedDataFault';
    this.address = address;
    this.length = length;
    this.access = access;
  }
}

/** A limit of this inline profile, not a claim that a Linux page faulted. */
export class MappedStringLimit extends RangeError {
  constructor() { super('Mapped string operation exceeds the inline transfer bound'); this.name = 'MappedStringLimit'; }
}

/** A scoped kernel copy capability, not a borrow of guest RAM. */
export interface MappedUserMemory {
  check(): void;
  prefix(address: number, length: number, access: DataAccess): number;
  copyIn(address: number, length: number): Uint8Array<ArrayBuffer>;
  copyOut(address: number, from: Uint8Array): void;
  cstring(address: number): string;
}

export class MappedVmCommitError extends Error {
  cleanupFailure?: unknown;
  constructor(cause: unknown) { super('Mapped memory installation did not complete', {cause}); this.name = 'MappedVmCommitError'; }
}

export class MappedVm {
  #vfs: Vfs;
  #base: number;
  #reader: Reader;
  readonly memory: WebAssembly.Memory;
  #code: MappedCodeSpace;
  #regions: Region[] = [];
  #sources = new Map<File, ExecutableSource>();
  #specs = new WeakMap<File, ElfLoadSpec>();
  #busy = false;
  #closed = false;
  #owner?: Caller;
  /** The dispatcher observes this owner's code and data authority. */
  readonly code: MappedRunView;

  /** Internal allocation for a distinct, unclaimed backing. If there is an
   * initial layout, validate and initialize it before returning that backing.
   * No kernel/guest API opts into mapped memory as a side effect of mmap. */
  static allocate({vfs, base, pages, sources, reader}: MemorySpec, initial?: InitialLayout): MappedMemory {
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > LIMIT / WASM_PAGE ||
        !Number.isSafeInteger(base) || base < MIN || base >= LIMIT || base % PAGE)
      throw new RangeError('Invalid mapped memory layout');
    initial?.verify();
    const memory = new WebAssembly.Memory({initial: pages, maximum: LIMIT / WASM_PAGE});
    const vm = new MappedVm(vfs, memory, base, sources, reader);
    if (initial) {
      const {regions, verify} = initial;
      try { vm.#seedDetached(regions, verify); verify(); }
      catch (error) { vm.close(); throw error; }
    }
    const made: MappedMemory = Object.assign(memory, {mappedVm: vm, users: 1, keeps: false as const, written: [], imageOf: null, tainted: true as const});
    Object.defineProperty(made, 'mappedVm', {writable: false, configurable: false});
    return made;
  }

  /** Commit to an inaccessible, private candidate first. If initialization
   * or a late source fence fails, no result or live memory is published. */
  static detached(spec: MemorySpec, regions: readonly InitialMappedRegion[], verify: () => void): DetachedMappedMemory {
    let held: MappedVm | null = MappedVm.allocate(spec, {regions, verify}).mappedVm;
    const discard = (): void => {
      const retired = held; held = null;
      retired?.close();
    };
    const current = (): MappedVm => {
      if (!held) throw new Error('Detached mapped memory was discarded');
      try { verify(); } catch (error) { discard(); throw error; }
      return held;
    };
    const permits = (address: number, length: number, access: DataAccess): boolean => {
      const vm = current();
      vm.#copyLength(length);
      return vm.#prefix(address, length, access) === length;
    };
    return Object.freeze({
      permits,
      read(address: number, length: number) {
        const vm = current();
        vm.#copyLength(length);
        if (vm.#prefix(address, length, 'read') !== length) fail(E.FAULT);
        return length ? new Uint8Array(vm.memory.buffer, address, length).slice() : new Uint8Array(0);
      },
      hasText(address: bigint) {
        const code = current().#code;
        return !!code.find(address, code.generation);
      },
      check: () => { current(); },
      discard,
    });
  }

  private constructor(vfs: Vfs, memory: WebAssembly.Memory, base: number, sources: readonly ExecutableSource[], reader: Reader) {
    this.#vfs = vfs;
    this.#base = base;
    this.#reader = reader;
    this.memory = memory;
    if (sources.length > MAX_SOURCES) fail(E.NOMEM);
    for (const source of sources) {
      const {node} = executableSourceFor(source, vfs);
      if (this.#sources.has(node)) throw new TypeError('Duplicate mapped code source');
      this.#sources.set(node, source);
    }
    const code = this.#code = new MappedCodeSpace(vfs, memory);
    this.code = Object.freeze({
      memory, get generation() { return code.generation; },
      find: code.find.bind(code), permits: this.permits.bind(this), string: this.#string.bind(this),
    });
  }

  claim(owner: Caller): void {
    if (owner.kernel.vfs !== this.#vfs) throw new TypeError('Mapped memory belongs to another Vfs');
    if (this.#closed || (this.#owner && this.#owner !== owner)) throw new Error('Mapped memory already has an owner or was retired');
    if (!owner.noNewPrivs) fail(E.PERM);
    this.#owner = owner;
  }

  close(): void {
    this.#closed = true;
    this.#owner = undefined;
    this.#code.invalidate(0, LIMIT);
    this.#regions = [];
    this.#sources.clear();
    this.#specs = new WeakMap();
  }

  #seedDetached(initial: readonly InitialMappedRegion[], verify: () => void): void {
    if (this.#owner || this.#closed || this.#regions.length) throw new Error('Initial pages need a fresh detached memory');
    if (!initial.length || initial.length > MAX_REGIONS) fail(E.NOMEM);
    const regions = [...initial].sort((a, b) => a.start - b.start);
    const memory = new Uint8Array(this.memory.buffer);
    const records: Region[] = [], bindings: ExecutableMapping[] = [];
    let after = MIN;
    for (const {start, end, prot, writes, kind, text} of regions) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start % PAGE || end % PAGE ||
          start < after || end <= start || end > this.#base || end > memory.length ||
          !Number.isInteger(prot) || (kind === 'load-text' ? prot !== RX || !text
            : !!text || (kind === 'load-data' ? prot < 0 || prot > (R | W) : kind !== 'stack' || prot !== (R | W)))) fail(E.INVAL);
      after = end;
      if (text && (text.prot !== prot || text.text.role === 'library' || text.text.address < start ||
          text.text.address + text.text.length > end)) fail(E.INVAL);
      let wrote = start;
      for (const part of [...writes].sort((a, b) => a.at - b.at)) {
        if (!Number.isInteger(part.at) || part.at < wrote || part.at + part.bytes.length > end) fail(E.INVAL);
        wrote = part.at + part.bytes.length;
      }
      // Binding can call a source reader. The published row classification
      // and exact extents are the already-validated values, not live inputs.
      records.push({start, end, prot, initial: kind, entry: text?.text.address});
      if (text) bindings.push({...text, text: {...text.text}});
    }
    for (const region of regions) for (const {at, bytes} of region.writes) memory.set(bytes, at);
    for (const text of bindings) {
      try { this.#code.bind(text); } finally { verify(); }
    }
    this.#regions = records;
  }

  /** The installed VM records are the only source of data permissions.
   * Copy calls can be short at a permission boundary, but never skip one. */
  userMemory(owner: Caller): MappedUserMemory {
    const identity = this.#pin(owner), buffer = this.memory.buffer;
    const check = (): void => {
      identity();
      if (this.#busy) throw new ReadLifetimeError();
    };
    const prefix = (address: number, length: number, access: DataAccess): number => {
      check();
      this.#copyLength(length);
      return this.#prefix(address, length, access);
    };
    const whole = (address: number, length: number, access: DataAccess): void => {
      if (prefix(address, length, access) !== length) fail(E.FAULT);
    };
    return Object.freeze({
      check, prefix,
      copyIn: (address: number, length: number) => {
        whole(address, length, 'read');
        return length ? new Uint8Array(buffer, address, length).slice() : new Uint8Array(0);
      },
      copyOut: (address: number, from: Uint8Array) => {
        whole(address, from.length, 'write');
        if (from.length) new Uint8Array(buffer, address, from.length).set(from);
      },
      cstring: (address: number) => {
        const length = prefix(address, PATH_LIMIT, 'read');
        if (!length) throw new FsError(E.FAULT);
        const bytes = new Uint8Array(buffer, address, length), n = bytes.indexOf(0);
        if (n < 0) throw new FsError(length === PATH_LIMIT ? E.NAMETOOLONG : E.FAULT);
        return utf8(bytes.subarray(0, n));
      },
    });
  }

  /** Whole-span data policy, used by checked CPU data access.
   * Takes the effective address before any narrowing. A zero-size data
   * operation accesses no memory; a retired or in-flight owner grants none. */
  permits(address: bigint, length: bigint, access: DataAccess): boolean {
    if (this.#closed || this.#busy || !this.#owner?.noNewPrivs || this.#owner.state !== 'live' || this.#owner.memory !== this.memory ||
        length < 0n || length > BigInt(LIMIT)) return false;
    if (!length) return true;
    if (address < 0n || address > BigInt(LIMIT)) return false;
    return this.#prefix(Number(address), Number(length), access) === Number(length);
  }

  /** A v4 checked string instruction. The VM preflights both complete
   * spans before touching memory; nothing calls out during the transfer.
   * Bits in mode: 1 for STOS (otherwise MOVS), 2 for backwards (DF). */
  #string(dest: bigint, source: bigint, count: bigint, value: bigint, width: number, mode: number): bigint {
    if ((width !== 1 && width !== 2 && width !== 4 && width !== 8) ||
        (mode !== 0 && mode !== 1 && mode !== 2 && mode !== 3)) throw new TypeError('Invalid mapped string operation');
    const store = !!(mode & 1), back = !!(mode & 2);
    const size = BigInt(width), extent = BigInt.asUintN(64, count) * size;
    if (extent > BigInt(MAPPED_STRING_LIMIT)) throw new MappedStringLimit();
    const n = Number(extent);
    if (!n) {
      if (!this.permits(0n, 0n, 'write')) throw new MappedDataFault(0n, 0, 'write');
      return 0n; // A zero count probes neither original pointer.
    }
    const low = back ? extent - size : 0n, d = BigInt.asUintN(64, dest) - low, s = BigInt.asUintN(64, source) - low;
    if (!store && !this.permits(s, extent, 'read')) throw new MappedDataFault(s, n, 'read');
    if (!this.permits(d, extent, 'write')) throw new MappedDataFault(d, n, 'write');
    const bytes = new Uint8Array(this.memory.buffer), at = Number(d);
    if (store) {
      const word = BigInt.asUintN(64, value);
      if (width === 1) bytes.fill(Number(word & 255n), at, at + n);
      else {
        // Write the little-endian element, then double the filled prefix.
        const first = new DataView(bytes.buffer, at, width);
        if (width === 2) first.setUint16(0, Number(word & 0xffffn), true);
        if (width === 4) first.setUint32(0, Number(word & 0xffff_ffffn), true);
        if (width === 8) first.setBigUint64(0, word, true);
        for (let done = width; done < n; done *= 2)
          bytes.copyWithin(at + done, at, at + Math.min(done, n - done));
      }
    } else {
      const from = Number(s);
      const feedsUnread = back ? at < from && at + n > from : from < at && at < from + n;
      if (!feedsUnread) bytes.copyWithin(at, from, from + n);
      else {
        // x86 takes one element at a time. Where a write changes unread
        // source, memmove of the full range is observably different.
        const step = back ? -width : width;
        for (let i = back ? n - width : 0; i >= 0 && i < n; i += step) {
          if (width === 1) bytes[at + i] = bytes[from + i];
          else bytes.copyWithin(at + i, from + i, from + i + width);
        }
      }
    }
    return extent;
  }

  mmap(owner: Caller, addr: bigint, len: bigint, prot: bigint, bits: bigint, fd: bigint, off: bigint): number {
    return this.#call(owner, (check) => {
      const p = permissions(prot), flags = word(bits, FLAGS);
      if ((flags & 3) !== PRIVATE || (flags & ~FLAGS) || (flags & FIXED && flags & NOREPLACE)) fail(E.OPNOTSUPP);
      const size = up(word(len, LIMIT)), hint = word(addr, LIMIT), offset = word(off);
      if (!size || offset % PAGE || !Number.isSafeInteger(offset + size)) fail(E.INVAL);
      const exact = flags & (FIXED | NOREPLACE), anonymous = flags & ANON;
      const start = exact ? this.#range(hint, size) : this.#hole(size, hint), end = start + size;
      if (flags & NOREPLACE && this.#regions.some(r => overlaps(r, start, end))) fail(E.EXIST);
      if (anonymous && (offset || p & X)) fail(p & X ? E.ACCES : E.INVAL);

      let mapping: ExecutableMapping | null = null, initial: Uint8Array | null = null, unchanged = check;
      if (!anonymous) {
        if (fd < 0n || fd > 0x7fffffffn) fail(E.BADF);
        const number = Number(fd), d = owner.fds.get(number);
        if (!d || d.kind !== 'file' || !(d.node instanceof File) || d.closed || d.flags & 0x200000 || (d.flags & 3) === 1 ||
            (d.flags & 3) === 3) throw new FsError(E.BADF);
        const {node, mnt, flags: oflags} = d, rev = node.version, mrev = mnt?.execRevision;
        const space = mnt?.space, parent = mnt?.parent, point = mnt?.point;
        const description = (): void => {
          check();
          if (owner.fds.get(number) !== d || d.closed || d.node !== node || d.mnt !== mnt || d.flags !== oflags) fail(E.BADF);
        };
        description();
        if (p & X) {
          const source = this.#sources.get(node);
          if (!source || !mnt || d.flags & 3 || !node.size || node.size > DYNAMIC_FILE_LIMIT || node.mode & 0o6000 || node.maps?.size)
            throw new FsError(E.ACCES);
          const captured = executableSourceFor(source, this.#vfs);
          const verify = (): void => {
            description();
            if (mnt.execRevision !== mrev || mnt.flags & MNT.NOEXEC) fail(E.PERM);
            if (mnt.space !== space || mnt.parent !== parent || mnt.point !== point || node.version !== rev ||
                !unchangedExecutableSource(captured) || node.mode & 0o6000 || node.maps?.size) fail(E.ACCES);
          };
          verify();
          let bytes: Uint8Array;
          try { bytes = node.share(); } finally { verify(); }
          const spec = this.#library(node, bytes, verify);
          const loads = spec.loads.filter(s => s.flags === 5 && s.fileSize && down(s.offset) === offset
            && up(s.vaddr + s.fileSize) - down(s.vaddr) === size);
          if (loads.length !== 1) throw new FsError(E.ACCES);
          const [load] = loads;
          const bias = start - down(load.vaddr);
          if (bias < 0 || bias % Math.max(PAGE, ...spec.loads.map(s => s.align))) fail(E.ACCES);
          const text = {role: 'library' as const, bias, address: bias + load.vaddr, offset: load.offset, length: load.fileSize};
          mapping = {file: node, mount: mnt, source, text, prot: p, private: true};
          initial = bytes.subarray(offset, offset + size);
          unchanged = verify;
        } else {
          // Settling a shared source can advance its version before data is
          // copied; normal private data mapping does not require an immutable
          // source. Still refuse a stale destination or replaced descriptor.
          try { initial = node.snapshotRange(offset, offset + size); }
          finally { description(); }
          unchanged = description;
        }
      }
      const regions = this.#cut(start, end);
      regions.push({start, end, prot: p, entry: mapping?.text.address});
      this.#change(regions, start, end, mapping, unchanged, () => {
        const bytes = new Uint8Array(this.memory.buffer, start, size);
        bytes.fill(0);
        if (initial) bytes.set(initial);
      }, true);
      return start;
    });
  }

  mprotect(owner: Caller, addr: bigint, len: bigint, prot: bigint): number {
    return this.#call(owner, check => {
      const size = up(word(len, LIMIT)), start = this.#range(word(addr, LIMIT), size, MIN), end = start + size;
      const initial = start < this.#base;
      if (initial && (!size || end > this.#base)) fail(E.INVAL);
      const p = permissions(prot);
      if (!size) return 0;
      const touched = this.#regions.filter(r => overlaps(r, start, end));
      let at = start;
      for (const r of touched) { if (r.start > at) fail(E.NOMEM); at = r.end; }
      if (at < end) fail(E.NOMEM);
      // glibc requests read-only RELRO through ordinary mprotect. The guest
      // reads its ELF headers; only this VM decides which installed pages
      // can change. Initial stack/text and re-granting permissions stay out.
      if (initial && ((p !== R && p !== 0) || touched.some(r => r.initial !== 'load-data' ||
          (p === R && !(r.prot & (R | W)))))) fail(E.ACCES);
      if (p & X) {
        const generation = this.#code.generation;
        if (!touched.every(r => r.prot === p && r.entry !== undefined && this.#code.find(BigInt(r.entry), generation))) fail(E.ACCES);
        return 0; // The first profile has no transition from data to executable code.
      }
      if (touched.every(r => r.prot === p)) return 0;
      const regions = this.#cut(start, end);
      regions.push({start, end, prot: p, initial: initial ? 'load-data' : undefined});
      this.#change(regions, start, end, null, check, () => {});
      return 0;
    });
  }

  munmap(owner: Caller, addr: bigint, len: bigint): number {
    return this.#call(owner, check => {
      const size = up(word(len, LIMIT)), start = this.#range(word(addr, LIMIT), size), end = start + size;
      if (!size) fail(E.INVAL);
      if (!this.#regions.some(r => overlaps(r, start, end))) return 0;
      this.#change(this.#cut(start, end), start, end, null, check, () => {
        new Uint8Array(this.memory.buffer).fill(0, start, Math.min(end, this.memory.buffer.byteLength));
      });
      return 0;
    });
  }

  #call<T>(owner: Caller, operation: (check: () => void) => T): T {
    const identity = this.#pin(owner);
    this.#busy = true;
    try { return operation(identity); }
    finally { this.#busy = false; }
  }

  #pin(owner: Caller): () => void {
    if (this.#closed || this.#busy || owner !== this.#owner || owner.state !== 'live' || owner.memory !== this.memory) throw new ReadLifetimeError();
    if (!owner.noNewPrivs) fail(E.PERM);
    const identity = owner.readIdentity();
    return () => {
      identity();
      if (this.#closed || this.#owner !== owner || !owner.noNewPrivs) throw new ReadLifetimeError();
    };
  }

  #copyLength(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAPPED_COPY_LIMIT) fail(E.INVAL);
  }

  #prefix(start: number, length: number, access: DataAccess): number {
    if (!length || !Number.isSafeInteger(start) || start < MIN || start >= LIMIT) return 0;
    // A writable AMD64 page can also be read.
    const flag = access === 'read' ? R | W : access === 'write' ? W : 0;
    if (!flag) return 0;
    // Clip without wrapping. A whole-span access still requires the
    // entire length; a kernel transfer may use a strictly shorter prefix.
    const end = Math.min(start + length, LIMIT, this.memory.buffer.byteLength);
    let at = start, lo = 0, hi = this.#regions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#regions[mid].end <= at) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; at < end && i < this.#regions.length; i++) {
      const pageRange = this.#regions[i];
      if (pageRange.start > at || !(pageRange.prot & flag)) break;
      at = Math.min(end, pageRange.end);
    }
    return at - start;
  }

  #library(node: File, bytes: Uint8Array, check: () => void): ElfLoadSpec {
    const cached = this.#specs.get(node);
    if (cached) return cached;
    let spec: ElfLoadSpec;
    try { spec = this.#reader.describeDynamic(bytes, 'library'); }
    catch (cause) { if (this.#reader.notProgram(cause)) throw new FsError(E.NOEXEC); throw cause; }
    finally { check(); }
    this.#specs.set(node, spec);
    return spec;
  }

  #range(start: number, length: number, floor = this.#base): number {
    if (start < floor || start % PAGE || start >= LIMIT || start + length > LIMIT) fail(E.INVAL);
    return start;
  }

  #hole(length: number, hint: number): number {
    if (hint >= this.#base && !(hint % PAGE) && hint + length <= LIMIT &&
        !this.#regions.some(r => overlaps(r, hint, hint + length))) return hint;
    let start = this.#base;
    for (const r of this.#regions) {
      if (r.end <= start) continue; // Bootstrap rows cannot lower the mmap floor.
      if (start + length <= r.start) return start;
      start = r.end;
    }
    if (start + length > LIMIT) fail(E.NOMEM);
    return start;
  }

  #cut(start: number, end: number): Region[] {
    const out: Region[] = [];
    for (const r of this.#regions) {
      if (!overlaps(r, start, end)) { out.push(r); continue; }
      // Losing any part retires the whole executable binding. Do not
      // silently describe a remaining fragment as an executable object.
      if (r.start < start) out.push({start: r.start, end: start, prot: r.prot & ~X, initial: r.initial});
      if (end < r.end) out.push({start: end, end: r.end, prot: r.prot & ~X, initial: r.initial});
    }
    return out;
  }

  #change(regions: Region[], start: number, end: number, mapping: ExecutableMapping | null, check: () => void,
      install: () => void, allocate = false): void {
    if (regions.length > MAX_REGIONS) fail(E.NOMEM);
    regions.sort((a, b) => a.start - b.start);
    let began = false;
    try {
      this.#code.replace(start, end - start, mapping, () => {
        began = true;
        retireMemoryView(this.memory);
        install();
      }, {ready: () => {
        check();
        if (!allocate || end <= this.memory.buffer.byteLength) return;
        try { this.memory.grow(up(end, WASM_PAGE) / WASM_PAGE - this.memory.buffer.byteLength / WASM_PAGE); }
        catch (cause) { if (cause instanceof RangeError) fail(E.NOMEM); throw cause; }
      }});
      this.#regions = regions;
    } catch (cause) {
      if (!began) throw cause;
      this.close();
      throw new MappedVmCommitError(cause); // No errno/pretend rollback after touching memory.
    }
  }
}
