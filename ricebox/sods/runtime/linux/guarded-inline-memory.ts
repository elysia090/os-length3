// Closed inline diagnostic profile: its own memory is never exported. Only
// the checked scalar read/write/fetch methods can be lent to an actual guest
// instruction. The stock Sods runtime does not yet use this memory or profile.
import {type ExecutableSource} from './executable-source.ts';
import {ExecutableMappingModel, type ExecutableFileProof, type FileRxRequest} from './executable-mappings.ts';
import {FdTable} from './fd.ts';
import {File, Vfs} from './fs.ts';

const PAGE = 4096, FLOOR = 65536, WASM_PAGE = 65536;
const READ = 1, WRITE = 2, EXEC = 4;
const MAPPED = 8, SEALED = 16; // host metadata; not in addressable guest memory
const RX = READ | EXEC;
const MAX_WASM_PAGES = 1024; // 64 MiB in this diagnostic, not a system limit
const dataRights = (rights: number) => rights === 0 || rights === READ || rights === (READ | WRITE);
const fresh = <T extends object>(): T => Object.freeze(Object.create(null)) as T;

declare const ownerToken: unique symbol;
export interface GuardedOwner { readonly [ownerToken]: true }

export class GuardedFault extends Error {
  readonly kind: 'owner' | 'unmapped' | 'permission';
  readonly address: bigint;
  constructor(kind: GuardedFault['kind'], address: bigint) {
    super(`guarded memory: ${kind} at guest 0x${address.toString(16)}`);
    this.kind = kind; this.address = address;
  }
}

interface Owner {
  readonly token: GuardedOwner;
  readonly fd: FdTable;
  readonly proof: ExecutableMappingModel;
}

export class GuardedInlineMemory {
  readonly #memory: WebAssembly.Memory;
  readonly #bytes: Uint8Array<ArrayBuffer>;
  readonly #pages: Uint8Array<ArrayBuffer>;
  #owner: Owner | null = null;
  #epoch = 0n;

  constructor(wasmPages: number) {
    if (!Number.isSafeInteger(wasmPages) || wasmPages < 2 || wasmPages > MAX_WASM_PAGES) throw new RangeError('Invalid guarded memory capacity');
    this.#memory = new WebAssembly.Memory({initial:wasmPages, maximum:wasmPages});
    this.#bytes = new Uint8Array(this.#memory.buffer as ArrayBuffer);
    this.#pages = new Uint8Array(wasmPages * (WASM_PAGE / PAGE));
  }

  /**
   * Install a newly prepared address-space owner. Call before switching a
   * checked adapter at exec/retirement. This guard is not a hook into stock
   * Process; its caller must never use raw or uninstrumented guest access.
   */
  installOwner(vfs: Vfs, fds: FdTable): GuardedOwner {
    // Validate completely before leaving the earlier owner.
    const next = {token:fresh<GuardedOwner>(), fd:fds, proof:new ExecutableMappingModel(vfs, this.#memory, fds)};
    if (this.#owner) this.#removeOwner(this.#owner);
    this.#owner = next;
    ++this.#epoch;
    return next.token;
  }

  retireOwner(token: GuardedOwner): void { this.#removeOwner(this.#current(token, 0n)); }

  async authenticate(token: GuardedOwner, source: ExecutableSource, digest: string): Promise<ExecutableFileProof | null> {
    const owner = this.#current(token, 0n);
    const result = await owner.proof.authenticate(source, digest);
    return this.#owner === owner ? result : null;
  }

  /** Fresh/explicitly replaced anonymous fixture data; never executable. */
  installData(token: GuardedOwner, start: number, length: number, prot: number, initial?: Uint8Array, replace = false): void {
    const owner = this.#current(token, 0n);
    const [lo, hi] = this.#range(start, length);
    if (!dataRights(prot)) throw new RangeError('Invalid anonymous page rights');
    if (initial && (!(initial.buffer instanceof ArrayBuffer) || initial.byteLength > length)) throw new RangeError('Invalid initial data');
    // No callback or guest runs during mutation. Even a producer alias must
    // have been captured before altering the old range.
    const snapshot = initial ? new Uint8Array(initial) : undefined;
    if (!replace && !this.#vacant(lo, hi)) throw new RangeError('Guarded page range already occupied');
    this.#beforeMutation(owner, start, length);
    this.#pages.fill(0, lo, hi);
    this.#bytes.fill(0, start, start + length);
    if (snapshot) this.#bytes.set(snapshot, start);
    this.#pages.fill(MAPPED | prot, lo, hi);
  }

  /**
   * Fixed, fresh, private RX file pages only. Bytes from an actual received
   * FD are staged before any page becomes readable or executable. No
   * temporary writable guest mapping is created, including on failure.
   */
  installRx(token: GuardedOwner, proof: ExecutableFileProof, fd: number, request: FileRxRequest): boolean {
    const owner = this.#current(token, 0n);
    // Seal unknown requests into one ordinary immutable descriptor before a
    // trusted VFS loader can call out and allow this owner to be changed.
    const {address:start, length, fileOffset, prot, flags} = request;
    const [lo, hi] = this.#range(start, length);
    if (prot !== RX || !(flags & 0x10) || !this.#vacant(lo, hi)) return false;
    const ticket = owner.proof.stage(proof, fd, {address:start, length, fileOffset, prot, flags});
    if (!ticket) return false;
    const d = owner.fd.get(fd);
    if (!(d?.node instanceof File)) return false;
    const epoch = this.#epoch;
    const bytes = d.node.snapshotRange(fileOffset, fileOffset + length);
    if (this.#owner !== owner || this.#epoch !== epoch || !this.#vacant(lo, hi) || bytes.length > length) return false;
    this.#bytes.fill(0, start, start + length);
    this.#bytes.set(bytes, start);
    if (!owner.proof.recordMapped(ticket, start)) {
      this.#bytes.fill(0, start, start + length);
      return false;
    }
    ++this.#epoch;
    this.#pages.fill(MAPPED | SEALED | RX, lo, hi);
    return true;
  }

  /** This first profile only keeps or drops X on admitted pages, never adds it. */
  protect(token: GuardedOwner, start: number, length: number, prot: number): boolean {
    const owner = this.#current(token, 0n), [lo, hi] = this.#range(start, length);
    if (!dataRights(prot) && prot !== RX) return false;
    let changed = false;
    for (let p = lo; p < hi; ++p) {
      const before = this.#pages[p]!;
      if (!(before & MAPPED) || ((before & SEALED) && (prot & WRITE)) || (prot === RX && !(before & EXEC))) return false;
      if ((before & 7) !== prot) changed = true;
    }
    if (!changed) return true;
    // Retire claims before publishing any changed permission or releasing
    // storage, including permission-only changes to a protected RX interval.
    this.#beforeMutation(owner, start, length);
    for (let p = lo; p < hi; ++p) this.#pages[p] = (this.#pages[p]! & SEALED) | MAPPED | prot;
    return true;
  }

  unmap(token: GuardedOwner, start: number, length: number): void {
    const owner = this.#current(token, 0n), [lo, hi] = this.#range(start, length);
    this.#beforeMutation(owner, start, length);
    this.#pages.fill(0, lo, hi);
  }

  read(token: GuardedOwner, address: bigint, width: number): bigint {
    this.#current(token, address);
    return this.#littleEndian(this.#allowed(address, width, READ), width);
  }

  write(token: GuardedOwner, address: bigint, width: number, value: bigint): void {
    this.#current(token, address);
    const k = this.#allowed(address, width, WRITE); // both pages before any scalar store
    let word = BigInt.asUintN(64, value);
    for (let n = 0; n < width; ++n) { this.#bytes[k + n] = Number(word & 255n); word >>= 8n; }
  }

  /** Observe exact authenticated file bytes. Does not create a dispatch target or execute an ELF. */
  inspectCode(token: GuardedOwner, address: bigint, width: number): bigint {
    const owner = this.#current(token, address), start = this.#allowed(address, width, EXEC);
    const observed = owner.proof.inspect(start, width);
    if (!observed) throw new GuardedFault('permission', address);
    return this.#littleEndian(start, width);
  }

  #current(token: GuardedOwner, at: bigint): Owner {
    if (!this.#owner || this.#owner.token !== token) throw new GuardedFault('owner', at);
    return this.#owner;
  }

  #removeOwner(owner: Owner): void {
    owner.proof.clear();
    ++this.#epoch;
    this.#pages.fill(0);
    this.#owner = null;
    // Held storage cannot be read under a prior owner or without an install
    // under the next owner. A fresh data or source install overwrites it.
  }

  #beforeMutation(owner: Owner, start: number, length: number): void {
    owner.proof.retireRange(start, length);
    ++this.#epoch;
  }

  #range(start: number, length: number): [number, number] {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < FLOOR
      || length <= 0 || start % PAGE || length % PAGE || length > this.#bytes.length - start) throw new RangeError('Invalid guarded page range');
    return [start / PAGE, (start + length) / PAGE];
  }

  #vacant(lo: number, hi: number): boolean {
    for (let p = lo; p < hi; ++p) if (this.#pages[p]) return false;
    return true;
  }

  #allowed(address: bigint, width: number, rights: number): number {
    if (typeof address !== 'bigint' || !Number.isInteger(width) || width < 1 || width > 8) throw new TypeError('Expected a bounded scalar address and length');
    if (address < BigInt(FLOOR) || address > BigInt(this.#bytes.length - width)) throw new GuardedFault('unmapped', address);
    const start = Number(address), last = start + width - 1;
    for (let p = Math.floor(start / PAGE); p <= Math.floor(last / PAGE); ++p) {
      const entry = this.#pages[p]!, fault = BigInt(Math.max(start, p * PAGE));
      if (!(entry & MAPPED)) throw new GuardedFault('unmapped', fault);
      if (!(entry & rights)) throw new GuardedFault('permission', fault);
    }
    return start;
  }

  #littleEndian(start: number, width: number): bigint {
    let word = 0n;
    for (let n = width - 1; n >= 0; --n) word = (word << 8n) | BigInt(this.#bytes[start + n]!);
    return word;
  }
}
