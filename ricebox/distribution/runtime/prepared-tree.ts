/** Prepared root ownership: the tree outlives individual rehearsals/runs. */
import {requireFileStoreName, type FileStoreArtifact} from './root-types.ts';
import {Vfs, mountTarget, provide, loadFileScope, captureExecutableSource, type ExecutableSource} from '../../sods/runtime/linux.ts';
import {mountPack, type Given, type Packed, type Reading} from '../format/mount.ts';

export type {FileStoreArtifact} from './root-types.ts';
export interface PreparedTree {
  vfs: Vfs;
  /** Canonical sources captured before any supplied overlay. Realm-local sods capabilities. */
  sources: ReadonlyMap<string, ExecutableSource>;
  /** Only after all kernels, images, mappings and embedding users have ended.
   * A Worker may instead end the entire owning realm. Not a per-run cleanup. */
  dispose(): void;
}
export async function prepareTree(options: {
  fileStore?: FileStoreArtifact;
  root?: {index: Packed; reading: Reading};
  files?: Given[];
  captureSources?: readonly {path: string; origin: string; size: number}[];
  muk: Uint8Array | null | undefined;
}): Promise<PreparedTree> {
  requireFileStoreName(options);
  if ('core' in options) throw new Error('core is an obsolete selection name; use fileStore and regenerate the prepared distribution');
  const {fileStore, root, files = [], muk} = options;
  if (root) requireFileStoreName(root.index);
  if (fileStore !== undefined && (fileStore === null || typeof fileStore !== 'object')) throw new Error('Invalid file-store artifact selection');
  if (!muk) throw new Error('The selected web root has no Muk artifact');
  const scope = fileStore !== undefined ? await loadFileScope(fileStore.module, fileStore.maxFileBytes) : null;
  const vfs = new Vfs();
  try {
    if (root) mountPack(scope ? scope.mountTarget(vfs) : mountTarget(vfs), root.index, root.reading);
    const sources = new Map<string, ExecutableSource>();
    for (const source of options.captureSources ?? []) {
      if (!sources.has(source.origin)) sources.set(source.origin, captureExecutableSource(vfs, source.path, source));
    }
    for (const file of files) {
      if (options.captureSources) {
        if (file.root) throw new Error('Prepared executable overlays cannot claim canonical root bytes');
        vfs.writeFile(file.path, file.bytes, file.mode);
      } else provide(vfs, file);
    }
    // Ordinary guest-created/non-pack files are not silently promoted yet.
    vfs.writeFile('/run/box/muk', muk, 0o755);
    return {vfs, sources, dispose() { scope?.dispose(); }};
  } catch (error) {
    try { scope?.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Root preparation and cleanup failed'); }
    throw error;
  }
}
