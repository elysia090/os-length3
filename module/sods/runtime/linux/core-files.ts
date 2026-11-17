/** Explicit migration entrance: existing inode/namespace/mapping semantics with
 * Rust-owned payloads. This is not a replacement of the portable kernel yet.
 */
import {CoreFileError, loadCoreFiles, type CoreFile} from '../core/files.ts';
import {epoch} from '../host.ts';
import {File, Vfs, E, FsError, FILE_MOST, counted, mountTarget, type Mapping} from './fs.ts';

function payload<T>(action: () => T): T {
  try { return action(); }
  catch (e) {
    if (!(e instanceof CoreFileError) || e.code === -6 || e.code === -7) throw e;
    // Only failures reported before a Rust payload mutation are normal errnos.
    throw new FsError(e.code === -2 ? E.FBIG : e.code === -3 ? E.NOSPC : e.code === -4 ? E.NOMEM : E.IO);
  }
}

class OwnedFile extends File {
  private readonly owned: CoreFile;
  private readonly live: () => void;
  private readonly limit: number;
  constructor(owned: CoreFile, size: number, mode: number, live: () => void, limit: number) {
    super(new Uint8Array(0), mode);
    this.owned = owned; this.live = live; this.limit = limit;
    this.size = size;
    // A legacy mutable array must not masquerade as this inode's canonical bytes.
    Object.defineProperty(this, '_data', {get() { throw new FsError(E.OPNOTSUPP); }, set() { throw new FsError(E.OPNOTSUPP); }});
  }
  override materialize(): void {
    this.live(); this.size = payload(() => this.owned.materialize());
    if (this.owned.source()) this.holdLoaded();
  }
  override heldBytes(): number { this.live(); return payload(() => this.owned.resident()); }
  override releasableBytes(): number { return this.maps ? 0 : this.heldBytes(); }
  override snapshotRange(start: number, end: number): Uint8Array { return this.read(start, end); }
  override get data(): Uint8Array { throw new FsError(E.OPNOTSUPP); }
  protected override range(start: number, end: number): Uint8Array {
    this.materialize();
    return payload(() => this.owned.read(start, Math.max(0, end - start)));
  }
  protected override replaceRange(at: number, bytes: Uint8Array): void {
    this.live(); payload(() => this.owned.write(at, bytes));
  }
  override map(m: Mapping): void { this.live(); payload(() => this.owned.checkIdle()); super.map(m); }
  override unmap(m: Mapping): void { this.live(); super.unmap(m); }
  override settle(start = 0, end = this.size, only: Mapping | null = null): void { this.live(); payload(() => this.owned.checkIdle()); super.settle(start, end, only); }
  override own(): void { this.live(); payload(() => this.owned.own()); this.unholdLoaded(); }
  override release(): number {
    this.live(); payload(() => this.owned.checkIdle());
    // Keep mapped bytes resident: a later dirty observation must not invoke a loader
    // inside mapping writeback. Mapping/pin-aware eviction is a separate contract.
    if (this.maps) return 0;
    const released = payload(() => this.owned.release());
    if (!this.owned.resident()) this.unholdLoaded();
    return released;
  }
  override given(bytes: Uint8Array): void {
    this.live(); this.size = payload(() => this.owned.given(bytes));
    if (this.owned.source()) this.holdLoaded();
  }
  override share(): Uint8Array { return this.bytes(); }
  override bytes(): Uint8Array { this.materialize(); if (this.maps) this.settle(); return this.range(0, this.size); }
  override readInto(start: number, into: Uint8Array, at: number, length: number, ready?: () => void): number {
    this.live(); if (this.maps) this.settle(start, start + length);
    try { this.materialize(); }
    catch (error) { ready?.(); throw error; }
    ready?.(); // After loading, before core read scratch. No callback crosses the lease.
    return payload(() => this.owned.readInto(start, into, at, length));
  }
  override write(at: number, bytes: Uint8Array): void {
    this.live();
    if (!Number.isInteger(at) || at < 0) throw new FsError(E.INVAL);
    if (at > this.limit || bytes.length > this.limit - at) throw new FsError(E.FBIG);
    // One stable value is committed and propagated, even for shared host input.
    this.materialize();
    const accepted = new Uint8Array(bytes);
    payload(() => this.owned.write(at, accepted));
    this.unholdLoaded();
    this.size = Math.max(this.size, at + accepted.length);
    this.mtime = epoch(); this.version++; counted.changes++;
    // Pass captured bytes: do not allocate a fresh Rust readout after commit.
    if (this.maps) this.show(at, at + accepted.length, accepted);
  }
  override truncate(length: number): void {
    this.live();
    if (!Number.isInteger(length) || length < 0) throw new FsError(E.INVAL);
    if (length > FILE_MOST) throw new FsError(E.FBIG);
    this.materialize();
    if (this.maps) this.settle();
    const was = this.size;
    payload(() => this.owned.truncate(length));
    this.unholdLoaded();
    this.size = length;
    this.mtime = epoch(); this.version++; counted.changes++;
    // The changed interval is entirely zero, both on growth and beyond new EOF.
    // No allocation or read-back is required after the payload commits.
    for (const m of this.maps ?? []) {
      const a = Math.max(Math.min(was, length), m.off), b = Math.min(Math.max(was, length), m.off + m.length);
      if (a >= b) continue;
      m.proc.bytes.fill(0, m.start + a - m.off, m.start + b - m.off);
      m.seen!.fill(0, a - m.off, b - m.off);
    }
  }
}

/** Caller owns the scope. Dispose only after every process, mapping, image and
 * embedding handle using its files has ended. Unlinked/replaced files remain
 * live until then; closing an fd does not close a payload. No automatic fallback.
 */
export async function loadFileScope(source: WebAssembly.Module | BufferSource, maxFileBytes: number) {
  const store = await loadCoreFiles(source, maxFileBytes), held = new Map<CoreFile, OwnedFile>();
  let closed = false;
  const live = () => { if (closed) throw new Error('Rust file scope is closed'); };
  const lazy = (mode: number, size: number, loader: () => Uint8Array): File => {
    live();
    const file = payload(() => store.createLazy(() => {
      try { return loader(); }
      catch { throw new FsError(E.IO); }
    }, size));
    try {
      const inode = new OwnedFile(file, size, mode, live, maxFileBytes);
      held.set(file, inode); return inode;
    } catch (e) { file.close(); throw e; }
  };
  return {
    /** All pack files use this scope, without coupling the pack reader to Rust. */
    mountTarget(vfs: Vfs) { live(); return mountTarget(vfs, lazy); },
    writeFile(vfs: Vfs, path: string, input: Uint8Array | string, mode = 0o644): File {
      live();
      const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
      if (bytes.length > maxFileBytes) throw new FsError(E.FBIG);
      const at = path.lastIndexOf('/'), dir = vfs.mkdirp(path.slice(0, at));
      const file = payload(() => store.create(bytes));
      try {
        const inode = new OwnedFile(file, bytes.length, mode, live, maxFileBytes);
        held.set(file, inode);
        dir.entries.set(path.slice(at + 1), inode);
        return inode;
      } catch (e) { held.delete(file); file.close(); throw e; }
    },
    /** Explicit lazy entrance. Rust owns source/attempt state; TS keeps only the host capability. */
    lazyFile(vfs: Vfs, path: string, loader: () => Uint8Array, mode = 0o644): File {
      live();
      const at = path.lastIndexOf('/'), dir = vfs.mkdirp(path.slice(0, at));
      const inode = lazy(mode, 0, loader);
      dir.entries.set(path.slice(at + 1), inode);
      return inode;
    },
    dispose(): void {
      if (closed) return;
      closed = true;
      for (const [file, inode] of held) { file.close(); inode.pool?.delete(inode); inode.pool = null; }
      held.clear();
    },
  };
}
