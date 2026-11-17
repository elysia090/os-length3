/** Resolve only the descriptor in the verified current index. A stale startup
 * plan is a cache hint, never authority to select another core generation. */
import type {CoreDescriptor} from './shape.ts';
import type {FileCore} from './prepared-tree.ts';
import {digest} from './fetch.ts';
import {prepareFileCore} from '../../sods/runtime/linux.ts';
export async function releaseFileCore(
  descriptor: CoreDescriptor | undefined,
  read: (descriptor: CoreDescriptor) => Promise<Uint8Array>,
  explicit?: FileCore,
): Promise<FileCore | undefined> {
  if (descriptor === undefined) return explicit;
  if (explicit) throw new Error('File core is selected by this release; a separate caller selection is not allowed');
  if (descriptor === null || typeof descriptor !== 'object' || descriptor.abi !== 4 || !Number.isInteger(descriptor.maxFileBytes) || descriptor.maxFileBytes < 0 || descriptor.maxFileBytes > 0x7fffffff
      || !/^[0-9a-f]{64}$/.test(descriptor.wasm) || !/^[0-9a-f]{64}$/.test(descriptor.sha256)
      || descriptor.path !== `blobs/${descriptor.sha256}.bin`
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 8 || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
    throw new Error('Invalid release file-core descriptor');
  }
  // The reader verifies the compressed blob. Independently bind the expanded
  // executable bytes and size before compile; no guessing an adjacent artifact.
  const bytes = await read(descriptor);
  if (bytes.length !== descriptor.bytes || await digest(bytes) !== descriptor.wasm) throw new Error('Release file-core content mismatch');
  const module = await prepareFileCore(bytes as BufferSource, descriptor.maxFileBytes);
  return {module, maxFileBytes: descriptor.maxFileBytes};
}
