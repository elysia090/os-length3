/** Opt-in regular-file payloads owned by the Rust file store. No namespace or mappings.
 * All returned bytes are owned snapshots; no wasm memory view escapes this facade.
 */
export const FILE_STORE_FUNCTIONS = ['files_abi_version', 'files_init', 'files_input', 'files_ptr', 'files_len', 'files_create',
  'files_create_lazy', 'files_load_begin', 'files_load_source', 'files_load_finish', 'files_size',
  'files_resident', 'files_release', 'files_own', 'files_load_check', 'files_write', 'files_read_begin',
  'files_read_finish', 'files_truncate', 'files_close'] as const;
interface FileStoreExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  files_abi_version(): number;
  files_init(limit: number): number;
  files_input(length: number): number;
  files_ptr(): number;
  files_len(): number;
  files_create(): number;
  files_create_lazy(source: number, size: number): number;
  files_load_begin(id: number): number;
  files_load_source(id: number): number;
  files_load_finish(id: number, operation: number, outcome: number): number;
  files_size(id: number): number;
  files_resident(id: number): number;
  files_release(id: number): number;
  files_own(id: number): number;
  files_load_check(id: number): number;
  files_write(id: number, at: number): number;
  files_read_begin(id: number, at: number, length: number): number;
  files_read_finish(operation: number, outcome: number, count: number): number;
  files_truncate(id: number, length: number): number;
  files_close(id: number): number;
}
export interface FilePayload {
  materialize(): number;
  checkIdle(): void;
  resident(): number;
  source(): number;
  release(): number;
  own(): void;
  /** Internal resident mapping route: never runs a loader; Rust validates readiness. */
  ownResident(): void;
  writeResident(at: number, bytes: Uint8Array): void;
  given(bytes: Uint8Array): number;
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
export class FileStoreError extends Error {
  readonly code: number;
  constructor(code: number) { super(`sods file-store error ${code}`); this.code = code; }
}
const check = (result: number): number => {
  if (result < 0) throw new FileStoreError(result);
  return result;
};
/** limit is per-file logical length, not a bound on total live memory or capacity. */
export async function loadFileStore(source: WebAssembly.Module | BufferSource, maxFileBytes: number) {
  uint(maxFileBytes);
  if (maxFileBytes > 0x7fffffff) throw new RangeError('File limit exceeds supported length');
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const exports = new Map(WebAssembly.Module.exports(module).map(entry => [entry.name, entry.kind]));
  if (exports.get('memory') !== 'memory' || FILE_STORE_FUNCTIONS.some(name => exports.get(name) !== 'function')) {
    throw new Error('Unsupported file-store ABI: missing required exports');
  }
  const wasm = new WebAssembly.Instance(module, {}).exports as FileStoreExports;
  if (typeof wasm.files_abi_version !== 'function' || wasm.files_abi_version() !== 4) throw new Error('Unsupported file-store ABI');
  check(wasm.files_init(maxFileBytes));
  const view = (): Uint8Array<ArrayBuffer> => {
    const offset = wasm.files_ptr() >>> 0, length = wasm.files_len() >>> 0;
    const buffer = wasm.memory.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error('File-store memory must be unshared');
    if (offset > buffer.byteLength || length > buffer.byteLength - offset) throw new Error('Invalid wasm file span');
    return new Uint8Array(buffer, offset, length);
  };
  // Snapshot before touching wasm scratch: reading an embedding object's input
  // must not run user code while a scratch write is outstanding.
  const input = (bytes: Uint8Array) => {
    if (bytes.byteLength > maxFileBytes) throw new RangeError('File exceeds configured limit');
    const owned = new Uint8Array(bytes);
    if (owned.length > maxFileBytes) throw new RangeError('File exceeds configured limit');
    check(wasm.files_input(owned.length));
    view().set(owned);
  };
  const abort = (operation: number, error: unknown): never => {
    // A failed copy is not a rollback claim. Retire the lease before propagating.
    try { check(wasm.files_read_finish(operation, 1, 0)); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'File-store read failed and its lease could not be retired'); }
    throw error;
  };
  const sources = new Map<number, () => Uint8Array>();
  let nextSource = 1;
  // origin is immutable host callback identity, not a cached loaded/owned state.
  // Rust remains authoritative; deleting an already-retired callback is harmless.
  const handle = (id: number, origin = 0): FilePayload => {
      let closed = false;
      const live = () => { if (closed) throw new Error('File handle is closed'); };
      const materialize = (given?: Uint8Array, needSize = true): number => {
        live();
        const operation = check(wasm.files_load_begin(id));
        if (!operation) return needSize ? check(wasm.files_size(id)) : 0;
        const source = check(wasm.files_load_source(id));
        try {
          const loader = sources.get(source);
          if (!loader) throw new Error('Missing wasm file source');
          const bytes = given ?? loader();
          // Input capture happens after the callback, with no read scratch lease.
          live();
          if (bytes.byteLength > maxFileBytes) throw new FileStoreError(-2);
          input(bytes); live();
        } catch (error) {
          // Closed slots already retired their attempt. Otherwise preparation
          // failure must explicitly abort before an independent retry is possible.
          if (!closed) {
            try { check(wasm.files_load_finish(id, operation, 1)); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'File-store load failed and its attempt could not be retired'); }
          }
          throw error;
        }
        // Matching finish retires on success, poison and allocation/size failure.
        // Do not mistake a second abort's BadCompletion for a cleanup failure.
        const size = check(wasm.files_load_finish(id, operation, 0));
        return size;
      };
      return {
        materialize() { return materialize(); },
        checkIdle() { live(); check(wasm.files_load_check(id)); },
        resident() { live(); return check(wasm.files_resident(id)); },
        source() { live(); return check(wasm.files_load_source(id)); },
        release() { live(); return check(wasm.files_release(id)); },
        own() { materialize(); const source = check(wasm.files_load_source(id)); check(wasm.files_own(id)); if (source) sources.delete(source); },
        ownResident() { live(); check(wasm.files_own(id)); if (origin) sources.delete(origin); },
        writeResident(at, bytes) { live(); uint(at); input(bytes); live(); check(wasm.files_write(id, at)); if (origin) sources.delete(origin); },
        given(bytes) { return materialize(bytes); },
        read(at, length) {
          materialize();
          const operation = check(wasm.files_read_begin(id, uint(at), uint(length)));
          try {
            const result = view().slice();
            check(wasm.files_read_finish(operation, 0, result.length));
            return result;
          } catch (error) { return abort(operation, error); }
        },
        readInto(start, into, at, length) {
          // Recheck readiness after the outer caller callback, but do not query
          // an unused size. Cold load completion and failure retirement are unchanged.
          uint(start); uint(at); uint(length); materialize(undefined, false);
          const operation = check(wasm.files_read_begin(id, start, length));
          try {
            const bytes = view();
            // No host callback or escaping scratch view between export and copy.
            Uint8Array.prototype.set.call(into, bytes, at);
            return check(wasm.files_read_finish(operation, 0, bytes.length));
          } catch (error) { return abort(operation, error); }
        },
        write(at, bytes) { live(); uint(at); materialize(); input(bytes); live(); const source = check(wasm.files_load_source(id)); check(wasm.files_write(id, at)); if (source) sources.delete(source); },
        truncate(length) { live(); uint(length); materialize(); const source = check(wasm.files_load_source(id)); check(wasm.files_truncate(id, length)); if (source) sources.delete(source); },
        close() {
          if (!closed) {
            const source = check(wasm.files_load_source(id));
            check(wasm.files_close(id)); closed = true;
            if (source) sources.delete(source);
          }
        },
      };
  };
  return {
    create(bytes: Uint8Array): FilePayload { input(bytes); return handle(check(wasm.files_create())); },
    createLazy(loader: () => Uint8Array, size = 0): FilePayload {
      uint(size); if (size > maxFileBytes) throw new FileStoreError(-2);
      if (nextSource > 0x7fffffff) throw new Error('File-store source identities exhausted');
      const source = nextSource++;
      const id = check(wasm.files_create_lazy(source, size));
      sources.set(source, loader);
      return handle(id, source);
    },
  };
}

/** Check an explicitly selected trusted wasm with the same consumer ABI.
 * This creates a temporary instance, not a sandbox or an integrity verifier.
 * The returned compiled module can be reused across separately owned scopes. */
export async function prepareFileStore(source: WebAssembly.Module | BufferSource, maxFileBytes: number): Promise<WebAssembly.Module> {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  if (WebAssembly.Module.imports(module).length) throw new Error('File-store module must not import host capabilities');
  const store = await loadFileStore(module, maxFileBytes);
  const file = store.create(new Uint8Array(0));
  try {
    if (file.read(0, 0).length !== 0) throw new Error('File-store module empty-read smoke failed');
  } finally { file.close(); }
  return module;
}
