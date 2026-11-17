/** Opt-in release artifact validation. Not a sandbox for untrusted Wasm. */
import {createHash} from 'node:crypto';
import {loadCoreFiles, CORE_FILE_FUNCTIONS} from '../../sods/runtime/core/files.ts';

export const FILE_CORE_ABI = 4;
export const FILE_CORE_LIMIT = 0x7fffffff;
/** Remove only these flags; reject malformed explicit selection before root work. */
export function fileCoreOptions(args: string[]): {path: string; maxFileBytes: number} | null {
  const take = (name: string): string | undefined => {
    const positions = args.flatMap((a, i) => a === name ? [i] : []);
    if (positions.length > 1) throw new Error(`Duplicate ${name}`);
    if (!positions.length) return undefined;
    const at = positions[0], value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    args.splice(at, 2); return value;
  };
  const path = take('--file-core'), limit = take('--file-core-limit');
  if (path === undefined) {
    if (limit !== undefined) throw new Error('--file-core-limit requires --file-core');
    return null;
  }
  const maxFileBytes = limit === undefined ? FILE_CORE_LIMIT : Number(limit);
  if (limit !== undefined && !/^\d+$/.test(limit) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > FILE_CORE_LIMIT) {
    throw new Error('file-core limit must be an integer in 0..2147483647');
  }
  return {path, maxFileBytes};
}
export async function validateFileCore(input: Uint8Array, maxFileBytes: number) {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > FILE_CORE_LIMIT) throw new Error('Invalid file-core limit');
  const bytes = new Uint8Array(input), module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('File core must not import host capabilities');
  const exports = new Map(WebAssembly.Module.exports(module).map(x => [x.name, x.kind]));
  if (exports.get('memory') !== 'memory' || CORE_FILE_FUNCTIONS.some(name => exports.get(name) !== 'function')) {
    throw new Error('File core is missing required ABI exports');
  }
  // One instance, selected ABI checked by the same facade the consumer uses.
  const store = await loadCoreFiles(module, maxFileBytes);
  const file = store.create(new Uint8Array(0));
  try {
    if (file.read(0, 0).length !== 0) throw new Error('File core empty-read smoke failed');
  } finally { file.close(); }
  return {bytes, abi: 4 as const, maxFileBytes, wasm: createHash('sha256').update(bytes).digest('hex')};
}
/** Reuse the release builder's content-addressed gzip writer. */
export function fileCoreDescriptor(core: Awaited<ReturnType<typeof validateFileCore>>,
  blob: (bytes: Uint8Array) => {path: string; sha256: string; size: number; bytes: number}) {
  return {abi: core.abi, maxFileBytes: core.maxFileBytes, wasm: core.wasm, ...blob(core.bytes)};
}
