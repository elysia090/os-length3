// Connect composition and checked distribution assets to Vite's build hooks.
import {prepareDistribution, type PrepareOptions} from '../build/prepare.ts';
import {distributionAssets} from '../deployment/assets.ts';
// Preserve the existing ricebox/vite named export; the implementation is bundler-independent.
export {distributionAssets} from '../deployment/assets.ts';

export default function ricebox({distribution, build, base = 'ricebox', maxAssetBytes}: {distribution?: string; build?: PrepareOptions; base?: string; maxAssetBytes?: number} = {}) {
  if (distribution && build) throw new Error('ricebox: choose distribution or build, not both');
  let prepared = distribution;
  return {
    name: 'ricebox',
    async buildStart() {
      if (build) prepared = await prepareDistribution(build);
    },
    config() { return {worker: {format: 'es'}}; },
    generateBundle(this: {emitFile(asset: {type: 'asset'; fileName: string; source: Uint8Array}): unknown}) {
      if (!prepared) return;
      const assets = distributionAssets(prepared, {base, maxAssetBytes});
      for (const [fileName, source] of assets) this.emitFile({type: 'asset', fileName, source});
    },
  };
}
