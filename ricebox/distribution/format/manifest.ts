// Stored distribution descriptors. No execution objects or runtime dependencies.
export interface StoredBlob { path: string; sha256: string; size: number }
export interface Blob extends StoredBlob { bytes: number }
export interface About {
  name: string; version: string;
  /** Digest and size of the native root archive from which these layers were built. */
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
export interface ExecutableArtifact {
  path: string; sha256: string; wasm: Blob;
  /** Omitted by older trusted producers; malformed present metadata is never a legacy fallback. */
  association?: TranslationAssociation;
}
export interface Translation extends ExecutableArtifact { elf: Blob }
export interface WebExecution {
  maker: StoredBlob;
  programs: (ExecutableArtifact & {association: TranslationAssociation})[];
}
export interface Index {
  name: string; version: string; sha256: string; codec: string;
  packs: {name: string; owner: string; bytes: number}[];
  dirs: {path: string; mode: number}[];
  links: {path: string; target: string}[];
  files: {path: string; mode: number; size: number; pack: number; at: number; len: number; raw?: boolean}[];
  translator: Blob & {name: string; version: string; wasm: string};
  translations: Translation[];
  /** The published Wasm for the maker and each distinct executable source in the packs. */
  execution?: WebExecution;
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

/** The canonical, content-addressed index descriptor carried by a release. */
export function releaseIndexAsset(about: unknown): About['index'] {
  if (!about || typeof about !== 'object' || !('index' in about)) throw new Error('ricebox: invalid index descriptor');
  const asset = about.index;
  if (!asset || typeof asset !== 'object' || !('sha256' in asset) || typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) || !('path' in asset) || asset.path !== `index-${asset.sha256}.json` ||
      !('size' in asset) || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0) {
    throw new Error('ricebox: invalid index descriptor');
  }
  return {path: asset.path, sha256: asset.sha256, size: asset.size};
}

/** Bind already authenticated index bytes to this release and the standard VFS. */
export function readReleaseIndex(bytes: Uint8Array, about: Pick<About, 'sha256' | 'version'>): Index {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ricebox: invalid distribution index');
  requireStandardFileOwner(value);
  if (!('sha256' in value) || typeof value.sha256 !== 'string' || value.sha256 !== about.sha256 ||
      !('version' in value) || typeof value.version !== 'string' || value.version !== about.version) {
    throw new Error('ricebox: distribution and index disagree');
  }
  if ('execution' in value) validateWebExecution(value as Index);
  return value as Index;
}

/** Also used at Worker admission, where the index arrives by structured clone. */
export function validateWebExecution(index: Index): void {
  const execution = index.execution;
  if (!execution || typeof execution !== 'object' || !Array.isArray(execution.programs) ||
      !Array.isArray(index.translations) || index.translations.length) {
    throw new Error('ricebox: invalid Web execution inventory');
  }
  blobAsset(execution.maker);
  for (const entry of execution.programs) {
    if (!entry || typeof entry !== 'object' || !entry.association || !Number.isSafeInteger(entry.wasm?.bytes) || entry.wasm.bytes < 8) {
      throw new Error('ricebox: invalid Web program descriptor');
    }
    blobAsset(entry.wasm);
  }
}

/** A release blob's path names its stored-byte digest, independent of decompression. */
export function blobAsset(value: unknown): StoredBlob {
  if (!value || typeof value !== 'object' || !('sha256' in value) || typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256) || !('path' in value) || value.path !== `blobs/${value.sha256}.bin` ||
      !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error('ricebox: invalid blob descriptor');
  }
  return {path: value.path, sha256: value.sha256, size: value.size};
}
