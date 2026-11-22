// Detached initial image for the inline mapped profile. This does not
// publish a process, load a Task, run the interpreter, or admit PT_INTERP
// on a normal start/exec. A later exec transaction owns any live handoff.
import type {Translate} from '../../translation/translator.ts';
import {E, FsError} from '../fs.ts';
import {MAPPED_VM_LIMIT, MappedVm, type DetachedMappedMemory, type InitialMappedRegion} from '../mapped-vm.ts';
import {planDynamicExec, type DynamicExecOwner, type DynamicExecPlan, type DynamicSources, type PlacedObject} from './dynamic-plan.ts';
import type {ExecRequest} from './plan.ts';
import {execScope} from './source.ts';
import {mappedStack, WASM_PAGE, type StackLayout} from './stack.ts';

const PAGE = 4096, PF_R = 4, PF_W = 2, PF_X = 1, PROT_R = 1, PROT_W = 2, PROT_X = 4;
const floor = (n: number): number => Math.floor(n / PAGE) * PAGE;
const ceil = (n: number): number => Math.ceil(n / PAGE) * PAGE;
type PlacedImage = Readonly<Pick<PlacedObject, 'path' | 'bias' | 'start' | 'end'>>;

export interface DetachedDynamicImage {
  readonly main: PlacedImage;
  readonly interpreter: PlacedImage;
  readonly firstPc: number;
  readonly aux: DynamicExecPlan['aux'];
  readonly stack: StackLayout;
  /** No raw memory, entries, descriptors, or attachment capability. */
  readonly pages: DetachedMappedMemory;
}

function regions(object: PlacedObject, verify: () => void): InitialMappedRegion[] {
  const {node: file, mnt: mount} = object.source.at;
  let payload: Uint8Array;
  try { payload = file.share(); } finally { verify(); }
  if (payload.length !== file.size) throw new FsError(E.ACCES);

  return object.mappings.map((m): InitialMappedRegion => {
    const start = floor(m.at), end = ceil(m.at + m.memSize), offset = floor(m.offset);
    if (offset < 0 || m.offset + m.fileSize > payload.length || m.memSize < m.fileSize ||
        m.at - start !== m.offset - offset || start < object.start || end > object.end || end <= start)
      throw new FsError(E.NOEXEC);
    const prot = (m.flags & PF_R ? PROT_R : 0) | (m.flags & PF_W ? PROT_W : 0) | (m.flags & PF_X ? PROT_X : 0);
    if (prot & PROT_X && (prot !== (PROT_R | PROT_X) || !m.fileSize)) throw new FsError(E.NOEXEC);
    // Linux lays the file's aligned first page, including bytes before an
    // unaligned segment start. A segment with BSS ends its file image at
    // p_filesz; its partial tail and remaining full pages begin zero.
    const fileEnd = m.memSize > m.fileSize ? m.at + m.fileSize : ceil(m.at + m.fileSize);
    const writes = m.fileSize ? [{at: start, bytes: payload.subarray(offset, offset + fileEnd - start)}] : [];
    const row = {start, end, prot, writes};
    if (!(prot & PROT_X)) return {...row, kind: 'load-data'};
    return {...row, kind: 'load-text', text: {file, mount, source: object.grant, prot, private: true,
      text: {role: object.spec.role, bias: object.bias, address: m.at, offset: m.offset, length: m.fileSize}}};
  });
}

const placed = ({path, bias, start, end}: PlacedObject): PlacedImage => Object.freeze({path, bias, start, end});

export function prepareDynamicImage(process: DynamicExecOwner, request: ExecRequest, sources: DynamicSources,
    reader: Pick<Translate, 'describeDynamic' | 'notProgram'>): DetachedDynamicImage {
  const describeDynamic = reader.describeDynamic;
  if (!describeDynamic) throw new Error('This Sods translator has no dynamic load-spec support');
  const scope = execScope(process), {path} = request;
  if (typeof path !== 'string' || path.includes('\0')) throw new FsError(E.INVAL);
  const argv = [...request.argv], env = [...request.env];
  scope();
  const plan = planDynamicExec(process, path, sources, reader);
  const verify = (): void => { scope(); plan.check(); };
  const stack = mappedStack({imageEnd: plan.interpreter.end, ...plan.aux}, argv, env, path, process.cred);
  verify();
  if (stack.mapBase >= MAPPED_VM_LIMIT) throw new FsError(E.NOMEM);
  const layout: InitialMappedRegion[] = [...regions(plan.main, verify), ...regions(plan.interpreter, verify),
    {kind: 'stack', start: stack.stackLow, end: stack.stackTop, prot: PROT_R | PROT_W, writes: stack.writes}];
  const pages = MappedVm.detached({vfs: process.kernel.vfs, base: stack.mapBase, pages: stack.mapBase / WASM_PAGE,
    sources: [], reader: {describeDynamic, notProgram: reader.notProgram}}, layout, verify);
  try {
    if (!pages.hasText(BigInt(plan.firstPc)) || !pages.hasText(BigInt(plan.aux.entry)) ||
        !pages.permits(plan.aux.phdr, plan.aux.phent * plan.aux.phnum, 'read') || !pages.permits(stack.sp, 8, 'write'))
      throw new FsError(E.NOEXEC);
    return Object.freeze({main: placed(plan.main), interpreter: placed(plan.interpreter), firstPc: plan.firstPc,
      aux: Object.freeze({...plan.aux}),
      stack: Object.freeze({stackLow: stack.stackLow, stackTop: stack.stackTop, mapBase: stack.mapBase, sp: stack.sp}), pages});
  } catch (error) { pages.discard(); throw error; }
}
