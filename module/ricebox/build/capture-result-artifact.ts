// Explicit offline release inclusion only. A valid build never selects a
// capture host by itself. Retain the artifact's marker and exact bytes.
import {sha256} from '../host/node/hash.ts';
import type {Blob, CaptureResultDescriptor} from '../distribution/manifest.ts';
import {validateCaptureResultModule} from '../../sods/runtime/linux.ts';

export const CAPTURE_RESULT_ARTIFACT_LIMIT = 32 * 1024 * 1024;
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);

export function captureResultOptions(args: string[]): {path: string; sha256: string} | undefined {
  const take = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    if (at !== args.lastIndexOf(name)) throw new Error(`Duplicate ${name}`);
    const value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    args.splice(at, 2);
    return value;
  };
  const path = take('--capture-result'), expected = take('--capture-result-sha256');
  if (path === undefined && expected === undefined) return undefined;
  if (!path || !expected || !digest(expected)) {
    throw new Error('Capture result inclusion requires --capture-result and a trusted --capture-result-sha256');
  }
  return {path, sha256: expected};
}

export function validateCaptureResultArtifact(input: Uint8Array, expected: string) {
  if (!digest(expected) || input.length < 8 || input.length > CAPTURE_RESULT_ARTIFACT_LIMIT) {
    throw new Error('Invalid capture result artifact size or pin');
  }
  const bytes = new Uint8Array(input);
  if (sha256(bytes) !== expected) throw new Error('Capture result artifact digest mismatch');
  const module = new WebAssembly.Module(bytes);
  validateCaptureResultModule(module);
  return {bytes, wasm: expected};
}

export function captureResultDescriptor(artifact: ReturnType<typeof validateCaptureResultArtifact>,
  blob: (bytes: Uint8Array) => Blob): CaptureResultDescriptor {
  return {kind: 'sods-linux-capture-result-v6', host: 'linux-x64-node22-24',
    wasm: artifact.wasm, ...blob(artifact.bytes)};
}
