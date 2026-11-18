// Lazy Node distribution reader. The caller owns pack descriptors and must close them.
// Unlike assets.ts this does not eagerly collect assets or impose its symlink policy.
import {openSync,readFileSync,readSync,closeSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {checkPacks,checkedRange} from '../format/pack.ts';
import {requireStandardFileOwner,type About,type Index,type Blob} from '../format/manifest.ts';
import {sha256,digest} from '../host/node/hash.ts';

type IndexFile = Index['files'][number];

/** The web root, opened: {about (webroot.json), index, dir, packs (where its packs are), read(file), blob(name)}. */
export function openDistribution(dir: string) {
  const about: About = JSON.parse(readFileSync(join(dir, 'webroot.json'), 'utf8'));
  const bytes = readFileSync(join(dir, about.index.path));
  if (sha256(bytes) !== about.index.sha256) throw new Error(`${about.index.path}: not the index webroot.json names (sha256 ${sha256(bytes)})`);
  const index: Index = JSON.parse(bytes.toString('utf8'));
  requireStandardFileOwner(index);
  const fds = new Map<string, number>();
  const fd = (name: string) => { let f = fds.get(name); if (f === undefined) { f = openSync(join(dir, 'packs', name), 'r'); fds.set(name, f); } return f; };
  /** Bytes [at, at+len) of the pack named `pack`, into `into` (as the browser's Range request gives them). */
  const readRange = <T extends Uint8Array>(pack: string, at: number, len: number, into: T): T => { if (len) readSync(fd(pack), into, 0, len, at); return into; };
  const range = (pack: string, at: number, len: number) => readRange(pack, at, len, Buffer.alloc(len));
  /** A file's stored bytes from its pack, checked against its table, and decoded. */
  const checked = checkedRange(index, range, digest);
  const read = (f: IndexFile): Buffer => {
    const stored = Buffer.from(checked(f.pack, f.at, f.len));
    return f.raw || !f.len ? stored : zstdDecompressSync(stored);
  };
  /** A blob (the translator, a translation): its gzip'd bytes checked against its name, then unpacked. */
  const blob = (b: Blob) => {
    const bytes = readFileSync(join(dir, b.path));
    if (sha256(bytes) !== b.sha256) throw new Error(`${b.path}: sha256 ${sha256(bytes)}, its index says ${b.sha256}`);
    return gunzipSync(bytes);
  };
  const unzstd = (bytes: Uint8Array) => zstdDecompressSync(bytes);
  const close = () => { for (const f of fds.values()) closeSync(f); fds.clear(); };
  /** Every pack whole: its table, each file it stores, and nothing besides (distribution/pack.ts checkPacks). */
  const checkAll = () => checkPacks(index, range, (name) => statSync(join(dir, 'packs', name)).size, digest);
  return {about, index, dir, packs: join(dir, 'packs'), read, readRange, unzstd, blob, checkAll, close};
}

