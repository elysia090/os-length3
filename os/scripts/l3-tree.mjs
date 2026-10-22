// The tree l3 is, read two ways, so the two can be held side by side:
//
//   nativeTree(TARBALL)  a release root (os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst)
//                        as l3 installs it on a device (core/src/root.rs unpack):
//                        what is under root/, directories at least 0700, files
//                        without set-id bits, symlinks as they are, a hard link the
//                        same bytes as its file. No other kind is part of a root.
//   nativeTree(DIR)      a root already installed (<data>/system/<sha256>/root)
//   webTree(DIR)         l3 as the browser reads it (scripts/l3.mjs): its index,
//                        and every file decoded from its pack
//
// Each gives the same shape, one entry a path (sorted):
//   {path, type: 'dir'|'file'|'link', mode, target?, size?, sha256?}
// and `manifestOf` and `differences` compare two. The bytes are hashed as
// they are read and never kept: a 250 MB root is read in one pass.
import {createHash} from 'node:crypto';
import {createReadStream, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, closeSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {createZstdDecompress, gunzipSync, zstdDecompressSync} from 'node:zlib';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Every member of a tar stream: {name, kind ('0' file, '5' dir, '2' symlink, '1' hard link), mode, link, size, bytes},
 * with pax path and linkpath applied, as core/src/root.rs reads one.
 */
export async function* tarMembers(stream) {
  // The stream's chunks as they come, and how far into the first one is read: each member is copied out once.
  const chunks = [];
  let have = 0, skip = 0, done = false;
  const it = stream[Symbol.asyncIterator]();
  const take = async (n) => {
    while (have < n && !done) {
      const r = await it.next();
      if (r.done) done = true;
      else { chunks.push(r.value); have += r.value.length; }
    }
    if (have < n) throw new Error('tar: cut short');
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = chunks[0];
      const k = Math.min(c.length - skip, n - at);
      c.copy(out, at, skip, skip + k);
      at += k; skip += k;
      if (skip === c.length) { chunks.shift(); skip = 0; }
    }
    have -= n;
    return out;
  };
  const octal = (b) => { const t = b.toString('latin1').replace(/\0.*$/s, '').trim(); return t ? parseInt(t, 8) : 0; };
  const text = (b) => b.toString('utf8').replace(/\0.*$/s, '');
  let longName = null, longLink = null;
  for (;;) {
    const block = await take(512);
    if (block.every((b) => b === 0)) return;
    const size = octal(block.subarray(124, 136));
    const kind = String.fromCharCode(block[156] || 0x30);
    let name = text(block.subarray(0, 100));
    if (block.subarray(257, 262).toString('latin1') === 'ustar' && block[345]) name = `${text(block.subarray(345, 500))}/${name}`;
    const padded = Math.ceil(size / 512) * 512;
    const body = (await take(padded)).subarray(0, size);
    if (kind === 'x' || kind === 'g') {
      if (kind === 'x') {
        let rest = body;
        while (rest.length) {
          const sp = rest.indexOf(0x20);
          const len = parseInt(rest.subarray(0, sp).toString('latin1'), 10);
          const record = rest.subarray(sp + 1, len - 1).toString('utf8');
          if (record.startsWith('path=')) longName = record.slice(5);
          if (record.startsWith('linkpath=')) longLink = record.slice(9);
          rest = rest.subarray(len);
        }
      }
      continue;
    }
    yield {name: longName ?? name, kind: kind === '7' ? '0' : kind, mode: octal(block.subarray(100, 108)) & 0o7777,
      link: longLink ?? text(block.subarray(157, 257)), size, bytes: body};
    longName = longLink = null;
  }
}

/** A member's place in the root: '/usr/bin/sh' for root/usr/bin/sh; null for what is beside the root (manifest) or the root itself. */
const inRoot = (name) => {
  const parts = name.split('/').filter((p) => p && p !== '.');
  if (parts[0] !== 'root' || parts.length < 2) return null;
  if (parts.some((p) => p === '..')) throw new Error(`tar: ${name} leaves the tree`);
  return `/${parts.slice(1).join('/')}`;
};

/**
 * The root in a release tarball, as l3 installs it, and its manifest file:
 * {entries, manifest}. `each(entry, bytes)` sees every file's bytes once
 * (scripts/l3.mjs packs them from here).
 */
export async function readTarball(file, each = () => {}) {
  const entries = [];
  const files = new Map();
  let manifest = '';
  const stream = createReadStream(file).pipe(createZstdDecompress());
  for await (const m of tarMembers(stream)) {
    if (m.name.replace(/^\.\//, '') === 'manifest') { manifest = m.bytes.toString('utf8'); continue; }
    const path = inRoot(m.name);
    if (!path) continue;
    if (m.kind === '5') entries.push({path, type: 'dir', mode: m.mode | 0o700});
    else if (m.kind === '2') entries.push({path, type: 'link', mode: 0o777, target: m.link});
    else if (m.kind === '0') {
      const e = {path, type: 'file', mode: m.mode & 0o777, size: m.size, sha256: sha256(m.bytes)};
      files.set(path, e);
      entries.push(e);
      each(e, m.bytes);
    } else if (m.kind === '1') {
      const to = files.get(inRoot(m.link) ?? '');
      if (!to) throw new Error(`tar: ${m.name} links to ${m.link}, which is not a file before it`);
      // One file with two names: its mode is the file's.
      const e = {...to, path, same: to.path};
      entries.push(e);
      each(e, null);
    } else throw new Error(`tar: ${m.name}: kind ${m.kind} is not part of a root`);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {entries, manifest};
}

/** An installed root, walked as the host has it. */
export function readDir(root) {
  const entries = [];
  (function walk(dir, rel) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), path = `${rel}/${name}`, st = lstatSync(full);
      if (st.isSymbolicLink()) entries.push({path, type: 'link', mode: 0o777, target: readlinkSync(full)});
      else if (st.isDirectory()) { entries.push({path, type: 'dir', mode: st.mode & 0o7777}); walk(full, path); }
      else if (st.isFile()) entries.push({path, type: 'file', mode: st.mode & 0o7777, size: st.size, sha256: sha256(readFileSync(full))});
      else entries.push({path, type: 'other', mode: st.mode & 0o7777});
    }
  })(root, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {entries};
}

export async function nativeTree(at) {
  return statSync(at).isDirectory() ? readDir(at) : readTarball(at);
}

/**
 * l3 for the browser, opened: {about (l3.json), index, dir, packs (where its packs are), blob(name)}.
 * Also takes a root of packs of before (root.json beside packs/), which has no l3.json.
 */
export function openWeb(dir) {
  let about = null, index;
  try { about = JSON.parse(readFileSync(join(dir, 'l3.json'), 'utf8')); } catch { /* a root of packs alone */ }
  if (about) {
    const bytes = readFileSync(join(dir, about.index.path));
    if (sha256(bytes) !== about.index.sha256) throw new Error(`${about.index.path}: not the index l3.json names (sha256 ${sha256(bytes)})`);
    index = JSON.parse(bytes.toString('utf8'));
  } else index = JSON.parse(readFileSync(join(dir, 'root.json'), 'utf8'));
  const fds = new Map();
  const fd = (name) => { if (!fds.has(name)) fds.set(name, openSync(join(dir, 'packs', name), 'r')); return fds.get(name); };
  /** A file's stored bytes from its pack, and decoded. */
  const read = (f) => {
    const stored = Buffer.alloc(f.len);
    if (f.len) readSync(fd(index.packs[f.pack].name), stored, 0, f.len, f.at);
    return f.raw || !f.len ? stored : zstdDecompressSync(stored);
  };
  /** A blob (the translator, a translation): its gzip'd bytes checked against its name, then unpacked. */
  const blob = (b) => {
    const bytes = readFileSync(join(dir, b.path));
    if (sha256(bytes) !== b.sha256) throw new Error(`${b.path}: sha256 ${sha256(bytes)}, its index says ${b.sha256}`);
    return gunzipSync(bytes);
  };
  /** Bytes [at, at+len) of the pack named `pack`, into `into` (as the browser's Range request gives them). */
  const readRange = (pack, at, len, into) => { if (len) readSync(fd(pack), into, 0, len, at); return into; };
  const unzstd = (bytes) => zstdDecompressSync(bytes);
  const close = () => { for (const f of fds.values()) closeSync(f); fds.clear(); };
  return {about, index, dir, packs: join(dir, 'packs'), read, readRange, unzstd, blob, close};
}

/** Every path of l3 for the browser, each file's bytes decoded from its pack and hashed; and each pack checked against its name. */
export function webTree(dir) {
  const web = openWeb(dir);
  const {index} = web;
  try {
    for (const p of index.packs) {
      const got = sha256(readFileSync(join(web.packs, p.name)));
      if (`${got}.pack` !== p.name) throw new Error(`packs/${p.name}: its bytes are sha256 ${got}`);
    }
    const entries = [
      ...index.dirs.map((d) => ({path: d.path, type: 'dir', mode: d.mode})),
      ...index.links.map((l) => ({path: l.path, type: 'link', mode: 0o777, target: l.target})),
      ...index.files.map((f) => {
        const bytes = web.read(f);
        if (bytes.length !== f.size) throw new Error(`${f.path}: ${bytes.length} bytes from its pack, its index says ${f.size}`);
        return {path: f.path, type: 'file', mode: f.mode, size: f.size, sha256: sha256(bytes)};
      }),
    ];
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // What a page gives its Prompt beside the packs (a hot program with its translation) is the same file, byte for byte.
    const at = new Map(entries.map((e) => [e.path, e]));
    for (const t of index.translations ?? []) {
      const elf = sha256(web.blob(t.elf));
      web.blob(t.wasm);
      if (elf !== t.sha256 || at.get(t.path)?.sha256 !== elf) throw new Error(`${t.elf.path}: sha256 ${elf}, not ${t.path} of the root (${at.get(t.path)?.sha256 ?? 'none'})`);
    }
    return {entries, about: web.about, index};
  } finally { web.close(); }
}

/** What is compared: one line a path, its type, mode, link target and the sha256 of its bytes. */
export const lineOf = (e) => `${e.path}\t${e.type}\t${e.mode.toString(8).padStart(4, '0')}\t${e.type === 'link' ? e.target : e.type === 'file' ? `${e.size}\t${e.sha256}` : ''}`;
export const manifestOf = (tree) => tree.entries.map(lineOf).join('\n') + '\n';

/** How two trees differ: {missing (in a, not b), extra (in b, not a), changed: [{path, a, b}]}. */
export function differences(a, b) {
  const by = (t) => new Map(t.entries.map((e) => [e.path, lineOf(e)]));
  const [x, y] = [by(a), by(b)];
  const missing = [...x.keys()].filter((p) => !y.has(p));
  const extra = [...y.keys()].filter((p) => !x.has(p));
  const changed = [...x.keys()].filter((p) => y.has(p) && x.get(p) !== y.get(p)).map((p) => ({path: p, a: x.get(p), b: y.get(p)}));
  return {missing, extra, changed, same: !missing.length && !extra.length && !changed.length};
}

/** {files, dirs, links, bytes} of a tree. */
export const counts = (t) => ({
  files: t.entries.filter((e) => e.type === 'file').length,
  dirs: t.entries.filter((e) => e.type === 'dir').length,
  links: t.entries.filter((e) => e.type === 'link').length,
  bytes: t.entries.reduce((n, e) => n + (e.type === 'file' ? e.size : 0), 0),
});
