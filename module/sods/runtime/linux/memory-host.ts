import {fixedTranslatedModule} from './translated-image.ts';
import {prepare} from '../translation/share.ts';
import type {createGuest} from '../host/node/execution.ts';
/** Private managed-memory adapter. Rust decides admission and lifetime; this file
 * holds engine objects, performs short synchronous memory operations, and
 * transports asynchronous source results and matching Worker evidence.
 * Not exported by linux.ts. The translated runner is a fixed diagnostic profile,
 * not the Node caller, ELF loader or complete Linux syscall implementation. */
interface Admission extends WebAssembly.Exports {
  linux_stack_input(execution: bigint, length: number): number;
  linux_stack_build(execution: bigint): number;
  linux_stack_clear(): number;
  linux_run_start(id: bigint): number;
  linux_run_receipt(id: bigint, invocation: bigint, outcome: number, next: bigint): number;
  linux_syscall(id: bigint, invocation: bigint, nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint): number;
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
// Capture the physical operations before any caller can replace their prototypes.
// The importing realm's intrinsics must be trusted at module initialization.
const Bytes = Uint8Array, Memory = WebAssembly.Memory, apply = Reflect.apply, freeze = Object.freeze;
const numeric = Number, wide = BigInt, unsigned = BigInt.asUintN;
const setBytes = Uint8Array.prototype.set;
const Instance = WebAssembly.Instance, Global = WebAssembly.Global;
const globalValue = Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype, 'value')!.set!;
const growMemory = WebAssembly.Memory.prototype.grow;
const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!;
const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapDelete = Map.prototype.delete;
const bufferOf = (memory: WebAssembly.Memory): ArrayBufferLike => apply(memoryBuffer, memory, []);
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
const lengthOf = (bytes: Uint8Array): number => apply(typedLength, bytes, []);
const extentOf = (memory: WebAssembly.Memory): bigint => wide(lengthOf(new Bytes(bufferOf(memory))));
export interface MemoryBinding { readonly kind: 'managed-memory' }
export interface InodeBinding { readonly kind: 'managed-inode' }
export interface ReadBinding { readonly kind: 'managed-read' }
export interface ExecutionBinding { readonly kind: 'managed-execution' }
export interface FileLimits {
  inodes: number; entries: number; fileBytes: number; tables: number;
  descriptions: number; slots: number; reads: number;
}
const required = ['linux_stack_input', 'linux_stack_build', 'linux_stack_clear', 'linux_run_start', 'linux_run_receipt', 'linux_syscall', 'linux_syscall_complete',
  'linux_syscall_resumed', 'linux_syscall_abandon', 'linux_syscall_load_finish', 'linux_result_auxiliary', 'linux_abi_version', 'linux_init', 'linux_result', 'linux_bind', 'linux_span',
  'linux_binding_room', 'linux_change', 'linux_start', 'linux_receipt', 'linux_retire',
  'linux_files_prepare', 'linux_name', 'linux_input', 'linux_tree_directory', 'linux_tree_file',
  'linux_files_seal', 'linux_open', 'linux_dup', 'linux_close', 'linux_offset', 'linux_seek',
  'linux_read_begin', 'linux_read_start', 'linux_read_receipt', 'linux_read_query',
  'linux_read_cancel', 'linux_read_retire', 'linux_result_length', 'linux_result_state',
  'linux_execution_create', 'linux_execution_retire', 'linux_execution_unstarted_stopped', 'linux_image_begin', 'linux_image_finish', 'linux_tree_lazy',
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

/** Instantiate once: the Rust instance is private and has no guest/host imports.
 * No memory/view/instance escapes. There is deliberately no arbitrary callback API. */
export function memoryHost(module: WebAssembly.Module, memories: number, actions: number) {
  integer(memories); integer(actions);
  if (memories > 0xffffffff || actions > 0xffffffff) throw new RangeError('Capacity exceeds u32');
  const names = new Map(WebAssembly.Module.exports(module).map(e => [e.name, e.kind]));
  if (WebAssembly.Module.imports(module).length || names.get('memory') !== 'memory' || required.some(name => names.get(name) !== 'function')) {
    throw new Error('Unsupported Linux admission module');
  }
  // Only a trusted matching artifact is accepted by the eventual artifact loader;
  // export-shape checks are not validation of arbitrary Wasm behavior.
  const core = new WebAssembly.Instance(module).exports as Admission;
  if (core.linux_abi_version() !== 2) throw new Error('Unsupported Linux admission ABI');
  checked(core.linux_init(memories, actions));
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
    return {tag: core.linux_result_state(), value, target: unsigned(64, core.linux_result_auxiliary()), next: unsigned(64, core.linux_result_length())};
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
    resourcesRetired: boolean;
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
    }
  };
  const abandonWorker = (w: WorkerState): void => {
    try { checked(core.linux_syscall_abandon(w.id)); retireWorker(w); }
    catch (error) { workerFailure(w, error); }
  };
  return {
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
    stopWorker(handle: ExecutionBinding): void { workerOf(handle).bridge.requestStop(); },
    /** Observations only: neither method proves tree disposal or full owner release. */
    workerEvidence(handle: ExecutionBinding) {
      const w = workerOf(handle), evidence = w.bridge.diagnostics();
      return {...evidence, failureCount: evidence.failureCount + w.failureCount,
        firstFailure: w.firstFailure ?? evidence.firstFailure,
        ownerFailure: w.firstFailure, transportFailure: evidence.firstFailure,
        resourcesRetired: w.resourcesRetired};
    },
    workerSettled(handle: ExecutionBinding): Promise<void> { return workerOf(handle).bridge.requestsSettled(); },
    async runWorker(handle: ExecutionBinding, entry: bigint, load?: Loader): Promise<{status: number; sourceFailures: number}> {
      const w = workerOf(handle);
      if (w.active || w.invocation || w.imagePending || w.bridge.diagnostics().exited || w.bridge.diagnostics().stopping) throw new Error('Worker run unavailable');
      w.invocation = result(core.linux_run_start(w.id));
      w.active = true;
      let failures = 0, exit = false;
      try {
        const outcome = await w.bridge.run(w.invocation, entry, async request => {
          try {
            const c = command(core.linux_syscall(w.id, request.invocation, request.nr, ...request.args, request.next));
            if (c.tag === 0) return {kind: 'return', value: c.value};
            if (c.tag === 2) { exit = true; return {kind: 'leave'}; }
            if (c.tag !== 1) throw new Error(`Unsupported Rust Worker command: ${c.tag}`);
            const completed = await finishRead(w.id, c.value, c.target, w.memory, load, () => { failures++; });
            if (completed.tag !== 0) throw new Error(`Worker read did not return: ${completed.tag}`);
            return {kind: 'return', value: completed.value};
          } catch (error) {
            // A callback can finish after exit; settle its source before trying
            // abandonment again. Unknown obligations remain owned in Rust.
            try { checked(core.linux_syscall_abandon(w.id)); retireWorker(w); }
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
      } finally { w.active = false; }
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
