// Code view of one address space. Its VM owner supplies already-established
// private RX mappings and withdraws them before changing guest memory.
// This is not the Linux mmap implementation or a guest permission API.
import {DYNAMIC_FILE_LIMIT, DYNAMIC_ROLES} from '../../translation/dynamic-load.ts';
import type {MappedText, MappedTranslate} from '../../translation/mapped.ts';
import {isShared} from '../../host.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from '../executable-source.ts';
import {E, FsError, MNT, type File, type Mount, type Vfs} from '../fs.ts';

const LIMIT = 2 ** 32, MAX_RANGES = 256, MAX_SOURCE_BYTES = 256 << 20, PROT_RX = 5;
const contains = (address: bigint, text: MappedText): boolean =>
  address >= BigInt(text.address) && address < BigInt(text.address + text.length);

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
  compile(generation: object, compiler: MappedTranslate, address: bigint, known: Set<bigint>, base: number): Uint8Array<ArrayBuffer>;
}

interface ActiveText {
  readonly bound: BoundText;
  readonly file: File;
  readonly size: number;
  live(): boolean;
}

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

  constructor(vfs: Vfs, memory: WebAssembly.Memory) {
    if (isShared(memory.buffer)) throw new Error('Mapped code requires single-owner inline memory');
    this.#vfs = vfs;
    this.memory = memory;
  }

  get generation(): object {
    if (this.#text.some(t => !t.live())) this.#publish(this.#text.filter(t => t.live()));
    return this.#epoch;
  }

  find(address: bigint, generation: object): BoundText | undefined {
    if (generation !== this.generation) throw new MappedCodeChanged();
    return this.#text.find(t => contains(address, t.bound.text))?.bound;
  }

  /** Bind the exact file-backed bytes already installed by the VM owner.
   * Code is compiled from the captured inode snapshot, not mutable guest RAM. */
  bind({file, mount, source, text, prot, private: privateMapping}: ExecutableMapping): void {
    const generation = this.generation;
    if (prot !== PROT_RX || privateMapping !== true || mount.flags & MNT.NOEXEC) throw new FsError(E.ACCES);
    const captured = executableSourceFor(source, this.#vfs);
    const {space, parent, point} = mount;
    const live = (): boolean => file === captured.node && unchangedExecutableSource(captured) &&
      !file.maps?.size && (mount.flags & MNT.NOEXEC) === 0 && mount.space === space && mount.parent === parent && mount.point === point;
    if (!live()) throw new FsError(E.ACCES);
    const extent = Object.freeze({...text});
    const {address, offset, length, bias, role} = extent;
    if (!Object.hasOwn(DYNAMIC_ROLES, role) || !Number.isInteger(bias) || bias < 0 || bias >= LIMIT ||
        !Number.isInteger(address) || !Number.isInteger(offset) || !Number.isInteger(length) ||
        address < 4096 || offset < 0 || length <= 0 || address + length > Math.min(LIMIT, this.memory.buffer.byteLength) ||
        offset + length > captured.size || captured.size > DYNAMIC_FILE_LIMIT) throw new FsError(E.INVAL);
    if (this.#text.length >= MAX_RANGES ||
        this.#text.some(({bound: {text: other}}) => address < other.address + other.length && other.address < address + length))
      throw new FsError(E.INVAL);
    const sources = new Map(this.#text.map(t => [t.file, t.size]));
    sources.set(file, captured.size);
    if ([...sources.values()].reduce((a, b) => a + b, 0) > MAX_SOURCE_BYTES) throw new FsError(E.NOMEM);

    let bytes: Uint8Array;
    try { bytes = file.share(); }
    finally { if (!live() || generation !== this.generation) throw new MappedCodeChanged(); }
    const mapped = new Uint8Array(this.memory.buffer, address, length);
    for (let i = 0; i < length; i++) if (mapped[i] !== bytes[offset + i]) throw new FsError(E.ACCES);
    if (generation !== this.generation || !live()) throw new MappedCodeChanged();
    const bound: BoundText = Object.freeze({
      text: extent,
      compile: (epoch: object, compiler: MappedTranslate, pc: bigint, known: Set<bigint>, base: number) => {
        const check = (): void => {
          if (epoch !== this.generation || !this.#text.includes(active) || !contains(pc, extent)) throw new MappedCodeChanged();
        };
        check();
        // Only the trusted translator gets the source snapshot. Finding a
        // range does not let a caller retain mutable canonical file bytes.
        try { return compiler.more(bytes, extent, pc, known, base); }
        finally { check(); }
      },
    });
    const active: ActiveText = {bound, file, size: captured.size, live};
    this.#publish([...this.#text, active]);
  }

  /** An overlapping unmap, replacement or permission change retires the
   * whole binding. The VM owner may then admit a new exact file mapping. */
  invalidate(address: number, length: number): void {
    if (!Number.isInteger(address) || !Number.isInteger(length) || address < 0 || length <= 0 || address + length > LIMIT)
      throw new RangeError('Invalid mapped code invalidation');
    const text = this.#text.filter(({bound: {text: t}}) => t.address >= address + length || t.address + t.length <= address);
    if (text.length !== this.#text.length) this.#publish(text);
  }

  #publish(text: ActiveText[]): void {
    this.#epoch = {};
    this.#text = text;
  }
}
