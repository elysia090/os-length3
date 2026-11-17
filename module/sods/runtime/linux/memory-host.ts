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
}
// Capture the physical operations before any caller can replace their prototypes.
// The importing realm's intrinsics must be trusted at module initialization.
const Bytes = Uint8Array, Memory = WebAssembly.Memory, apply = Reflect.apply, freeze = Object.freeze;
const setBytes = Uint8Array.prototype.set;
const growMemory = WebAssembly.Memory.prototype.grow;
const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer')!.get!;
const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapDelete = Map.prototype.delete;
const bufferOf = (memory: WebAssembly.Memory): ArrayBuffer => apply(memoryBuffer, memory, []);
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
const lengthOf = (bytes: Uint8Array): number => apply(typedLength, bytes, []);
const extentOf = (memory: WebAssembly.Memory): bigint => BigInt(lengthOf(new Bytes(bufferOf(memory))));
export interface MemoryBinding { readonly kind: 'managed-memory' }
const required = ['linux_abi_version', 'linux_init', 'linux_result', 'linux_bind', 'linux_span',
  'linux_binding_room', 'linux_change', 'linux_start', 'linux_receipt', 'linux_retire'];
const integer = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Expected a nonnegative safe integer');
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
  if (WebAssembly.Module.imports(module).length || required.some(name => names.get(name) !== 'function')) {
    throw new Error('Unsupported Linux admission module');
  }
  // Only a trusted matching artifact is accepted by the eventual artifact loader;
  // export-shape checks are not validation of arbitrary Wasm behavior.
  const core = new WebAssembly.Instance(module).exports as Admission;
  if (core.linux_abi_version() !== 1) throw new Error('Unsupported Linux admission ABI');
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
  const result = (status: number): bigint => { checked(status); return core.linux_result(); };
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
  return {
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
      const action = result(core.linux_span(id, BigInt(offset), BigInt(length)));
      return perform(action, BigInt(length), () => {
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
      const action = result(core.linux_span(id, BigInt(offset), BigInt(length)));
      perform(action, BigInt(length), () => { apply(setBytes, new Bytes(bufferOf(memory), offset, length), [bytes]); });
    },
    grow(binding: MemoryBinding, pages: number): MemoryBinding {
      integer(pages);
      const {id, memory} = get(binding);
      const extent = extentOf(memory) + BigInt(pages) * 65536n;
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
