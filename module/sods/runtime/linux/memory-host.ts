import {utf8} from './flow.ts';
import {fixedTranslatedModule, fixedTranslatedModuleAsync} from './translated-image.ts';
import {prepare} from '../translation/share.ts';
import {loadTranslator} from '../translation/translator.ts';
import {isNode, sha256} from '../host.ts';
import type {createGuest} from '../host/node/execution.ts';
import type {captureStdio, Endpoint, PhysicalResult} from '../host/node/stdio.ts';
/** Private managed-memory adapter. Rust decides admission and lifetime; this file
 * holds engine objects, performs short synchronous memory operations, and
 * transports asynchronous source results and matching Worker evidence.
 * Not exported by linux.ts. The translated runner is a fixed diagnostic profile,
 * not the Node caller, ELF loader or complete Linux syscall implementation. */
interface Admission extends WebAssembly.Exports {
  linux_prepared_files(inodes: number, entries: number, fileBytes: number, tables: number, descriptions: number, slots: number, reads: number, contexts: number, views: number, holds: number, policy: number): number;
  linux_root_input(length: number): number;
  linux_prepared_root(inodes: number, entries: number, fileBytes: number, tables: number, descriptions: number, slots: number, reads: number, contexts: number, views: number, holds: number, policy: number, fdLimit: number): number;
  linux_root_source(source: number): number;
  linux_root_artifact(artifact: number): number;
  linux_startup_artifact_start(id: bigint): number;
  linux_startup_artifact_finish(id: bigint, artifact: number, success: number, entry: bigint, phdr: bigint, phent: bigint, phnum: bigint, extent: bigint): number;
  linux_startup_input(length: number): number;
  linux_startup_begin(): number;
  linux_startup_begin_stdio(): number;
  linux_stream_start(id: bigint, action: bigint): number;
  linux_stream_receipt(id: bigint, action: bigint, count: bigint, outcome: number): number;
  linux_result_endpoint(): bigint;
  linux_startup_source_start(id: bigint): number;
  linux_startup_source_finish(id: bigint, attempt: number, success: number): number;
  linux_startup_bytes(id: bigint): number;
  linux_startup_translation_finish(id: bigint, success: number, entry: bigint, phdr: bigint, phent: bigint, phnum: bigint, extent: bigint): number;
  linux_startup_image_begin(id: bigint, binding: bigint, low: bigint, top: bigint): number;
  linux_startup_stack(id: bigint): number;
  linux_startup_image_finish(id: bigint, outcome: number): number;
  linux_startup_cancel(id: bigint): number;
  linux_startup_failed_image(id: bigint): number;
  linux_startup_entry(id: bigint): number;
  linux_startup_check(id: bigint): number;
  linux_stack_input(execution: bigint, length: number): number;
  linux_stack_build(execution: bigint): number;
  linux_stack_clear(): number;
  linux_run_start(id: bigint): number;
  linux_run_receipt(id: bigint, invocation: bigint, outcome: number, next: bigint): number;
  linux_syscall(id: bigint, invocation: bigint, nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint): number;
  linux_syscall_sequenced(id: bigint, invocation: bigint, sequence: number, nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint): number;
  linux_task_registration(id: bigint): number;
  linux_register_start(id: bigint, sequence: number, action: bigint, base: bigint): number;
  linux_register_receipt(id: bigint, sequence: number, action: bigint, base: bigint, outcome: number): number;
  linux_sendfile_cap_start(id: bigint, sequence: number, action: bigint): number;
  linux_sendfile_cap_finish(id: bigint, sequence: number, action: bigint, endpoint: bigint, proof: number): number;
  linux_sendfile_load_start(id: bigint, sequence: number, action: bigint): number;
  linux_sendfile_load_finish(id: bigint, sequence: number, action: bigint, source: number, attempt: number, success: number): number;
  linux_sendfile_start(id: bigint, sequence: number, action: bigint): number;
  linux_sendfile_receipt(id: bigint, sequence: number, action: bigint, count: bigint, outcome: number, ended: number): number;
  linux_sendfile_cleanup(id: bigint, sequence: number): number;
  linux_sendfile_query(id: bigint): number;
  linux_syscall_path_start(id: bigint, action: bigint): number;
  linux_syscall_path_finish(id: bigint, action: bigint, actual: bigint, outcome: number): number;
  linux_syscall_complete(id: bigint): number;
  linux_syscall_resumed(id: bigint, completion: number, success: number): number;
  linux_syscall_abandon(id: bigint): number;
  linux_syscall_load_finish(id: bigint, read: bigint, attempt: number, success: number): number;
  linux_result_auxiliary(): bigint;
  linux_abi_version(): number;
  linux_init(memories: number, actions: number): number;
  linux_result(): bigint;
  linux_bind(extent: bigint): number;
  linux_binding_room(): number;
  linux_span(binding: bigint, offset: bigint, length: bigint): number;
  linux_change(binding: bigint, extent: bigint): number;
  linux_start(action: bigint): number;
  linux_receipt(action: bigint, confirmed: bigint, completion: number): number;
  linux_retire(action: bigint): number;
  memory: WebAssembly.Memory;
  linux_files_prepare(inodes: number, entries: number, fileBytes: number, tables: number, descriptions: number, slots: number, reads: number): number;
  linux_name(length: number): number;
  linux_input(length: number): number;
  linux_tree_directory(parent: bigint, mode: number): number;
  linux_tree_file(parent: bigint, mode: number): number;
  linux_tree_symlink(parent: bigint): number;
  linux_files_seal(fdLimit: number): number;
  linux_open(inode: bigint): number;
  linux_dup(fd: number): number;
  linux_close(fd: number): number;
  linux_offset(fd: number): number;
  linux_seek(fd: number, offset: bigint): number;
  linux_read_begin(fd: number, binding: bigint, at: bigint, requested: bigint): number;
  linux_read_start(read: bigint): number;
  linux_read_receipt(read: bigint, confirmed: bigint, completion: number): number;
  linux_read_query(read: bigint): number;
  linux_read_cancel(read: bigint): number;
  linux_read_retire(read: bigint): number;
  linux_result_length(): bigint;
  linux_result_state(): number;
  linux_execution_create(binding: bigint): number;
  linux_execution_retire(execution: bigint): number;
  linux_execution_unstarted_stopped(execution: bigint): number;
  linux_image_begin(execution: bigint, extent: bigint): number;
  linux_image_finish(execution: bigint, outcome: number): number;
  linux_tree_lazy(parent: bigint, mode: number, source: number, size: number): number;
  linux_managed_read_begin(execution: bigint, fd: number, at: bigint, requested: bigint): number;
  linux_read_load_start(execution: bigint, read: bigint): number;
  linux_load_input(length: number): number;
  linux_read_load_finish(execution: bigint, read: bigint, attempt: number, success: number): number;
  linux_managed_read_start(execution: bigint, read: bigint): number;
}
interface ResultAdmission extends WebAssembly.Exports {
  linux_capture_candidate(): number;
  linux_capture_select(profile: number): number;
  linux_capture_result_init(): number;
  linux_capture_result_startup(): number;
  linux_capture_result_resume(execution: bigint, sequence: number, action: bigint): number;
  linux_capture_result_write_start(execution: bigint, sequence: number, action: bigint): number;
  linux_capture_result_write_finish(execution: bigint, sequence: number, action: bigint, evidence: number, count: number): number;
  linux_capture_result_head(): number;
  linux_capture_result_copy_start(slot: number, generation: bigint): number;
  linux_capture_result_copy_finish(attempt: bigint, evidence: number, count: number): number;
}
// Capture the physical operations before any caller can replace their prototypes.
// The importing realm's intrinsics must be trusted at module initialization.
const Bytes = Uint8Array, Memory = WebAssembly.Memory, apply = Reflect.apply, freeze = Object.freeze;
const numeric = Number, wide = BigInt, unsigned = BigInt.asUintN;
const setBytes = Uint8Array.prototype.set, findByte = Uint8Array.prototype.indexOf;
const Instance = WebAssembly.Instance, Module = WebAssembly.Module, Global = WebAssembly.Global;
const globalValue = Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype, 'value')!.set!;
const growMemory = WebAssembly.Memory.prototype.grow;
const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!;
const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapDelete = Map.prototype.delete;
const bufferOf = (memory: WebAssembly.Memory): ArrayBufferLike => apply(memoryBuffer, memory, []);
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const arrayByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
// Stronger selected ingress: reject shared backing rather than claiming an
// atomic snapshot of concurrent writes. Built-in conversion also avoids Buffer.slice.
const ownedInput = (input: Uint8Array): Uint8Array<ArrayBuffer> => {
  apply(arrayByteLength, apply(typedBuffer, input, []), []);
  return new Bytes(input);
};

const lengthOf = (bytes: Uint8Array): number => apply(typedLength, bytes, []);
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const signalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const aborted = (signal?: AbortSignal): boolean => signal !== undefined && apply(signalAborted, signal, []);
const abortReason = (signal?: AbortSignal): unknown => signal === undefined ? new Error('Startup aborted') : apply(signalReason, signal, []);
const extentOf = (memory: WebAssembly.Memory): bigint => wide(lengthOf(new Bytes(bufferOf(memory))));
export interface MemoryBinding { readonly kind: 'managed-memory' }
export interface InodeBinding { readonly kind: 'managed-inode' }
export interface ReadBinding { readonly kind: 'managed-read' }
export interface ExecutionBinding { readonly kind: 'managed-execution' }
export interface FileLimits {
  inodes: number; entries: number; fileBytes: number; tables: number;
  descriptions: number; slots: number; reads: number;
}
export interface PreparedFileLimits extends FileLimits {
  contexts: number; views: number; holds: number;
  policy: {noExec: boolean; noSuid: boolean; noSymfollow: boolean};
}
export interface PreparedArtifactRequest {
  readonly rootGeneration: string;
  readonly sourceSha256: string;
  readonly artifactSha256: string;
  readonly translatorSha256: string;
  readonly source: number;
  readonly sourceBytes: number;
  readonly shared: boolean;
}
export interface PathExecutionOptions {
  translator?: WebAssembly.Module;
  /** Trusted transport: authenticate the requested stored blob/generation, then
   * return its decoded Wasm bytes. No arbitrary compiled Module/segments input. */
  preparedArtifact?: (request: PreparedArtifactRequest) => Uint8Array | Promise<Uint8Array>;
  load?: (source: number) => Uint8Array | Promise<Uint8Array>;
  random: Uint8Array;
  stackBytes?: number;
  /** Guest cwd bytes. Rust resolves and requires an existing directory; no implicit creation. */
  cwd?: Uint8Array;
  /** Explicit borrowed Linux non-TTY host standards; absent keeps an empty FD table. */
  stdio?: true;
  /** Startup-only cooperative cancellation; source callbacks remain observed. */
  signal?: AbortSignal;
}
/** Supplied by the trusted build/deployment owner, not by the artifact source. */
export interface CaptureResultPin {
  readonly kind: 'sods-linux-capture-result-v3';
  readonly byteLength: number;
  readonly sha256: string;
}
const ordinaryOnly = ['linux_sendfile_cap_start', 'linux_sendfile_cap_finish', 'linux_sendfile_load_start', 'linux_sendfile_load_finish',
  'linux_sendfile_start', 'linux_sendfile_receipt', 'linux_sendfile_cleanup', 'linux_sendfile_query',
  'linux_startup_begin', 'linux_startup_begin_stdio', 'linux_execution_create'];
const resultOnly = ['linux_capture_candidate', 'linux_capture_select', 'linux_capture_result_init', 'linux_capture_result_startup',
  'linux_capture_result_resume', 'linux_capture_result_write_start', 'linux_capture_result_write_finish', 'linux_capture_result_head',
  'linux_capture_result_copy_start', 'linux_capture_result_copy_finish'];
const checkedResultExtent = (length: number): number => {
  if (length < 1 || length > 4) throw new Error('Unsupported captured result extent');
  return length; // The pinned profile 2 wire envelope, not a Linux write limit.
};
const required = ['linux_task_registration', 'linux_syscall_sequenced', 'linux_register_start', 'linux_register_receipt', 'linux_root_input', 'linux_prepared_root', 'linux_root_source', 'linux_root_artifact', 'linux_startup_artifact_start', 'linux_startup_artifact_finish', 'linux_prepared_files', 'linux_startup_input', 'linux_stream_start', 'linux_stream_receipt', 'linux_result_endpoint', 'linux_startup_source_start', 'linux_startup_source_finish', 'linux_startup_bytes', 'linux_startup_translation_finish', 'linux_startup_image_begin', 'linux_startup_stack', 'linux_startup_image_finish', 'linux_startup_cancel', 'linux_startup_failed_image', 'linux_startup_entry', 'linux_startup_check', 'linux_stack_input', 'linux_stack_build', 'linux_stack_clear', 'linux_run_start', 'linux_run_receipt', 'linux_syscall', 'linux_syscall_complete',
  'linux_syscall_path_start', 'linux_syscall_path_finish', 'linux_syscall_resumed', 'linux_syscall_abandon', 'linux_syscall_load_finish', 'linux_result_auxiliary', 'linux_abi_version', 'linux_init', 'linux_result', 'linux_bind', 'linux_span',
  'linux_binding_room', 'linux_change', 'linux_start', 'linux_receipt', 'linux_retire',
  'linux_files_prepare', 'linux_name', 'linux_input', 'linux_tree_directory', 'linux_tree_file', 'linux_tree_symlink',
  'linux_files_seal', 'linux_open', 'linux_dup', 'linux_close', 'linux_offset', 'linux_seek',
  'linux_read_begin', 'linux_read_start', 'linux_read_receipt', 'linux_read_query',
  'linux_read_cancel', 'linux_read_retire', 'linux_result_length', 'linux_result_state',
  'linux_execution_retire', 'linux_execution_unstarted_stopped', 'linux_image_begin', 'linux_image_finish', 'linux_tree_lazy',
  'linux_managed_read_begin', 'linux_read_load_start', 'linux_load_input',
  'linux_read_load_finish', 'linux_managed_read_start'];
const integer = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Expected a nonnegative safe integer');
  return n;
};
const u32 = (n: number): number => {
  integer(n);
  if (n > 0xffffffff) throw new RangeError('Expected u32');
  return n;
};
const checked = (status: number): void => {
  if (status !== 0) throw new Error(`Linux memory admission failed: ${status}`);
};

/** Private fixed-profile input, not a credential or ELF authentication API.
 * Rust validates and lays out the stack; this adapter only serializes bytes. */
export interface InitialStack {
  low: number; top: number;
  facts: {entry: number; phdr: number; phent: number; phnum: number};
  credentials: {uid: number; euid: number; gid: number; egid: number; secure: boolean};
  execfn: Uint8Array; argv: readonly Uint8Array[]; env: readonly Uint8Array[];
  random: Uint8Array;
}
function stackWire(input: InitialStack, extent: bigint): Uint8Array {
  if (input.argv.length + input.env.length > 65536 || lengthOf(input.random) !== 16) throw new RangeError('Stack transport input exceeds profile');
  const strings = [input.execfn, ...input.argv, ...input.env];
  const size = strings.reduce((n, s, i) => integer(n + lengthOf(s) + (i ? 8 : 0)), 144);
  if (size > 2 * 1024 * 1024) throw new RangeError('Stack transport input exceeds profile');
  const bytes = new Bytes(size), view = new DataView(bytes.buffer);
  const {facts: f, credentials: c} = input;
  if (typeof c.secure !== 'boolean') throw new TypeError('Expected secure flag');
  const header = [1n, wide(integer(input.low)), wide(integer(input.top)), extent,
    ...[f.entry, f.phdr, f.phent, f.phnum].map(n => wide(integer(n))),
    ...[c.uid, c.euid, c.gid, c.egid].map(n => wide(u32(n))),
    c.secure ? 1n : 0n, wide(input.argv.length), wide(input.env.length), wide(lengthOf(input.execfn))];
  for (let i = 0; i < header.length; i++) view.setBigUint64(i * 8, header[i], true);
  apply(setBytes, bytes, [input.random, 128]);
  let at = 144;
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    if (i) { view.setBigUint64(at, wide(lengthOf(s)), true); at += 8; }
    apply(setBytes, bytes, [s, at]); at += lengthOf(s);
  }
  return bytes;
}

/** Transport snapshot only. Rust validates strings, budgets, and selected execfn. */
function startupWire(path: Uint8Array, argv: readonly Uint8Array[], env: readonly Uint8Array[], random: Uint8Array, cwd?: Uint8Array): Uint8Array {
  if (argv.length + env.length > 65536 || lengthOf(random) !== 16) throw new RangeError('Startup transport exceeds profile');
  const strings = [path, ...argv, ...env];
  const size = strings.reduce((n, bytes, i) => integer(n + lengthOf(bytes) + (i ? 8 : 0)),
    cwd === undefined ? 48 : integer(56 + lengthOf(cwd)));
  if (size > 2 * 1024 * 1024) throw new RangeError('Startup transport exceeds profile');
  const bytes = new Bytes(size), view = new DataView(bytes.buffer);
  for (const [i, value] of [cwd === undefined ? 1 : 2, argv.length, env.length, lengthOf(path)].entries()) view.setBigUint64(i * 8, wide(value), true);
  apply(setBytes, bytes, [random, 32]);
  let at = 48;
  if (cwd !== undefined) {
    view.setBigUint64(at, wide(lengthOf(cwd)), true); at += 8;
    apply(setBytes, bytes, [cwd, at]); at += lengthOf(cwd);
  }
  for (let i = 0; i < strings.length; i++) {
    const value = strings[i];
    if (i) { view.setBigUint64(at, wide(lengthOf(value)), true); at += 8; }
    apply(setBytes, bytes, [value, at]); at += lengthOf(value);
  }
  return bytes;
}

/** Instantiate once: the Rust instance is private and has no guest/host imports.
 * No memory/view/instance escapes. There is deliberately no arbitrary callback API. */
export function memoryHost(module: WebAssembly.Module, memories: number, actions: number) {
  return memoryHostFor(module, memories, actions, false);
}

/** Internal opt-in, not the default managedRoot or the product's terminal.
 * The independent pin and exact owned snapshot are verified before any Core
 * instance exists. No raw Module or structural "verified" value can enter. */
export async function capturedResultHost(input: Uint8Array, pin: CaptureResultPin, memories: number, actions: number) {
  if (!isNode || process.platform !== 'linux' || process.arch !== 'x64' || ![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
    throw new Error('Captured result requires reviewed Linux x64 Node 22 or 24');
  }
  const {kind, byteLength, sha256: expected} = pin;
  if (kind !== 'sods-linux-capture-result-v3' || !Number.isSafeInteger(byteLength) || byteLength < 8 ||
      byteLength > 32 * 1024 * 1024 || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new TypeError('Invalid trusted captured result pin');
  }
  if (lengthOf(input) !== byteLength) throw new Error('Captured result artifact length mismatch');
  const bytes = ownedInput(input);
  if (lengthOf(bytes) !== byteLength) throw new Error('Captured result artifact length changed');
  const actual = Array.from(await sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Captured result artifact digest mismatch');
  const module = new Module(bytes);
  const wire = Module.customSections(module, 'sods.linux.capture');
  const identity = [83, 79, 68, 83, 67, 65, 80, 0, 7, 3, 2, 0];
  if (wire.length !== 1 || wire[0]!.byteLength !== identity.length ||
      !new Bytes(wire[0]!).every((byte, i) => byte === identity[i])) {
    throw new Error('Unsupported captured result artifact identity');
  }
  const host = memoryHostFor(module, memories, actions, true);
  return freeze({prepareRoot: host.prepareRoot, rootSource: host.rootSource, pathExecution: host.pathExecution,
    runPath: host.runPath, stopWorker: host.stopWorker, workerSettled: host.workerSettled,
    workerEvidence: host.workerEvidence, takeOutput: host.takeOutput,
    runPathPaced: host.runPathPaced, waitForCapturePressure: host.waitForCapturePressure,
    waitForCaptureOutput: host.waitForCaptureOutput});
}

function memoryHostFor(module: WebAssembly.Module, memories: number, actions: number, captureResult: boolean) {
  integer(memories); integer(actions);
  if (memories > 0xffffffff || actions > 0xffffffff) throw new RangeError('Capacity exceeds u32');
  const exports = Module.exports(module);
  const names = new Map(exports.map(e => [e.name, e.kind]));
  // A probe has synthetic physical truth, never a usable host capability. Reject
  // before instantiation, even when all required names/version are present.
  if (names.has('linux_sendfile_probe') || names.has('linux_sendfile_probe_access_ended')) {
    throw new Error('Synthetic sendfile probe is not a production Linux admission module');
  }
  if (!captureResult && names.has('linux_capture_candidate')) {
    throw new Error('Linux capture candidate is not an ordinary Linux admission module');
  }
  if (Module.imports(module).length || names.get('memory') !== 'memory' ||
      required.some(name => names.get(name) !== 'function') ||
      (captureResult ? resultOnly : ordinaryOnly).some(name => names.get(name) !== 'function') ||
      (captureResult && (ordinaryOnly.some(name => names.has(name)) ||
        exports.some(e => e.name.startsWith('linux_queued_') || e.name.startsWith('linux_sendfile_'))))) {
    throw new Error('Unsupported Linux admission module');
  }
  // Only a trusted matching artifact is accepted by the eventual artifact loader;
  // export-shape checks are not validation of arbitrary Wasm behavior.
  const core = new Instance(module).exports as Admission;
  const capture = captureResult ? core as unknown as ResultAdmission : undefined;
  if (core.linux_abi_version() !== 7) throw new Error('Unsupported Linux admission ABI');
  checked(core.linux_init(memories, actions));
  if (capture) {
    if (capture.linux_capture_candidate() !== 2) throw new Error('Unsupported captured result artifact profile');
    checked(capture.linux_capture_select(2));
  }
  const safeNumber = (value: bigint): number => {
    const number = integer(numeric(value));
    if (wide(number) !== value) throw new RangeError('Transport coordinate exceeds safe integer');
    return number;
  };
  const artifactRequest = (artifact: number): PreparedArtifactRequest => {
    const pointer = result(core.linux_root_artifact(artifact));
    const length = safeNumber(core.linux_result_length());
    if (length !== 160) throw new Error('Invalid prepared artifact metadata');
    // The core view ends synchronously before digest conversion or callbacks.
    const bytes = new Bytes(new Bytes(bufferOf(core.memory), safeNumber(pointer), length));
    const view = new DataView(bytes.buffer);
    const hex = (at: number) => { let out = ''; const digits = '0123456789abcdef'; for (let i = 0; i < 32; i++) { const b = bytes[at + i]!; out += digits[b >>> 4]! + digits[b & 15]!; } return out; };
    const source = view.getUint32(128, true), mode = view.getUint32(132, true);
    if (!source || mode !== 1 || view.getBigUint64(152, true) !== 0n) throw new Error('Unsupported prepared artifact metadata');
    return freeze({rootGeneration: hex(0), sourceSha256: hex(32), artifactSha256: hex(64), translatorSha256: hex(96),
      source, sourceBytes: safeNumber(view.getBigUint64(136, true)), shared: true});
  };
  const objects = new Map<MemoryBinding, {id: bigint; memory: WebAssembly.Memory}>();
  const get = (binding: MemoryBinding): {id: bigint; memory: WebAssembly.Memory} => {
    const entry = apply(mapGet, objects, [binding]);
    if (!entry) throw new Error('Unknown memory binding');
    return entry;
  };
  const remember = (id: bigint, memory: WebAssembly.Memory): MemoryBinding => {
    const binding = freeze({kind: 'managed-memory' as const});
    apply(mapSet, objects, [binding, {id, memory}]);
    return binding;
  };
  const executions = new Map<ExecutionBinding, {id: bigint; binding: MemoryBinding}>();
  const executionOf = (handle: ExecutionBinding): {id: bigint; binding: MemoryBinding} => {
    const e = apply(mapGet, executions, [handle]);
    if (!e) throw new Error('Unknown execution binding');
    return e;
  };
  const inodes = new Map<InodeBinding, bigint>();
  const inodeHandles = new Map<bigint, InodeBinding>();
  const reads = new Map<ReadBinding, {id: bigint; memory: WebAssembly.Memory; offset: number; execution?: bigint}>();
  const inodeOf = (inode: InodeBinding): bigint => {
    const id = apply(mapGet, inodes, [inode]);
    if (id === undefined) throw new Error('Unknown inode binding');
    return id;
  };
  const rememberInode = (id: bigint): InodeBinding => {
    const known = apply(mapGet, inodeHandles, [id]);
    if (known) return known;
    const inode = freeze({kind: 'managed-inode' as const});
    apply(mapSet, inodes, [inode, id]);
    apply(mapSet, inodeHandles, [id, inode]);
    return inode;
  };
  const readOf = (read: ReadBinding): {id: bigint; memory: WebAssembly.Memory; offset: number; execution?: bigint} => {
    const entry = apply(mapGet, reads, [read]);
    if (!entry) throw new Error('Unknown read binding');
    return entry;
  };
  const result = (status: number): bigint => { checked(status); return unsigned(64, core.linux_result()); };
  const perform = <T>(action: bigint, units: bigint, work: () => T): {value: T; replacement: bigint} => {
    checked(core.linux_start(action));
    let value: T;
    try { value = work(); }
    catch (error) {
      // Conservatively retain on unexpected host failure. No automatic retry or
      // release: a throw alone is not an access/effect completion certificate.
      try { checked(core.linux_receipt(action, 0n, 1)); }
      catch (receipt) { throw new AggregateError([error, receipt], 'Host action and receipt failed'); }
      throw error;
    }
    checked(core.linux_receipt(action, units, 0));
    const replacement = result(core.linux_retire(action));
    return {value, replacement};
  };
  const put = (pointer: bigint, bytes: Uint8Array): void => {
    apply(setBytes, new Bytes(bufferOf(core.memory), numeric(pointer), lengthOf(bytes)), [bytes]);
  };
  // Physical initialization only. Rust owns the image generation and decides
  // whether this binding may change. No view survives the synchronous write.
  const installImage = (id: bigint, binding: MemoryBinding, bytes: Uint8Array, owner?: ExecutionBinding): MemoryBinding => {
    const {memory} = get(binding), extent = extentOf(memory);
    if (wide(lengthOf(bytes)) > extent) throw new RangeError('Image exceeds memory extent');
    checked(core.linux_image_begin(id, extent));
    try { apply(setBytes, new Bytes(bufferOf(memory), 0, lengthOf(bytes)), [bytes]); }
    catch (error) {
      // Captured synchronous intrinsics have unwound: no access remains, but
      // partial initialization is not rollback or a usable image.
      try {
        const next = remember(result(core.linux_image_finish(id, 2)), memory);
        apply(mapDelete, objects, [binding]);
        // The failed image is not runnable, but a known stopped mutation must
        // not leave the physical owner associated with a retired incarnation.
        if (owner !== undefined) apply(mapSet, executions, [owner, {id, binding: next}]);
      }
      catch (receipt) { throw new AggregateError([error, receipt], 'Image initialization and receipt failed'); }
      throw error;
    }
    const next = remember(result(core.linux_image_finish(id, 0)), memory);
    apply(mapDelete, objects, [binding]);
    return next;
  };
  const copyRead = ({id, memory, offset, execution}: {id: bigint; memory: WebAssembly.Memory; offset: number; execution?: bigint}): number => {
      const pointer = numeric(result(execution === undefined ? core.linux_read_start(id) : core.linux_managed_read_start(execution, id)));
      const length = numeric(core.linux_result_length());
      try {
        if (length) {
          const source = new Bytes(bufferOf(core.memory), pointer, length);
          const target = new Bytes(bufferOf(memory), offset, length);
          apply(setBytes, target, [source]);
        }
      } catch (error) {
        try { checked(core.linux_read_receipt(id, 0n, 1)); }
        catch (receipt) { throw new AggregateError([error, receipt], 'Read copy and receipt failed'); }
        throw error;
      }
      checked(core.linux_read_receipt(id, wide(length), 0));
      return length;
  };
  type Guest = {run: (address: bigint) => unknown; r0: WebAssembly.Global; r1: WebAssembly.Global};
  const guests = new Map<ExecutionBinding, {guest: Guest; memory: WebAssembly.Memory; active: boolean; invocation: bigint; command?: {tag: number; value: bigint; target: bigint; next: bigint}}>();
  const unwind = freeze({kind: 'private-guest-unwind'});
  const command = (status: number) => {
    const value = result(status);
    const tag = core.linux_result_state();
    return {tag, value, target: unsigned(64, core.linux_result_auxiliary()), next: unsigned(64, core.linux_result_length()),
      endpoint: (tag & 255) === 7 || tag === 10 || tag === 12 ? numeric(core.linux_result_endpoint()) : 0};
  };
  type Loader = (source: number) => Uint8Array | Promise<Uint8Array>;
  // Shared source dispatcher for inline suspension and Worker synchronous waits.
  // The Rust continuation, not this adapter, owns errno and OFD commit policy.
  const finishRead = async (id: bigint, read: bigint, target: bigint, memory: WebAssembly.Memory, load?: Loader, failed: () => void = () => {}): Promise<ReturnType<typeof command>> => {
    checked(core.linux_read_query(read));
    if ((core.linux_result_state() & 255) === 5) {
      const source = numeric(result(core.linux_read_load_start(id, read)));
      const attempt = numeric(core.linux_result_length());
      let ok = false, sourceError: unknown;
      try {
        if (!load) throw new Error('No translated source loader');
        const bytes = new Bytes(await load(source));
        put(result(core.linux_load_input(u32(lengthOf(bytes)))), bytes);
        ok = true;
      } catch (error) { failed(); sourceError = error; }
      let completionError: unknown, completionFailed = false;
      try { checked(core.linux_syscall_load_finish(id, read, attempt, ok ? 1 : 0)); }
      catch (error) { completionError = error; completionFailed = true; }
      // No await/callback since staging: only this attempt can own the scratch.
      // Late rejected source bytes must not remain retained as staging input.
      try { checked(core.linux_load_input(0)); }
      catch (cleanup) {
        throw new AggregateError([...(ok ? [] : [sourceError]), ...(completionFailed ? [completionError] : []), cleanup], 'Source staging cleanup failed');
      }
      if (completionFailed) throw new AggregateError(ok ? [completionError] : [sourceError, completionError], 'Source completion failed');
    }
    checked(core.linux_read_query(read));
    if ((core.linux_result_state() & 255) === 0) copyRead({id: read, memory, offset: numeric(target), execution: id});
    return command(core.linux_syscall_complete(id));
  };
  type WorkerState = {
    id: bigint; memory: WebAssembly.Memory; bridge: ReturnType<typeof createGuest>;
    invocation: bigint; receipt: boolean; imagePending: boolean; active: boolean;
    failureCount: number; firstFailure?: unknown;
    resourcesRetired: boolean; entry?: bigint; stdio?: ReturnType<typeof captureStdio>;
  };
  // One selected lane, one active captured Worker and one blocked producer.
  // Pressure and output availability each allow one independent observer.
  let captureRun: {worker: WorkerState; paced: boolean} | undefined;
  let pausedOutput: {worker: WorkerState; wake: () => void} | undefined;
  let pressureObserver: {worker: WorkerState; ready: () => void; cancel: (error: Error) => void} | undefined;
  let outputObserver: {worker: WorkerState; ready: () => void; cancel: (error: Error) => void} | undefined;
  const wakeProducer = (worker?: WorkerState): void => {
    if (!pausedOutput || (worker && pausedOutput.worker !== worker)) return;
    const {wake} = pausedOutput;
    pausedOutput = undefined;
    wake();
  };
  const publishOutput = (worker: WorkerState): void => {
    if (outputObserver?.worker !== worker) return;
    const {ready} = outputObserver;
    outputObserver = undefined;
    ready();
  };
  const closeCaptureWaits = (worker: WorkerState): void => {
    wakeProducer(worker);
    if (pressureObserver?.worker === worker) {
      const {cancel} = pressureObserver;
      pressureObserver = undefined;
      cancel(new Error('Captured result pressure is not available'));
    }
    if (outputObserver?.worker === worker) {
      const {cancel} = outputObserver;
      outputObserver = undefined;
      cancel(new Error('Captured result producer ended without another notification'));
    }
  };
  const workers = new Map<ExecutionBinding, WorkerState>();
  const workerOf = (handle: ExecutionBinding): WorkerState => {
    const w = apply(mapGet, workers, [handle]);
    if (!w) throw new Error('Unknown Worker execution');
    return w;
  };
  const workerFailure = (w: WorkerState, error: unknown): void => {
    if (!w.failureCount++) w.firstFailure = error;
  };
  const retireWorker = (w: WorkerState): void => {
    // An unwind and an observed Node exit are separate prerequisites. Rust also
    // checks its own pending reads/copies before returning the execution's holder.
    if (!w.resourcesRetired && w.bridge.diagnostics().exited) {
      w.resourcesRetired = result(core.linux_execution_retire(w.id)) === 1n;
      if (w.resourcesRetired && !w.active && captureRun?.worker === w) captureRun = undefined;
    }
  };
  const abandonWorker = (w: WorkerState): void => {
    try { checked(core.linux_syscall_abandon(w.id)); retireWorker(w); }
    catch (error) { workerFailure(w, error); }
  };
  const rejectSourceOutput = (w: WorkerState, sequence: number, c: ReturnType<typeof command>): ReturnType<typeof command> => {
    if (c.target !== wide(sequence) || c.next !== 0n) throw new Error('Rust source-output sequence mismatch');
    const action = c.value, endpoint = c.endpoint;
    // The capability request is retained in Rust, not reconstructed from a JS
    // boolean or a guest FD. No physical qualifier/loader/output is invoked in
    // this negative-only production stage. Generic non-TTY stdio is not proof.
    const started = result(core.linux_sendfile_cap_start(w.id, sequence, action));
    let attempted = false;
    try {
      if (started !== action || core.linux_result_auxiliary() !== wide(sequence) ||
          core.linux_result_endpoint() !== wide(endpoint) || core.linux_result_length() !== 0n) {
        throw new Error('Rust source-output capability metadata changed');
      }
      attempted = true;
      return command(core.linux_sendfile_cap_finish(w.id, sequence, action, wide(endpoint), 0));
    } catch (error) {
      if (!attempted) {
        // The read-only local qualification never dispatched IO and has ended.
        // Settle rejection once; never retry a possibly committed finish export.
        try { checked(core.linux_sendfile_cap_finish(w.id, sequence, action, wide(endpoint), 0)); }
        catch (receipt) { throw new AggregateError([error, receipt], 'Source-output qualification and rejection failed'); }
      }
      throw error;
    }
  };
  const transferStream = (w: WorkerState, c: ReturnType<typeof command>): ReturnType<typeof command> => {
    if (!w.stdio) throw new Error('No physical standard-stream capability');
    const reading = c.tag === 7;
    if (!(reading ? c.endpoint === 1 : c.tag === 263 && (c.endpoint === 2 || c.endpoint === 3))) throw new Error('Unsupported physical stream endpoint');
    // Construct the view before start; afterward only the captured synchronous
    // physical operation and its one matching Rust receipt may run.
    const bytes = new Bytes(bufferOf(w.memory), numeric(c.target), numeric(c.next));
    w.stdio.prepareView(bytes);
    checked(core.linux_stream_start(w.id, c.value));
    let observed: PhysicalResult;
    try { observed = w.stdio.transfer(c.endpoint as Endpoint, bytes); }
    catch (error) { observed = {kind: 'unknown', error}; }
    const code = observed.kind === 'count' ? 0 : observed.kind === 'unknown' ? 6 :
      observed.code === 'EAGAIN' ? 1 : observed.code === 'EINTR' ? 2 : observed.code === 'EBADF' ? 3 : observed.code === 'EPIPE' ? 4 : 5;
    const count = observed.kind === 'count' ? wide(observed.count) : 0n;
    let completed: ReturnType<typeof command>;
    try { completed = command(core.linux_stream_receipt(w.id, c.value, count, code)); }
    catch (receipt) {
      if (observed.kind === 'unknown') throw new AggregateError([observed.error, receipt], 'Unknown physical IO and receipt failure');
      throw receipt;
    }
    if (observed.kind === 'unknown') throw observed.error;
    return completed;
  };
  const capturePath = (w: WorkerState, c: ReturnType<typeof command>): ReturnType<typeof command> => {
    const pointer = numeric(result(core.linux_syscall_path_start(w.id, c.value)));
    const limit = numeric(core.linux_result_length());
    let actual: number;
    try {
      // Rust admitted the binding/span and owns bounded initialized scratch.
      // NUL scanning only reduces physical copying; Rust validates the actual
      // prefix and decides all pathname/dirfd/flag/permission/errno semantics.
      const guestBuffer = bufferOf(w.memory), offset = numeric(c.target);
      const source = new Bytes(guestBuffer, offset, limit);
      const nul = apply(findByte, source, [0]);
      actual = nul < 0 ? limit : nul + 1;
      // TypedArray.subarray is NOT callback-free: even a captured method asks
      // SpeciesConstructor. Use only captured built-in constructors on buffers.
      const prefix = new Bytes(guestBuffer, offset, actual);
      const target = new Bytes(bufferOf(core.memory), pointer, actual);
      apply(setBytes, target, [prefix]);
      // No view escapes, callback/await/core call interleaves these intrinsics.
    } catch (error) {
      // The captured synchronous interval has unwound: both views/accesses are
      // ended, but scratch content is invalid and no FD has been published.
      // This does not certify guest Worker exit or reusable execution memory.
      try { checked(core.linux_syscall_path_finish(w.id, c.value, 0n, 1)); }
      catch (receipt) { throw new AggregateError([error, receipt], 'Path capture and failed receipt'); }
      throw error;
    }
    // Do not replay a failed/trapped finish: it may already have published an FD.
    return command(core.linux_syscall_path_finish(w.id, c.value, wide(actual), 0));
  };
  const captureWrite = capture && ((w: WorkerState, sequence: number, c: ReturnType<typeof command>): ReturnType<typeof command> => {
    const count = checkedResultExtent(safeNumber(c.next)), source = safeNumber(c.target);
    if (c.endpoint !== 0) throw new Error('Captured write has a physical endpoint');
    const address = result(capture.linux_capture_result_write_start(w.id, sequence, c.value));
    try {
      if (core.linux_result_auxiliary() !== c.target || core.linux_result_length() !== c.next) {
        throw new Error('Captured write extent changed');
      }
      // Synchronous and callback-free. Neither view escapes Rust's lexical fence.
      apply(setBytes, new Bytes(bufferOf(core.memory), numeric(address), count),
        [new Bytes(bufferOf(w.memory), source, count)]);
    } catch (error) {
      try { checked(capture.linux_capture_result_write_finish(w.id, sequence, c.value, 1, 0)); }
      catch (receipt) { throw new AggregateError([error, receipt], 'Captured write and stopped receipt failed'); }
      throw error;
    }
    // A failure can have committed already. Never replay a success receipt.
    return command(capture.linux_capture_result_write_finish(w.id, sequence, c.value, 0, count));
  });
  let unsettledOutput: Uint8Array<ArrayBuffer> | undefined;
  const ensureResultUsable = (): void => {
    if (unsettledOutput) throw new Error('Captured result access remains unconfirmed');
  };
  const takeOutput = (): Uint8Array<ArrayBuffer> | undefined => {
    if (!capture) throw new Error('This host has no captured result');
    ensureResultUsable();
    const generation = result(capture.linux_capture_result_head());
    if (generation === 0n) return undefined; // Temporarily empty, not EOF or stop evidence.
    const slot = u32(safeNumber(core.linux_result_auxiliary()));
    const length = checkedResultExtent(safeNumber(core.linux_result_length()));
    const output = new Bytes(length);
    unsettledOutput = output;
    const start = capture.linux_capture_result_copy_start(slot, generation);
    if (start !== 0) {
      // A known rejection, rather than a trap, produced no pointer for this attempt.
      unsettledOutput = undefined;
      checked(start);
    }
    const attempt = unsigned(64, core.linux_result_auxiliary()), pointer = unsigned(64, core.linux_result());
    try {
      if (core.linux_result_length() !== wide(length)) throw new Error('Captured result extent changed');
      apply(setBytes, output, [new Bytes(bufferOf(core.memory), numeric(pointer), length)]);
    } catch (error) {
      try { checked(capture.linux_capture_result_copy_finish(attempt, 1, 0)); unsettledOutput = undefined; }
      catch (receipt) { throw new AggregateError([error, receipt], 'Captured result copy and stopped receipt failed'); }
      throw error;
    }
    if (result(capture.linux_capture_result_copy_finish(attempt, 0, length)) !== wide(length)) {
      throw new Error('Captured result publication remains unconfirmed');
    }
    unsettledOutput = undefined;
    wakeProducer(); // Only exact committed receive returns credit to the lane.
    return output;
  };
  const runWorker = async (handle: ExecutionBinding, entry: bigint, load?: Loader, paced = false): Promise<{status: number; sourceFailures: number}> => {
      ensureResultUsable();
      const w = workerOf(handle);
      if (w.entry !== undefined && entry !== w.entry) throw new Error('Entry differs from Rust committed startup');
      if (w.active || w.invocation || w.imagePending || w.bridge.diagnostics().exited || w.bridge.diagnostics().stopping) throw new Error('Worker run unavailable');
      if (capture && captureRun) throw new Error('Captured result lane already has a Worker');
      w.invocation = result(core.linux_run_start(w.id));
      w.active = true;
      if (capture) captureRun = {worker: w, paced};
      let failures = 0, exit = false;
      try {
        const outcome = await w.bridge.run(w.invocation, entry, async request => {
          try {
            let c = command(core.linux_syscall_sequenced(w.id, request.invocation, request.sequence, request.nr, ...request.args, request.next));
            if (c.tag === 0) return {kind: 'return', value: c.value};
            if (c.tag === 2) { exit = true; return {kind: 'leave'}; }
            if ((c.tag & 255) === 7) {
              const completed = transferStream(w, c);
              if (completed.tag !== 0) throw new Error(`Worker stream did not return: ${completed.tag}`);
              return {kind: 'return', value: completed.value};
            }
            if (c.tag === 8) {
              const completed = capturePath(w, c);
              if (completed.tag !== 0) throw new Error(`Path capture did not return: ${completed.tag}`);
              return {kind: 'return', value: completed.value};
            }
            if (c.tag === 9) {
              if (c.next !== wide(request.sequence)) throw new Error('Rust register sequence mismatch');
              checked(core.linux_register_start(w.id, request.sequence, c.value, c.target));
              let physical: Awaited<ReturnType<typeof w.bridge.applyFs>>;
              try { physical = await w.bridge.applyFs(request, c.value, c.target); }
              catch (error) {
                // Start was consumed. A transport throw cannot certify zero.
                // Attempt this receipt once; never retry a trapped core export.
                try { checked(core.linux_register_receipt(w.id, request.sequence, c.value, c.target, 2)); }
                catch (receipt) { throw new AggregateError([error, receipt], 'Register transport and uncertain receipt failed'); }
                throw error;
              }
              const completed = command(core.linux_register_receipt(w.id, request.sequence, c.value, c.target,
                physical === 'applied' ? 0 : physical === 'not-applied' ? 1 : 2));
              if (completed.tag !== 0) throw new Error(`Worker register application failed or remains uncertain: ${physical}`);
              return {kind: 'return', value: completed.value};
            }
            if (c.tag === 10) {
              if (capture) throw new Error('Captured result rejects physical output');
              const completed = rejectSourceOutput(w, request.sequence, c);
              // No accepted production physical capability exists yet. Never
              // turn a rejected/unknown stage into a successful zero result.
              throw new Error(`Unsupported Rust Worker command: ${completed.tag} (value ${completed.value}, syscall ${request.nr})`);
            }
            if (c.tag !== 1) {
              if (c.tag === 14 && capture) {
                if (!paced) throw new Error('Captured result queue is full and no draining consumer is attached');
                const action = c.value, sequence = request.sequence;
                const active = () => {
                  const state = w.bridge.diagnostics();
                  if (state.stopping || state.exited) throw new Error('Captured result Worker stopped before resume');
                };
                do {
                  if (c.value !== action || c.target !== wide(sequence) || c.next !== 0n || c.endpoint !== 0 || pausedOutput) {
                    throw new Error('Captured result pressure identity mismatch');
                  }
                  active();
                  await new Promise<void>(wake => {
                    pausedOutput = {worker: w, wake};
                    if (pressureObserver?.worker === w) {
                      const {ready} = pressureObserver;
                      pressureObserver = undefined;
                      ready();
                    }
                  });
                  active(); // Stops in the same turn as a consume still win.
                  c = command(capture.linux_capture_result_resume(w.id, sequence, action));
                } while (c.tag === 14);
              }
              if (c.tag === 13 && captureWrite) c = captureWrite(w, request.sequence, c);
              if (c.tag === 15 && capture) {
                publishOutput(w); // Rust committed, and no borrowed view remains.
                return {kind: 'return', value: c.value};
              }
              throw new Error(`Unsupported Rust Worker command: ${c.tag} (value ${c.value}, syscall ${request.nr})`);
            }
            const completed = await finishRead(w.id, c.value, c.target, w.memory, load, () => { failures++; });
            if (completed.tag !== 0) throw new Error(`Worker read did not return: ${completed.tag}`);
            return {kind: 'return', value: completed.value};
          } catch (error) {
            // A callback can finish after exit; settle its source before trying
            // abandonment again. Unknown obligations remain owned in Rust.
            try {
              if (!w.resourcesRetired) { checked(core.linux_syscall_abandon(w.id)); retireWorker(w); }
            }
            catch (cleanup) { workerFailure(w, cleanup); throw new AggregateError([error, cleanup], 'Worker source and cleanup failed'); }
            throw error;
          }
        });
        if (outcome.kind !== 'left' || !outcome.unwound || !exit) {
          throw outcome.kind === 'failed' ? outcome.error : new Error('Worker did not unwind an exit command');
        }
        w.receipt = true;
        const status = numeric(result(core.linux_run_receipt(w.id, w.invocation, 1, 0n)));
        w.bridge.requestStop();
        const evidence = await w.bridge.stopEvidence();
        if (!evidence.stopped) throw new Error('Worker stop remains unconfirmed');
        retireWorker(w);
        if (w.failureCount || w.bridge.diagnostics().failureCount) throw w.firstFailure ?? w.bridge.diagnostics().firstFailure;
        return {status, sourceFailures: failures};
      } catch (error) {
        workerFailure(w, error);
        w.bridge.requestStop();
        // A host error/termination request is not a stopped-stack certificate.
        // The exit callback above is responsible for the fault receipt.
        throw error;
      } finally {
        w.active = false;
        if (captureRun?.worker === w) {
          closeCaptureWaits(w);
          if (w.resourcesRetired) captureRun = undefined;
        }
      }
    };
  return {
    takeOutput,
    /** Initial prepared-path profile: empty FD table, fixed memory, one runner.
     * Not default Node/muk startup or a complete Linux syscall environment. */
    async pathExecution(path: Uint8Array, argv: readonly Uint8Array[], env: readonly Uint8Array[], options: PathExecutionOptions): Promise<ExecutionBinding> {
      ensureResultUsable();
      if ('credentials' in options || 'execfn' in options) throw new TypeError('Path startup derives credentials and execfn in Rust');
      const {translator: translatorModule, load, signal, stdio: useStdio, preparedArtifact: artifactLoader} = options;
      if (artifactLoader !== undefined && typeof artifactLoader !== 'function') throw new TypeError('Expected prepared artifact transport');
      if (artifactLoader === undefined && translatorModule === undefined) throw new TypeError('Fresh startup requires a translator');
      if (useStdio !== undefined && useStdio !== true) throw new TypeError('Expected explicit stdio profile');
      if (capture && useStdio !== undefined) throw new TypeError('Captured result does not borrow physical stdio');
      const stackBytes = u32(options.stackBytes ?? 1024 * 1024);
      if (!stackBytes || stackBytes % 65536) throw new RangeError('Stack backing must be a positive whole number of Wasm pages');
      const wire = startupWire(path, argv, env, options.random, options.cwd);
      if (aborted(signal)) throw abortReason(signal);
      const stdio = useStdio ? (await import('../host/node/stdio.ts')).captureStdio() : undefined;
      if (aborted(signal)) throw abortReason(signal);
      put(result(core.linux_startup_input(wire.length)), wire);
      const begun = capture ? capture.linux_capture_result_startup()
        : stdio ? core.linux_startup_begin_stdio() : core.linux_startup_begin();
      const id = unsigned(64, core.linux_result());
      checked(core.linux_startup_input(0));
      if (begun !== 0) {
        const failure = new Error(`Linux startup admission failed: ${begun}`);
        try { if (id) checked(core.linux_startup_cancel(id)); }
        catch (cleanup) { throw new AggregateError([failure, cleanup], 'Startup admission and cleanup failed'); }
        throw failure;
      }
      let cancelled = false, translating = false, preparingArtifact = false, artifact = 0, imagePending = false;
      let memory: WebAssembly.Memory | undefined, bridge: ReturnType<typeof createGuest> | undefined;
      let admittedMemory: MemoryBinding | undefined;
      let physicalOwner: {id: bigint; memory: WebAssembly.Memory} | undefined;
      let w: WorkerState | undefined, cancellationFailure: unknown;
      const cancel = (): void => {
        cancelled = true;
        try { checked(core.linux_startup_cancel(id)); }
        catch (error) { cancellationFailure = error; }
        bridge?.requestStop();
      };
      const check = (): void => {
        if (cancelled || aborted(signal)) throw abortReason(signal);
        checked(core.linux_startup_check(id));
      };
      const retireFailedImage = (): void => {
        // Retain physical memory under the returned incarnation; this is not a
        // memory-disposal proof. Only actual stop/synchronous unwinding calls it.
        if (physicalOwner) {
          const replacement = result(core.linux_startup_failed_image(id));
          physicalOwner.id = replacement;
        }
        const retired = result(core.linux_startup_cancel(id)) === 1n;
        if (w) w.resourcesRetired = retired;
      };
      try {
        if (signal) apply(addListener, signal, ['abort', cancel, {once: true}]);
        if (aborted(signal)) cancel();
        check();
        let wasm: Uint8Array;
        if (artifactLoader) {
          artifact = u32(numeric(result(core.linux_startup_artifact_start(id))));
          preparingArtifact = true;
          const request = artifactRequest(artifact);
          const returned = await artifactLoader(request);
          check();
          // This private owned snapshot feeds BOTH validator and segment/facts
          // preparation. No supplied Module or separately supplied data is accepted.
          wasm = ownedInput(returned);
        } else {
          const source = numeric(result(core.linux_startup_source_start(id)));
          const attempt = numeric(core.linux_result_auxiliary());
          if (source) {
            let success = false, failed = false, failure: unknown;
            try {
              if (!load) throw new Error('No program source loader');
              const returned = await load(source);
              // A cancelled callback still completes exactly once, without
              // adopting its late bytes. Cancellation never asserts callback stop.
              if (!cancelled && !aborted(signal)) {
                const bytes = new Bytes(returned);
                put(result(core.linux_load_input(u32(lengthOf(bytes)))), bytes);
                success = true;
              }
            } catch (error) { failed = true; failure = error; }
            const failures: unknown[] = failed ? [failure] : [];
            // One matching receipt attempt only, even if it reports failure after
            // changing Rust state. Staging cleanup never hides the loader error.
            try { checked(core.linux_startup_source_finish(id, attempt, success ? 1 : 0)); }
            catch (error) { failures.push(error); }
            try { checked(core.linux_load_input(0)); }
            catch (error) { failures.push(error); }
            if (failures.length === 1) throw failures[0];
            if (failures.length) throw new AggregateError(failures, 'Program source and completion cleanup failed');
            check();
          }
          const translator = await loadTranslator(translatorModule!);
          check();
          const pointer = result(core.linux_startup_bytes(id));
          const length = numeric(core.linux_result_length());
          translating = true;
          // whole synchronously copies the canonical bytes into translator memory.
          // No view is stored across an export, callback or await in this adapter.
          wasm = translator.whole(new Bytes(bufferOf(core.memory), numeric(pointer), length));
        }
        const originalModule = await fixedTranslatedModuleAsync(wasm);
        check();
        const sections = WebAssembly.Module.customSections(originalModule, 'sods.facts');
        if (sections.length !== 1) throw new Error('Expected one translator facts section');
        const facts = JSON.parse(utf8(sections[0])) as Record<string, unknown>;
        const fact = (name: string): number => {
          const value = facts[name];
          if (typeof value !== 'number') throw new TypeError('Invalid translator facts');
          return integer(value);
        };
        const entry = fact('entry'), phdr = fact('phdr'), phent = fact('phent'), phnum = fact('phnum');
        const low = integer(Math.ceil(fact('imageEnd') / 65536) * 65536), top = integer(low + stackBytes);
        if (top > 0x100000000) throw new RangeError('Startup memory exceeds wasm32');
        const prepared = prepare(wasm, {shared: true});
        if (prepared.segments === null) throw new Error('Worker image requires external data');
        const translated = fixedTranslatedModule(prepared.wasm, {externalData: true});
        for (const segment of prepared.segments) {
          const end = integer(segment.offset + lengthOf(segment.bytes));
          if (!Number.isSafeInteger(segment.offset) || segment.offset < 0 || end > top) throw new RangeError('Worker image segment exceeds memory');
          if (lengthOf(segment.bytes) && segment.offset < top && end > low) throw new RangeError('Stack overlaps image segment');
        }
        // Attempt exactly one matching receipt even if the export fails after
        // changing Rust state. Never replay an uncertain completion.
        if (preparingArtifact) {
          preparingArtifact = false;
          checked(core.linux_startup_artifact_finish(id, artifact, 1, wide(entry), wide(phdr), wide(phent), wide(phnum), wide(top)));
        } else {
          translating = false;
          checked(core.linux_startup_translation_finish(id, 1, wide(entry), wide(phdr), wide(phent), wide(phnum), wide(top)));
        }
        const guestHost = await import('../host/node/execution.ts');
        check();
        checked(core.linux_binding_room());
        memory = new Memory({initial: top / 65536, maximum: top / 65536, shared: true});
        const binding = result(core.linux_bind(wide(top)));
        // Bind succeeds before image admission, which may still fail. Keep the
        // physical owner associated with every admitted incarnation, including
        // quarantined pre-image failures; this does not claim memory reclamation.
        // This opaque handle is never returned by the path API. Its private
        // record survives incarnation changes without post-publication allocation.
        physicalOwner = {id: binding, memory};
        admittedMemory = freeze({kind: 'managed-memory' as const});
        apply(mapSet, objects, [admittedMemory, physicalOwner]);
        checked(core.linux_startup_image_begin(id, binding, wide(low), wide(top)));
        imagePending = true;
        const stackPointer = result(core.linux_startup_stack(id));
        const stackLength = numeric(core.linux_result_length()), rsp = core.linux_result_auxiliary();
        apply(setBytes, new Bytes(bufferOf(memory), numeric(rsp), stackLength),
          [new Bytes(bufferOf(core.memory), numeric(stackPointer), stackLength)]);
        for (const segment of prepared.segments) apply(setBytes, new Bytes(bufferOf(memory), segment.offset, lengthOf(segment.bytes)), [segment.bytes]);
        bridge = guestHost.createGuest({module: translated, memory, stackPointer: rsp});
        const handle = freeze({kind: 'managed-execution' as const});
        w = {id, memory, bridge, invocation: 0n, receipt: false, imagePending: true, active: false, failureCount: 0, resourcesRetired: false, stdio};
        const owned = w;
        void bridge.stopped.then(() => {
          if (captureRun?.worker === owned) closeCaptureWaits(owned);
          if (owned.imagePending) {
            try {
              checked(core.linux_startup_image_finish(id, 2));
              owned.imagePending = false; imagePending = false;
              retireFailedImage();
            } catch (error) { workerFailure(owned, error); }
            return;
          }
          if (owned.invocation && !owned.receipt) {
            owned.receipt = true;
            try { checked(core.linux_run_receipt(id, owned.invocation, 2, 0n)); }
            catch (error) { workerFailure(owned, error); }
            abandonWorker(owned);
          } else if (!owned.invocation) {
            try { checked(core.linux_execution_unstarted_stopped(id)); }
            catch (error) { workerFailure(owned, error); }
          }
          try { retireWorker(owned); } catch (error) { workerFailure(owned, error); }
        }).catch(error => workerFailure(owned, error));
        // Reserve every host owner entry before Rust can publish Live. Register
        // stop evidence first so even a Map allocation failure retains cleanup.
        // This handle stays private until installation and entry validation.
        apply(mapSet, workers, [handle, owned]);
        apply(mapSet, executions, [handle, {id, binding: admittedMemory}]);
        await bridge.ready;
        check();
        if (bridge.diagnostics().exited) throw new Error('Worker exited during initialization');
        checked(core.linux_startup_image_finish(id, 0));
        // Rust is Live now. These plain private-field assignments cannot invoke
        // callbacks or allocate, so any later failure follows normal Live stop.
        imagePending = false; owned.imagePending = false;
        physicalOwner.id = unsigned(64, core.linux_result());
        owned.entry = result(core.linux_startup_entry(id));
        return handle;
      } catch (error) {
        const cleanup: unknown[] = [];
        if (w) workerFailure(w, error);
        if (preparingArtifact) {
          preparingArtifact = false;
          try { checked(core.linux_startup_artifact_finish(id, artifact, 0, 0n, 0n, 0n, 0n, 0n)); }
          catch (failure) { cleanup.push(failure); }
        }
        if (translating) {
          translating = false;
          try { checked(core.linux_startup_translation_finish(id, 0, 0n, 0n, 0n, 0n, 0n)); }
          catch (failure) { cleanup.push(failure); }
        }
        if (imagePending) {
          if (bridge) {
            try { checked(core.linux_startup_image_finish(id, 3)); }
            catch (failure) { cleanup.push(failure); }
            bridge.requestStop(); // The actual exit listener owns stopped receipt.
          } else {
            try { checked(core.linux_startup_image_finish(id, 2)); imagePending = false; retireFailedImage(); }
            catch (failure) { cleanup.push(failure); }
          }
        } else if (!w || w.imagePending || w.resourcesRetired) {
          try { checked(core.linux_startup_cancel(id)); }
          catch (failure) { cleanup.push(failure); }
        }
        bridge?.requestStop();
        if (cancellationFailure !== undefined) cleanup.push(cancellationFailure);
        if (cleanup.length) throw new AggregateError([error, ...cleanup], 'Path startup and cleanup failed');
        throw error;
      } finally { if (signal) apply(removeListener, signal, ['abort', cancel]); }
    },
    /** Fixed shared-memory diagnostic. No default Node caller cutover. */
    async workerExecution(input: Uint8Array, pages: number, stack?: InitialStack): Promise<ExecutionBinding> {
      u32(pages);
      const bytes = new Bytes(input);
      fixedTranslatedModule(bytes); // Reject raw start/defined memory before transform.
      const prepared = prepare(bytes, {shared: true});
      if (prepared.segments === null) throw new Error('Worker image requires external data');
      const translated = fixedTranslatedModule(prepared.wasm, {externalData: true});
      const extent = wide(pages) * 65536n;
      // Snapshot transport before the first await; no caller array is retained.
      const stackInput = stack ? stackWire(stack, extent) : undefined;
      const stackHeader = stackInput ? new DataView(stackInput.buffer) : undefined;
      const stackLow = stackHeader ? numeric(stackHeader.getBigUint64(8, true)) : 0;
      const stackTop = stackHeader ? numeric(stackHeader.getBigUint64(16, true)) : 0;
      for (const segment of prepared.segments) {
        if (!Number.isSafeInteger(segment.offset) || segment.offset < 0 || wide(segment.offset) > extent || wide(lengthOf(segment.bytes)) > extent - wide(segment.offset)) throw new RangeError('Worker image segment exceeds memory');
        if (stackInput && lengthOf(segment.bytes) > 0 && segment.offset < stackTop && segment.offset + lengthOf(segment.bytes) > stackLow) throw new RangeError('Stack overlaps image segment');
      }
      const {createGuest} = await import('../host/node/execution.ts');
      checked(core.linux_binding_room());
      const memory = new Memory({initial: pages, maximum: pages, shared: true});
      const binding = result(core.linux_bind(extent));
      const id = result(core.linux_execution_create(binding));
      checked(core.linux_image_begin(id, extent));
      let bridge: ReturnType<typeof createGuest>;
      try {
        let stackPointer: bigint | undefined;
        if (stackInput) {
          try {
            put(result(core.linux_stack_input(id, stackInput.length)), stackInput);
            const pointer = result(core.linux_stack_build(id));
            const length = numeric(core.linux_result_length());
            stackPointer = core.linux_result_auxiliary();
            // No export/callback/await while this short core view is live.
            apply(setBytes, new Bytes(bufferOf(memory), numeric(stackPointer), length),
              [new Bytes(bufferOf(core.memory), numeric(pointer), length)]);
          } finally { checked(core.linux_stack_clear()); }
        }
        for (const segment of prepared.segments) apply(setBytes, new Bytes(bufferOf(memory), segment.offset, lengthOf(segment.bytes)), [segment.bytes]);
        bridge = createGuest({module: translated, memory, stackPointer});
      } catch (error) {
        try { checked(core.linux_image_finish(id, 2)); }
        catch (receipt) { throw new AggregateError([error, receipt], 'Worker preparation and receipt failed'); }
        throw error;
      }
      const handle = freeze({kind: 'managed-execution' as const});
      const w: WorkerState = {id, memory, bridge, invocation: 0n, receipt: false, imagePending: true, active: false, failureCount: 0, resourcesRetired: false};
      apply(mapSet, workers, [handle, w]);
      // The listener retains failed initialization as well as successful handles.
      // Exit evidence is separate from an outstanding source callback obligation.
      void bridge.stopped.then(() => {
        if (w.imagePending) {
          try { checked(core.linux_image_finish(id, 2)); w.imagePending = false; }
          catch (error) { workerFailure(w, error); }
        } else if (w.invocation && !w.receipt) {
          w.receipt = true; // One attempt: failure is retained, never replayed blindly.
          try { checked(core.linux_run_receipt(id, w.invocation, 2, 0n)); }
          catch (error) { workerFailure(w, error); }
          abandonWorker(w);
        } else if (!w.invocation) {
          // Actual exit of an initialized Worker that never received a run.
          // A stop request alone does not take this path.
          try { checked(core.linux_execution_unstarted_stopped(w.id)); }
          catch (error) { workerFailure(w, error); }
        }
        try { retireWorker(w); }
        catch (error) { workerFailure(w, error); }
      }).catch(error => workerFailure(w, error));
      try {
        await bridge.ready;
        if (bridge.diagnostics().exited) throw new Error('Worker exited during initialization');
        const next = remember(result(core.linux_image_finish(id, 0)), memory);
        w.imagePending = false;
        apply(mapSet, executions, [handle, {id, binding: next}]);
        return handle;
      } catch (error) {
        workerFailure(w, error);
        if (w.imagePending) {
          try { checked(core.linux_image_finish(id, 3)); }
          catch (receipt) { workerFailure(w, receipt); }
        }
        bridge.requestStop();
        // No unbounded exit wait on failure. Late exit owns the matching receipt.
        throw error;
      }
    },
    stopWorker(handle: ExecutionBinding): void {
      const w = workerOf(handle);
      w.bridge.requestStop();
      if (captureRun?.worker === w) closeCaptureWaits(w);
    },
    /** Observations only: neither method proves tree disposal or full owner release. */
    workerEvidence(handle: ExecutionBinding) {
      const w = workerOf(handle), evidence = w.bridge.diagnostics();
      return {...evidence, failureCount: evidence.failureCount + w.failureCount,
        firstFailure: w.firstFailure ?? evidence.firstFailure,
        ownerFailure: w.firstFailure, transportFailure: evidence.firstFailure,
        resourcesRetired: w.resourcesRetired};
    },
    workerSettled(handle: ExecutionBinding): Promise<void> { return workerOf(handle).bridge.requestsSettled(); },
    runWorker,
    runPath(handle: ExecutionBinding, load?: Loader): Promise<{status: number; sourceFailures: number}> {
      const w = workerOf(handle);
      if (w.entry === undefined) throw new Error('Not a Rust path startup');
      return runWorker(handle, w.entry, load);
    },
    /** Private opt-in pressure witness, not a delivery or terminal API.
     * The caller takes from this session's lane, which is not a Worker FD. */
    runPathPaced(handle: ExecutionBinding, load?: Loader): Promise<{status: number; sourceFailures: number}> {
      const w = workerOf(handle);
      if (!capture || w.entry === undefined) return Promise.reject(new Error('Paced capture requires selected prepared startup'));
      return runWorker(handle, w.entry, load, true);
    },
    async waitForCapturePressure(handle: ExecutionBinding): Promise<void> {
      const w = workerOf(handle);
      if (captureRun?.worker !== w || !captureRun.paced || !w.active || w.bridge.diagnostics().stopping) {
        throw new Error('Captured result pressure is not available');
      }
      if (pressureObserver) throw new Error('Captured result already has a pressure observer');
      if (pausedOutput?.worker === w) return;
      return new Promise<void>((ready, cancel) => { pressureObserver = {worker: w, ready, cancel}; });
    },
    /** Lane availability is a hint, not a copy, producer status or EOF. */
    async waitForCaptureOutput(): Promise<void> {
      if (!capture) throw new Error('This host has no captured result');
      ensureResultUsable();
      if (outputObserver) throw new Error('Captured result already has an output observer');
      // Peek and install the waiter in one synchronous turn; an already
      // committed head cannot be lost between the check and registration.
      if (result(capture.linux_capture_result_head()) !== 0n) return;
      const w = captureRun?.worker;
      if (!w?.active || w.bridge.diagnostics().stopping) throw new Error('Captured result has no active producer');
      return new Promise<void>((ready, cancel) => { outputObserver = {worker: w, ready, cancel}; });
    },
    /** Diagnostic only: fresh fixed memory, one runner, preopened files. */
    translatedExecution(input: Uint8Array, pages: number): ExecutionBinding {
      u32(pages);
      const translated = fixedTranslatedModule(input);
      checked(core.linux_binding_room());
      const memory = new Memory({initial: pages, maximum: pages});
      // Failure after binding retains a bounded Rust owner; this diagnostic has
      // no unbind/reclaim API and must not claim initialization rollback.
      const old = result(core.linux_bind(extentOf(memory)));
      const id = result(core.linux_execution_create(old));
      const handle = freeze({kind: 'managed-execution' as const});
      let ready = false;
      let state: {guest: Guest; memory: WebAssembly.Memory; active: boolean; invocation: bigint; command?: {tag: number; value: bigint; target: bigint; next: bigint}};
      const unavailable = (): never => { throw new Error('Unsupported translated guest import or initialization call'); };
      checked(core.linux_image_begin(id, extentOf(memory)));
      let instance: WebAssembly.Instance;
      try {
        instance = new Instance(translated, {env: {
          memory,
          syscall: (nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint) => {
            if (!ready || !state.active) return unavailable();
            const c0 = command(core.linux_syscall(id, state.invocation, nr, a, b, c, d, e, f, next));
            if (c0.tag === 0) return c0.value;
            if (c0.tag === 1) {
              checked(core.linux_read_query(c0.value));
              if ((core.linux_result_state() & 255) === 0) {
                // The guest stack is paused inside this import. No callback or
                // await occurs during the canonical copy. Resident reads need
                // neither a synthetic unwind nor register restoration.
                copyRead({id: c0.value, memory, offset: numeric(c0.target), execution: id});
                const done = command(core.linux_syscall_complete(id));
                if (done.tag !== 0) throw new Error('Resident read did not return synchronously');
                return done.value;
              }
            }
            if (c0.tag !== 1 && c0.tag !== 2) throw new Error(`Unsupported Rust syscall command: ${c0.tag}`);
            state.command = {...c0, next};
            throw unwind;
          },
          trap: unavailable, div128: unavailable, clock: unavailable, fpu: unavailable,
          trace: unavailable, miss: unavailable,
          time: () => { if (!ready || !state.active) return unavailable(); return NaN; },
        }});
        const {run, r0, r1} = instance.exports;
        if (typeof run !== 'function' || !(r0 instanceof Global) || !(r1 instanceof Global)) {
          throw new Error('Unsupported translated guest exports');
        }
      } catch (error) {
        try { checked(core.linux_image_finish(id, 2)); }
        catch (receipt) { throw new AggregateError([error, receipt], 'Guest initialization and receipt failed'); }
        throw error;
      }
      const binding = remember(result(core.linux_image_finish(id, 0)), memory);
      apply(mapSet, executions, [handle, {id, binding}]);
      state = {guest: instance.exports as unknown as Guest, memory, active: false, invocation: 0n};
      apply(mapSet, guests, [handle, state]);
      ready = true;
      return handle;
    },
    async runTranslated(handle: ExecutionBinding, entry: bigint, load?: (source: number) => Uint8Array | Promise<Uint8Array>): Promise<{status: number; sourceFailures: number}> {
      const e = executionOf(handle);
      const state: {guest: Guest; memory: WebAssembly.Memory; active: boolean; invocation: bigint; command?: {tag: number; value: bigint; target: bigint; next: bigint}} | undefined = apply(mapGet, guests, [handle]);
      if (!state || state.active) throw new Error('Unknown or active translated execution');
      state.active = true;
      let failures = 0;
      let next = entry;
      try {
        for (;;) {
          state.command = undefined;
          state.invocation = result(core.linux_run_start(e.id));
          let caught: unknown;
          try { state.guest.run(next); caught = new Error('Translated guest returned without an exit command'); }
          catch (error) { caught = error; }
          // The Wasm import callback may publish a command during run().
          const c = state.command as {tag: number; value: bigint; target: bigint; next: bigint} | undefined;
          if (caught !== unwind || !c) {
            try { checked(core.linux_run_receipt(e.id, state.invocation, 2, 0n)); }
            catch (receipt) { throw new AggregateError([caught, receipt], 'Guest failure and unwind receipt failed'); }
            throw caught;
          }
          if (c.tag === 2) {
            return {status: numeric(result(core.linux_run_receipt(e.id, state.invocation, 1, 0n))), sourceFailures: failures};
          }
          checked(core.linux_run_receipt(e.id, state.invocation, 0, c.next));
          const resume = await finishRead(e.id, c.value, c.target, state.memory, load, () => { failures++; });
          if (resume.tag !== 5) throw new Error(`Read did not produce a resume command: ${resume.tag}`);
          try {
            apply(globalValue, state.guest.r0, [resume.value]);
            apply(globalValue, state.guest.r1, [resume.target]);
          } catch (error) {
            try { checked(core.linux_syscall_resumed(e.id, 0, 0)); }
            catch (receipt) { throw new AggregateError([error, receipt], 'Resume application and receipt failed'); }
            throw error;
          }
          checked(core.linux_syscall_resumed(e.id, 0, 1));
          next = resume.next;
        }
      } catch (error) {
        try { checked(core.linux_syscall_abandon(e.id)); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Translated execution failed and cleanup could not be confirmed'); }
        throw error;
      } finally { state.active = false; }
    },
    /** Neutral readonly root ingress. Rust seals one namespace atomically;
     * no TS inode graph, path resolver or SourceId assignment is created here. */
    prepareRoot(wire: Uint8Array<ArrayBuffer>, limits: PreparedFileLimits, fdLimit: number): void {
      const {inodes, entries, fileBytes, tables, descriptions, slots, reads, contexts, views, holds, policy} = limits;
      const values = [inodes, entries, fileBytes, tables, descriptions, slots, reads, contexts, views, holds, fdLimit].map(u32);
      if ([policy.noExec, policy.noSuid, policy.noSymfollow].some(v => typeof v !== 'boolean')) throw new TypeError('Expected immutable view policy');
      const flags = (policy.noExec ? 1 : 0) | (policy.noSuid ? 2 : 0) | (policy.noSymfollow ? 4 : 0);
      if (lengthOf(wire) > 16 * 1024 * 1024) throw new RangeError('Prepared root wire exceeds profile budget');
      const bytes = ownedInput(wire);
      const pointer = result(core.linux_root_input(lengthOf(bytes)));
      try { put(pointer, bytes); }
      catch (error) {
        try { checked(core.linux_root_input(0)); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Root staging and cleanup failed'); }
        throw error;
      }
      checked(core.linux_prepared_root(values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, values[5]!, values[6]!, values[7]!, values[8]!, values[9]!, flags, values[10]!));
      if (capture) checked(capture.linux_capture_result_init());
    },
    /** Root-local immutable transport coordinates, not namespace lookup. */
    rootSource(source: number): {pack: number; at: number; stored: number; size: number; raw: boolean} {
      const pack = u32(numeric(result(core.linux_root_source(u32(source)))));
      const size = safeNumber(core.linux_result_length()), at = safeNumber(core.linux_result_auxiliary()), stored = safeNumber(core.linux_result_endpoint());
      const raw = core.linux_result_state();
      if (raw > 1) throw new Error('Invalid root source storage mode');
      return {pack, at, stored, size, raw: raw === 1};
    },
    /** Prepared namespace, not diagnostic preopened-table fallback. */
    preparePreparedFiles(limits: PreparedFileLimits): InodeBinding {
      const {inodes, entries, fileBytes, tables, descriptions, slots, reads, contexts, views, holds, policy} = limits;
      if ([policy.noExec, policy.noSuid, policy.noSymfollow].some(v => typeof v !== 'boolean')) throw new TypeError('Expected immutable view policy');
      const flags = (policy.noExec ? 1 : 0) | (policy.noSuid ? 2 : 0) | (policy.noSymfollow ? 4 : 0);
      return rememberInode(result(core.linux_prepared_files(u32(inodes), u32(entries), u32(fileBytes),
        u32(tables), u32(descriptions), u32(slots), u32(reads), u32(contexts), u32(views), u32(holds), flags)));
    },
    prepareFiles(limits: FileLimits): InodeBinding {
      const {inodes, entries, fileBytes, tables, descriptions, slots, reads} = limits;
      return rememberInode(result(core.linux_files_prepare(u32(inodes), u32(entries), u32(fileBytes),
        u32(tables), u32(descriptions), u32(slots), u32(reads))));
    },
    directory(parent: InodeBinding, name: Uint8Array, mode = 0o755): InodeBinding {
      const id = inodeOf(parent), bytes = new Bytes(name); u32(mode);
      put(result(core.linux_name(u32(lengthOf(bytes)))), bytes);
      return rememberInode(result(core.linux_tree_directory(id, mode)));
    },
    file(parent: InodeBinding, name: Uint8Array, input: Uint8Array, mode = 0o644): InodeBinding {
      // Capture caller-owned inputs before staging into the private instance.
      const id = inodeOf(parent), component = new Bytes(name), bytes = new Bytes(input); u32(mode);
      put(result(core.linux_name(u32(lengthOf(component)))), component);
      put(result(core.linux_input(u32(lengthOf(bytes)))), bytes);
      return rememberInode(result(core.linux_tree_file(id, mode)));
    },
    /** Prepared symlink bytes only; Rust owns metadata and guest resolution. */
    symlink(parent: InodeBinding, name: Uint8Array, target: Uint8Array): InodeBinding {
      const id = inodeOf(parent), component = new Bytes(name), bytes = new Bytes(target);
      put(result(core.linux_name(u32(lengthOf(component)))), component);
      put(result(core.linux_input(u32(lengthOf(bytes)))), bytes);
      return rememberInode(result(core.linux_tree_symlink(id)));
    },
    lazyFile(parent: InodeBinding, name: Uint8Array, source: number, size: number, mode = 0o644): InodeBinding {
      const id = inodeOf(parent), component = new Bytes(name); u32(source); u32(size); u32(mode);
      put(result(core.linux_name(u32(lengthOf(component)))), component);
      return rememberInode(result(core.linux_tree_lazy(id, mode, source, size)));
    },
    /** Private memory-image admission, not ELF loading or a guest run API. */
    execution(binding: MemoryBinding, input: Uint8Array): {execution: ExecutionBinding; memory: MemoryBinding} {
      const bytes = new Bytes(input), {id, memory} = get(binding);
      if (wide(lengthOf(bytes)) > extentOf(memory)) throw new RangeError('Image exceeds memory extent');
      const executionId = result(core.linux_execution_create(id));
      const next = installImage(executionId, binding, bytes);
      const execution = freeze({kind: 'managed-execution' as const});
      apply(mapSet, executions, [execution, {id: executionId, binding: next}]);
      return {execution, memory: next};
    },
    replaceImage(execution: ExecutionBinding, input: Uint8Array): MemoryBinding {
      if (apply(mapGet, guests, [execution]) || apply(mapGet, workers, [execution])) throw new Error('Translated image replacement is not supported');
      const bytes = new Bytes(input), entry = executionOf(execution);
      const next = installImage(entry.id, entry.binding, bytes, execution);
      apply(mapSet, executions, [execution, {id: entry.id, binding: next}]);
      return next;
    },
    beginManagedRead(execution: ExecutionBinding, fd: number, offset: number, length: number): ReadBinding {
      if (apply(mapGet, guests, [execution]) || apply(mapGet, workers, [execution])) throw new Error('Translated execution owns its reads');
      u32(fd); integer(offset); integer(length);
      const e = executionOf(execution), {memory} = get(e.binding);
      const id = result(core.linux_managed_read_begin(e.id, fd, wide(offset), wide(length)));
      const read = freeze({kind: 'managed-read' as const});
      apply(mapSet, reads, [read, {id, memory, offset, execution: e.id}]);
      return read;
    },
    startLoad(read: ReadBinding): {source: number; attempt: number} {
      const r = readOf(read);
      if (r.execution === undefined) throw new Error('Read has no execution');
      const source = numeric(result(core.linux_read_load_start(r.execution, r.id)));
      return {source, attempt: numeric(core.linux_result_length())};
    },
    finishLoad(read: ReadBinding, attempt: number, input: Uint8Array | null): void {
      u32(attempt); const r = readOf(read);
      if (r.execution === undefined) throw new Error('Read has no execution');
      // The source caller has returned before input staging. A capture/allocation
      // failure must settle that stopped attempt, not strand a Loading owner.
      try {
        const bytes = input === null ? null : new Bytes(input);
        if (bytes !== null) put(result(core.linux_load_input(u32(lengthOf(bytes)))), bytes);
      } catch (error) {
        try { checked(core.linux_read_load_finish(r.execution, r.id, attempt, 0)); }
        catch (completion) { throw new AggregateError([completion, error], 'Source completion and input staging failed'); }
        throw error;
      }
      // Do not retry completion if this call fails after changing source state.
      checked(core.linux_read_load_finish(r.execution, r.id, attempt, input === null ? 0 : 1));
    },
    sealFiles(fdLimit: number): void { checked(core.linux_files_seal(u32(fdLimit))); },
    open(inode: InodeBinding): number { return numeric(result(core.linux_open(inodeOf(inode)))); },
    dup(fd: number): number { return numeric(result(core.linux_dup(u32(fd)))); },
    close(fd: number): void { checked(core.linux_close(u32(fd))); },
    offset(fd: number): bigint { return result(core.linux_offset(u32(fd))); },
    seek(fd: number, offset: bigint): void {
      if (offset < 0n || offset > 0xffffffffffffffffn) throw new RangeError('Expected u64 offset');
      checked(core.linux_seek(u32(fd), offset));
    },
    beginRead(fd: number, binding: MemoryBinding, offset: number, length: number): ReadBinding {
      u32(fd); integer(offset); integer(length);
      const {id: memoryId, memory} = get(binding);
      const id = result(core.linux_read_begin(fd, memoryId, wide(offset), wide(length)));
      const read = freeze({kind: 'managed-read' as const});
      apply(mapSet, reads, [read, {id, memory, offset}]);
      return read;
    },
    copyRead(read: ReadBinding): number { return copyRead(readOf(read)); },
    readResult(read: ReadBinding) {
      const confirmed = result(core.linux_read_query(readOf(read).id));
      const length = numeric(core.linux_result_length()), flags = core.linux_result_state();
      const state = (['ready', 'executing', 'unknown', 'finished', 'cancelled', 'load-ready', 'loading', 'failed'] as const)[flags & 0xff];
      if (state === undefined) throw new Error('Invalid read state');
      return {state, confirmed, length, cancelRequested: !!(flags & 0x100)};
    },
    cancelRead(read: ReadBinding): void { checked(core.linux_read_cancel(readOf(read).id)); },
    retireRead(read: ReadBinding): void {
      checked(core.linux_read_retire(readOf(read).id));
      apply(mapDelete, reads, [read]);
    },
    create(initial: number, maximum: number, shared = false): MemoryBinding {
      integer(initial); integer(maximum);
      checked(core.linux_binding_room());
      // No await or caller callback between preflight and registration.
      const memory = new Memory({initial, maximum, shared});
      const binding = result(core.linux_bind(extentOf(memory)));
      return remember(binding, memory);
    },
    capture(binding: MemoryBinding, offset: number, length: number): Uint8Array<ArrayBuffer> {
      integer(offset); integer(length);
      const {id, memory} = get(binding);
      const action = result(core.linux_span(id, wide(offset), wide(length)));
      return perform(action, wide(length), () => {
        const bytes = new Bytes(length);
        apply(setBytes, bytes, [new Bytes(bufferOf(memory), offset, length)]);
        return bytes;
      }).value;
    },
    write(binding: MemoryBinding, offset: number, input: Uint8Array): void {
      integer(offset);
      // Caller-owned input is captured before acquiring a lease. Its custom
      // behavior cannot run while a core/guest span is active.
      const bytes = new Bytes(input), length = lengthOf(bytes);
      const {id, memory} = get(binding);
      const action = result(core.linux_span(id, wide(offset), wide(length)));
      perform(action, wide(length), () => { apply(setBytes, new Bytes(bufferOf(memory), offset, length), [bytes]); });
    },
    grow(binding: MemoryBinding, pages: number): MemoryBinding {
      integer(pages);
      const {id, memory} = get(binding);
      const extent = extentOf(memory) + wide(pages) * 65536n;
      const action = result(core.linux_change(id, extent));
      const {replacement} = perform(action, 1n, () => apply(growMemory, memory, [pages]));
      if (replacement === 0n) throw new Error('Mutation completed without a new binding');
      // Keep the old physical object reachable if publishing the new handle fails.
      const next = remember(replacement, memory);
      apply(mapDelete, objects, [binding]);
      return next;
    },
  };
}
