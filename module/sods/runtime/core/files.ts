/** Opt-in regular-file payloads owned by the Rust core. No namespace or mappings.
 * All returned bytes are owned snapshots; no core memory view escapes this facade.
 */
interface Core extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  files_abi_version(): number;
  files_init(limit: number): number;
  files_input(length: number): number;
  files_ptr(): number;
  files_len(): number;
  files_create(): number;
  files_write(id: number, at: number): number;
  files_read(id: number, at: number, length: number): number;
  files_truncate(id: number, length: number): number;
  files_close(id: number): number;
}
export interface CoreFile {
  read(at: number, length: number): Uint8Array<ArrayBuffer>;
  readInto(start: number, into: Uint8Array, at: number, length: number): number;
  write(at: number, bytes: Uint8Array): void;
  truncate(length: number): void;
  close(): void;
}
const uint = (n: number): number => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('Expected a uint32');
  return n;
};
const check = (result: number): number => {
  if (result < 0) throw new Error(`sods core file error ${result}`);
  return result;
};
/** limit is per-file logical length, not a bound on total live memory or capacity. */
export async function loadCoreFiles(source: WebAssembly.Module | BufferSource, maxFileBytes: number) {
  uint(maxFileBytes);
  if (maxFileBytes > 0x7fffffff) throw new RangeError('File limit exceeds supported length');
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const core = new WebAssembly.Instance(module, {}).exports as Core;
  if (typeof core.files_abi_version !== 'function' || core.files_abi_version() !== 1) throw new Error('Unsupported core files ABI');
  check(core.files_init(maxFileBytes));
  const view = (): Uint8Array<ArrayBuffer> => {
    const offset = core.files_ptr() >>> 0, length = core.files_len() >>> 0;
    const buffer = core.memory.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Core memory must be unshared');
    if (offset > buffer.byteLength || length > buffer.byteLength - offset) throw new Error('Invalid core file span');
    return new Uint8Array(buffer, offset, length);
  };
  // Snapshot before touching core scratch: reading an embedding object's input
  // must not run user code while a scratch write is outstanding.
  const input = (bytes: Uint8Array) => {
    if (bytes.byteLength > maxFileBytes) throw new RangeError('File exceeds configured limit');
    const owned = new Uint8Array(bytes);
    if (owned.length > maxFileBytes) throw new RangeError('File exceeds configured limit');
    check(core.files_input(owned.length));
    view().set(owned);
  };
  return {
    create(bytes: Uint8Array): CoreFile {
      input(bytes);
      const id = check(core.files_create());
      let closed = false;
      const live = () => { if (closed) throw new Error('File handle is closed'); };
      return {
        read(at, length) { live(); check(core.files_read(id, uint(at), uint(length))); return view().slice(); },
        readInto(start, into, at, length) {
          live(); uint(start); uint(at); uint(length);
          check(core.files_read(id, start, length));
          const bytes = view();
          // No host callback or escaping scratch view between export and copy.
          Uint8Array.prototype.set.call(into, bytes, at);
          return bytes.length;
        },
        write(at, bytes) { live(); uint(at); input(bytes); live(); check(core.files_write(id, at)); },
        truncate(length) { live(); check(core.files_truncate(id, uint(length))); },
        close() { if (!closed) { check(core.files_close(id)); closed = true; } },
      };
    },
  };
}
