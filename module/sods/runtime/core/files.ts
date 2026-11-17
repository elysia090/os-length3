/** Opt-in regular-file payloads owned by the Rust core. No namespace or mappings.
 * All returned bytes are owned snapshots; no core memory view escapes this facade.
 */
export const CORE_FILE_FUNCTIONS = ['files_abi_version', 'files_init', 'files_input', 'files_ptr', 'files_len', 'files_create',
  'files_create_lazy', 'files_load_begin', 'files_load_source', 'files_load_finish', 'files_size',
  'files_resident', 'files_release', 'files_own', 'files_load_check', 'files_write', 'files_read_begin',
  'files_read_finish', 'files_truncate', 'files_close'] as const;
interface Core extends WebAssembly.Exports {
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
export interface CoreFile {
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
export class CoreFileError extends Error {
  readonly code: number;
  constructor(code: number) { super(`sods core file error ${code}`); this.code = code; }
}
const check = (result: number): number => {
  if (result < 0) throw new CoreFileError(result);
  return result;
};
/** limit is per-file logical length, not a bound on total live memory or capacity. */
export async function loadCoreFiles(source: WebAssembly.Module | BufferSource, maxFileBytes: number) {
  uint(maxFileBytes);
  if (maxFileBytes > 0x7fffffff) throw new RangeError('File limit exceeds supported length');
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const exports = new Map(WebAssembly.Module.exports(module).map(entry => [entry.name, entry.kind]));
  if (exports.get('memory') !== 'memory' || CORE_FILE_FUNCTIONS.some(name => exports.get(name) !== 'function')) {
    throw new Error('Unsupported core files ABI: missing required exports');
  }
  const core = new WebAssembly.Instance(module, {}).exports as Core;
  if (typeof core.files_abi_version !== 'function' || core.files_abi_version() !== 4) throw new Error('Unsupported core files ABI');
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
  const abort = (operation: number, error: unknown): never => {
    // A failed copy is not a rollback claim. Retire the lease before propagating.
    try { check(core.files_read_finish(operation, 1, 0)); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Core read failed and its lease could not be retired'); }
    throw error;
  };
  const sources = new Map<number, () => Uint8Array>();
  let nextSource = 1;
  // origin is immutable host callback identity, not a cached loaded/owned state.
  // Rust remains authoritative; deleting an already-retired callback is harmless.
  const handle = (id: number, origin = 0): CoreFile => {
      let closed = false;
      const live = () => { if (closed) throw new Error('File handle is closed'); };
      const materialize = (given?: Uint8Array): number => {
        live();
        const operation = check(core.files_load_begin(id));
        if (!operation) return check(core.files_size(id));
        const source = check(core.files_load_source(id));
        try {
          const loader = sources.get(source);
          if (!loader) throw new Error('Missing core file source');
          const bytes = given ?? loader();
          // Input capture happens after the callback, with no read scratch lease.
          live();
          if (bytes.byteLength > maxFileBytes) throw new CoreFileError(-2);
          input(bytes); live();
        } catch (error) {
          // Closed slots already retired their attempt. Otherwise preparation
          // failure must explicitly abort before an independent retry is possible.
          if (!closed) {
            try { check(core.files_load_finish(id, operation, 1)); }
            catch (cleanup) { throw new AggregateError([error, cleanup], 'Core load failed and its attempt could not be retired'); }
          }
          throw error;
        }
        // Matching finish retires on success, poison and allocation/size failure.
        // Do not mistake a second abort's BadCompletion for a cleanup failure.
        const size = check(core.files_load_finish(id, operation, 0));
        return size;
      };
      return {
        materialize,
        checkIdle() { live(); check(core.files_load_check(id)); },
        resident() { live(); return check(core.files_resident(id)); },
        source() { live(); return check(core.files_load_source(id)); },
        release() { live(); return check(core.files_release(id)); },
        own() { materialize(); const source = check(core.files_load_source(id)); check(core.files_own(id)); if (source) sources.delete(source); },
        ownResident() { live(); check(core.files_own(id)); if (origin) sources.delete(origin); },
        writeResident(at, bytes) { live(); uint(at); input(bytes); live(); check(core.files_write(id, at)); if (origin) sources.delete(origin); },
        given(bytes) { return materialize(bytes); },
        read(at, length) {
          materialize();
          const operation = check(core.files_read_begin(id, uint(at), uint(length)));
          try {
            const result = view().slice();
            check(core.files_read_finish(operation, 0, result.length));
            return result;
          } catch (error) { return abort(operation, error); }
        },
        readInto(start, into, at, length) {
          uint(start); uint(at); uint(length); materialize();
          const operation = check(core.files_read_begin(id, start, length));
          try {
            const bytes = view();
            // No host callback or escaping scratch view between export and copy.
            Uint8Array.prototype.set.call(into, bytes, at);
            return check(core.files_read_finish(operation, 0, bytes.length));
          } catch (error) { return abort(operation, error); }
        },
        write(at, bytes) { live(); uint(at); materialize(); input(bytes); live(); const source = check(core.files_load_source(id)); check(core.files_write(id, at)); if (source) sources.delete(source); },
        truncate(length) { live(); uint(length); materialize(); const source = check(core.files_load_source(id)); check(core.files_truncate(id, length)); if (source) sources.delete(source); },
        close() {
          if (!closed) {
            const source = check(core.files_load_source(id));
            check(core.files_close(id)); closed = true;
            if (source) sources.delete(source);
          }
        },
      };
  };
  return {
    create(bytes: Uint8Array): CoreFile { input(bytes); return handle(check(core.files_create())); },
    createLazy(loader: () => Uint8Array, size = 0): CoreFile {
      uint(size); if (size > maxFileBytes) throw new CoreFileError(-2);
      if (nextSource > 0x7fffffff) throw new Error('Core source identities exhausted');
      const source = nextSource++;
      const id = check(core.files_create_lazy(source, size));
      sources.set(source, loader);
      return handle(id, source);
    },
  };
}
