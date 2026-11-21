// Prepared root values passed to execution workers; not the on-disk manifest.
import type {Segment} from '../../sods/runtime/translate.ts';
import type {About, Index} from '../format/manifest.ts';
export type {Segment};
export type {Blob, About, Translation, Index} from '../format/manifest.ts';
export interface RootContext {
  about: About;
  index: Index;
  translator: WebAssembly.Module;
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

/** Legacy materialized hot files remain byte-bearing. */
export interface Webroot extends RootContext {
  /**
   * What the Worker is given beside the packs: each hot program at its own path in the root, with its translation
   * (its module, its data kept outside it, and whether its memory is shared: threads in Workers of their own). Its
   * bytes are the root's own (checked against its digest), so the Worker puts them in the root's file (`root`), which
   * each of its names shares: git's commands are names of git, and each runs git's translation.
   */
  files: {path: string; bytes: Uint8Array; module: WebAssembly.Module | null; mode: number; segments: Segment[] | null; shared: boolean; root?: boolean; more?: More[]}[];
}

/** A compiled artifact associated with a canonical lazy source, never a file overlay. */
export interface PreparedExecutable {
  generation: string;
  key: string;
  path: string;
  source: {origin: string; sha256: string; size: number; binding: 'explicit' | 'legacy-derived'};
  artifact: {sha256: string; translator: string; mode: 'whole'};
  module: WebAssembly.Module;
  segments: Segment[] | null;
  shared: boolean;
  more?: More[];
}
export interface PreparedRoot extends RootContext {
  profile: 'canonical-aot-v1';
  generation: string;
  executables: PreparedExecutable[];
}
