// Types for pack.mjs, as os/scripts reads them (l3-runnable.ts).
import type {Vfs} from './fs.mjs';

/** l3's index, as far as mounting it reads it (os/app/prompt/userland.ts Index has all of it). */
export interface Packed {
  codec: string;
  packs: {name: string; bytes: number}[];
  dirs: {path: string; mode: number}[];
  links: {path: string; target: string}[];
  files: {path: string; mode: number; size: number; pack: number; at: number; len: number; raw?: boolean}[];
}
export function mountPack(vfs: Vfs, index: Packed, how: {range: (pack: string, at: number, len: number) => Uint8Array;
  decode: (bytes: Uint8Array) => Uint8Array; sha256: (bytes: Uint8Array) => Uint8Array}, at?: string): void;
export function provide(vfs: Vfs, file: {path: string; bytes: Uint8Array; mode?: number; root?: boolean}): void;
