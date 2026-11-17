// Verify and collect only the assets named by a prepared distribution.
// No bundler, composition or execution dependency; the caller owns the returned bytes.
import {createHash} from 'node:crypto';
import {readFileSync, lstatSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {requireFileStoreName, type Index, type About, type Blob} from '../distribution/manifest.ts';
import {checkPacks} from '../distribution/pack.ts';

export function distributionAssets(directory: string, {base = 'ricebox', maxAssetBytes = Infinity}: {base?: string; maxAssetBytes?: number} = {}) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) throw new Error('ricebox: base must be a relative asset directory');
  if (!(maxAssetBytes > 0)) throw new Error('ricebox: maxAssetBytes must be positive');
  const root = resolve(directory), result = new Map<string, Buffer>();
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
    result.set(`${base}/${name}`, bytes);
    return bytes;
  };
  const about = JSON.parse(read('webroot.json').toString('utf8')) as About;
  if (!about.index || !/^[0-9a-f]{64}$/.test(about.index.sha256) || about.index.path !== `index-${about.index.sha256}.json` || !Number.isSafeInteger(about.index.size)) throw new Error('ricebox: invalid index descriptor');
  const index = JSON.parse(read(about.index.path, about.index.sha256, about.index.size).toString('utf8')) as Index;
  requireFileStoreName(index);
  if (index.sha256 !== about.sha256 || index.version !== about.version) throw new Error('ricebox: distribution and index disagree');
  const blob = (b: Blob) => {
    if (!b || !/^[0-9a-f]{64}$/.test(b.sha256) || !Number.isSafeInteger(b.size) || b.size < 0 || b.path !== `blobs/${b.sha256}.bin`) throw new Error('ricebox: invalid blob descriptor');
    return read(b.path, b.sha256, b.size);
  };
  blob(index.translator);
  if (index.fileStore !== undefined) {
    const store = index.fileStore;
    if (!store || store.abi !== 4 || !Number.isInteger(store.maxFileBytes) || store.maxFileBytes < 0 || store.maxFileBytes > 0x7fffffff || !/^[0-9a-f]{64}$/.test(store.wasm)) throw new Error('ricebox: invalid file store descriptor');
    const bytes = gunzipSync(blob(store));
    if (bytes.length !== store.bytes || createHash('sha256').update(bytes).digest('hex') !== store.wasm) throw new Error('ricebox: file store expanded content mismatch');
  }
  for (const translation of index.translations ?? []) { blob(translation.elf); blob(translation.wasm); }
  const packs = new Map(index.packs.map(pack => [pack.name, read(`packs/${pack.name}`, undefined, pack.bytes)]));
  checkPacks(index, (name, at, len) => packs.get(name)!.subarray(at, at + len), name => packs.get(name)!.length, bytes => createHash('sha256').update(bytes).digest());
  // The maker is required for a deployable root. Do not produce a seemingly valid
  // deployment whose first launch fails because muk was omitted.
  const muk = JSON.parse(read('muk.json').toString('utf8')) as Blob;
  blob(muk);
  return result;
}

