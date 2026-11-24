// Node distribution readers. The lazy reader owns only open pack descriptors;
// the deployment visitor checks the exact file snapshots it hands off.
import {openSync,readFileSync,readSync,closeSync,statSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {checkPacks,checkedRange} from '../format/pack.ts';
import {blobAsset,releaseIndexAsset,readReleaseIndex,type About,type Index,type Blob} from '../format/manifest.ts';
import {webExecutableSources} from '../format/executable-source.ts';
import {sha256,digest} from '../host/node/hash.ts';

type IndexFile = Index['files'][number];

/** Decode a typical pack member into one buffer, with a byte for the end
 * check. Cap the initial allocation for larger members. */
function unzstd(bytes: Uint8Array, size?: number): Buffer {
  if (size === undefined) return zstdDecompressSync(bytes);
  const chunkSize = Math.max(64, Math.min(size + 1, 32 << 20));
  const decoded = zstdDecompressSync(bytes, {chunkSize, maxOutputLength: Math.max(1, size)});
  if (decoded.length !== size) throw new Error(`root: decoded ${decoded.length} bytes, not ${size}`);
  return decoded;
}

/** The web root, opened: {about (webroot.json), index, dir, packs (where its packs are), read(file), blob(name)}. */
export function openDistribution(dir: string) {
  const about: About = JSON.parse(readFileSync(join(dir, 'webroot.json'), 'utf8'));
  const asset = releaseIndexAsset(about);
  const bytes = readFileSync(join(dir, asset.path)), actual = sha256(bytes);
  if (bytes.length !== asset.size || actual !== asset.sha256) throw new Error(`${asset.path}: not the index webroot.json names (sha256 ${actual})`);
  const index = readReleaseIndex(bytes, about);
  const fds = new Map<string, number>();
  const fd = (name: string) => { let f = fds.get(name); if (f === undefined) { f = openSync(join(dir, 'packs', name), 'r'); fds.set(name, f); } return f; };
  /** Bytes [at, at+len) of the pack named `pack`, into `into` (as the browser's Range request gives them). */
  const readRange = <T extends Uint8Array>(pack: string, at: number, len: number, into: T): T => { if (len) readSync(fd(pack), into, 0, len, at); return into; };
  const range = (pack: string, at: number, len: number) => readRange(pack, at, len, Buffer.alloc(len));
  /** A file's stored bytes from its pack, checked against its table, and decoded. */
  const checked = checkedRange(index, range, digest);
  const read = (f: IndexFile): Buffer => {
    const stored = checked(f.pack, f.at, f.len);
    return f.raw || !f.len ? Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength) : unzstd(stored, f.size);
  };
  /** A blob (the translator, a translation): its gzip'd bytes checked against its name, then unpacked. */
  const blob = (b: Blob) => {
    const asset = blobAsset(b), bytes = readFileSync(join(dir, asset.path));
    const actual = sha256(bytes);
    if (bytes.length !== asset.size || actual !== asset.sha256) throw new Error(`${asset.path}: not the stored blob its index names (sha256 ${actual})`);
    const decoded = gunzipSync(bytes);
    if (decoded.length !== b.bytes) throw new Error(`${asset.path}: wrong decoded size`);
    return decoded;
  };
  const close = () => { for (const f of fds.values()) closeSync(f); fds.clear(); };
  /** Every pack whole: its table, each file it stores, and nothing besides (distribution/pack.ts checkPacks). */
  const checkAll = () => checkPacks(index, range, (name) => statSync(join(dir, 'packs', name)).size, digest);
  return {about, index, dir, packs: join(dir, 'packs'), read, readRange, unzstd, blob, checkAll, close};
}


/** Deliver exact buffers as they are checked. The caller must not publish until the whole release passes. */
export function visitDistributionAssets(directory: string, {base = 'ricebox', maxAssetBytes = Infinity}:
  {base?: string; maxAssetBytes?: number}, take: (path: string, bytes: Buffer) => void) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) throw new Error('ricebox: base must be a relative asset directory');
  if (!(maxAssetBytes > 0)) throw new Error('ricebox: maxAssetBytes must be positive');
  const root = resolve(directory);
  const read = (name: string, digest?: string, size?: number) => {
    if (!/^(?:webroot\.json|muk\.json|index-[0-9a-f]{64}\.json|packs\/[0-9a-f]{64}\.pack|blobs\/[0-9a-f]{64}\.bin)$/.test(name)) {
      throw new Error(`ricebox: invalid distribution asset ${name}`);
    }
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(join(root, ...parts.slice(0, i)));
      if (stat.isSymbolicLink()) throw new Error(`ricebox: symbolic link in asset ${name}`);
      if (i === parts.length && !stat.isFile()) throw new Error(`ricebox: not a file: ${name}`);
    }
    const bytes = readFileSync(join(root, name));
    if (bytes.length > maxAssetBytes) throw new Error(`ricebox: ${name} is ${bytes.length} bytes, over the deployment asset limit ${maxAssetBytes}`);
    if (size !== undefined && bytes.length !== size) throw new Error(`ricebox: wrong size for ${name}`);
    if (digest && sha256(bytes) !== digest) throw new Error(`ricebox: wrong digest for ${name}`);
    return bytes;
  };
  const asset = (name: string, digest?: string, size?: number) => {
    const bytes = read(name, digest, size);
    take(`${base}/${name}`, bytes);
    return bytes;
  };
  const about = JSON.parse(asset('webroot.json').toString('utf8')) as About;
  const descriptor = releaseIndexAsset(about);
  const index = readReleaseIndex(asset(descriptor.path, descriptor.sha256, descriptor.size), about);
  const verified = new Map<string, number>();
  const blob = (value: unknown) => {
    const b = blobAsset(value);
    const size = verified.get(b.path);
    if (size !== undefined) {
      if (size !== b.size) throw new Error(`ricebox: conflicting sizes for ${b.path}`);
      return;
    }
    asset(b.path, b.sha256, b.size);
    verified.set(b.path, b.size);
  };
  blob(index.translator);
  for (const translation of index.translations ?? []) { blob(translation.elf); blob(translation.wasm); }
  for (const {program} of webExecutableSources(index).values()) blob(program.wasm);
  // The pack checker asks its size before reading its ranges and finishes that
  // pack before asking for another. The size-checked buffer is the only reader.
  let current: {name: string; bytes: Buffer} | undefined, nextPack = 0;
  const takePack = () => {
    if (!current) return;
    const {name, bytes} = current;
    current = undefined;
    take(`${base}/packs/${name}`, bytes);
  };
  checkPacks(index, (name, at, len) => {
    if (current?.name !== name) throw new Error(`ricebox: unexpected pack read: ${name}`);
    return current.bytes.subarray(at, at + len);
  }, name => {
    takePack(); // Opening the next pack means the previous one passed all checks.
    const pack = index.packs[nextPack++];
    if (pack?.name !== name) throw new Error(`ricebox: unexpected pack order: ${name}`);
    const bytes = read(`packs/${name}`, undefined, pack.bytes);
    current = {name, bytes};
    return bytes.length;
  }, digest);
  takePack();
  // A root without this maker would only fail once a visitor launched it.
  const maker = blobAsset(JSON.parse(asset('muk.json').toString('utf8')));
  const deployed = index.execution?.maker;
  if (deployed && (deployed.path !== maker.path || deployed.size !== maker.size)) {
    throw new Error('ricebox: the box maker disagrees with the deployed Wasm index');
  }
  blob(maker);
  return {descriptor, index, maker};
}
