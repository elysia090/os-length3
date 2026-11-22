// Internal Node reader: use one verification path for buffered assets and private staging.
import {createHash} from 'node:crypto';
import {readFileSync, lstatSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {blobAsset, releaseIndexAsset, readReleaseIndex, type About} from '../format/manifest.ts';
import {checkPacks} from '../format/pack.ts';

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
    if (digest && createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`ricebox: wrong digest for ${name}`);
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
  const blob = (value: unknown) => {
    const b = blobAsset(value);
    asset(b.path, b.sha256, b.size);
  };
  blob(index.translator);
  for (const translation of index.translations ?? []) { blob(translation.elf); blob(translation.wasm); }
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
  }, b => createHash('sha256').update(b).digest());
  takePack();
  // A root without this maker would only fail once a visitor launched it.
  const maker = blobAsset(JSON.parse(asset('muk.json').toString('utf8')));
  asset(maker.path, maker.sha256, maker.size);
  return {descriptor, index, maker};
}
