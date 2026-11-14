// A root from packs (module/ricebox/make/layers.ts), put in a tree someone lends (MountTarget: a kernel's, sods' linux.ts
// mountTarget, or any other): its directories and links at once, each file's bytes only when a program first reads
// it. A kernel reads inside a system call, where nothing can wait, so the bytes are fetched synchronously:
// `range(pack, at, len)` returns them from the pack of that name (in a Worker, a synchronous Range request, pack.ts
// syncRange; in node, a read of the pack file), and they are used only once they are checked against the pack's
// table (table.ts; `sha256`: in a Worker the translator's, in node its own). A file
// is stored as zstd frames (`decode(bytes, size)` gives it back: in a Worker the translator's decoder, in node its
// own) or as it is (`raw`), whichever is smaller.

import {checkedRange, type Sha256} from './table.ts';

/** The root's index, as far as mounting it reads it (what serves it holds all of it). */
export interface Packed {
  codec: string;
  /** Each pack: its name (its table's digest), the package whose files it holds (or local), its length. */
  packs: {name: string; owner?: string; bytes: number}[];
  dirs: {path: string; mode: number}[];
  links: {path: string; target: string}[];
  files: {path: string; mode: number; size: number; pack: number; at: number; len: number; raw?: boolean}[];
}
/** How a pack's bytes are had: a range of one, a file's zstd frames decoded to `size`, the SHA-256 they are checked by. */
export interface Reading { range: (pack: string, at: number, len: number) => Uint8Array; decode: (bytes: Uint8Array, size: number) => Uint8Array; sha256: Sha256 }
/** A file given with its bytes (and the root's own, `root`). */
export interface Given { path: string; bytes: Uint8Array; mode?: number; root?: boolean }

/** The file operations an image consumer lends. No execution engine or node representation crosses this port. */
export interface MountTarget<F> {
  directory(path: string, mode: number): void;
  has(path: string): boolean;
  symlink(target: string, path: string): void;
  file(path: string, mode: number, size: number, read: () => Uint8Array, origin: string): F;
  hardlink(file: F, path: string): void;
}

/** Put the pack's tree under `at`; existing names stay. Hard links keep one identity and files stay lazy. */
export function mountPack<F>(target: MountTarget<F>, index: Packed, {range, decode, sha256}: Reading, at = '/'): void {
  if (index.codec !== 'zstd') throw new Error(`root: packs in ${index.codec ?? 'an older form'} are not read here`);
  const base = at === '/' ? '' : at.replace(/\/$/, '');
  for (const d of index.dirs) target.directory(base + d.path, d.mode);
  for (const l of index.links) if (!target.has(base + l.path)) target.symlink(l.target, base + l.path);
  const named = new Map<string, F>();
  const read = checkedRange(index, range, sha256);
  for (const f of index.files) {
    const path = base + f.path;
    if (target.has(path)) continue;
    const pack = index.packs[f.pack].name;
    const where = `${f.pack}:${f.at}:${f.len}`;
    const same = f.len ? named.get(where) : undefined;
    if (same !== undefined) { target.hardlink(same, path); continue; }
    const file = target.file(path, f.mode, f.size, () => {
      const stored = read(f.pack, f.at, f.len);
      return f.raw ? stored.slice() : decode(stored, f.size);
    }, `${pack.replace(/\.pack$/, '')}_${f.at}_${f.len}`);
    if (f.len) named.set(where, file);
  }
}
