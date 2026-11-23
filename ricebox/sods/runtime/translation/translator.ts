// Run the translator itself as wasm, so a browser can translate the
// programs it executes (a compiler's output included) without a server.
//
// A wasm memory only grows, so what the translator held (programs it keeps
// parsed) goes back to the host only with the instance: `renew` makes a
// fresh one from the same compiled module.

import {said} from '../host.ts';
import type {MappedText, MappedTranslate} from './mapped.ts';
import {DYNAMIC_FILE_LIMIT, DYNAMIC_ROLES, dynamicLoadSpec, dynamicMetadataSpans, type DynamicRole, type ElfLoadSpec} from './dynamic-load.ts';
import {prepare} from './share.ts';

/** The translator's own exports. */
interface Exports {
  memory: WebAssembly.Memory;
  sods_budget(n: number): void;
  sods_run(n: number): void;
  sods_alloc(n: number): number;
  sods_free(at: number, n: number): void;
  sods_output_ptr(): number;
  sods_output_len(): number;
  sods_translate(elf: number, length: number): number;
  sods_translate_whole(elf: number, length: number): number;
  sods_translate_seeded(elf: number, length: number, seeds: number, count: number): number;
  sods_open(elf: number, length: number, known: number, count: number): number;
  sods_translate_more(handle: number, seeds: number, count: number, base: number): number;
  sods_close(handle: number): void;
  sods_describe_dynamic_v1?(elf: number, length: number, role: number): number;
  sods_describe_dynamic_v2?(metadata: number, metadataLength: number, fileLength: number, role: number): number;
  sods_mapped_core_v4?(): number;
  sods_open_mapped_v1?(elf: number, length: number, role: number, bias: number, address: number,
    offset: number, bytes: number, known: number, nKnown: number): number;
  sods_open_mapped_v2?(metadata: number, metadataLength: number, fileLength: number, rx: number,
    role: number, bias: number, address: number, offset: number, bytes: number, known: number, nKnown: number): number;
  sods_translate_mapped_one?(handle: number, seed: bigint): number;
  sods_replay_mapped_v1?(handle: number, seeds: number, count: number): number;
  sods_unzstd(at: number, length: number, size: number): number;
  sods_sha256(at: number, length: number): number;
}

/**
 * The translator's own word that what it was given is no program it takes: not an ELF it can read (cut short, of
 * another machine or class, not an executable, not one with nothing to load at run time), said as it reads it and
 * before it translates anything. Whoever asked to run the file has this as the file's fault (a kernel's exec:
 * ENOEXEC); anything else thrown by the translator is its own fault and not the file's.
 */
export class NotAProgram extends Error {
  override name = 'NotAProgram';
}

/** The translator, loaded: an x86-64 program's bytes in, a WebAssembly module's out; and what else it is asked. */
export interface Translate {
  (elf: Uint8Array): Uint8Array<ArrayBuffer>;
  /** Whether an error is this translator's rejection of its input, rather than a failure of the translator. */
  notProgram(error: unknown): boolean;
  /** Metadata only. Older translator releases do not have this capability. */
  describeDynamic?(elf: Uint8Array, role: DynamicRole): ElfLoadSpec;
  readonly mapped?: MappedTranslate;
  whole(elf: Uint8Array): Uint8Array<ArrayBuffer>;
  seeded(elf: Uint8Array, seeds: (bigint | number)[]): Uint8Array<ArrayBuffer>;
  more(elf: Uint8Array, seeds: (bigint | number)[], known: Set<bigint>, base: number): Uint8Array<ArrayBuffer>;
  close(known: Set<bigint>): void;
  unzstd(bytes: Uint8Array, size: number): Uint8Array<ArrayBuffer>;
  sha256(bytes: Uint8Array): Uint8Array<ArrayBuffer>;
  held(): number;
  spare(): number;
  renew(): boolean;
  /** The translator's compiled module: the x87 (x87.ts) is an instance of it of its own. */
  readonly module: WebAssembly.Module;
}

export type InitialPreparationResult = ReturnType<typeof prepare> | {preparationError: unknown};
type InitialPreparation = (elf: Uint8Array, shared: boolean) => InitialPreparationResult;
const initialPreparations = new WeakMap<(elf: Uint8Array) => Uint8Array, InitialPreparation>();

/** Internal static entry path for exact instances of this loader. No raw Wasm view escapes. */
export function initialPreparationFor(translate: (elf: Uint8Array) => Uint8Array): InitialPreparation | undefined {
  return initialPreparations.get(translate);
}

type MappedEmitter = MappedTranslate['more'];
const mappedOutputViews = new WeakMap<MappedEmitter, MappedEmitter>();

/** Synchronous use of the built-in translator's output. Consume it before
 * another translator call. An embedding's replacement `more` is called as usual. */
export function withMappedOutput<T>(compiler: MappedTranslate, args: Parameters<MappedEmitter>,
    consume: (code: Uint8Array<ArrayBuffer>) => T): T {
  const more = compiler.more, view = mappedOutputViews.get(more);
  return consume(view ? view(...args) : more.apply(compiler, args));
}

export async function loadTranslator(source: WebAssembly.Module | BufferSource): Promise<Translate> {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = (m: WebAssembly.Module): Exports => new WebAssembly.Instance(m, {}).exports as unknown as Exports;
  let x = instance(module);
  // SODS_BUDGET=N (node): how much code reached later one module may hold, for measuring (0: all it reaches).
  const budget = said('SODS_BUDGET');
  if (budget) x.sods_budget(Number(budget));
  // SODS_RUN=N (node): functions cut into runs of N blocks (layout.rs RUN), so the cut is tested on small programs.
  const run = said('SODS_RUN');
  if (run) x.sods_run(Number(run));
  // What a fresh instance holds: that much never goes back.
  let base = x.memory.buffer.byteLength;
  const put = (bytes: Uint8Array): number => { const p = x.sods_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  const putMetadata = (file: Uint8Array, role: DynamicRole): {at: number; length: number} => {
    const spans = dynamicMetadataSpans(file, role);
    const header = 8 * spans.length, length = spans.reduce((total, span) => total + span.length, header);
    const at = x.sods_alloc(length);
    const target = new Uint8Array(x.memory.buffer, at, length), view = new DataView(target.buffer, at, header);
    let payload = header;
    for (const [i, span] of spans.entries()) {
      const {offset, length} = span;
      view.setUint32(i * 8, offset, true);
      view.setUint32(i * 8 + 4, length, true);
      if (length) target.set(file.subarray(offset, offset + length), payload);
      payload += length;
    }
    return {at, length};
  };
  // (`read`: the call's only failure is the ELF's reading, as sods_translate and its kin fail: NotAProgram.)
  const outputView = (status: number, read = false): Uint8Array<ArrayBuffer> => {
    const view = new Uint8Array(x.memory.buffer, x.sods_output_ptr(), x.sods_output_len());
    if (status !== 0) {
      const why = new TextDecoder().decode(view.slice());
      throw read ? new NotAProgram(why) : new Error(why);
    }
    return view;
  };
  const output = (status: number, read = false): Uint8Array<ArrayBuffer> => outputView(status, read).slice();
  // The ELF is the translator's once given (parsed where it lies), so it is not freed here.
  const initialView = (elf: Uint8Array): Uint8Array<ArrayBuffer> => outputView(x.sods_translate(put(elf), elf.length), true);
  function translate(elf: Uint8Array): Uint8Array<ArrayBuffer> { return initialView(elf).slice(); }
  translate.notProgram = (error: unknown): boolean => error instanceof NotAProgram;
  initialPreparations.set(translate, (elf, shared) => {
    const view = initialView(elf); // Translation errors stay separate from preparation errors.
    try { return prepare(view, {shared}); }
    catch (preparationError) { return {preparationError}; }
  });
  if (x.sods_describe_dynamic_v1 || x.sods_describe_dynamic_v2) translate.describeDynamic = (elf: Uint8Array, role: DynamicRole): ElfLoadSpec => {
    if (!Object.hasOwn(DYNAMIC_ROLES, role) || !elf.length || elf.length > DYNAMIC_FILE_LIMIT)
      throw new NotAProgram('Invalid dynamic object size or role');
    if (x.sods_describe_dynamic_v2) {
      const {at, length} = putMetadata(elf, role);
      try { return dynamicLoadSpec(output(x.sods_describe_dynamic_v2(at, length, elf.length, DYNAMIC_ROLES[role]), true), role); }
      finally { x.sods_free(at, length); }
    }
    const at = put(elf);
    try { return dynamicLoadSpec(output(x.sods_describe_dynamic_v1!(at, elf.length, DYNAMIC_ROLES[role]), true), role); }
    finally { x.sods_free(at, elf.length); }
  };
  /** As translate, all of the program: as the release translates the hot ones, and a page a program ahead of its run. */
  translate.whole = (elf: Uint8Array): Uint8Array<ArrayBuffer> => output(x.sods_translate_whole(put(elf), elf.length), true);
  const words = (list: readonly (bigint | number)[]): Uint8Array<ArrayBuffer> => new Uint8Array(new BigUint64Array(list.map((w) => BigInt(w))).buffer);
  /** As translate, and from the function starts `seeds` too: the program with the code it reached later, as one module. */
  translate.seeded = function seeded(elf: Uint8Array, seeds: (bigint | number)[]): Uint8Array<ArrayBuffer> {
    const s = put(words(seeds));
    const status = x.sods_translate_seeded(put(elf), elf.length, s, seeds.length);
    x.sods_free(s, seeds.length * 8);
    return output(status, true);
  };
  // Each program's handle (by its set of starts known: one per translation of it, so a program translated again as
  // one module, and its first translation still running, are told apart), while the translator holds its ELF parsed
  // with the starts translated so far (it keeps a few, and adds each module's starts itself).
  let handles = new WeakMap<Set<bigint>, number>();
  const open = new Set<number>();
  const opened = (elf: Uint8Array, known: Set<bigint>): number => {
    const list = [...known];
    const k = put(words(list));
    const handle = x.sods_open(put(elf), elf.length, k, list.length);
    x.sods_free(k, list.length * 8);
    if (handle === 0) output(1);
    handles.set(known, handle);
    open.add(handle);
    return handle;
  };
  /** Code reached later: from `seeds`, past the `known` addresses (a set, read only when the ELF is opened; the program's handle), filling table slots from `base`. */
  translate.more = function more(elf: Uint8Array, seeds: (bigint | number)[], known: Set<bigint>, base: number): Uint8Array<ArrayBuffer> {
    const s = put(words(seeds));
    const go = (handle: number): number => x.sods_translate_more(handle, s, seeds.length, base);
    const handle = handles.get(known) ?? opened(elf, known);
    let status = go(handle);
    // Let go of by the translator for others since: open it again.
    if (status !== 0 && new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.sods_output_ptr(), x.sods_output_len())) === 'that ELF is not open') {
      open.delete(handle);
      status = go(opened(elf, known));
    }
    x.sods_free(s, seeds.length * 8);
    return output(status);
  };
  /** Let go of what the translator keeps for the program whose starts are `known` (it is no longer kept). */
  translate.close = (known: Set<bigint>): void => {
    const handle = handles.get(known);
    if (handle === undefined) return;
    x.sods_close(handle);
    handles.delete(known);
    open.delete(handle);
  };
  let translatorEpoch: object = {};
  if (x.sods_mapped_core_v4 && (x.sods_open_mapped_v1 || x.sods_open_mapped_v2)) {
    // Preserve parsed ELF bytes per authorized text generation. The old
    // Wasm instance itself is not retained when the translator is renewed.
    const sources = new WeakMap<Set<bigint>, {epoch: object; handle: number; elf: Uint8Array; text: MappedText}>();
    const openText = (elf: Uint8Array, text: MappedText, knownAt: number, knownCount: number): number => {
      const {role, bias, address, offset, length} = text, kind = DYNAMIC_ROLES[role];
      if (!x.sods_open_mapped_v2)
        return x.sods_open_mapped_v1!(put(elf), elf.length, kind, bias, address, offset, length, knownAt, knownCount);
      const metadata = putMetadata(elf, role);
      try {
        const rx = put(elf.subarray(offset, offset + length));
        return x.sods_open_mapped_v2(metadata.at, metadata.length, elf.length, rx,
          kind, bias, address, offset, length, knownAt, knownCount);
      } finally { x.sods_free(metadata.at, metadata.length); }
    };
    const openMapped = (elf: Uint8Array, text: MappedText, known: Set<bigint>): number => {
      const u32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff;
      if (!Object.hasOwn(DYNAMIC_ROLES, text.role) || !elf.length || elf.length > DYNAMIC_FILE_LIMIT ||
          ![text.bias, text.address, text.offset, text.length].every(u32) || !text.length || text.offset + text.length > elf.length)
        throw new NotAProgram('Invalid mapped ELF input');
      const list = [...known], k = put(words(list));
      try {
        const handle = openText(elf, text, k, list.length);
        if (!handle) output(1, true);
        sources.set(known, {epoch: translatorEpoch, handle, elf, text});
        return handle;
      } finally { x.sods_free(k, list.length * 8); }
    };
    const mappedView: MappedEmitter = (elf, text, address, known) => {
      const cached = sources.get(known);
      if (cached && (cached.elf !== elf || cached.text !== text)) throw new Error('Mapped translator source identity changed');
      let seed: number | undefined;
      const go = (handle: number): number => {
        if (x.sods_translate_mapped_one) return x.sods_translate_mapped_one(handle, address);
        seed ??= put(words([address]));
        return x.sods_translate_more(handle, seed, 1, 0);
      };
      let status: number;
      try {
        status = go(cached?.epoch === translatorEpoch ? cached.handle : openMapped(elf, text, known));
        if (status && new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.sods_output_ptr(), x.sods_output_len())) === 'that ELF is not open')
          status = go(openMapped(elf, text, known));
      } finally { if (seed !== undefined) x.sods_free(seed, 8); }
      return outputView(status);
    };
    const mapped: MappedTranslate = {
      core: () => output(x.sods_mapped_core_v4!()),
      more: (...args) => mappedView(...args).slice(),
      close(known) {
        const cached = sources.get(known);
        if (cached?.epoch === translatorEpoch) x.sods_close(cached.handle);
        sources.delete(known);
      },
    };
    mappedOutputViews.set(mapped.more, mappedView);
    if (x.sods_replay_mapped_v1) mapped.replay = (elf, text, pcs) => {
      if (!pcs.length || pcs.length > 65536 || pcs.some(pc => !Number.isInteger(pc) || pc < text.address || pc >= text.address + text.length))
        throw new RangeError('Invalid mapped replay PCs');
      const known = new Set<bigint>();
      const handle = openMapped(elf, text, known);
      try {
        const seeds = words(pcs), at = put(seeds);
        try { return output(x.sods_replay_mapped_v1!(handle, at, pcs.length)); }
        finally { x.sods_free(at, seeds.length); }
      } finally { mapped.close(known); }
    };
    translate.mapped = mapped;
  }
  /** A root file from a pack: its zstd frames decoded, `size` bytes (sods_unzstd). */
  translate.unzstd = (bytes: Uint8Array, size: number): Uint8Array<ArrayBuffer> => {
    const p = put(bytes);
    const status = x.sods_unzstd(p, bytes.length, size);
    x.sods_free(p, bytes.length);
    return output(status);
  };
  /** The SHA-256 of `bytes`, its 32 bytes (sods_sha256): what a pack's table holds of a file, checked at once. */
  translate.sha256 = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
    const p = put(bytes);
    const status = x.sods_sha256(p, bytes.length);
    x.sods_free(p, bytes.length);
    return output(status);
  };
  /** Bytes the translator's memory holds now. */
  translate.held = (): number => x.memory.buffer.byteLength;
  /** Of those, what a fresh instance would give back. */
  translate.spare = (): number => Math.max(0, x.memory.buffer.byteLength - base);
  /**
   * A fresh instance, so the old memory goes back: what it kept is let go,
   * and a program still running opens its ELF again on its next miss (with
   * the starts it knows, which it sends then). True: renewed.
   */
  translate.renew = (): boolean => {
    x = instance(module);
    translatorEpoch = {};
    if (budget) x.sods_budget(Number(budget));
    if (run) x.sods_run(Number(run));
    base = x.memory.buffer.byteLength;
    handles = new WeakMap();
    open.clear();
    return true;
  };
  translate.module = module;
  return translate;
}
