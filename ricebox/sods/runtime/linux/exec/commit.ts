// One entry to a static exec transaction for both initial start and guest
// execve. Recoverable input errors occur before the first irreversible step.
import {asProgram, idIn, type Cred} from '../cred.ts';
import type {FdTable} from '../fd.ts';
import {MNT, type Vfs} from '../fs.ts';
import type {Mem} from '../parts.ts';
import {REG, kept, type Process, type Task} from '../process.ts';
import {lay} from '../../translation/share.ts';
import {planStaticExec, type ExecRequest, type StaticExecPlan} from './plan.ts';
import {WASM_PAGE} from './stack.ts';
import {ExecPreparationChangedError} from './source.ts';

type ExecPhase = 'prepared-descriptors' | 'initial-preparation' | 'initial-publication' | 'threads' |
  'address-space' | 'descriptors' | 'backend' | 'memory-retirement' | 'resume';

/** A possibly partial transaction. No guest errno, rollback, worker stop or
 * release is implied. The retained references are for ownership evidence,
 * not authorization to retry a failed operation. */
export class ExecCommitError extends Error {
  declare readonly process: Process;
  declare readonly phase: ExecPhase;
  declare readonly owners: Readonly<{task?: Task; oldMemory?: Mem; newMemory?: Mem; oldFds?: FdTable; newFds?: FdTable}>;
  constructor(process: Process, phase: ExecPhase, cause: unknown, owners: ExecCommitError['owners'] = {}) {
    super(`Exec transaction could not complete (${phase})`, {cause});
    this.name = 'ExecCommitError';
    this.process = process;
    this.phase = phase;
    this.owners = owners;
  }
}

const preparing = new WeakSet<Process>();
const unresolvedTrees = new WeakSet<Vfs>();

/** A fatal executor still owns its original tree. A second kernel cannot
 * claim it as a fresh input or quietly replace its owners. */
export function checkExecTree(vfs: Vfs): void {
  if (unresolvedTrees.has(vfs)) throw new Error('Exec source tree has an unresolved transaction; a new tree is required');
}

export function execMayRun(process: Process): void {
  const state = process.execTransition;
  if (state === true) throw new ExecPreparationChangedError();
  if (state) throw state;
}

export function retainExecFailure(process: Process, phase: ExecPhase, cause: unknown, owners?: ExecCommitError['owners']): never {
  const failure = new ExecCommitError(process, phase, cause, owners);
  process.execTransition = failure;
  unresolvedTrees.add(process.kernel.vfs);
  (process.kernel.failedExecs ??= new Set()).add(failure);
  throw failure;
}

export function replaceExec(process: Process, request: ExecRequest, firstTask?: () => Task): void {
  execMayRun(process);
  checkExecTree(process.kernel.vfs);
  if (preparing.has(process)) throw new ExecPreparationChangedError();
  preparing.add(process);
  try {
    const plan = planStaticExec(process, request);
    const task = firstTask ? firstTask() : process.task;
    const table = process.fds, holders = table.holders, revision = table.revision, limit = table.limit;
    // A CLONE_FILES table must be copied before losing any old image or
    // thread. Nothing closes the shared table or any CLOEXEC slot yet.
    const own = holders > 1 ? table.fork() : null;
    let identity: ExecIdentity;
    try {
      plan.check();
      checkExecTree(process.kernel.vfs);
      if (process.task !== task || !process.tasks.has(task) || task.dead || process.fds !== table ||
          table.holders !== holders || table.revision !== revision || table.limit !== limit)
        throw new ExecPreparationChangedError();
      identity = execIdentity(process, plan);
    } catch (cause) {
      try { own?.letGo(); }
      catch (cleanup) { retainExecFailure(process, 'prepared-descriptors', new AggregateError([cause, cleanup]), {task, newFds: own!}); }
      throw cause;
    }
    process.execTransition = true;
    try { commit(process, task, plan, identity, table, own); }
    finally { if (process.execTransition === true) process.execTransition = undefined; }
  } finally { preparing.delete(process); }
}

interface ExecIdentity { readonly cred: Cred; readonly dumpable: boolean; check(installed: boolean): void }

function execIdentity(p: Process, plan: StaticExecPlan): ExecIdentity {
  const {mnt, node} = plan.source.at, c = p.cred;
  const suid = !(mnt.flags & MNT.NOSUID) && !p.noNewPrivs;
  const setuid = suid && node.mode & 0o4000 && idIn(c.ns, node.uid) >= 0 ? node.uid : -1;
  const setgid = suid && (node.mode & 0o2010) === 0o2010 && idIn(c.ns, node.gid, true) >= 0 ? node.gid : -1;
  const next = asProgram(c, setuid, setgid);
  const cred = p.noNewPrivs ? next.with({permitted: next.permitted & (c.permitted | next.ambient),
    effective: next.effective & (c.permitted | next.ambient)}) : next;
  const {mode, uid, gid} = node, {fs, noNewPrivs} = p;
  const {root, pwd} = fs, epoch = p.kernel.executionEpoch;
  const mask = MNT.NOEXEC | MNT.NOSUID, flags = mnt.flags & mask;
  return {cred, dumpable: setuid < 0 && setgid < 0, check(installed) {
    // Old mapping/descriptor retirement may call back into the host. Do not
    // install previously computed credentials if their grant was revoked.
    if (node.mode !== mode || node.uid !== uid || node.gid !== gid || (mnt.flags & mask) !== flags ||
        p.noNewPrivs !== noNewPrivs || p.cred !== (installed ? cred : c) || p.fs !== fs ||
        fs.root !== root || fs.pwd !== pwd || p.kernel.executionEpoch !== epoch)
      throw new ExecPreparationChangedError();
  }};
}

function commit(p: Process, task: Task, plan: StaticExecPlan, identity: ExecIdentity, table: FdTable, own: FdTable | null): void {
  const k = p.kernel, {image, stack, laid} = plan, {mnt, node, parent: dir, name} = plan.source.at;
  const memory = p.memory;
  let phase: ExecPhase = 'threads', fresh: Mem | undefined;
  let returnedMemory = false, returnedFds = false;
  try {
    // Point of no return: a sibling may be stopped, a mapping published or
    // a descriptor released. Those effects must never look like a failed
    // execve that returned to its old program.
    const written = memory ? p.written() : null;
    for (const other of p.tasks) if (other !== task) { k.endTask(other); p.tasks.delete(other); }
    const again = !!(image === p.image && image.segments && memory?.users === 1 && !memory.tainted && p.tasks.size === 1);
    phase = 'address-space';
    p.image = image;
    p.stackLow = stack.stackLow;
    p.stackTop = stack.stackTop;
    p.mapEnd = p.mapBase = stack.mapBase;
    p.free = [];
    p.fixed = [];
    p.retireShared();
    if (p.memory !== memory || p.fds !== table || p.task !== task) throw new ExecPreparationChangedError();
    if (again && memory) {
      k.renew(memory, written, stack.mapBase / WASM_PAGE, image, laid);
      fresh = memory;
    } else {
      k.leaveInstance(p);
      // A later failing retirement must not leave the old task's memory
      // in the reuse pool. Keep this owner until the replacement is installed.
      fresh = p.newMemory(stack.mapBase / WASM_PAGE, image, laid, (taken) => { fresh = taken; });
      p.memory = fresh;
    }
    identity.check(false);
    p.argv = plan.argv;
    p.env = plan.env;
    p.comm = null;
    p.cred = identity.cred;
    p.dumpable = identity.dumpable;
    p.exe = plan.exe;
    p.exeAt = {mnt, node, dir, name};

    phase = 'descriptors';
    if (own) {
      p.fds = own;
      for (const t of p.tasks) t.tableLeft(table);
      table.letGo();
      returnedFds = true;
    }
    p.fds.exec();
    if (p.memory !== fresh || p.fds !== (own ?? table) || p.task !== task) throw new ExecPreparationChangedError();
    for (const [sig, h] of p.actions) if (h.handler > 1n) p.actions.delete(sig);
    task.altstack = {sp: 0n, size: 0n, flags: 2};

    phase = 'backend';
    if (image.segments) {
      const reuse = fresh.keeps ? kept(image, !!fresh.exact) : [];
      lay(p.bytes, reuse.length ? image.segments.filter((s) => !reuse.some(([a, b]) => s.offset >= a && s.offset + s.bytes.length <= b)) : image.segments);
    }
    if (again) task.renew(); else task.load(image, fresh);
    task.setContext(REG.map(() => 0n), plan.entry);
    stack.install(p.bytes);
    task.setReg(4, BigInt(stack.sp));
    fresh.deepest = stack.sp;
    identity.check(true);

    if (!again) {
      phase = 'memory-retirement';
      k.letGo(memory, written);
      returnedMemory = true;
    }
    phase = 'resume';
    k.releaseVfork(p);
    k.noteRootConsoleExec(p);
  } catch (cause) {
    // A failure before owner return must not leave possibly active memory
    // eligible for pooling or cause it to be returned again.
    const quarantine = (memory: Mem): void => {
      memory.tainted = true;
      const slot = k.spareMemories.indexOf(memory);
      if (slot >= 0) k.spareMemories.splice(slot, 1);
    };
    if (!returnedMemory && memory) quarantine(memory);
    if (fresh && fresh !== memory) quarantine(fresh);
    retainExecFailure(p, phase, cause, {task, oldMemory: returnedMemory ? undefined : memory ?? undefined, newMemory: fresh,
      oldFds: returnedFds ? undefined : table, newFds: own ?? undefined});
  }
}
