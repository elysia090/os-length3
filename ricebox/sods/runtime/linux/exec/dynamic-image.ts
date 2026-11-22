// Detached initial image for the inline mapped profile. This does not
// publish a process, run the interpreter, or admit PT_INTERP on a normal
// start/exec. Only the original unpublished Task can reserve a held handoff.
import type {Translate} from '../../translation/translator.ts';
import type {MappedTranslate} from '../../translation/mapped.ts';
import {E, FsError} from '../fs.ts';
import {MAPPED_VM_LIMIT, MappedVm, type DetachedMappedMemory, type InitialMappedRegion, type StagedMappedMemory} from '../mapped-vm.ts';
import {execIdentity, type ExecIdentity} from './commit.ts';
import {planDynamicExec, type DynamicExecOwner, type DynamicExecPlan, type DynamicSources, type PlacedObject} from './dynamic-plan.ts';
import type {ExecMetadata, ExecRequest} from './plan.ts';
import {ExecPreparationChangedError, execScope} from './source.ts';
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

type ClaimOwner = DynamicExecOwner & Parameters<StagedMappedMemory['claim']>[0];
interface DetachedOwner {
  readonly process: DynamicExecOwner;
  readonly task: object | undefined;
  readonly staged: StagedMappedMemory;
  readonly reader: object;
  readonly compiler: MappedTranslate;
  readonly metadata: ExecMetadata;
  readonly identity: ExecIdentity;
  reserved: boolean;
}
const heldImages = new WeakMap<DetachedDynamicImage, DetachedOwner>();

/** Only available to the internal handoff transaction, not the image view. */
export interface InitialImageLease {
  readonly memory: StagedMappedMemory['memory'];
  readonly pc: bigint;
  readonly sp: bigint;
  readonly metadata: ExecMetadata;
  readonly identity: ExecIdentity;
  check(): void;
  claim(): void;
  discard(): void;
}

export function reserveInitialImage(image: DetachedDynamicImage, process: ClaimOwner, task: object,
    reader: object, compiler: MappedTranslate): InitialImageLease {
  const held = heldImages.get(image);
  if (!held || held.reserved || held.process !== process || held.task !== task || process.own !== task ||
      process.memory || process.state !== 'live' || held.reader !== reader || held.compiler !== compiler)
    throw new ExecPreparationChangedError();
  const {staged, metadata, identity} = held, pc = BigInt(image.firstPc), main = BigInt(image.aux.entry), sp = metadata.stack.sp;
  const checkOwner = (): void => {
    if (heldImages.get(image) !== held || process.own !== task || process.memory || process.state !== 'live')
      throw new ExecPreparationChangedError();
  };
  const check = (): void => {
    checkOwner();
    staged.checkEntry(pc, main, sp);
  };
  check();
  const memory = staged.memory;
  held.reserved = true;
  return Object.freeze({
    memory, pc, sp: BigInt(sp), metadata, identity, check,
    claim() {
      checkOwner();
      staged.claim(process, pc, main, sp);
      heldImages.delete(image);
    },
    discard() {
      if (heldImages.get(image) !== held) return;
      heldImages.delete(image);
      staged.pages.discard();
    },
  });
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
    reader: Pick<Translate, 'describeDynamic' | 'notProgram' | 'mapped'>): DetachedDynamicImage {
  const {describeDynamic, mapped: compiler} = reader;
  if (!describeDynamic) throw new Error('This Sods translator has no dynamic load-spec support');
  const task = process.own, scope = execScope(process), {path} = request;
  if (typeof path !== 'string' || path.includes('\0')) throw new FsError(E.INVAL);
  const argv = [...request.argv], env = [...request.env];
  if (!argv.length) argv.push('');
  scope();
  const plan = planDynamicExec(process, path, sources, reader);
  const source = plan.main.source, identity = execIdentity(process, source);
  const verify = (): void => { scope(); plan.check(); identity.check(false); };
  const stack = mappedStack({imageEnd: plan.interpreter.end, ...plan.aux}, argv, env, path, identity.cred);
  verify();
  if (stack.mapBase >= MAPPED_VM_LIMIT) throw new FsError(E.NOMEM);
  const layout: InitialMappedRegion[] = [...regions(plan.main, verify), ...regions(plan.interpreter, verify),
    {kind: 'stack', start: stack.stackLow, end: stack.stackTop, prot: PROT_R | PROT_W, writes: stack.writes}];
  const staged = MappedVm.stage({vfs: process.kernel.vfs, base: stack.mapBase, pages: stack.mapBase / WASM_PAGE,
    libraries: plan.libraries, reader: {describeDynamic, notProgram: reader.notProgram}}, layout, verify);
  const {pages} = staged;
  try {
    staged.checkEntry(BigInt(plan.firstPc), BigInt(plan.aux.entry), stack.sp);
    if (!pages.permits(plan.aux.phdr, plan.aux.phent * plan.aux.phnum, 'read'))
      throw new FsError(E.NOEXEC);
    const view = Object.freeze({main: placed(plan.main), interpreter: placed(plan.interpreter), firstPc: plan.firstPc,
      aux: Object.freeze({...plan.aux}),
      stack: Object.freeze({stackLow: stack.stackLow, stackTop: stack.stackTop, mapBase: stack.mapBase, sp: stack.sp}), pages});
    if (task && compiler) {
      const metadata = {source, exe: plan.main.path, argv, env, stack: view.stack};
      heldImages.set(view, {process, task, staged, reader, compiler, metadata, identity, reserved: false});
    }
    return view;
  } catch (error) { pages.discard(); throw error; }
}
