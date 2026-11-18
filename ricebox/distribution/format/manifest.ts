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
/** Additive source association for the producer's existing whole-program translation. */
export interface TranslationAssociation {
  version: 1;
  origin: string;
  sourceSha256: string;
  sourceBytes: number;
  mode: 'whole';
}
export interface Translation {
  path: string; sha256: string; elf: Blob; wasm: Blob;
  /** Omitted by older trusted producers; malformed present metadata is never a legacy fallback. */
  association?: TranslationAssociation;
}
export interface Index {
  name: string; version: string; sha256: string; codec: string;
  packs: {name: string; owner: string; bytes: number}[];
  dirs: {path: string; mode: number}[];
  links: {path: string; target: string}[];
  files: {path: string; mode: number; size: number; pack: number; at: number; len: number; raw?: boolean}[];
  translator: Blob & {name: string; version: string; wasm: string};
  translations: Translation[];
}
/**
 * An archive or API request for a different payload owner must not silently
 * change ownership when it is loaded.
 */
export function requireStandardFileOwner(input: object): void {
  if ('fileStore' in input || 'fileCore' in input) {
    throw new Error('Unsupported file owner; use a distribution built for the standard VFS');
  }
}
