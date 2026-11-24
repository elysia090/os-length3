// Verify and collect only the assets named by a prepared distribution.
// No bundler, composition or execution dependency; the caller owns the returned bytes.
import {readFileSync, lstatSync} from 'node:fs';
import {visitDistributionAssets} from './local.ts';

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

export function distributionAssets(directory: string, options: {base?: string; maxAssetBytes?: number} = {}) {
  const result = new Map<string, Buffer>();
  visitDistributionAssets(directory, options, (name, bytes) => result.set(name, bytes));
  return result;
}

