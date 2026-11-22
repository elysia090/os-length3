// The preparation side of ordinary dynamic exec. No image is installed and
// no interpreter or DSO is executed by this module. The static transaction
// remains the only admitted start/exec path.
import {DYNAMIC_FILE_LIMIT, type ElfLoadSpec, type ElfLoadSegment} from '../../translation/dynamic-load.ts';
import type {Translate} from '../../translation/translator.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from '../executable-source.ts';
import {E, FsError, type Vfs} from '../fs.ts';
import {mappedLibrariesFor, type MappedLibraries} from '../mapped-libraries.ts';
import {execScope, execSource, type ExecSource, type ExecSourceOwner} from './source.ts';
import {STACK_BYTES, WASM_PAGE} from './stack.ts';

const PAGE = 4096, FIRST = 0x40_0000, END = 2 ** 32;
const up = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;
const down = (value: number, alignment: number): number => Math.floor(value / alignment) * alignment;

export interface PlacedObject {
  readonly path: string;
  readonly spec: ElfLoadSpec;
  readonly bias: number;
  readonly start: number;
  readonly end: number;
  readonly mappings: readonly (ElfLoadSegment & {at: number})[];
  readonly source: ExecSource;
  readonly grant: ExecutableSource;
}

export interface DynamicExecPlan {
  readonly main: PlacedObject;
  readonly interpreter: PlacedObject;
  readonly libraries?: MappedLibraries;
  readonly firstPc: number;
  readonly aux: {readonly base: number; readonly entry: number; readonly phdr: number; readonly phent: 56; readonly phnum: number};
  /** Fence the initial objects while their payloads are being read. The
   * whole catalogue is checked at plan, VM and handoff boundaries. */
  check(): void;
}

export type DynamicSources = {
  readonly main: ExecutableSource;
  readonly interpreter: ExecutableSource;
  /** Exact authenticated dependency inodes supplied before guest lookup. */
  readonly libraries?: MappedLibraries;
};
type Reader = Pick<Translate, 'describeDynamic' | 'notProgram'>;
export interface DynamicExecOwner extends ExecSourceOwner {
  readonly kernel: ExecSourceOwner['kernel'] & {readonly vfs: Vfs};
}

function place(spec: ElfLoadSpec, source: ExecSource, grant: ExecutableSource, after: number): PlacedObject {
  const first = spec.loads[0], last = spec.loads.at(-1);
  if (!first || !last) throw new Error('Dynamic load spec has no segments');
  const alignment = Math.max(PAGE, ...spec.loads.map(x => x.align));
  const low = down(first.vaddr, PAGE), bias = up(Math.max(0, after - low), alignment);
  const start = bias + low, end = bias + up(last.vaddr + last.memSize, PAGE);
  // Leave room for the same stack and guard layout the static transaction
  // uses in a wasm32 address space. A spec is not a reservation.
  if (start < after || end + STACK_BYTES + 2 * WASM_PAGE > END || end <= start) throw new FsError(E.NOMEM);
  return {path: source.describe(), spec, source, grant, bias, start, end,
    mappings: spec.loads.map(segment => ({...segment, at: bias + segment.vaddr}))};
}

export function planDynamicExec(process: DynamicExecOwner, path: string, input: DynamicSources, reader: Reader): DynamicExecPlan {
  const describe = reader.describeDynamic;
  if (!describe) throw new Error('This Sods translator has no dynamic load-spec support');
  if (!process.noNewPrivs) throw new FsError(E.PERM);
  const scope = execScope(process), vfs = process.kernel.vfs;
  const {main: mainGrant, interpreter: interpreterGrant, libraries} = input;
  const dependencies = libraries === undefined ? undefined : mappedLibrariesFor(libraries, vfs);
  dependencies?.check();
  scope();
  const read = (where: string, role: 'main' | 'interpreter') => {
    const resolved = execSource(process, where, scope, role === 'interpreter');
    const grant = role === 'main' ? mainGrant : interpreterGrant;
    const {node, mnt} = resolved.at, mountRevision = mnt.execRevision;
    const canonical = executableSourceFor(grant, vfs);
    const check = (): void => {
      resolved.check();
      // The caller authenticates the mounted root that issued these
      // capabilities, and may not substitute a path, overlay, or new revision.
      if (node !== canonical.node || !unchangedExecutableSource(canonical) || node.mode & 0o6000 ||
          node.maps?.size || mnt.execRevision !== mountRevision)
        throw new FsError(E.ACCES);
    };
    check();
    if (dependencies?.member(node)) throw new FsError(E.ACCES); // Initial objects are not DSO grants.
    const error = role === 'main' ? E.NOEXEC : E.LIBBAD;
    if (!node.size || node.size > DYNAMIC_FILE_LIMIT) throw new FsError(error);
    let bytes: Uint8Array;
    try { bytes = node.share(); } finally { check(); }
    let spec: ElfLoadSpec;
    try { spec = describe(bytes, role); }
    catch (cause) { if (reader.notProgram(cause)) throw new FsError(error); throw cause; }
    finally { check(); }
    if (spec.role !== role) throw new Error('Translator returned the wrong dynamic load role');
    return {spec, resolved, grant, check};
  };

  const mainInput = read(path, 'main');
  const name = mainInput.spec.interpreter;
  if (name === null || !name.startsWith('/')) throw new Error('Dynamic PIE spec has no absolute interpreter');
  const loaderInput = read(name, 'interpreter');
  const main = place(mainInput.spec, mainInput.resolved, mainInput.grant, FIRST);
  const interpreter = place(loaderInput.spec, loaderInput.resolved, loaderInput.grant, main.end + PAGE);
  const check = (): void => { mainInput.check(); loaderInput.check(); };
  check();
  dependencies?.check();
  return {main, interpreter, libraries, firstPc: interpreter.bias + interpreter.spec.entry, check,
    aux: {base: interpreter.bias, entry: main.bias + main.spec.entry, phdr: main.bias + main.spec.phdr,
      phent: main.spec.phent, phnum: main.spec.phnum}};
}
