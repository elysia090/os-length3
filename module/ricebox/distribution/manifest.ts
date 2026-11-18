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
export interface FileStoreDescriptor extends Blob {
  abi: 4;
  wasm: string;
  maxFileBytes: number;
}
/** Private opt-in Node capture slot. Ordinary distribution loading ignores it. */
export interface CaptureResultDescriptor extends Blob {
  kind: 'sods-linux-capture-result-v3';
  host: 'linux-x64-node22-24';
  /** Expanded executable digest, independent of the content-addressed gzip. */
  wasm: string;
}
const captureOutputArtifactLimit = 32 * 1024 * 1024;
const captureDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const captureExtent = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= captureOutputArtifactLimit;

/** Shape only. Trusted index selection and byte verification belong to the
 * caller. Absence is handled by policy, not a fallback on malformed input. */
export function checkedCaptureResultDescriptor(input: unknown): CaptureResultDescriptor {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid or missing capture result descriptor');
  }
  const {kind, host, path, sha256, size, bytes, wasm} = input as Partial<CaptureResultDescriptor>;
  if (kind !== 'sods-linux-capture-result-v3' || host !== 'linux-x64-node22-24' ||
      !captureDigest(sha256) || !captureDigest(wasm) || path !== `blobs/${sha256}.bin` ||
      !captureExtent(size, 1) || !captureExtent(bytes, 8)) {
    throw new Error('Invalid or missing capture result descriptor');
  }
  return {kind, host, path, sha256, wasm, size, bytes};
}

export interface Index {
  captureResult?: CaptureResultDescriptor;
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
