/** Explicit migration entrance: existing inode/namespace/mapping semantics with
 * Rust-owned payloads. This is not a replacement of the portable kernel yet.
 */
import {CoreFileError, loadCoreFiles, type CoreFile} from '../core/files.ts';
import {epoch} from '../host.ts';
import {File, Vfs, E, FsError, FILE_MOST, counted, type Mapping} from './fs.ts';

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
  override get data(): Uint8Array { throw new FsError(E.OPNOTSUPP); }
  protected override range(start: number, end: number): Uint8Array {
    this.live();
    return payload(() => this.owned.read(start, Math.max(0, end - start)));
  }
  protected override replaceRange(at: number, bytes: Uint8Array): void {
    this.live(); payload(() => this.owned.write(at, bytes));
  }
  override map(m: Mapping): void { this.live(); super.map(m); }
  override unmap(m: Mapping): void { this.live(); super.unmap(m); }
  override settle(start = 0, end = this.size, only: Mapping | null = null): void { this.live(); super.settle(start, end, only); }
  override own(): void { this.live(); }
  override release(): number { this.live(); return 0; } // No lazy/reload source in this entrance.
  override given(_bytes: Uint8Array): void { this.live(); }
  override share(): Uint8Array { return this.bytes(); }
  override bytes(): Uint8Array { this.live(); if (this.maps) this.settle(); return this.range(0, this.size); }
  override readInto(start: number, into: Uint8Array, at: number, length: number, ready?: () => void): number {
    this.live(); if (this.maps) this.settle(start, start + length);
    ready?.(); // Before entering core scratch; no callback is passed into the core facade.
    return payload(() => this.owned.readInto(start, into, at, length));
  }
  override write(at: number, bytes: Uint8Array): void {
    this.live();
    if (!Number.isInteger(at) || at < 0) throw new FsError(E.INVAL);
    if (at > this.limit || bytes.length > this.limit - at) throw new FsError(E.FBIG);
    // One stable value is committed and propagated, even for shared host input.
    const accepted = new Uint8Array(bytes);
    payload(() => this.owned.write(at, accepted));
    this.size = Math.max(this.size, at + accepted.length);
    this.mtime = epoch(); this.version++; counted.changes++;
    // Pass captured bytes: do not allocate a fresh Rust readout after commit.
    if (this.maps) this.show(at, at + accepted.length, accepted);
  }
  override truncate(length: number): void {
    this.live();
    if (!Number.isInteger(length) || length < 0) throw new FsError(E.INVAL);
    if (length > FILE_MOST) throw new FsError(E.FBIG);
    if (this.maps) this.settle();
    const was = this.size;
    payload(() => this.owned.truncate(length));
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
  const store = await loadCoreFiles(source, maxFileBytes), held = new Set<CoreFile>();
  let closed = false;
  const live = () => { if (closed) throw new Error('Rust file scope is closed'); };
  return {
    writeFile(vfs: Vfs, path: string, input: Uint8Array | string, mode = 0o644): File {
      live();
      const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
      if (bytes.length > maxFileBytes) throw new FsError(E.FBIG);
      const at = path.lastIndexOf('/'), dir = vfs.mkdirp(path.slice(0, at));
      const file = payload(() => store.create(bytes));
      try {
        const inode = new OwnedFile(file, bytes.length, mode, live, maxFileBytes);
        held.add(file);
        dir.entries.set(path.slice(at + 1), inode);
        return inode;
      } catch (e) { held.delete(file); file.close(); throw e; }
    },
    dispose(): void {
      if (closed) return;
      closed = true;
      for (const file of held) file.close();
      held.clear();
    },
  };
}
