// Code view of one address space. Its VM owner authorizes and installs
// private RX mappings. This is not itself a Linux permission API.
import {DYNAMIC_FILE_LIMIT, DYNAMIC_ROLES} from '../../translation/dynamic-load.ts';
import type {MappedText, MappedTranslate} from '../../translation/mapped.ts';
import {withMappedOutput} from '../../translation/translator.ts';
import {isShared} from '../../host.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from '../executable-source.ts';
import {E, FsError, MNT, sameBytes, type File, type Mount, type Vfs} from '../fs.ts';
import type {PreparedMappedLookup, PreparedMappedPiece, PreparedMappedTrace} from './prepared-mapped-code.ts';

const LIMIT = 2 ** 32, MAX_RANGES = 256, MAX_SOURCE_BYTES = 256 << 20, PROT_RX = 5;

export interface ExecutableMapping {
  readonly file: File;
  readonly mount: Mount;
  readonly source: ExecutableSource;
  readonly text: MappedText;
  readonly prot: number;
  readonly private: boolean;
}

export interface BoundText {
  readonly text: MappedText;
  readonly prepared?: PreparedMappedPiece;
  readonly preparedTrace?: {trace: PreparedMappedTrace; origin: string; placementMismatch: boolean};
  compile<T>(generation: object, compiler: MappedTranslate, address: bigint, known: Set<bigint>,
    consume: (code: Uint8Array<ArrayBuffer>) => T): T;
}

interface ActiveText {
  readonly bound: BoundText;
  readonly file: File;
  readonly mount: Mount;
  readonly size: number;
  readonly end: number;
  installed: boolean;
}

interface ObservedSource {
  readonly rows: Set<ActiveText>;
  stop(): void;
}

export type MappedCodeView = Pick<MappedCodeSpace, 'generation' | 'find'>;

export class MappedCodeChanged extends Error {
  constructor() { super('Mapped executable code no longer belongs to the running generation'); this.name = 'MappedCodeChanged'; }
}

/** One memory owner, a bounded set of verified text extents and an opaque
 * publication generation. No instruction can name a table slot directly.
 * A revoked source never comes back merely because a mount flag was reset. */
export class MappedCodeSpace {
  declare readonly memory: WebAssembly.Memory;
  #vfs: Vfs;
  #epoch: object = {};
  #text: ActiveText[] = [];
  #observed = new Map<File | Mount, ObservedSource>();
  #prepared?: PreparedMappedLookup;

  constructor(vfs: Vfs, memory: WebAssembly.Memory, prepared?: PreparedMappedLookup) {
    if (isShared(memory.buffer)) throw new Error('Mapped code requires single-owner inline memory');
    this.#vfs = vfs;
    this.memory = memory;
    this.#prepared = prepared;
  }

  get generation(): object { return this.#epoch; }

  keepSources(files: Set<File>): void {
    for (const row of this.#text) files.add(row.file);
  }

  find(address: bigint, generation: object): BoundText | undefined {
    if (generation !== this.#epoch) throw new MappedCodeChanged();
    // All executable extents fit in 32 bits, where conversion is exact.
    const pc = Number(address), row = this.#text[this.#firstEndingAfter(pc)];
    return row && row.bound.text.address <= pc ? row.bound : undefined;
  }

  /** Bind the exact file-backed bytes already installed by the VM owner.
   * Code is compiled from the captured inode snapshot, not mutable guest RAM. */
  bind(mapping: ExecutableMapping): void {
    this.#publish(mapping.text.address, mapping.text.length, mapping);
  }

  /** Retire overlapping code, then give the VM the exact RX initializer for
   * this range. Publish the binding once the VM has installed its backing. */
  replace(address: number, length: number, mapping: ExecutableMapping | null,
      install: (pages: Uint8Array | undefined) => void,
      {ready}: {ready?: () => void} = {}): void {
    this.#publish(address, length, mapping, install, ready);
  }

  #publish(address: number, length: number, mapping: ExecutableMapping | null,
      install?: (pages: Uint8Array | undefined) => void, ready?: () => void): void {
    this.#extent(address, length);
    const generation = this.#epoch, first = this.#firstEndingAfter(address);
    const end = address + length;
    const after = install ? this.#afterOverlap(first, end) : first;
    if (mapping && (mapping.text.address < address || mapping.text.address + mapping.text.length > end))
      throw new FsError(E.INVAL);
    const staged = mapping && this.#stage(mapping, first, after, generation);
    let pages: Uint8Array | undefined;
    if (staged && install) {
      const text = staged.active.bound.text;
      const offset = text.offset - (text.address - address);
      if (offset < 0) throw new FsError(E.INVAL);
      pages = staged.bytes.subarray(offset, offset + length);
    }
    ready?.(); // Grow if needed, without overwriting any already mapped bytes.
    if (generation !== this.#epoch) throw new MappedCodeChanged();
    staged?.checkSource();
    if (staged && end > this.memory.buffer.byteLength) throw new FsError(E.INVAL);
    if (staged && staged.bytes.length !== staged.active.size) throw new FsError(E.ACCES);
    this.#remove(first, after);
    const installing = this.#epoch;
    install?.(pages);
    if (installing !== this.#epoch) throw new MappedCodeChanged();
    if (!staged) return;
    staged.checkSource();
    const row = staged.active;
    if (!install) {
      const installed = new Uint8Array(this.memory.buffer, address, length), offset = row.bound.text.offset;
      if (!sameBytes(installed, staged.bytes.subarray(offset, offset + length))) throw new FsError(E.ACCES);
    }
    this.#watch(row.file, row);
    try { this.#watch(row.mount, row); }
    catch (cause) { this.#unwatch(row.file, row); throw cause; }
    row.installed = true;
    this.#text.splice(first, 0, row);
    this.#epoch = {};
  }

  #stage({file, mount, source, text, prot, private: privateMapping}: ExecutableMapping, first: number, after: number,
      generation: object) {
    if (prot !== PROT_RX || privateMapping !== true || mount.flags & MNT.NOEXEC) throw new FsError(E.ACCES);
    const captured = executableSourceFor(source, this.#vfs);
    if (file !== captured.node || !unchangedExecutableSource(captured) || file.mode & 0o6000 || file.maps?.size)
      throw new FsError(E.ACCES);
    const fileRevision = file.execRevision, mountRevision = mount.execRevision;
    const checkSource = (): void => {
      if (file.execRevision !== fileRevision || mount.execRevision !== mountRevision) throw new MappedCodeChanged();
    };
    const extent = Object.freeze({...text});
    const {address, offset, length, bias, role} = extent, end = address + length;
    if (!Object.hasOwn(DYNAMIC_ROLES, role) || !Number.isInteger(bias) || bias < 0 || bias >= LIMIT ||
        !Number.isInteger(address) || !Number.isInteger(offset) || !Number.isInteger(length) ||
        address < 4096 || offset < 0 || length <= 0 || end > LIMIT ||
        offset + length > captured.size || captured.size > DYNAMIC_FILE_LIMIT) throw new FsError(E.INVAL);
    if (this.#text.length - (after - first) >= MAX_RANGES ||
        (after < this.#text.length && this.#text[after].bound.text.address < end))
      throw new FsError(E.INVAL);
    const sources = new Set([file]);
    let bytesHeld = captured.size;
    for (let i = 0; i < this.#text.length; i++) {
      if (i >= first && i < after) continue;
      const row = this.#text[i];
      if (sources.has(row.file)) continue;
      sources.add(row.file);
      bytesHeld += row.size;
    }
    if (bytesHeld > MAX_SOURCE_BYTES) throw new FsError(E.NOMEM);

    let bytes: Uint8Array;
    try { bytes = file.share(); }
    finally {
      if (generation !== this.#epoch) throw new MappedCodeChanged();
      checkSource();
    }
    const prepared = this.#prepared?.(file, extent), observe = this.#prepared?.diagnostics;
    const bound: BoundText = Object.freeze({
      text: extent,
      prepared,
      ...(observe && {preparedTrace: {trace: observe.trace, origin: captured.origin,
        placementMismatch: !prepared && observe.hasPieceFor(file)}}),
      compile: <T>(epoch: object, compiler: MappedTranslate, pc: bigint, known: Set<bigint>,
          consume: (code: Uint8Array<ArrayBuffer>) => T): T => {
        const at = Number(pc);
        if (at < address || at >= end) throw new MappedCodeChanged();
        const check = (): void => {
          if (epoch !== this.#epoch || !active.installed) throw new MappedCodeChanged();
        };
        check();
        // Only the trusted translator gets the source snapshot. Finding a
        // range does not let a caller retain mutable canonical file bytes.
        try {
          return withMappedOutput(compiler, [bytes, extent, pc, known], code => {
            check();
            return consume(code);
          });
        }
        finally { check(); }
      },
    });
    const active: ActiveText = {bound, file, mount, size: captured.size, end, installed: false};
    return {active, checkSource, bytes};
  }

  /** An overlapping unmap, replacement or permission change retires the
   * whole binding. The VM owner may then admit a new exact file mapping. */
  invalidate(address: number, length: number): void {
    this.#extent(address, length);
    const first = this.#firstEndingAfter(address);
    this.#remove(first, this.#afterOverlap(first, address + length));
  }

  close(): void {
    this.#prepared = undefined;
    this.#remove(0, this.#text.length);
  }

  #extent(address: number, length: number): void {
    if (!Number.isInteger(address) || !Number.isInteger(length) || address < 0 || length <= 0 || address + length > LIMIT)
      throw new RangeError('Invalid mapped code extent');
  }

  #firstEndingAfter(address: number): number {
    let first = 0, after = this.#text.length;
    while (first < after) {
      const middle = (first + after) >>> 1;
      if (this.#text[middle].end <= address) first = middle + 1;
      else after = middle;
    }
    return first;
  }

  #afterOverlap(first: number, end: number): number {
    while (first < this.#text.length && this.#text[first].bound.text.address < end) first++;
    return first;
  }

  #remove(first: number, after: number): void {
    if (first === after) return;
    this.#epoch = {};
    for (const row of this.#text.splice(first, after - first)) this.#detach(row);
  }

  #watch(source: File | Mount, row: ActiveText): void {
    let observed = this.#observed.get(source);
    if (!observed) {
      // An unclaimed or discarded image must not be owned by its source tree.
      const owner = new WeakRef(this);
      observed = {rows: new Set(), stop: source.watchExecutable(() => {
        const live = owner.deref();
        if (live) live.#withdraw(source);
      })};
      this.#observed.set(source, observed);
    }
    observed.rows.add(row);
  }

  #withdraw(source: File | Mount): void {
    const {rows} = this.#observed.get(source)!;
    this.#epoch = {};
    this.#text = this.#text.filter(active => !rows.has(active));
    for (const retired of rows) this.#detach(retired);
  }

  #unwatch(source: File | Mount, row: ActiveText): void {
    const observed = this.#observed.get(source)!;
    observed.rows.delete(row);
    if (observed.rows.size) return;
    observed.stop();
    this.#observed.delete(source);
  }

  #detach(row: ActiveText): void {
    row.installed = false;
    this.#unwatch(row.file, row);
    this.#unwatch(row.mount, row);
  }
}
