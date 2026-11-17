/** Resolve only the descriptor in the verified current index. A stale startup
 * plan is a cache hint, never authority to select another file-store generation. */
import type {FileStoreDescriptor} from './shape.ts';
import type {FileStoreArtifact} from './prepared-tree.ts';
import {digest} from './fetch.ts';
import {prepareFileStore} from '../../sods/runtime/linux.ts';
export async function releaseFileStore(
  descriptor: FileStoreDescriptor | undefined,
  read: (descriptor: FileStoreDescriptor) => Promise<Uint8Array>,
  explicit?: FileStoreArtifact,
): Promise<FileStoreArtifact | undefined> {
  if (explicit !== undefined && (explicit === null || typeof explicit !== 'object')) throw new Error('Invalid file-store artifact selection');
  if (descriptor === undefined) return explicit;
  if (explicit !== undefined) throw new Error('File store is selected by this release; a separate caller selection is not allowed');
  if (descriptor === null || typeof descriptor !== 'object' || descriptor.abi !== 4 || !Number.isInteger(descriptor.maxFileBytes) || descriptor.maxFileBytes < 0 || descriptor.maxFileBytes > 0x7fffffff
      || !/^[0-9a-f]{64}$/.test(descriptor.wasm) || !/^[0-9a-f]{64}$/.test(descriptor.sha256)
      || descriptor.path !== `blobs/${descriptor.sha256}.bin`
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 8 || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
    throw new Error('Invalid release file-store descriptor');
  }
  // The reader verifies the compressed blob. Independently bind the expanded
  // executable bytes and size before compile; no guessing an adjacent artifact.
  const bytes = await read(descriptor);
  if (bytes.length !== descriptor.bytes || await digest(bytes) !== descriptor.wasm) throw new Error('Release file-store content mismatch');
  const module = await prepareFileStore(bytes as BufferSource, descriptor.maxFileBytes);
  return {module, maxFileBytes: descriptor.maxFileBytes};
}
