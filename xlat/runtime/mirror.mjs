// One directory of the guest kept in step with the outside: what the guest
// changes under `root` is reported as changes, and what the outside changes
// is put in without being reported back. The app uses it so a repo the
// shell works in is the same repo File, Forge and Git show.
//
// A change is {dirs: [rel], files: [{path: rel, bytes, existed}], removed: [rel]}.
// Paths are relative to `root`; a removed directory is reported once, not
// with everything it held.

import {Dir, File} from './fs.mjs';

/**
 * A repo's .git however it is spelt (the app's core refuses the same names):
 * case, trailing dots and spaces, the short name git~1 and invisible code
 * points do not make it something else. It is never mirrored either way.
 */
export function isGitName(name) {
  const n = name.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toLowerCase().replace(/[. ]+$/, '');
  return n === '.git' || n === 'git~1';
}

/** Every directory and file under `dir`, by relative path. */
function walk(dir, prefix, out) {
  for (const [name, node] of dir.entries) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (isGitName(name)) continue;
    if (node instanceof Dir) { out.set(rel, {node, dir: true}); walk(node, rel, out); }
    else if (node instanceof File) out.set(rel, {node, dir: false, version: node.version, size: node.size});
  }
  return out;
}

export class Mirror {
  constructor(vfs, root) {
    this.vfs = vfs;
    this.root = root;
    this.seen = this.now();
  }

  now() {
    let dir;
    try { dir = this.vfs.lookup(this.root, '/'); } catch { return new Map(); }
    return dir instanceof Dir ? walk(dir, '', new Map()) : new Map();
  }

  /** What changed in the guest since the last call; null when nothing did. */
  changes() {
    const now = this.now();
    const dirs = [], files = [], removed = [];
    for (const [rel, e] of now) {
      const before = this.seen.get(rel);
      if (e.dir) { if (!before?.dir) dirs.push(rel); continue; }
      if (before && !before.dir && before.node === e.node && before.version === e.version && before.size === e.size) continue;
      files.push({path: rel, bytes: e.node.data.slice(0, e.node.size), existed: !!before && !before.dir});
    }
    for (const [rel, e] of this.seen) {
      if (now.has(rel) && now.get(rel).dir === e.dir) continue;
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;
      // Only the top of what went away.
      if (parent && this.seen.has(parent) && !now.has(parent)) continue;
      removed.push(rel);
    }
    this.seen = now;
    return dirs.length || files.length || removed.length ? {dirs, files, removed} : null;
  }

  /** Put an outside change in: bytes for a file, null to remove, 'dir' for a directory. */
  put(rel, what) {
    const parts = rel.split('/');
    if (!rel || parts.some((p) => !p || p === '.' || p === '..' || isGitName(p))) return;
    const path = `${this.root}/${rel}`;
    if (what === 'dir') this.vfs.mkdirp(path);
    else if (what === null) {
      const at = path.lastIndexOf('/');
      try { this.vfs.lookup(path.slice(0, at), '/').entries.delete(path.slice(at + 1)); } catch { /* already gone */ }
    } else this.vfs.writeFile(path, what);
    // What was put in is now how things are; it is not a guest change.
    const now = this.now();
    // The directories a put made on the way count as put too.
    for (let i = 1; i < parts.length; i++) {
      const up = parts.slice(0, i).join('/');
      if (now.has(up)) this.seen.set(up, now.get(up));
    }
    for (const [k, e] of now) if (k === rel || k.startsWith(`${rel}/`)) this.seen.set(k, e);
    for (const k of [...this.seen.keys()]) if ((k === rel || k.startsWith(`${rel}/`)) && !now.has(k)) this.seen.delete(k);
  }
}
