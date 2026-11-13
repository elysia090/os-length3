// Run the translator itself as wasm, so a browser can translate the
// programs it executes (a compiler's output included) without a server.
//
// A wasm memory only grows, so what the translator held (programs it keeps
// parsed) goes back to the host only with the instance: `renew` makes a
// fresh one from the same compiled module.

import {said} from './host.ts';

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
  // (`read`: the call's only failure is the ELF's reading, as sods_translate and its kin fail: NotAProgram.)
  const output = (status: number, read = false): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(x.memory.buffer, x.sods_output_ptr(), x.sods_output_len()).slice();
    if (status !== 0) { const why = new TextDecoder().decode(out); throw read ? new NotAProgram(why) : new Error(why); }
    return out;
  };
  // The ELF is the translator's once given (parsed where it lies), so it is not freed here.
  function translate(elf: Uint8Array): Uint8Array<ArrayBuffer> {
    return output(x.sods_translate(put(elf), elf.length), true);
  }
  translate.notProgram = (error: unknown): boolean => error instanceof NotAProgram;
  /** As translate, all of the program: as the release translates the hot ones, and a page a program ahead of its run. */
  translate.whole = (elf: Uint8Array): Uint8Array<ArrayBuffer> => output(x.sods_translate_whole(put(elf), elf.length), true);
  const words = (list: (bigint | number)[]): Uint8Array<ArrayBuffer> => new Uint8Array(new BigUint64Array(list.map((w) => BigInt(w))).buffer);
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
