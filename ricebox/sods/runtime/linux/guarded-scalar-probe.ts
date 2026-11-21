// Opt-in executable proof of the Rust scalar lowering, detached from the
// ordinary kernel Task entry. Do not attach this to the stock raw-memory path.
import {sha256} from '../host.ts';
import {type ExecutableSource} from './executable-source.ts';
import {type ExecutableFileProof, type FileRxRequest} from './executable-mappings.ts';
import {GuardedInlineMemory, type GuardedOwner} from './guarded-inline-memory.ts';
import {Process} from './process.ts';

declare const compilerProof: unique symbol;
export interface GuardedScalarCompiler { readonly [compilerProof]: true }
type Compile = (bytes: Uint8Array<ArrayBuffer>) => WebAssembly.Module | null;
const trusted = new WeakMap<GuardedScalarCompiler, Compile>();

/** Use an explicitly admitted Sods producer, with no old-compiler fallback. */
export async function guardedScalarCompiler(bytes: Uint8Array<ArrayBufferLike>, expected: string): Promise<GuardedScalarCompiler> {
  if (!/^[0-9a-f]{64}$/.test(expected) || bytes.byteLength > 64 << 20) throw new TypeError('Expected pinned translator bytes');
  const stable = new Uint8Array(bytes);
  const actual = Array.from(await sha256(stable), b => b.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('Guarded scalar translator hash differs');
  const engine = new WebAssembly.Instance(await WebAssembly.compile(stable), {}).exports;
  const {memory, sods_alloc, sods_output_ptr, sods_output_len, sods_translate_guarded_scalar} = engine;
  if (!(memory instanceof WebAssembly.Memory) || typeof sods_alloc !== 'function' || typeof sods_output_ptr !== 'function'
    || typeof sods_output_len !== 'function' || typeof sods_translate_guarded_scalar !== 'function')
    throw new Error('Pinned translator has no guarded scalar entry');
  const proof = Object.freeze(Object.create(null)) as GuardedScalarCompiler;
  trusted.set(proof, source => {
    const at = sods_alloc(source.byteLength) >>> 0;
    new Uint8Array(memory.buffer, at, source.byteLength).set(source);
    const status = sods_translate_guarded_scalar(at, source.byteLength);
    if (status === 1) return null;
    if (status !== 0) throw new Error('Invalid guarded translator status');
    const n = sods_output_len() >>> 0;
    if (!n || n > 1024) throw new Error('Invalid guarded scalar artifact size');
    const out = new Uint8Array(memory.buffer, sods_output_ptr() >>> 0, n).slice();
    const module = new WebAssembly.Module(out), ins = WebAssembly.Module.imports(module), outs = WebAssembly.Module.exports(module);
    if (ins.length !== 2 || ins[0]!.module !== 'guard' || ins[0]!.kind !== 'function' || ins[0]!.name !== 'read'
      || ins[1]!.module !== 'guard' || ins[1]!.kind !== 'function' || ins[1]!.name !== 'write'
      || outs.length !== 1 || outs[0]!.kind !== 'function' || outs[0]!.name !== 'run')
      throw new Error('Guarded scalar ABI differs');
    return module;
  });
  return proof;
}

export interface GuardedScalarExecution {
  /** The actual following RET. Its stack effects are outside this probe. */
  readonly next: bigint;
  run(rdi: bigint, rsi: bigint): bigint;
}

/**
 * A stock Process is used for its identity and live FD ownership, not as a
 * source of raw guest bytes. This proof uses separate private guarded
 * backing and refuses a Process with a Task at admission or use.
 */
export class GuardedScalarProbe {
  readonly #guard: GuardedInlineMemory;
  readonly #owner: GuardedOwner;
  readonly #checkIdentity: () => void;
  readonly #compile: Compile;
  #dead = false;

  constructor(proc: Process, compiler: GuardedScalarCompiler, pages = 4) {
    const compile = trusted.get(compiler);
    if (!(proc instanceof Process) || proc.state !== 'live' || proc.tasks.size || !proc.memory
      || !(proc.memory.buffer instanceof ArrayBuffer) || !compile) throw new TypeError('Expected live detached inline Process and admitted compiler');
    this.#compile = compile;
    const stable = proc.readIdentity(), table = proc.fds;
    this.#checkIdentity = () => {
      stable();
      if (proc.state !== 'live' || proc.fds !== table || proc.tasks.size) throw new Error('Guarded scalar Process changed');
    };
    this.#guard = new GuardedInlineMemory(pages);
    this.#owner = this.#guard.installOwner(proc.kernel.vfs, table);
  }

  async authenticate(source: ExecutableSource, digest: string): Promise<ExecutableFileProof | null> {
    this.#alive();
    const proof = await this.#guard.authenticate(this.#owner, source, digest);
    this.#alive();
    return proof;
  }
  installCode(proof: ExecutableFileProof, fd: number, request: FileRxRequest): boolean {
    this.#alive();
    const result = this.#guard.installRx(this.#owner, proof, fd, request);
    this.#alive();
    return result;
  }
  installData(start: number, length: number, prot: number, initial?: Uint8Array): void {
    this.#alive();
    this.#guard.installData(this.#owner, start, length, prot, initial);
  }
  protect(start: number, length: number, prot: number): boolean {
    this.#alive();
    return this.#guard.protect(this.#owner, start, length, prot);
  }
  unmap(start: number, length: number): void {
    this.#alive();
    this.#guard.unmap(this.#owner, start, length);
  }
  read(address: bigint, width: number): bigint {
    this.#alive();
    return this.#guard.read(this.#owner, address, width);
  }
  prepare(address: bigint, length: number): GuardedScalarExecution | null {
    this.#alive();
    const source = this.#guard.bindCode(this.#owner, address, length);
    if (!source) return null;
    const compiled = this.#compile(source.bytes);
    if (!compiled) return null; // no ordinary lowering and no original run
    this.#alive();
    if (!source.current()) return null;
    const admit = () => {
      this.#alive();
      if (!source.current()) throw new Error('Guarded scalar executable lease expired');
    };
    const instance = new WebAssembly.Instance(compiled, {guard:{
      read:(at: bigint, width: number) => { admit(); return this.#guard.read(this.#owner, at, width); },
      write:(at: bigint, width: number, value: bigint) => { admit(); this.#guard.write(this.#owner, at, width, value); },
    }});
    const run = instance.exports.run as (rdi: bigint, rsi: bigint) => bigint;
    return Object.freeze({next:address + BigInt(length - 1), run:(rdi: bigint, rsi: bigint) => { admit(); return run(rdi, rsi); }});
  }
  close(): void {
    if (!this.#dead) { this.#dead = true; this.#guard.retireOwner(this.#owner); }
  }
  #alive(): void {
    if (this.#dead) throw new Error('Guarded scalar Process already retired');
    try { this.#checkIdentity(); }
    catch (cause) { this.close(); throw new Error('Guarded scalar Process lifetime expired', {cause}); }
  }
}
