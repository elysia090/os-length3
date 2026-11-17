// Prepared root values passed to execution workers; not the on-disk manifest.
import type {Segment} from '../../sods/runtime/translate.ts';
import type {About, Index} from '../distribution/manifest.ts';
export type {Segment};
export {requireFileStoreName} from '../distribution/manifest.ts';
export type {Blob, About, Translation, FileStoreDescriptor, Index} from '../distribution/manifest.ts';
/** Explicit artifact selection. Omission uses legacy storage; a supplied invalid
 * artifact fails preparation and never falls back to a different owner. */
export interface FileStoreArtifact {
  module: WebAssembly.Module | BufferSource;
  maxFileBytes: number;
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
