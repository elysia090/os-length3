// Private release transport; does not compile, choose an ordinary host, or
// install a Worker. The deployment caller, not its blob reader or startup
// cache, supplies the pin of the current index.
import {gunzipSync} from 'node:zlib';
import type {CaptureResultDescriptor} from '../distribution/manifest.ts';
import {sha256} from '../host/node/hash.ts';

const maximum = 32 * 1024 * 1024;
const kind = 'sods-linux-capture-result-v3';
const host = 'linux-x64-node22-24';
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const extent = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= maximum;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const ordinaryLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const apply = Reflect.apply;

// The caller uses this view only in the current synchronous turn. Shared
// backing could still change during hashing and decoding and is never admitted.
function localView(input: Uint8Array, expected: number, mismatch: string): Uint8Array<ArrayBuffer> {
  if (apply(byteLength, input, []) !== expected) throw new Error(mismatch);
  const backing: ArrayBuffer = apply(buffer, input, []);
  try { apply(ordinaryLength, backing, []); }
  catch { throw new TypeError('Capture release bytes require ordinary ArrayBuffer backing'); }
  return new Uint8Array(backing, apply(byteOffset, input, []), expected);
}

/** This identifies a current index already selected by the caller's trust
 * policy. It is neither a signature verifier nor a rollback policy. */
export async function readCapturedResultRelease(
  current: {readonly sha256: string; readonly size: number},
  indexInput: Uint8Array,
  readStored: (path: string, size: number) => Promise<Uint8Array>,
) {
  const {sha256: indexSha256, size: indexSize} = current;
  if (!hash(indexSha256) || !extent(indexSize, 2)) throw new TypeError('Invalid trusted capture release index pin');
  const indexBytes = localView(indexInput, indexSize, 'Capture release index content mismatch');
  if (sha256(indexBytes) !== indexSha256) throw new Error('Capture release index content mismatch');

  const index: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(indexBytes));
  const raw = record(index) && Object.hasOwn(index, 'captureResult') ? index.captureResult : undefined;
  if (!record(raw) || raw.kind !== kind || raw.host !== host || !hash(raw.sha256) || !hash(raw.wasm) ||
      raw.path !== `blobs/${raw.sha256}.bin` || !extent(raw.size, 1) || !extent(raw.bytes, 8)) {
    throw new Error('Invalid or missing capture result descriptor');
  }
  const descriptor: CaptureResultDescriptor = {
    kind, host, path: raw.path, sha256: raw.sha256, wasm: raw.wasm, size: raw.size, bytes: raw.bytes,
  };
  const mismatch = 'Capture release stored blob content mismatch';
  const stored = localView(await readStored(descriptor.path, descriptor.size), descriptor.size, mismatch);
  if (sha256(stored) !== descriptor.sha256) throw new Error(mismatch);
  let bytes: Uint8Array;
  try { bytes = gunzipSync(stored, {maxOutputLength: descriptor.bytes}); }
  catch (cause) {
    if (record(cause) && cause.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error('Capture release expansion exceeded verified bounds', {cause});
    }
    throw new Error('Invalid capture release gzip', {cause});
  }
  if (bytes.length !== descriptor.bytes) throw new Error('Capture release expanded Wasm length mismatch');
  // The Sods admission adapter checks the expanded digest of the exact
  // snapshot it compiles. Do not hash it twice or return a compiled module.
  // Node 24 can place a small result in the same slab as a caller Buffer.
  // Never expose the slab, even if the two logical regions do not overlap.
  const owned = new Uint8Array(bytes);
  return {indexSha256, bytes: owned, pin: Object.freeze({kind, byteLength: descriptor.bytes, sha256: descriptor.wasm})};
}
