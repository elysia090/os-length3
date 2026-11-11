// A root from packs (scripts/webroot.ts), put in this kernel's tree: its directories and links at once, each file's
// bytes only when a program first reads it. The kernel reads inside a system call, where nothing can wait, so the
// bytes are fetched synchronously: `range(pack, at, len)` returns them from the pack of that name (in a Worker, a
// synchronous Range request, muk's syncRange; in node, a read of the pack file), and they are used only once they are
// checked against the pack's table (muk's table.ts; `sha256`: in a Worker the translator's, in node its own). A file
// is stored as zstd frames (`decode(bytes, size)` gives it back: in a Worker the translator's decoder, in node its
// own) or as it is (`raw`), whichever is smaller.

import {Dir, File, Link, type Vfs} from './fs.ts';
import {checkedRange, type Sha256} from '../../muk/runtime/table.ts';

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

/** Put the pack's tree under `at` ('/' for the whole root); what is already there stays. */
export function mountPack(vfs: Vfs, index: Packed, {range, decode, sha256}: Reading, at = '/'): void {
  if (index.codec !== 'zstd') throw new Error(`root: packs in ${index.codec ?? 'an older form'} are not read here`);
  const base = at === '/' ? '' : at.replace(/\/$/, '');
  for (const d of index.dirs) {
    const dir = vfs.mkdirp(base + d.path);
    if (dir instanceof Dir) dir.mode = (dir.mode & ~0o7777) | d.mode;
  }
  const place = (path: string): [Dir, string] => {
    const i = path.lastIndexOf('/');
    return [vfs.mkdirp(base + path.slice(0, i) || '/'), path.slice(i + 1)];
  };
  for (const l of index.links) {
    const [dir, name] = place(l.path);
    if (!dir.entries.has(name)) dir.entries.set(name, new Link(l.target));
  }
  // A file with more than one name (a hard link in the root: git's commands, each a name of git) is put in the index
  // at one place; each name of it is the same node here, as on the device, so what is made from it once (its
  // translation, its bytes read) serves every name, and a write through one name is seen through each.
  const named = new Map<string, File>();
  const read = checkedRange(index, range, sha256);
  for (const f of index.files) {
    const [dir, name] = place(f.path);
    if (dir.entries.has(name)) continue;
    const pack = index.packs[f.pack].name;
    const where = `${f.pack}:${f.at}:${f.len}`;
    const same = f.len ? named.get(where) : undefined;
    if (same) { dir.entries.set(name, same); same.nlink++; continue; }
    const file = new File(new Uint8Array(0), f.mode, () => {
      const stored = read(f.pack, f.at, f.len);
      return f.raw ? stored.slice() : decode(stored, f.size);
    });
    file.size = f.size;
    // Where its bytes are: the same bytes wherever this pack is (a pack is named by its digest), so what is made from
    // them (a program's translation) can be kept by it while the file is unchanged (version 0).
    file.origin = `${pack.replace(/\.pack$/, '')}_${f.at}_${f.len}`;
    dir.entries.set(name, file);
    if (f.len) named.set(where, file);
  }
}

/**
 * A file of the root given with its bytes (`root`: a hot program, its bytes the root's own, checked against the
 * root's digest of them): put in the root's node, so every name of it (a hard link) is still the one file, and its
 * bytes are not read from its pack. Anything else given is written over the root, as it is given.
 */
export function provide(vfs: Vfs, {path, bytes, mode = 0o644, root = false}: Given): File {
  if (root) {
    let node = null;
    try { node = vfs.lookup(path, '/', false); } catch { /* not in the root: written */ }
    if (node instanceof File && node.origin && node.version === 0 && node.size === bytes.length) { node.given(bytes); return node; }
  }
  return vfs.writeFile(path, bytes, mode);
}
