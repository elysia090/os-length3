/** Prepared root ownership: the tree outlives individual rehearsals/runs. */
import {requireFileStoreName} from './shape.ts';
import {Vfs, mountTarget, provide, loadFileScope} from '../../sods/runtime/linux.ts';
import {mountPack, type Given, type Packed, type Reading} from './mount.ts';

/** Explicit artifact selection. Omission uses legacy storage; a supplied invalid
 * artifact fails preparation and never falls back to a different owner. */
export interface FileStoreArtifact {
  module: WebAssembly.Module | BufferSource;
  maxFileBytes: number;
}
export interface PreparedTree {
  vfs: Vfs;
  /** Only after all kernels, images, mappings and embedding users have ended.
   * A Worker may instead end the entire owning realm. Not a per-run cleanup. */
  dispose(): void;
}
export async function prepareTree(options: {
  fileStore?: FileStoreArtifact;
  root?: {index: Packed; reading: Reading};
  files?: Given[];
  muk: Uint8Array | null | undefined;
}): Promise<PreparedTree> {
  requireFileStoreName(options);
  if ('core' in options) throw new Error('core is an obsolete selection name; use fileStore and regenerate the prepared distribution');
  const {fileStore, root, files = [], muk} = options;
  if (root) requireFileStoreName(root.index);
  if (fileStore !== undefined && (fileStore === null || typeof fileStore !== 'object')) throw new Error('Invalid file-store artifact selection');
  if (!muk) throw new Error('This root is served with no muk beside it (module/ricebox/make/muk.ts puts it there)');
  const scope = fileStore !== undefined ? await loadFileScope(fileStore.module, fileStore.maxFileBytes) : null;
  const vfs = new Vfs();
  try {
    if (root) mountPack(scope ? scope.mountTarget(vfs) : mountTarget(vfs), root.index, root.reading);
    for (const file of files) provide(vfs, file);
    // Ordinary guest-created/non-pack files are not silently promoted yet.
    vfs.writeFile('/run/box/muk', muk, 0o755);
    return {vfs, dispose() { scope?.dispose(); }};
  } catch (error) {
    try { scope?.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Root preparation and cleanup failed'); }
    throw error;
  }
}
