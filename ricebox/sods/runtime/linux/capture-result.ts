// The Linux entry snapshots the selected input before its first await.
import {isNode, sha256} from '../host.ts';
import {ownedInput, validateCaptureResultIdentity, type CaptureResultPolicy} from './admission-wire.ts';

const Module = WebAssembly.Module, apply = Reflect.apply;
const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
const lengthOf = (bytes: Uint8Array): number => apply(length, bytes, []);

/** Supplied by the trusted build/deployment owner, not by the artifact source. */
export interface CaptureResultPin {
  readonly kind: 'sods-linux-capture-result-v6';
  readonly byteLength: number;
  readonly sha256: string;
}
/** Explicit experimental opt-in, not the default managedRoot or product terminal.
 * The independent pin and exact owned snapshot are verified before any Core
 * instance exists. No raw Module or structural "verified" value can enter. */
export async function capturedResultHost(input: Uint8Array, pin: CaptureResultPin, memories: number, actions: number,
  policy: CaptureResultPolicy) {
  if (!isNode || process.platform !== 'linux' || process.arch !== 'x64' || ![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
    throw new Error('Captured result requires reviewed Linux x64 Node 22 or 24');
  }
  const {kind, byteLength, sha256: expected} = pin;
  if (kind !== 'sods-linux-capture-result-v6' || !Number.isSafeInteger(byteLength) || byteLength < 8 ||
      byteLength > 32 * 1024 * 1024 || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new TypeError('Invalid trusted captured result pin');
  }
  // Snapshot scalars before either artifact hashing or future callbacks.
  const {maximumRequest, queueBytes, borrowStdin} = policy;
  if (borrowStdin !== undefined && borrowStdin !== true) throw new TypeError('Expected explicit capture stdin loan');
  if (!Number.isSafeInteger(maximumRequest) || !Number.isSafeInteger(queueBytes) ||
      maximumRequest < 1 || maximumRequest > queueBytes || queueBytes > 64 * 1024) {
    throw new RangeError('Invalid trusted captured result capacity');
  }
  if (lengthOf(input) !== byteLength) throw new Error('Captured result artifact length mismatch');
  const bytes = ownedInput(input);
  if (lengthOf(bytes) !== byteLength) throw new Error('Captured result artifact length changed');
  const actual = Array.from(await sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Captured result artifact digest mismatch');
  const module = new Module(bytes);
  validateCaptureResultIdentity(module);
  const {createCapturedResultHost} = await import('./memory-host.ts');
  return createCapturedResultHost(module, memories, actions, {maximumRequest, queueBytes, borrowStdin});
}
