/** Opt-in release artifact validation. Not a sandbox for untrusted Wasm. */
import {createHash} from 'node:crypto';
import {prepareFileStore} from '../../sods/runtime/file-store.ts';

export const FILE_STORE_ABI = 4;
export const FILE_STORE_LIMIT = 0x7fffffff;
/** Remove only these flags; reject malformed explicit selection before root work. */
export function fileStoreOptions(args: string[]): {path: string; maxFileBytes: number} | null {
  if (args.some(arg => arg === '--file-core' || arg === '--file-core-limit')) throw new Error('Obsolete --file-core selection; use --file-store and --file-store-limit and regenerate the distribution');
  const take = (name: string): string | undefined => {
    const positions = args.flatMap((a, i) => a === name ? [i] : []);
    if (positions.length > 1) throw new Error(`Duplicate ${name}`);
    if (!positions.length) return undefined;
    const at = positions[0], value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    args.splice(at, 2); return value;
  };
  const path = take('--file-store'), limit = take('--file-store-limit');
  if (path === undefined) {
    if (limit !== undefined) throw new Error('--file-store-limit requires --file-store');
    return null;
  }
  const maxFileBytes = limit === undefined ? FILE_STORE_LIMIT : Number(limit);
  if (limit !== undefined && !/^\d+$/.test(limit) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > FILE_STORE_LIMIT) {
    throw new Error('file-store limit must be an integer in 0..2147483647');
  }
  return {path, maxFileBytes};
}
export async function validateFileStore(input: Uint8Array, maxFileBytes: number) {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > FILE_STORE_LIMIT) throw new Error('Invalid file-store limit');
  const bytes = new Uint8Array(input);
  await prepareFileStore(bytes, maxFileBytes);
  return {bytes, abi: 4 as const, maxFileBytes, wasm: createHash('sha256').update(bytes).digest('hex')};
}
/** Reuse the release builder's content-addressed gzip writer. */
export function fileStoreDescriptor(store: Awaited<ReturnType<typeof validateFileStore>>,
  blob: (bytes: Uint8Array) => {path: string; sha256: string; size: number; bytes: number}) {
  return {abi: store.abi, maxFileBytes: store.maxFileBytes, wasm: store.wasm, ...blob(store.bytes)};
}
