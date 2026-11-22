// The static SysV initial stack is calculated before anything in the old
// address space is retired. Only installation needs the new guest memory.
import {randomBytes} from '../flow.ts';
import {E, FsError} from '../fs.ts';
import type {Facts} from '../parts.ts';

export const WASM_PAGE = 65536;
const PAGE = 4096, GUARD = WASM_PAGE, STACK_BYTES = 8 << 20;
const encoder = new TextEncoder();
const down = (at: number, align: number): number => Math.floor(at / align) * align;

export interface StaticStack {
  readonly stackLow: number;
  readonly stackTop: number;
  readonly mapBase: number;
  readonly sp: number;
  install(bytes: Uint8Array): void;
}

export function staticStack(facts: Facts, argv: string[], env: string[]): StaticStack {
  const stackLow = Math.ceil((facts.imageEnd + GUARD) / PAGE) * PAGE;
  const stackTop = stackLow + STACK_BYTES;
  const mapBase = Math.ceil((stackTop + GUARD) / WASM_PAGE) * WASM_PAGE;
  if (!Number.isSafeInteger(mapBase) || facts.imageEnd < 0 || mapBase > 2 ** 32)
    throw new RangeError('Executable image and stack do not fit in guest memory');

  // argc, pointers, two NULLs, and fourteen auxv pairs (the last AT_NULL).
  const words = argv.length + env.length + 3 + 28, vectors = words * 8;
  const execfn = argv[0] ?? '';
  let minimum = vectors + execfn.length + 1 + 16;
  for (const inputs of [argv, env]) for (const s of inputs) minimum += s.length + 1;
  if (minimum > STACK_BYTES) throw new FsError(E.TOOBIG);
  const strings = encoder.encode([...argv, ...env, execfn].join('\0') + '\0');
  const at = down(stackTop - 8 - strings.length, 8), entropyAt = down(at - 16, 16);
  const sp = down(entropyAt - vectors, 16);
  if (sp < stackLow) throw new FsError(E.TOOBIG);
  const entropy = randomBytes(16);

  // Every pointer is below 4 GiB, and this static ABI keeps its existing
  // auxv, including the present, zero-valued AT_BASE and argv[0] copy.
  const out = new Uint32Array(words * 2);
  let word = 0, offset = 0;
  const push = (value: number): void => { out[(word++) * 2] = value; };
  const names = (length: number): void => {
    for (let i = 0; i < length; i++) { push(at + offset); offset = strings.indexOf(0, offset) + 1; }
    push(0);
  };
  push(argv.length); names(argv.length); names(env.length);
  const aux = [3, facts.phdr, 4, facts.phent, 5, facts.phnum, 6, PAGE, 7, 0, 9, facts.entry, 11, 0, 12, 0, 13, 0, 14, 0,
    23, 0, 25, entropyAt, 31, at + offset, 0, 0];
  for (const value of aux) push(value);
  const vectorBytes = new Uint8Array(out.buffer);
  return {stackLow, stackTop, mapBase, sp, install(bytes) {
    bytes.set(strings, at);
    bytes.set(entropy, entropyAt);
    bytes.set(vectorBytes, sp);
  }};
}
