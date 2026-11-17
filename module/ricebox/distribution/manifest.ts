// Stored distribution descriptors. No execution objects or runtime dependencies.
export interface Blob { path: string; sha256: string; size: number; bytes: number }
export interface About {
  name: string; version: string;
  /** The root this why was made from, by the digest why/prompt/roots pins: the same as the app's. */
  sha256: string; bytes: number; file: string;
  root: {name: string; profile: string};
  index: {path: string; sha256: string; size: number};
  translator: {name: string; version: string};
}
export interface Translation { path: string; sha256: string; elf: Blob; wasm: Blob }
export interface FileStoreDescriptor extends Blob {
  abi: 4;
  wasm: string;
  maxFileBytes: number;
}
export interface Index {
  /** When present this release requires the matching Rust file owner. */
  fileStore?: FileStoreDescriptor;
  name: string; version: string; sha256: string; codec: string;
  packs: {name: string; owner: string; bytes: number}[];
  dirs: {path: string; mode: number}[];
  links: {path: string; target: string}[];
  files: {path: string; mode: number; size: number; pack: number; at: number; len: number; raw?: boolean}[];
  translator: Blob & {name: string; version: string; wasm: string};
  translations: Translation[];
}
/** Reject the unreleased old selection name before it can silently downgrade
 * a selected Rust store to the legacy payload path. Rebuild those distributions. */
export function requireFileStoreName(input: object): void {
  if ('fileCore' in input) throw new Error('fileCore is an obsolete selection name; use fileStore and regenerate the prepared distribution');
}
