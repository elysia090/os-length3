// Linux initial stack layout. The static and mapped exec preparations
// choose their own auxv inputs; formatting never needs the old memory.
import {shownIn, type Cred} from '../cred.ts';
import {randomBytes} from '../flow.ts';
import {E, FsError} from '../fs.ts';
import type {Facts} from '../parts.ts';

export const WASM_PAGE = 65536;
export const STACK_BYTES = 8 << 20;
const PAGE = 4096, GUARD = WASM_PAGE;
const encoder = new TextEncoder();
const down = (at: number, align: number): number => Math.floor(at / align) * align;

export interface StackLayout {
  readonly stackLow: number;
  readonly stackTop: number;
  readonly mapBase: number;
  readonly sp: number;
}

export interface StackWrite { readonly at: number; readonly bytes: Uint8Array }
export interface StaticStack extends StackLayout {
  install(bytes: Uint8Array): void;
}

interface StartFacts { readonly imageEnd: number; readonly phdr: number; readonly phent: number; readonly phnum: number; readonly entry: number }
interface AuxIdentity { uid: number; euid: number; gid: number; egid: number; secure: number }
const staticIds: AuxIdentity = {uid: 0, euid: 0, gid: 0, egid: 0, secure: 0};

export function staticStack(facts: Facts, argv: string[], env: string[]): StaticStack {
  const plan = initialStack(facts, argv, env, argv[0] ?? '', 0, staticIds);
  return {stackLow: plan.stackLow, stackTop: plan.stackTop, mapBase: plan.mapBase, sp: plan.sp, install(bytes) {
    for (const write of plan.writes) bytes.set(write.bytes, write.at);
  }};
}

const ARG_STRLEN = 32 * PAGE, ARG_BYTES = 2 << 20;
export function mappedStack(facts: StartFacts & {readonly base: number}, argv: readonly string[], env: readonly string[],
    execfn: string, cred: Cred): StackLayout & {readonly writes: readonly StackWrite[]} {
  // In this bounded loader profile, take ordinary UTF-8 strings only.
  // Check a cheap minimum before joining or allocating a large host string.
  const args = argv.length ? argv : [''];
  let bytes = (args.length + env.length + 31) * 8 + 16;
  const length = (arg: string): number => {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new FsError(E.INVAL);
    if (arg.length >= ARG_STRLEN) throw new FsError(E.TOOBIG);
    const n = encoder.encode(arg).length + 1;
    if (n > ARG_STRLEN) throw new FsError(E.TOOBIG);
    return n;
  };
  bytes += length(execfn);
  for (const list of [args, env]) for (const arg of list) {
    if ((bytes += length(arg)) > ARG_BYTES) throw new FsError(E.TOOBIG);
  }
  const ids: AuxIdentity = {uid: shownIn(cred.ns, cred.uid), euid: shownIn(cred.ns, cred.euid),
    gid: shownIn(cred.ns, cred.gid, true), egid: shownIn(cred.ns, cred.egid, true),
    secure: cred.uid !== cred.euid || cred.gid !== cred.egid ? 1 : 0};
  return initialStack(facts, args, env, execfn, facts.base, ids);
}

function initialStack(facts: StartFacts, argv: readonly string[], env: readonly string[], execfn: string,
    base: number, ids: AuxIdentity): StackLayout & {readonly writes: readonly StackWrite[]} {
  const stackLow = Math.ceil((facts.imageEnd + GUARD) / PAGE) * PAGE;
  const stackTop = stackLow + STACK_BYTES;
  const mapBase = Math.ceil((stackTop + GUARD) / WASM_PAGE) * WASM_PAGE;
  if (!Number.isSafeInteger(mapBase) || facts.imageEnd < 0 || mapBase > 2 ** 32)
    throw new RangeError('Executable image and stack do not fit in guest memory');

  // argc, pointers, two NULLs, and fourteen auxv pairs (the last AT_NULL).
  const words = argv.length + env.length + 3 + 28, vectors = words * 8;
  let minimum = vectors + execfn.length + 1 + 16;
  for (const inputs of [argv, env]) for (const s of inputs) minimum += s.length + 1;
  if (minimum > STACK_BYTES) throw new FsError(E.TOOBIG);
  const strings = encoder.encode([...argv, ...env, execfn].join('\0') + '\0');
  const at = down(stackTop - 8 - strings.length, 8), entropyAt = down(at - 16, 16);
  const sp = down(entropyAt - vectors, 16);
  if (sp < stackLow) throw new FsError(E.TOOBIG);
  const entropy = randomBytes(16);

  // Every pointer is below 4 GiB. Preserve static auxv and its argv[0]
  // copy with the static inputs; mapped callers provide the exec path.
  const out = new Uint32Array(words * 2);
  let word = 0, offset = 0;
  const push = (value: number): void => { out[(word++) * 2] = value; };
  const names = (length: number): void => {
    for (let i = 0; i < length; i++) { push(at + offset); offset = strings.indexOf(0, offset) + 1; }
    push(0);
  };
  push(argv.length); names(argv.length); names(env.length);
  const aux = [3, facts.phdr, 4, facts.phent, 5, facts.phnum, 6, PAGE, 7, base, 9, facts.entry,
    11, ids.uid, 12, ids.euid, 13, ids.gid, 14, ids.egid, 23, ids.secure, 25, entropyAt, 31, at + offset, 0, 0];
  for (const value of aux) push(value);
  const vectorBytes = new Uint8Array(out.buffer);
  return {stackLow, stackTop, mapBase, sp, writes: [
    {at, bytes: strings}, {at: entropyAt, bytes: entropy}, {at: sp, bytes: vectorBytes},
  ]};
}
