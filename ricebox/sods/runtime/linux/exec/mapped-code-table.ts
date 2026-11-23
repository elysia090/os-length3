import type {MappedTranslate} from '../../translation/mapped.ts';
import {sameBytes} from '../fs.ts';
import type {BoundText} from './mapped-code-space.ts';
import {MAPPED_ENTRY_BYTES, type MappedEntries} from './mapped-entries.ts';

export const MAPPED_ABI_VERSION = 17;
const CHECKED_FRAGMENT_IMPORTS = ['mapped_string', 'mapped_fx_state'];
const MAX_SLOTS = 65536, DEFAULT_BYTES = 64 << 20;

interface Piece {
  readonly source: BoundText;
  readonly base: WebAssembly.Global;
  readonly entries: DataView;
  readonly count: number;
  readonly bytes: number;
}

interface CompiledPiece {
  readonly module: WebAssembly.Module;
  readonly bytes: number;
}

export class MappedArtifactRetirementError extends AggregateError {
  readonly handles: readonly Set<bigint>[];
  constructor(errors: unknown[], message: string, handles: readonly Set<bigint>[]) {
    super(errors, message);
    this.handles = handles;
  }
}

export function mappedPieceMetadata(module: WebAssembly.Module): {count: number; starts: DataView; entries: DataView} {
  const sections = WebAssembly.Module.customSections(module, 'sods.mapped-piece-v' + MAPPED_ABI_VERSION);
  if (sections.length !== 1) throw new Error('Mapped code fragment lacks the checked data ABI');
  const bytes = sections[0];
  if (bytes.byteLength < 4) throw new Error('Invalid mapped code metadata');
  const count = new DataView(bytes).getUint32(0, true), entryAt = 4 + count * 4;
  if (count > MAX_SLOTS || entryAt > bytes.byteLength || (bytes.byteLength - entryAt) % MAPPED_ENTRY_BYTES)
    throw new Error('Invalid mapped code metadata');
  return {count, starts: new DataView(bytes, 4, count * 4), entries: new DataView(bytes, entryAt)};
}

/** A validated Wasm module has at most one type section and one import
 * section. The standard emitter puts both immediately after the header. */
function sectionEnd(code: Uint8Array, at: number, kind: number): number {
  if (code[at++] !== kind) return 0;
  let length = 0;
  for (let shift = 0; shift < 35 && at < code.length; shift += 7) {
    const byte = code[at++];
    length += (byte & 127) * 2 ** shift;
    if (byte < 128) return at + length <= code.length ? at + length : 0;
  }
  return 0;
}

/** A prepared piece has no instantiation effects on the live VM. */
function checkPreparedSections(code: Uint8Array): void {
  for (let at = 8; at < code.length;) {
    const kind = code[at];
    if (kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3 && kind !== 7 && kind !== 10)
      throw new Error('Prepared mapped code has unexpected Wasm sections');
    const next = sectionEnd(code, at, kind);
    if (!next) throw new Error('Invalid prepared mapped code section');
    at = next;
  }
}

/** The compiled code held by one dispatcher. A binding owns its fragments
 * until its exact executable mapping is withdrawn. */
export class MappedCodeTable {
  readonly #table: WebAssembly.Table;
  readonly #shared: WebAssembly.ModuleImports;
  readonly #env: WebAssembly.ModuleImports;
  readonly #compiler: MappedTranslate;
  readonly #entries: MappedEntries;
  readonly #limit: number;
  #starts = new Map<BoundText, Set<bigint>>();
  #pieces: Piece[] = [];
  #slots = 0;
  #bytes = 0;
  readonly #importPrefixes: Uint8Array[] = [];

  constructor(core: WebAssembly.Exports & {table: WebAssembly.Table},
      env: WebAssembly.ModuleImports, compiler: MappedTranslate, entries: MappedEntries, limit = DEFAULT_BYTES) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('Invalid mapped translation budget');
    const {table, contexts, save_context, restore_context, ...shared} = core;
    this.#table = table;
    this.#shared = shared;
    this.#env = env;
    this.#compiler = compiler;
    this.#entries = entries;
    this.#limit = limit;
  }

  compile(source: BoundText, generation: object, pc: bigint, checkLive: () => void): bigint {
    let known = this.#starts.get(source);
    const prepared = known ? undefined : source.prepared, requested = Number(pc);
    if (!known) this.#starts.set(source, known = new Set());
    try {
      const remaining = this.#limit - this.#bytes;
      if (prepared?.entry === requested && prepared.bytes <= remaining) {
        const bytes = prepared.read();
        checkLive();
        if (bytes) {
          if (bytes.byteLength !== prepared.bytes) throw new Error('Prepared mapped code length changed');
          checkPreparedSections(bytes);
          const target = this.#install(source, requested, known, this.#compile(bytes, remaining), checkLive, true);
          if (target !== -1n) return target;
        }
      }
      const compiled = source.compile(generation, this.#compiler, pc, known, code => this.#compile(code, remaining));
      return this.#install(source, requested, known, compiled, checkLive);
    } catch (cause) {
      // On failure, the translator can reopen from the starts we actually published.
      try { this.#compiler.close(known); }
      catch (cleanup) { throw new MappedArtifactRetirementError([cause, cleanup], 'Mapped attachment failed', [known]); }
      if (!known.size) this.#starts.delete(source);
      throw cause;
    }
  }

  #compile(code: Uint8Array<ArrayBuffer>, remaining: number): CompiledPiece {
    const bytes = code.byteLength;
    if (bytes > remaining) throw new RangeError('Mapped translation budget exhausted');
    const module = new WebAssembly.Module(code);
    this.#checkImports(code, module);
    return {module, bytes};
  }

  #install(source: BoundText, requestedPc: number, known: Set<bigint>, {module, bytes}: CompiledPiece,
      checkLive: () => void, prepared = false): bigint {
    const {count, starts, entries} = mappedPieceMetadata(module);
    const base = this.#slots, end = base + count;
    if (end > MAX_SLOTS) {
      if (prepared) return -1n;
      throw new Error('Mapped translation leaves its executable extent');
    }
    const first = source.text.address, last = first + source.text.length;
    const within = (at: number): boolean => at >= first && at < last;
    for (let i = 0; i < starts.byteLength; i += 4)
      if (!within(starts.getUint32(i, true))) throw new Error('Mapped translation leaves its executable extent');
    let target = -1;
    for (let i = 0; i < entries.byteLength; i += MAPPED_ENTRY_BYTES) {
      const at = entries.getUint32(i, true), slot = entries.getUint32(i + 8, true);
      if (!within(at) || slot >= count) throw new Error('Mapped translation has an invalid entry');
      if (at === requestedPc) target = (base + slot) * (2 ** 32) + entries.getUint32(i + 4, true);
    }
    if (target === -1) {
      if (!prepared && (count || entries.byteLength)) throw new Error('Mapped translation did not describe the requested PC');
      return -1n;
    }

    const slot = new WebAssembly.Global({value: 'i32', mutable: true}, base);
    const own = new WebAssembly.Instance(module, {env: this.#env, main: this.#shared, piece: {base: slot}}).exports;
    const functions = Object.values(own);
    if (functions.length !== count || functions.some((fn, index) => typeof fn !== 'function' || fn !== own[index]))
      throw new Error('Mapped translation has invalid function slots');
    checkLive();
    const table = this.#table;
    this.#entries.reserve(entries.byteLength / MAPPED_ENTRY_BYTES);
    if (table.length < end) table.grow(Math.min(MAX_SLOTS, Math.max(end, table.length * 2, 16)) - table.length);
    for (let i = 0; i < count; i++) table.set(base + i, functions[i]);
    this.#pieces.push({source, base: slot, entries, count, bytes});
    this.#slots = end;
    this.#bytes += bytes;
    for (let i = 0; i < starts.byteLength; i += 4) known.add(BigInt(starts.getUint32(i, true)));
    this.#entries.publish(entries, base);
    return BigInt(target);
  }

  #checkImports(code: Uint8Array, module: WebAssembly.Module): void {
    const prefixes = this.#importPrefixes;
    for (const prefix of prefixes) if (sameBytes(code.subarray(0, prefix.length), prefix)) return;
    const imports = WebAssembly.Module.imports(module);
    if (!imports.some(i => i.kind === 'global' && i.module === 'piece' && i.name === 'base') ||
        !imports.some(i => i.kind === 'function' && i.module === 'main' && i.name === 'mapped_address') ||
        !CHECKED_FRAGMENT_IMPORTS.every(name => imports.some(i => i.kind === 'function' && i.module === 'env' && i.name === name)))
      throw new Error('Mapped code fragment lacks the checked data ABI');
    const typeEnd = sectionEnd(code, 8, 1), end = typeEnd && sectionEnd(code, typeEnd, 2);
    if (end) {
      if (prefixes.length === 2) prefixes.shift();
      prefixes.push(code.slice(0, end));
    }
  }

  /** Called after Wasm has unwound. Evict withdrawn bindings and move
   * surviving slots left into any holes without translating them again. */
  retain(live: (source: BoundText) => boolean): void {
    const retired = new Set([...this.#starts.keys()].filter(source => !live(source)));
    if (!retired.size) return;
    const table = this.#table, kept: Piece[] = [];
    let next = 0;
    this.#entries.clear();
    for (const piece of this.#pieces) {
      if (retired.has(piece.source)) {
        this.#bytes -= piece.bytes;
        continue;
      }
      const base = Number(piece.base.value);
      if (base !== next) {
        for (let i = 0; i < piece.count; i++) table.set(next + i, table.get(base + i));
        piece.base.value = next;
      }
      this.#entries.publish(piece.entries, next);
      kept.push(piece);
      next += piece.count;
    }
    for (let i = next; i < this.#slots; i++) table.set(i, null);
    this.#slots = next;
    this.#pieces = kept;

    const failures: unknown[] = [], handles: Set<bigint>[] = [];
    for (const source of retired) {
      const known = this.#starts.get(source)!;
      this.#starts.delete(source);
      try { this.#compiler.close(known); } catch (error) { failures.push(error); handles.push(known); }
    }
    if (failures.length) throw new MappedArtifactRetirementError(failures, 'Mapped artifact retirement failed', handles);
  }
}
