// Linux's bounded inline mapped-memory profile. One fresh memory, no sharing
// or reuse by the static runtime. Records and executable authority are
// changed together. The same installed records authorize checked user
// copies and translated data accesses. It is not an exec entry.
import type {ElfLoadSpec} from '../translation/dynamic-load.ts';
import type {Translate} from '../translation/translator.ts';
import type {Description} from './fd.ts';
import {unchangedExecutableSource} from './executable-source.ts';
import {MappedCodeSpace, type ExecutableMapping, type MappedCodeView} from './exec/mapped-code-space.ts';
import type {PreparedMappedLookup} from './exec/prepared-mapped-code.ts';
import {E, File, FsError, Memfd, MNT, type FileReadMapping, type Mapping, type Vfs} from './fs.ts';
import {utf8} from './flow.ts';
import {checkMappedLibrary, mappedLibrariesFor, type MappedLibraries, type MappedLibraryView} from './mapped-libraries.ts';
import {ReadLifetimeError, retireMemoryView} from './read-lifetime.ts';

export const MAPPED_VM_LIMIT = 256 << 20;
const PAGE = 4096, WASM_PAGE = 65536, LIMIT = MAPPED_VM_LIMIT, MAX_REGIONS = 4096;
const MIN = 65536, R = 1, W = 2, X = 4, RX = R | X;
export const MAPPED_COPY_LIMIT = 1 << 20;
export const MAPPED_STRING_LIMIT = 1 << 20;
const PATH_LIMIT = 4096;
const SHARED = 1, PRIVATE = 2, FIXED = 0x10, ANON = 0x20, NOREPLACE = 0x100000;
// DENYWRITE, EXECUTABLE, NORESERVE and MAP_STACK leave the arena's
// capacity and page protections to the VM.
const FLAGS = SHARED | PRIVATE | FIXED | ANON | NOREPLACE | 0x800 | 0x1000 | 0x4000 | 0x20000;
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

/** Unrepresentable pointers cannot become aliases in this inline VM.
 * Registration itself does not test whether the address is mapped. */
export function mappedTidAddress(address: bigint): number {
  return address >= BigInt(MIN) && address + 4n <= BigInt(LIMIT) ? Number(address) : 0;
}

type Reader = Required<Pick<Translate, 'describeDynamic' | 'notProgram'>>;
interface Region {
  start: number;
  end: number;
  prot: number;
  entry?: number;
  initial?: InitialMappedRegion['kind'];
  shared?: SharedFileRange;
  deferred?: {file: File; bytes: Uint8Array};
}
interface RegionRange { start: number; end: number; first: number; after: number }
interface SharedFileRange {
  file: File;
  offset: number;
  fileEnd: number;
  mayWrite: boolean;
  observer?: FileReadMapping;
  writer?: SharedWriter;
}
type SharedWriter = Mapping & {file: File; pages: Set<number>};

function filePageEnd(start: number, end: number, offset: number, size: number): number {
  return Math.max(start, Math.min(end, start + up(size) - offset));
}

function sharedFileRange(file: File, offset: number, start: number, end: number, mayWrite: boolean): SharedFileRange {
  return {file, offset, fileEnd: filePageEnd(start, end, offset, file.size), mayWrite};
}

/** A surviving subrange keeps its file offset. Splitting an RX mapping
 * retires its code grant; only a fresh executable mmap can create one. */
function sliceRegion(row: Region, start: number, end: number, prot = row.prot & ~X): Region {
  const source = row.shared, deferred = row.deferred, from = start - row.start;
  return {start, end, prot, initial: row.initial,
    shared: source && sharedFileRange(source.file, source.offset + from, start, end, source.mayWrite),
    deferred: deferred && from < deferred.bytes.length
      ? {file: deferred.file, bytes: deferred.bytes.subarray(from, end - row.start)} : undefined};
}

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
  vfs: Vfs; base: number; pages: number; libraries?: MappedLibraries; reader: Reader; prepared?: PreparedMappedLookup;
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

/** Internal build/claim authority, never part of the detached inspection. */
export interface StagedMappedMemory {
  readonly memory: MappedMemory;
  readonly pages: DetachedMappedMemory;
  checkEntry(pc: bigint, main: bigint, sp: number): void;
  claim(owner: Caller, pc: bigint, main: bigint, sp: number): (checkSources: () => void) => void;
}

export type DataAccess = 'read' | 'write';
export type MappedRunView = MappedCodeView & {
  readonly memory: WebAssembly.Memory;
  readonly accessPages: WebAssembly.Memory;
  permits(address: bigint, length: bigint, access: DataAccess): boolean;
  beginRead(address: bigint, length: bigint): boolean;
  beginWrite(address: bigint, length: bigint): boolean;
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
  copyInTo(address: number, into: Uint8Array, start: number, length: number): void;
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
  #accessPages = new WebAssembly.Memory({initial: 1, maximum: 1});
  #pageRights = new Uint8Array(this.#accessPages.buffer);
  // Cold pages carry an initializer, with their Wasm data rights withheld.
  #cold?: Uint8Array;
  #code: MappedCodeSpace;
  #regions: Region[] = [];
  #sharedWriters = 0;
  #pendingWriters = new Set<SharedWriter>();
  #sharedBytes?: Uint8Array;
  #libraries?: MappedLibraryView;
  #specs = new WeakMap<File, ElfLoadSpec>();
  #busy = false;
  #closed = false;
  #owner?: Caller;
  /** The dispatcher observes this owner's code and data authority. */
  readonly code: MappedRunView;

  /** Internal allocation for a distinct, unclaimed backing. If there is an
   * initial layout, validate and initialize it before returning that backing.
   * No kernel/guest API opts into mapped memory as a side effect of mmap. */
  static allocate({vfs, base, pages, libraries, reader, prepared}: MemorySpec, initial?: InitialLayout): MappedMemory {
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > LIMIT / WASM_PAGE ||
        !Number.isSafeInteger(base) || base < MIN || base >= LIMIT || base % PAGE)
      throw new RangeError('Invalid mapped memory layout');
    initial?.verify();
    const libraryView = libraries === undefined ? undefined : mappedLibrariesFor(libraries, vfs);
    libraryView?.check();
    const memory = new WebAssembly.Memory({initial: pages, maximum: LIMIT / WASM_PAGE});
    const vm = new MappedVm(vfs, memory, base, libraryView, reader, prepared);
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
    return MappedVm.stage(spec, regions, verify).pages;
  }

  static stage(spec: MemorySpec, regions: readonly InitialMappedRegion[], verify: () => void): StagedMappedMemory {
    let held: {memory: MappedMemory; verify(): void} | null = {memory: MappedVm.allocate(spec, {regions, verify}), verify};
    const discard = (): void => {
      const retired = held; held = null;
      if (retired) { retired.memory.mappedVm.close(); retired.memory.users = 0; }
    };
    const current = (): MappedMemory => {
      const candidate = held;
      if (candidate) {
        try { candidate.verify(); } catch (error) { discard(); throw error; }
        if (held === candidate) return candidate.memory;
      }
      throw new Error('Detached mapped memory was discarded or claimed');
    };
    const permits = (address: number, length: number, access: DataAccess): boolean => {
      const vm = current().mappedVm;
      vm.#copyLength(length);
      return vm.#prefix(address, length, access) === length;
    };
    const pages: DetachedMappedMemory = Object.freeze({
      permits,
      read(address: number, length: number) {
        const vm = current().mappedVm;
        vm.#copyLength(length);
        if (vm.#prefix(address, length, 'read') !== length) fail(E.FAULT);
        return length ? new Uint8Array(vm.memory.buffer, address, length).slice() : new Uint8Array(0);
      },
      hasText(address: bigint) {
        const code = current().mappedVm.#code;
        return !!code.find(address, code.generation);
      },
      check: () => { current(); },
      discard,
    });
    const starting = (pc: bigint, main: bigint, sp: number) => {
      const vm = current().mappedVm;
      if (vm.#closed || vm.#owner) fail(E.NOEXEC);
      const generation = vm.#checkInitialEntry(pc, main, sp);
      try { vm.#libraries?.check(); }
      catch (error) { discard(); throw error; }
      return {vm, generation};
    };
    return Object.freeze({
      get memory() { return current(); },
      pages,
      checkEntry(pc: bigint, main: bigint, sp: number) { starting(pc, main, sp); },
      claim(owner: Caller, pc: bigint, main: bigint, sp: number) {
        const {vm, generation} = starting(pc, main, sp);
        if (vm.#code.generation !== generation) fail(E.ACCES);
        vm.claim(owner);
        held = null; // Inspection cannot read or close the claimed address space.
        // Only the installed owner can recheck this original entry. This
        // does not carry the detached caller scope or grant execution.
        return (checkSources: () => void) => {
          const current = vm.#pin(owner);
          vm.#checkInitialEntry(pc, main, sp, generation);
          vm.#libraries?.check();
          checkSources();
          if (vm.#code.generation !== generation) fail(E.ACCES);
          current();
        };
      },
    });
  }

  private constructor(vfs: Vfs, memory: WebAssembly.Memory, base: number, libraries: MappedLibraryView | undefined,
      reader: Reader, prepared?: PreparedMappedLookup) {
    this.#vfs = vfs;
    this.#base = base;
    this.#reader = reader;
    this.memory = memory;
    this.#libraries = libraries;
    const code = this.#code = new MappedCodeSpace(vfs, memory, prepared);
    this.code = Object.freeze({
      memory, accessPages: this.#accessPages, get generation() { return code.generation; },
      find: code.find.bind(code), permits: this.permits.bind(this), beginRead: this.#beginRead.bind(this),
      beginWrite: this.#beginWrite.bind(this), string: this.#string.bind(this),
    });
  }

  claim(owner: Caller): void {
    if (owner.kernel.vfs !== this.#vfs) throw new TypeError('Mapped memory belongs to another Vfs');
    if (this.#closed || (this.#owner && this.#owner !== owner)) throw new Error('Mapped memory already has an owner or was retired');
    if (!owner.noNewPrivs) fail(E.PERM);
    this.#owner = owner;
  }

  checkTaskOwner(owner: Caller): void { this.#pin(owner)(); }

  keepSources(files: Set<File>): void {
    this.#code.keepSources(files);
    for (const row of this.#regions) if (row.deferred) files.add(row.deferred.file);
  }

  #checkInitialEntry(pc: bigint, main: bigint, sp: number, expected?: object): object {
    const code = this.#code, generation = code.generation;
    if (expected !== undefined && generation !== expected) fail(E.ACCES);
    if (code.find(pc, generation)?.text.role !== 'interpreter' || code.find(main, generation)?.text.role !== 'main' ||
        !Number.isSafeInteger(sp) || sp % 16 ||
        !this.#regions.some(r => r.initial === 'stack' && r.start <= sp - 128 && sp + 8 <= r.end) ||
        this.#prefix(sp - 128, 136, 'write') !== 136) fail(E.NOEXEC);
    return generation;
  }

  /** Check the single clear-tid word before sealing this address space.
   * The resulting one-use action is not a guest copy lease. It can only
   * clear that word on the original backing after ordinary access ends. */
  prepareTidClear(owner: Caller, address: number): (() => void) | undefined {
    if (!address) return undefined;
    this.checkTaskOwner(owner);
    if (this.#prefix(address, 4, 'write') !== 4) return undefined;
    this.#materialize(address, 4);
    const memory = this.memory, buffer = memory.buffer, identity = owner.readIdentity();
    let pending = true;
    return () => {
      if (!pending) throw new ReadLifetimeError();
      pending = false;
      identity();
      if (!this.#closed || this.#owner || owner.state !== 'live' || owner.memory !== memory ||
          memory.buffer !== buffer || !owner.noNewPrivs)
        throw new ReadLifetimeError();
      new DataView(buffer, address, 4).setUint32(0, 0, true);
    };
  }

  /** Only already-installed library text and an arena stack may start the
   * internal inline Task backend. Initial exec images remain detached. */
  taskEntry(owner: Caller, pc: bigint, sp: bigint): () => void {
    const identity = this.#pin(owner), generation = this.#code.generation;
    const check = (): void => {
      identity();
      if (this.#busy || this.#regions.some(r => r.initial !== undefined)) fail(E.OPNOTSUPP);
      if (this.#code.find(pc, generation)?.text.role !== 'library') fail(E.ACCES);
      if (sp % 16n || !this.permits(sp - 128n, 128n, 'write')) fail(E.FAULT);
    };
    check();
    return check;
  }

  close(): void {
    this.#closed = true;
    this.#owner = undefined;
    this.#code.close();
    this.#pageRights.fill(0);
    this.#cold = undefined;
    for (const row of this.#regions) this.#unobserve(row);
    this.#regions = [];
    this.#sharedBytes = undefined;
    this.#libraries = undefined;
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
    this.#publishRights(records, MIN, this.#base);
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
      this.#materialize(address, length);
    };
    return Object.freeze({
      check, prefix,
      copyIn: (address: number, length: number) => {
        whole(address, length, 'read');
        return length ? new Uint8Array(buffer, address, length).slice() : new Uint8Array(0);
      },
      copyInTo: (address: number, into: Uint8Array, start: number, length: number) => {
        whole(address, length, 'read');
        if (length) into.set(new Uint8Array(buffer, address, length), start);
      },
      copyOut: (address: number, from: Uint8Array) => {
        whole(address, from.length, 'write');
        if (from.length) {
          this.#trackWrite(address, from.length);
          new Uint8Array(buffer, address, from.length).set(from);
        }
      },
      cstring: (address: number) => {
        const length = prefix(address, PATH_LIMIT, 'read');
        if (!length) throw new FsError(E.FAULT);
        this.#materialize(address, length);
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

  #beginRead(address: bigint, length: bigint): boolean {
    if (!this.permits(address, length, 'read')) return false;
    this.#materialize(Number(address), Number(length));
    return true;
  }

  #beginWrite(address: bigint, length: bigint): boolean {
    if (!this.permits(address, length, 'write')) return false;
    if (length) {
      const start = Number(address), size = Number(length);
      this.#materialize(start, size);
      this.#trackWrite(start, size);
    }
    return true;
  }

  /** A clean shared page sends its first write through the checked import.
   * Once tracked, subsequent scalar writes use the ordinary Wasm path. */
  #trackWrite(start: number, length: number): void {
    if (!this.#sharedWriters) return;
    const end = start + length;
    for (let index = this.#firstRegionAfter(start); index < this.#regions.length; index++) {
      const row = this.#regions[index];
      if (row.start >= end) break;
      const writer = row.shared?.writer;
      if (!writer) continue;
      this.#pendingWriters.add(writer);
      for (let at = Math.max(row.start, down(start)); at < Math.min(end, row.end); at += PAGE) {
        writer.pages.add(writer.off + at - row.start);
        this.#pageRights[at / PAGE] |= W;
      }
    }
  }

  flushShared(): void {
    for (const writer of this.#pendingWriters) writer.file.settle(writer.off, writer.off + writer.length, writer);
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
    if (!this.#beginWrite(d, extent)) throw new MappedDataFault(d, n, 'write');
    if (!store) this.#materialize(Number(s), n);
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
      const kind = flags & (SHARED | PRIVATE), shared = kind === SHARED, anonymous = flags & ANON;
      if ((!shared && kind !== PRIVATE) || (flags & ~FLAGS) || (flags & FIXED && flags & NOREPLACE) ||
          (shared && (anonymous || p & X))) fail(E.OPNOTSUPP);
      const size = up(word(len, LIMIT)), hint = word(addr, LIMIT), offset = word(off);
      if (!size || offset % PAGE || !Number.isSafeInteger(offset + size)) fail(E.INVAL);
      const exact = flags & (FIXED | NOREPLACE);
      const start = exact ? this.#range(hint, size) : this.#hole(size, hint), end = start + size;
      const range = this.#overlapping(start, end);
      if (flags & NOREPLACE && range.first !== range.after) fail(E.EXIST);
      if (anonymous && (offset || p & X)) fail(p & X ? E.ACCES : E.INVAL);

      let mapping: ExecutableMapping | null = null, initial: Uint8Array | undefined, unchanged = check;
      let privateSource: File | undefined;
      let sharedFile: SharedFileRange | undefined;
      if (!anonymous) {
        if (fd < 0n || fd > 0x7fffffffn) fail(E.BADF);
        const number = Number(fd), d = owner.fds.get(number);
        if (!d || d.kind !== 'file' || !(d.node instanceof File) || d.closed || d.flags & 0x200000 || (d.flags & 3) === 1 ||
            (d.flags & 3) === 3) throw new FsError(E.BADF);
        const {node, mnt, flags: oflags} = d, rev = node.version, mrev = mnt?.execRevision;
        const mayWrite = node instanceof Memfd && (oflags & 3) === 2;
        if (shared && p & W && !mayWrite) fail(node instanceof Memfd ? E.ACCES : E.OPNOTSUPP);
        const space = mnt?.space, parent = mnt?.parent, point = mnt?.point;
        const description = (): void => {
          check();
          if (owner.fds.get(number) !== d || d.closed || d.node !== node || d.mnt !== mnt || d.flags !== oflags) fail(E.BADF);
        };
        description();
        if (p & X) {
          const member = this.#libraries?.member(node);
          if (!member || !mnt || d.flags & 3) throw new FsError(E.ACCES);
          const verify = (): void => {
            description();
            if (mnt.space !== space || mnt.parent !== parent || mnt.point !== point) fail(E.ACCES);
            if (mnt.execRevision !== mrev || mnt.flags & MNT.NOEXEC) fail(E.PERM);
            if (node.version !== rev) fail(E.ACCES);
            checkMappedLibrary(member);
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
          mapping = {file: node, mount: mnt, source: member.grant, text, prot: p, private: true};
          unchanged = verify;
        } else {
          // Settle writes before borrowing source bytes. The shared path
          // consumes the view in this turn and receives later publications.
          try { initial = shared ? node.read(offset, offset + size) : this.#privateFileRange(node, offset, offset + size); }
          finally { description(); }
          if (shared) sharedFile = sharedFileRange(node, offset, start, end, mayWrite);
          unchanged = description;
        }
        if (!shared && !(p & W)) privateSource = node;
      }
      const row: Region = {start, end, prot: p, entry: mapping?.text.address, shared: sharedFile};
      this.#change(range, [row], mapping, unchanged, text => {
        const bytes = text ?? initial, length = bytes?.length ?? 0, file = privateSource;
        const deferred = bytes?.length && file && File.ownsLoadedBacking(file, bytes) && this.#fixedBacking(bytes)
          ? {file, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, length)} : undefined;
        if (!deferred && bytes?.length) new Uint8Array(this.memory.buffer, start, bytes.length).set(bytes);
        if (flags & FIXED) this.#clearMapped(deferred ? start : start + length, end);
        this.#cold?.fill(0, start / PAGE, end / PAGE);
        if (deferred) {
          row.deferred = deferred;
          this.#cold ??= new Uint8Array(LIMIT / PAGE);
          this.#cold.fill(1, start / PAGE, up(start + length) / PAGE);
        }
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
      const range = this.#overlapping(start, end), touched = this.#regions.slice(range.first, range.after);
      let at = start;
      for (const r of touched) { if (r.start > at) fail(E.NOMEM); at = r.end; }
      if (at < end) fail(E.NOMEM);
      // glibc requests read-only RELRO through ordinary mprotect. The guest
      // reads its ELF headers; only this VM decides which installed pages
      // can change. Initial stack/text and re-granting permissions stay out.
      if (initial && ((p !== R && p !== 0) || touched.some(r => r.initial !== 'load-data' ||
          (p === R && !(r.prot & (R | W)))))) fail(E.ACCES);
      if (touched.some(r => r.shared && (p & X || p & W && !r.shared.mayWrite))) fail(E.ACCES);
      if (p & X) {
        const generation = this.#code.generation;
        if (!touched.every(r => r.prot === p && r.entry !== undefined && this.#code.find(BigInt(r.entry), generation))) fail(E.ACCES);
        return 0; // The first profile has no transition from data to executable code.
      }
      if (touched.every(r => r.prot === p)) return 0;
      const replacement = touched.some(r => r.shared || r.deferred)
        ? touched.map(r => sliceRegion(r, Math.max(r.start, start), Math.min(r.end, end), p))
        : [{start, end, prot: p, initial: initial ? 'load-data' as const : undefined}];
      this.#change(range, replacement, null, check, () => {});
      return 0;
    });
  }

  munmap(owner: Caller, addr: bigint, len: bigint): number {
    return this.#call(owner, check => {
      const size = up(word(len, LIMIT)), start = this.#range(word(addr, LIMIT), size), end = start + size;
      if (!size) fail(E.INVAL);
      const range = this.#overlapping(start, end);
      if (range.first === range.after) return 0;
      this.#change(range, [], null, check, () => {
        this.#clearMapped(start, end);
        this.#cold?.fill(0, start / PAGE, end / PAGE);
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

  #firstRegionAfter(address: number): number {
    let lo = 0, hi = this.#regions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#regions[mid].end <= address) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Holes and cold pages are zero. Clear only initialized parts of old
   * mappings so replacing a cold range never commits its backing. */
  #clearMapped(start: number, end: number): void {
    if (start >= end) return;
    const bytes = new Uint8Array(this.memory.buffer);
    for (let i = this.#firstRegionAfter(start); i < this.#regions.length; i++) {
      const row = this.#regions[i];
      if (row.start >= end) break;
      const lo = Math.max(start, row.start), hi = Math.min(end, row.end);
      let from = lo;
      if (row.deferred) for (let at = down(lo); at < hi; at += PAGE) {
        if (!this.#cold![at / PAGE]) continue;
        if (from < at) bytes.fill(0, from, at);
        from = at + PAGE;
      }
      if (from < hi) bytes.fill(0, from, hi);
    }
  }

  /** Publish fast-path rights only after the bytes for a page are in RAM.
   * The caller has already checked the entire span. No file hooks run here. */
  #materialize(start: number, length: number): void {
    const cold = this.#cold;
    if (!cold || !length) return;
    const end = up(start + length) / PAGE;
    let memory: Uint8Array | undefined, row: Region | undefined;
    for (let page = down(start) / PAGE; page < end; page++) {
      if (!cold[page]) continue;
      const at = page * PAGE;
      if (!row || at >= row.end) row = this.#regions[this.#firstRegionAfter(at)];
      const offset = at - row.start;
      (memory ??= new Uint8Array(this.memory.buffer)).set(row.deferred!.bytes.subarray(offset, offset + PAGE), at);
      cold[page] = 0;
      this.#pageRights[page] = this.#dataRights(row);
    }
  }

  #prefix(start: number, length: number, access: DataAccess): number {
    if (!length || !Number.isSafeInteger(start) || start < MIN || start >= LIMIT) return 0;
    // A writable AMD64 page can also be read.
    const flag = access === 'read' ? R | W : access === 'write' ? W : 0;
    if (!flag) return 0;
    // Clip without wrapping. A whole-span access still requires the
    // entire length; a kernel transfer may use a strictly shorter prefix.
    const end = Math.min(start + length, LIMIT, this.memory.buffer.byteLength);
    let at = start;
    for (let i = this.#firstRegionAfter(start); at < end && i < this.#regions.length; i++) {
      const pageRange = this.#regions[i];
      if (pageRange.start > at || !(pageRange.prot & flag)) break;
      const available = pageRange.shared?.fileEnd ?? pageRange.end;
      if (at >= available) break;
      at = Math.min(end, available);
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

  #privateFileRange(node: File, start: number, end: number): Uint8Array {
    const member = this.#libraries?.member(node);
    if (!member || node.maps || Object.getPrototypeOf(node) !== File.prototype || !unchangedExecutableSource(member.captured))
      return node.snapshotRange(start, end);
    // A captured library already supplies copy-on-write bytes to the code
    // owner. Data mappings can use the same snapshot through VM publication.
    const bytes = node.share().subarray(start, end);
    // An embedding can supply an alias of VM memory. Growth can detach it.
    return this.#fixedBacking(bytes) ? bytes : new Uint8Array(bytes);
  }

  #fixedBacking({buffer}: Uint8Array): boolean {
    return buffer instanceof ArrayBuffer && !buffer.resizable && buffer !== this.memory.buffer;
  }

  #range(start: number, length: number, floor = this.#base): number {
    if (start < floor || start % PAGE || start >= LIMIT || start + length > LIMIT) fail(E.INVAL);
    return start;
  }

  #hole(length: number, hint: number): number {
    if (hint >= this.#base && !(hint % PAGE) && hint + length <= LIMIT) {
      const next = this.#regions[this.#firstRegionAfter(hint)];
      if (!next || next.start >= hint + length) return hint;
    }
    let start = this.#base;
    for (const r of this.#regions) {
      if (r.end <= start) continue; // Bootstrap rows cannot lower the mmap floor.
      if (start + length <= r.start) return start;
      start = r.end;
    }
    if (start + length > LIMIT) fail(E.NOMEM);
    return start;
  }

  #overlapping(start: number, end: number): RegionRange {
    const first = this.#firstRegionAfter(start);
    let after = first;
    while (after < this.#regions.length && this.#regions[after].start < end) after++;
    return {start, end, first, after};
  }

  #observe(row: Region): void {
    const shared = row.shared;
    if (!shared) return;
    const {start, end, prot} = row, {file, offset} = shared;
    const length = end - start;
    const resized = (size: number): void => {
      const before = shared.fileEnd, now = filePageEnd(start, end, offset, size);
      if (now < before) this.#pageRights.fill(0, now / PAGE, before / PAGE);
      if (now > before) this.#pageRights.fill(this.#dataRights(row), before / PAGE, now / PAGE);
      shared.fileEnd = now;
    };
    if (prot & W) {
      const pages = new Set<number>(), vm = this;
      const writer: SharedWriter = {file, pages, start, length, off: offset, resized,
        proc: {get bytes() { return vm.#bytesForSharedWriter(); }},
        pending: {pages, settled: page => {
          pages.delete(page);
          this.#pageRights[(start + page - offset) / PAGE] &= ~W;
          if (!pages.size) this.#pendingWriters.delete(writer);
        }},
      };
      file.map(writer);
      shared.writer = writer;
      this.#sharedWriters++;
      file.refreshSharedAliases();
      return;
    }
    const observer: FileReadMapping = {offset, length, publish: (lo, hi, data, size) => {
      // Memory.grow replaces the buffer. Each publication resolves the
      // same live address range in its current backing.
      const into = new Uint8Array(this.memory.buffer, start + lo - offset, hi - lo);
      into.set(data);
      if (data.length < into.length) into.fill(0, data.length);
      resized(size);
    }};
    shared.observer = observer;
    file.mapReadOnly(observer);
  }

  #bytesForSharedWriter(): Uint8Array {
    const buffer = this.memory.buffer, bytes = this.#sharedBytes;
    if (bytes?.buffer === buffer) return bytes;
    return this.#sharedBytes = new Uint8Array(buffer);
  }

  #unobserve(row: Region, settle = false): void {
    const shared = row.shared;
    if (!shared) return;
    if (shared.observer) {
      shared.file.unmapReadOnly(shared.observer);
      shared.observer = undefined;
    }
    if (shared.writer) {
      const writer = shared.writer;
      if (settle) writer.file.unmap(writer);
      else writer.file.abandon(writer);
      shared.writer = undefined;
      this.#pendingWriters.delete(writer);
      this.#sharedWriters--;
      writer.file.refreshSharedAliases();
    }
  }

  #dataRights(row: Region): number {
    return row.shared && (row.prot & W) ? R : row.prot & (R | W);
  }

  /** One byte of data rights per guest page. Translated scalar/SIMD
   * accesses read this separate memory. Mapping and EOF changes write it. */
  #publishRights(regions: Region[], start: number, end: number): void {
    this.#pageRights.fill(0, start / PAGE, end / PAGE);
    for (const row of regions) {
      if (row.start >= end) break;
      if (row.end <= start) continue;
      const available = row.shared?.fileEnd ?? row.end;
      const rights = this.#dataRights(row), lo = Math.max(start, row.start) / PAGE, hi = Math.min(end, available) / PAGE;
      if (!rights) continue;
      if (row.deferred) {
        for (let page = lo; page < hi; page++) if (!this.#cold![page]) this.#pageRights[page] = rights;
      } else this.#pageRights.fill(rights, lo, hi);
    }
  }

  #ensureCapacity(end: number): void {
    const current = this.memory.buffer.byteLength / WASM_PAGE, required = Math.ceil(end / WASM_PAGE);
    if (required <= current) return;
    // A growth updates every Wasm fragment that imports this memory.
    // Reserve capacity in batches. Only installed regions publish rights.
    const preferred = Math.min(LIMIT / WASM_PAGE, Math.max(required, current + Math.ceil(current / 2)));
    try {
      try { this.memory.grow(preferred - current); }
      catch (cause) {
        if (!(cause instanceof RangeError) || preferred === required) throw cause;
        this.memory.grow(required - current);
      }
    } catch (cause) {
      if (cause instanceof RangeError) fail(E.NOMEM);
      throw cause;
    }
  }

  #change({start, end, first, after}: RegionRange, inserted: Region[], mapping: ExecutableMapping | null, check: () => void,
      install: (text: Uint8Array | undefined) => void, allocate = false): void {
    const regions: Region[] = [];
    if (first < after && this.#regions[first].start < start) {
      const left = this.#regions[first];
      regions.push(sliceRegion(left, left.start, start));
    }
    regions.push(...inserted);
    if (first < after && this.#regions[after - 1].end > end) {
      const right = this.#regions[after - 1];
      regions.push(sliceRegion(right, end, right.end));
    }
    if (this.#regions.length - (after - first) + regions.length > MAX_REGIONS) fail(E.NOMEM);
    let began = false;
    try {
      this.#code.replace(start, end - start, mapping, text => {
        began = true;
        retireMemoryView(this.memory);
        for (let i = first; i < after; i++) this.#unobserve(this.#regions[i], true);
        install(text);
      }, {ready: () => {
        check();
        if (allocate) this.#ensureCapacity(end);
      }});
      this.#regions.splice(first, after - first, ...regions);
      for (const row of regions) this.#observe(row);
      this.#publishRights(regions, start, end);
    } catch (cause) {
      if (!began) throw cause;
      this.close();
      throw new MappedVmCommitError(cause); // No errno/pretend rollback after touching memory.
    }
  }
}
