/** Private managed-memory adapter. Rust decides admission and lifetime; this file
 * holds actual engine objects and executes synchronous physical operations only.
 * Not exported by linux.ts and not connected to guest execution yet. */
interface Admission extends WebAssembly.Exports {
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
}
// Capture the physical operations before any caller can replace their prototypes.
// The importing realm's intrinsics must be trusted at module initialization.
const Bytes = Uint8Array, Memory = WebAssembly.Memory, apply = Reflect.apply, freeze = Object.freeze;
const numeric = Number, wide = BigInt, unsigned = BigInt.asUintN;
const setBytes = Uint8Array.prototype.set;
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
export interface FileLimits {
  inodes: number; entries: number; fileBytes: number; tables: number;
  descriptions: number; slots: number; reads: number;
}
const required = ['linux_abi_version', 'linux_init', 'linux_result', 'linux_bind', 'linux_span',
  'linux_binding_room', 'linux_change', 'linux_start', 'linux_receipt', 'linux_retire',
  'linux_files_prepare', 'linux_name', 'linux_input', 'linux_tree_directory', 'linux_tree_file',
  'linux_files_seal', 'linux_open', 'linux_dup', 'linux_close', 'linux_offset', 'linux_seek',
  'linux_read_begin', 'linux_read_start', 'linux_read_receipt', 'linux_read_query',
  'linux_read_cancel', 'linux_read_retire', 'linux_result_length', 'linux_result_state'];
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
  const inodes = new Map<InodeBinding, bigint>();
  const inodeHandles = new Map<bigint, InodeBinding>();
  const reads = new Map<ReadBinding, {id: bigint; memory: WebAssembly.Memory; offset: number}>();
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
  const readOf = (read: ReadBinding): {id: bigint; memory: WebAssembly.Memory; offset: number} => {
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
  return {
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
    copyRead(read: ReadBinding): number {
      const {id, memory, offset} = readOf(read);
      const pointer = numeric(result(core.linux_read_start(id)));
      const length = numeric(core.linux_result_length());
      try {
        // No caller callback, await or core export between fresh views and copy.
        // Canonical payload is pinned by Rust; neither view escapes this scope.
        if (length) {
          const source = new Bytes(bufferOf(core.memory), pointer, length);
          const target = new Bytes(bufferOf(memory), offset, length);
          apply(setBytes, target, [source]);
        }
      } catch (error) {
        // Keep the caller's read handle: unknown effect is queryable, never replayed.
        try { checked(core.linux_read_receipt(id, 0n, 1)); }
        catch (receipt) { throw new AggregateError([error, receipt], 'Read copy and receipt failed'); }
        throw error;
      }
      checked(core.linux_read_receipt(id, wide(length), 0));
      return length;
    },
    readResult(read: ReadBinding) {
      const confirmed = result(core.linux_read_query(readOf(read).id));
      const length = numeric(core.linux_result_length()), flags = core.linux_result_state();
      const state = (['ready', 'executing', 'unknown', 'finished', 'cancelled'] as const)[flags & 0xff];
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
