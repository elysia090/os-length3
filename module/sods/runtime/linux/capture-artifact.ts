/** Private Node-side admission of the capture-v1 *candidate*, not a caller.
 * The trusted deployment/build catalog must supply the pin independently of
 * artifact bytes. No guest, instance, file, or ordinary fallback is created. */
import {createHash} from 'node:crypto';

export interface CaptureCandidatePin {
  readonly kind: 'sods-linux-capture-candidate-v1';
  readonly byteLength: number;
  readonly sha256: string;
}

const Bytes = Uint8Array;
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Bytes.prototype), 'byteLength')!.get!;
const apply = Reflect.apply;
const identity = [83, 79, 68, 83, 67, 65, 80, 0, 7, 1, 1, 0] as const;
const required = ['linux_abi_version', 'linux_init', 'linux_result', 'linux_prepared_files', 'linux_files_seal',
  'linux_capture_candidate', 'linux_capture_select'] as const;

export function verifiedCaptureCandidate(input: Uint8Array, pin: CaptureCandidatePin): WebAssembly.Module {
  const {kind, byteLength: expected, sha256} = pin;
  if (kind !== 'sods-linux-capture-candidate-v1' || !Number.isSafeInteger(expected) || expected < 8 ||
      expected > 32 * 1024 * 1024 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid trusted Linux capture candidate pin');
  }
  if (apply(byteLength, input, []) !== expected) throw new Error('Linux capture candidate length mismatch');
  const owned = new Bytes(input);
  if (owned.byteLength !== expected) throw new Error('Linux capture candidate length changed');
  if (createHash('sha256').update(owned).digest('hex') !== sha256) throw new Error('Linux capture candidate digest mismatch');
  const module = new WebAssembly.Module(owned);
  const exports = WebAssembly.Module.exports(module);
  if (exports.some(e => e.name.startsWith('linux_sendfile_probe') || e.name.startsWith('linux_queued_'))) {
    throw new Error('Synthetic probe is not a Linux capture candidate');
  }
  const wire = WebAssembly.Module.customSections(module, 'sods.linux.capture');
  if (wire.length !== 1 || wire[0]!.byteLength !== identity.length ||
      !new Bytes(wire[0]!).every((value, index) => value === identity[index])) {
    throw new Error('Unsupported Linux capture candidate identity');
  }
  const names = new Map(exports.map(e => [e.name, e.kind]));
  if (WebAssembly.Module.imports(module).length || names.get('memory') !== 'memory' ||
      required.some(name => names.get(name) !== 'function') ||
      ['linux_startup_begin', 'linux_startup_begin_stdio', 'linux_capture_startup',
        'linux_execution_create'].some(name => names.has(name))) {
    throw new Error('Unsupported Linux capture candidate surface');
  }
  return module;
}
