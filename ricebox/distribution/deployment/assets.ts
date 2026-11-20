// Verify and collect only the assets named by a prepared distribution.
// No bundler, composition or execution dependency; the caller owns the returned bytes.
import {createHash} from 'node:crypto';
import {readFileSync, lstatSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {blobAsset, releaseIndexAsset, readReleaseIndex, type About} from '../format/manifest.ts';
import {checkPacks} from '../format/pack.ts';

/** Copy native ES modules from the built npm package, preserving relative Worker URLs. */
export function browserModules({display = false}: {display?: boolean} = {}): Map<string, Buffer> {
  const packageFiles = new URL('../../', import.meta.url);
  const read = (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(new URL(parts.slice(0, i).join('/'), packageFiles));
      if (i === parts.length ? !stat.isFile() : !stat.isDirectory()) {
        throw new Error(`ricebox: browser module path is not a regular file: ${path}`);
      }
    }
    return readFileSync(new URL(path, packageFiles));
  };
  const {v, core, display: optional} = JSON.parse(read('distribution/deployment/browser-modules.json').toString('utf8'));
  if (v !== 1 || !Array.isArray(core) || !Array.isArray(optional)) throw new Error('ricebox: invalid browser module manifest');
  const paths = [...core, ...optional];
  const browser = /^(?:distribution\/(?:format|runtime)|sods\/runtime|everyday\/src)(?:\/[a-z0-9-]+)*\/[a-z0-9.-]+\.js$/;
  if (paths.some(path => typeof path !== 'string' || !browser.test(path)) || new Set(paths).size !== paths.length ||
      !core.includes('distribution/runtime/root.js') || core.some(path => path.startsWith('everyday/')) ||
      !optional.includes('everyday/src/surface.js')) throw new Error('ricebox: invalid browser module manifest paths');
  return new Map((display === true ? paths : core).map(path => [`ricebox-js/${path}`, read(path)]));
}

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
  const asset = releaseIndexAsset(about);
  const index = readReleaseIndex(read(asset.path, asset.sha256, asset.size), about);
  const blob = (value: unknown) => {
    const b = blobAsset(value);
    return read(b.path, b.sha256, b.size);
  };
  blob(index.translator);
  for (const translation of index.translations ?? []) { blob(translation.elf); blob(translation.wasm); }
  const packs = new Map(index.packs.map(pack => [pack.name, read(`packs/${pack.name}`, undefined, pack.bytes)]));
  checkPacks(index, (name, at, len) => packs.get(name)!.subarray(at, at + len), name => packs.get(name)!.length, bytes => createHash('sha256').update(bytes).digest());
  // The maker is required for a deployable root. Do not produce a seemingly valid
  // deployment whose first launch fails because muk was omitted.
  blob(JSON.parse(read('muk.json').toString('utf8')));
  return result;
}

