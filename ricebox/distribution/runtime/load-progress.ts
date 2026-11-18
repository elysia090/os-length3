import type {StoredBlob} from '../format/manifest.ts';
import type {Progress} from './download.ts';

export type Stage =
  | {at: 'fetch'; got: number; of: number; quiet?: number}
  | {at: 'retry'; attempt: number; why: string; got: number; of: number}
  | {at: 'prepare'}
  | {at: 'ready'}
  | {at: 'failed'; message: string};

export interface AssetProgress extends Progress {
  verified(): void;
}

/** Report unique stored assets, not the logical uses of those bytes. */
export function trackTransfers(blobs: readonly StoredBlob[], tell: (stage: Stage) => void) {
  const assets = new Map<string, {size: number; got: number; verified: boolean}>();
  let of = 0, got = 0, verified = 0, stopped = false;
  for (const {path, size} of blobs) {
    const asset = assets.get(path);
    if (asset) {
      if (asset.size !== size) throw new Error(`webroot: ${path} has conflicting sizes`);
      continue;
    }
    assets.set(path, {size, got: 0, verified: false});
    of += size;
  }
  tell({at: 'fetch', got, of});
  function forBlob(blob: StoredBlob): AssetProgress {
    const asset = assets.get(blob.path)!;
    const active = () => !stopped && !asset.verified;
    const bytes = (n: number) => {
      if (!active()) return;
      const size = Math.min(asset.size, n);
      if (size === asset.got) return;
      got += size - asset.got;
      asset.got = size;
      tell({at: 'fetch', got, of});
    };
    return {
      bytes,
      retry(attempt, why) { if (active()) tell({at: 'retry', attempt, why, got, of}); },
      waiting(quiet) { if (active()) tell({at: 'fetch', got, of, quiet}); },
      verified() {
        if (!active()) return;
        bytes(asset.size);
        asset.verified = true;
        if (++verified === assets.size) tell({at: 'prepare'});
      },
    };
  }
  return {forBlob, stop() { stopped = true; }};
}
