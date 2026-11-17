// The root as a page reads it, in its shapes: what webroot.json says (About), its index (Index: packs, directories,
// links, files, the translator and what is translated ahead), and the root loaded (Webroot: what a Worker is given).
import type {Segment} from '../../sods/runtime/translate.ts';
export type {Segment};
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
/** Explicit artifact selection. Omission uses legacy storage; a supplied invalid
 * artifact fails preparation and never falls back to a different owner. */
export interface FileStoreArtifact {
  module: WebAssembly.Module | BufferSource;
  maxFileBytes: number;
}
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
export interface Webroot {
  fileStore?: FileStoreArtifact;
  about: About;
  index: Index;
  translator: WebAssembly.Module;
  /**
   * What the Worker is given beside the packs: each hot program at its own path in the root, with its translation
   * (its module, its data kept outside it, and whether its memory is shared: threads in Workers of their own). Its
   * bytes are the root's own (checked against its digest), so the Worker puts them in the root's file (`root`), which
   * each of its names shares: git's commands are names of git, and each runs git's translation.
   */
  files: {path: string; bytes: Uint8Array; module: WebAssembly.Module | null; mode: number; segments: Segment[] | null; shared: boolean; root?: boolean; more?: More[]}[];
  /** Where the packs are (the Worker reads them under packs/). */
  url: string;
  /**
   * The maker of a box (muk: an x86-64 Linux program, as every program of the root is), where the root is served
   * with one beside it (muk.json: its place and digest): what runs the root runs it in a box this makes, translated
   * as the root's programs are. It is beside the root, not in it, until a root is released that carries it.
   */
  muk: Uint8Array | null;
}
export interface More { module: WebAssembly.Module; bytes: Uint8Array; base: number }

/** Reject the unreleased old selection name before it can silently downgrade
 * a selected Rust store to the legacy payload path. Rebuild those distributions. */
export function requireFileStoreName(input: object): void {
  if ('fileCore' in input) throw new Error('fileCore is an obsolete selection name; use fileStore and regenerate the prepared distribution');
}
