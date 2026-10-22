// A root from packs (os/scripts/webroot.mjs): its directories and
// links at once, each file's bytes only when a program first reads it. The
// kernel reads inside a system call, where nothing can wait, so the bytes
// are fetched synchronously: `range(pack, at, len)` returns them from the
// pack of that name (in a Worker, a synchronous Range request; in node, a
// read of the pack file). A file is stored as zstd frames (`decode(bytes,
// size)` gives it back: in a Worker the translator's decoder, in node its
// own) or as it is (`raw`), whichever is smaller.

import {Dir, File, Link} from './fs.mjs';

/** Put the pack's tree under `at` ('/' for the whole root); what is already there stays. */
export function mountPack(vfs, index, range, decode, at = '/') {
  if (index.codec !== 'zstd') throw new Error(`root: packs in ${index.codec ?? 'an older form'} are not read here`);
  const base = at === '/' ? '' : at.replace(/\/$/, '');
  for (const d of index.dirs) {
    const dir = vfs.mkdirp(base + d.path);
    if (dir instanceof Dir) dir.mode = (dir.mode & ~0o7777) | d.mode;
  }
  const place = (path) => {
    const i = path.lastIndexOf('/');
    return [vfs.mkdirp(base + path.slice(0, i) || '/'), path.slice(i + 1)];
  };
  for (const l of index.links) {
    const [dir, name] = place(l.path);
    if (!dir.entries.has(name)) dir.entries.set(name, new Link(l.target));
  }
  for (const f of index.files) {
    const [dir, name] = place(f.path);
    if (dir.entries.has(name)) continue;
    const pack = index.packs[f.pack].name;
    const file = new File(new Uint8Array(0), f.mode, () => {
      const stored = range(pack, f.at, f.len);
      return f.raw ? stored.slice() : decode(stored, f.size);
    });
    file.size = f.size;
    dir.entries.set(name, file);
  }
}

/** In a Worker: the bytes [at, at+len) of a pack in `packs/` under `base`, fetched synchronously. */
export function syncRange(base) {
  return (pack, at, len) => {
    if (!len) return new Uint8Array(0);
    const url = new URL(`packs/${pack}`, base).href;
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.responseType = 'arraybuffer';
    x.setRequestHeader('Range', `bytes=${at}-${at + len - 1}`);
    x.send();
    if (x.status !== 206 && x.status !== 200) throw new Error(`root: ${url} answered ${x.status}`);
    const bytes = new Uint8Array(x.response);
    // A server that ignores Range sends the whole pack.
    return x.status === 200 ? bytes.subarray(at, at + len) : bytes;
  };
}
