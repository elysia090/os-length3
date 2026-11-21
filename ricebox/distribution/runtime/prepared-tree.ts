import {requireStandardFileOwner} from '../format/manifest.ts';
import {Vfs, mountTarget, provide, captureExecutableSource, type ExecutableSource} from '../../sods/runtime/linux.ts';
import {mountPack, type Given, type Packed, type Reading} from '../format/mount.ts';

export interface PreparedTree {
  vfs: Vfs;
  /** Realm-local identities captured before any supplied overlay. */
  sources: ReadonlyMap<string, ExecutableSource>;
}

export function prepareTree(options: {
  root?: {index: Packed; reading: Reading};
  files?: Given[];
  captureSources?: readonly {path: string; origin: string; size: number}[];
  muk: Uint8Array | null | undefined;
}): PreparedTree {
  const {root, files = [], muk, captureSources} = options;
  if (root) requireStandardFileOwner(root.index);
  if (!muk) throw new Error('The selected web root has no Muk artifact');
  const vfs = new Vfs();
  if (root) mountPack(mountTarget(vfs), root.index, root.reading);

  const sources = new Map<string, ExecutableSource>();
  for (const source of captureSources ?? []) {
    if (!sources.has(source.origin)) sources.set(source.origin, captureExecutableSource(vfs, source.path, source));
  }
  for (const file of files) {
    if (captureSources) {
      if (file.root) throw new Error('Prepared executable overlays cannot claim canonical root bytes');
      vfs.writeFile(file.path, file.bytes, file.mode);
    } else {
      provide(vfs, file);
    }
  }
  vfs.writeFile('/run/box/muk', muk, 0o755);
  return {vfs, sources};
}
