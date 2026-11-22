import {forkFailure, forkIdentity} from './fork-preparation.ts';
export {ForkPreparationChangedError} from './fork-preparation.ts';
import {ReadLifetimeError, memoryEpoch, retireMemoryView} from './read-lifetime.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from './executable-source.ts';
import {blockExecTree, checkExecTree, execMayRun, replaceExec, type ExecOwners, type ExecPhase} from './exec/commit.ts';
import {sourceRevision} from './exec/source.ts';
import {WASM_PAGE} from './exec/stack.ts';
export {ImageSourceChangedError} from './exec/source.ts';
// Processes and threads for translated programs. There is no machine to
// boot: a process starts at its ELF entry with a SysV stack and its system
// calls land in the tables of sys-file.ts, sys-proc.ts and signal.ts.
//
// Every process runs at once with every other, as on Linux: fork returns
// in the parent at once and the child is one more thread to run; a call
// that must wait (input not typed yet, a child still running, a full pipe)
// leaves its thread waiting, and the kernel makes the call again when
// something changed, so whatever can run, runs. Threads (clone with
// CLONE_VM) share their process's memory and run the same way.
//
// Where the threads run is the kernel's choice of backend:
//   - here, in this thread (the default): one thread at a time, each until
//     it waits, or for a time slice measured at its system calls. A call
//     that waits unwinds the wasm stack and the thread goes on after its
//     syscall instruction once the call is done; nothing is suspended, so no
//     shared memory is needed (remote.ts says how this is used when it is).
//   - in Workers (remote.ts), each thread in its own, all at once, with
//     memory shared (SharedArrayBuffer) and system calls made to this
//     kernel through Atomics: preempted by the host, as a Linux thread is.

import {Exec, Exit, Redirect, Wait, utf8} from './flow.ts';
import {zero} from './bulk.ts';
import {namesIn, x87Of, type X87} from '../translation/x87.ts';
import {machine} from './machine.ts';
import {procfs} from './procfs.ts';
import {sysfs} from './sysfs.ts';
import {devpts, type Instance} from './pty.ts';
import {MOUNT_CALLS} from './sys-mount.ts';
import {Description, FdTable} from './fd.ts';
import type {Dir, Mapping, Place, Super} from './fs.ts';
import {E, File, FsError, Link, MNT, Mount, Vfs, walk} from './fs.ts';
import {CAP, HOST, ROOT, capable, type Cred} from './cred.ts';
import {copy, firstSpace, put, retireInitialTree} from './mount.ts';
import {CgroupNs, Fs, byNr, discardNumberLookups, failedInitialReservation, firstSpaces, forget, namespaceWasExposed, nrIn, number, publishInitialPid, type Numbers, type PidNs, type Spaces} from './space.ts';
import {cgroupMount, cgroups, enter, type Cgroup} from './cgroup.ts';
import {GuestBytes, GuestView} from './guest.ts';
import {FILE_CALLS} from './sys-file.ts';
import {NET_CALLS} from './sys-net.ts';
import {PROC_CALLS} from './sys-proc.ts';
import {prepare, type Segment} from '../translation/share.ts';
import {answerTime, clocks} from './clock.ts';
import {CLD, SA, SIG, SIGNAL_CALLS, Pending, SI, actionOf, bit, deliverable, send, take} from './signal.ts';
import type {Taken} from '../translation/kept.ts';
import type {Machine} from './machine.ts';
import {REG, keptImageRanges} from './parts.ts';
import type {ForkOptions, AltStack, Call, Calls, Console, Outside, Cpu, Extra, Facts, Filter, FutexKey, FutexWaiter, Held, ImageEntry, Kern, Mem, Proc, Program, Range, SigAction, Slot, Thread, Timer, Tty} from './parts.ts';
import {ARCH, RET, STRICT, verdict} from './seccomp.ts';
import {said, steady} from '../host.ts';

const terminalDimension = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 0xffff;
/** Positive cell counts that can survive the root console's Linux winsize ABI. */
export function validConsoleWindow(cols: number, rows: number): boolean {
  return terminalDimension(cols) && terminalDimension(rows);
}

type RootConsoleGuest = {
  closed: boolean;
  child: {launcher: WeakRef<Process>; process: WeakRef<Process>; executed: boolean} | null;
};

/**
 * What the kernel asks of the translator it is given, not the translator's implementation. The translator knows
 * its own rejected-input errors; the kernel alone turns that answer into an exec's ENOEXEC. An error it does not
 * recognize stays an error, even if its name happens to be the same as a translator's rejection.
 */
export interface Translator {
  (elf: Uint8Array): Uint8Array;
  notProgram?(error: unknown): boolean;
  seeded?(elf: Uint8Array, seeds: (bigint | number)[]): Uint8Array<ArrayBuffer>;
  more?(elf: Uint8Array, seeds: (bigint | number)[], known: Set<bigint>, base: number): Uint8Array<ArrayBuffer>;
  close?(known: Set<bigint>): void;
  held?(): number;
  spare?(): number;
  renew?(): boolean;
  /** The coprocessor's module, until its execution interface is supplied independently. */
  readonly module?: WebAssembly.Module;
}
/** What a translation's instance exports: its entry, its table, its registers and its counters. */
export interface Translation {
  run(at: bigint): void;
  readonly table: WebAssembly.Table;
  readonly budget?: WebAssembly.Global;
  readonly depth?: WebAssembly.Global;
  readonly low?: WebAssembly.Global;
  /** Its thread's x87 registers' handle (x87.ts). */
  readonly x87?: WebAssembly.Global;
  readonly [reg: `r${number}`]: WebAssembly.Global | undefined;
  readonly fs?: WebAssembly.Global;
  readonly fl?: WebAssembly.Global;
  readonly rf?: WebAssembly.Global;
}
/** A file's translation, as the kernel keeps it (an Image). */
/** Continue independent retirement steps, then report every failure. */
class Retirement {
  private errors: unknown[] | undefined;
  get failed(): boolean { return !!this.errors?.length; }
  attempt(action: () => void): void {
    try { action(); } catch (error) { (this.errors ??= []).push(error); }
  }
  abort(error: unknown): never {
    (this.errors ??= []).push(error);
    this.finish();
    throw error;
  }
  finish(): void {
    if (!this.errors?.length) return;
    if (this.errors.length === 1) throw this.errors[0];
    throw new AggregateError(this.errors, 'Process retirement failed');
  }
}

interface Kept extends ImageEntry { image: Image }

/** What a pump says: init's wait status once it ended, else that everything waits (until a time, or input). */
export interface Pumped { status?: number; waiting?: true; until?: number }

const PAGE = 4096;
const STACK_BYTES = 8 << 20;
/**
 * Resource limits a first process has ([soft, hard], RLIMIT_CPU on), as Linux gives them (systemd's descriptors: 1024,
 * raised to 524288 by whoever asks): unlimited is all ones.
 */
const INF = 0xffffffffffffffffn;
const RLIMITS: [bigint, bigint][] = [[INF, INF], [INF, INF], [INF, INF], [BigInt(STACK_BYTES), INF], [0n, INF], [INF, INF], [63432n, 63432n],
  [1024n, 524288n], [8n << 20n, 8n << 20n], [INF, INF], [INF, INF], [63432n, 63432n], [819200n, 819200n], [0n, 0n], [0n, 0n], [INF, INF]];
/** The kernel's clocks (clock.ts). */
const CLOCK = clocks();

const CALLS: Calls = {...FILE_CALLS, ...PROC_CALLS, ...NET_CALLS, ...SIGNAL_CALLS, ...MOUNT_CALLS};
const enc = new TextEncoder();

/** How long a thread runs before another that can run gets a turn (checked at the calls in YIELDS that are timed). */
const SLICE = 10;
/**
 * One call in CALL_SAMPLE is timed: a clock read costs as much as a third of a call that does little, and each call
 * had two. The kernel's time on the calls is then a sample, as Linux's ticks sample it: what a timed call took, as
 * CALL_SAMPLE calls, is owed to the kernel's side and paid from the thread's time as it is counted (Kernel.lap).
 * The split conserves the elapsed interval during which the guest was marked running; the sample estimates the
 * kernel share. These monotonic wall ticks include host scheduling and Remote Worker round trips. They are not an
 * OS-thread CPU clock and don't imply a fixed proportion of system time for any program.
 */
export const CALL_SAMPLE = 8;
/** Calls a thread may be made to wait at for another's turn: ones that may wait anyway, so nothing a program relies on across them (its flags) is held. */
const YIELDS = new Set([0, 1, 7, 17, 18, 19, 20, 23, 24, 35, 61, 202, 230, 232, 247, 270, 271, 281]);
/**
 * Calls that change nothing another call may wait for: they read (who, what time, a file's state or bytes, a
 * directory) or change only the caller's own memory and mask. One of them done leaves the kernel as clean as it was, so
 * the calls that wait are not all made again after it (retry), as they are after any other; a pipe's, a socket's or a
 * futex's call that wakes another says so itself (dirty) besides.
 */
const QUIET = new Uint8Array(512);
for (const nr of [4, 5, 6, 8, 9, 10, 11, 12, 14, 17, 21, 39, 63, 79, 89, 96, 97, 98, 99, 100, 102, 104, 107, 108, 110, 111, 115, 118,
  120, 121, 124, 137, 138, 140, 186, 201, 204, 217, 228, 229, 262, 267, 269, 318, 332, 439]) QUIET[nr] = 1;
/** Calls Linux makes again after a handler with SA_RESTART (the rest say EINTR). */
const RESTARTS = new Set([0, 1, 2, 16, 17, 18, 19, 20, 61, 72, 73, 202, 247, 257, 295, 296]);

class GuestTrap extends Error {
  declare readonly address: bigint | number;
  declare readonly code: number;
  constructor(address: bigint | number, code: number) {
    const kind = ({1: 'jump to untranslated code', 2: 'undecodable code', 3: 'unsupported instruction', 4: 'divide error',
      7: 'ud2', 8: 'int3', 9: 'hlt'} as Record<number, string>)[code] ?? `trap ${code}`;
    super(`${kind} at 0x${address.toString(16)}`);
    this.address = address;
    this.code = code;
  }
}

/**
 * The signal a fault in guest code ends its process with: an instruction
 * that cannot run (SIGILL), a crash on purpose (hlt, as musl's a_crash,
 * SIGSEGV as Linux gives it), a divide error (SIGFPE), a stray access out
 * of its memory (SIGSEGV). Null for anything else, which is the host's.
 */
export function fault(e: unknown): number | null {
  if (e instanceof GuestTrap) return ({1: 11, 2: 4, 3: 4, 4: 8, 7: 4, 8: 5, 9: 11} as Record<number, number>)[e.code] ?? 4;
  if (!(e instanceof WebAssembly.RuntimeError)) return null;
  // A division translated as the engine's own (the divisor's width the dividend's: sods' integer.rs), which the
  // processor would have refused: by zero, or a quotient too large (the least integer by -1). The engine traps, and
  // says which in its own words (V8: "divide by zero", "remainder by zero", "divide result unrepresentable";
  // SpiderMonkey: "integer divide by zero", "integer overflow"; JavaScriptCore: "Division by zero", "Integer
  // overflow"). SIGFPE, as the wider division's own check gives it (div128: a GuestTrap of code 4).
  if (/divi(de|sion) by zero|remainder by zero|unrepresentable|integer overflow/i.test(e.message)) return 8;
  if (/out of bounds|unreachable/i.test(e.message)) return 11;
  return null;
}

/** A trap that is the translator's limit, not the program's: said on stderr, so it is not taken for the program's own. */
export const translatorsLimit = (e: unknown): e is GuestTrap => e instanceof GuestTrap && e.code >= 1 && e.code <= 3;
/**
 * Thrown through wasm frames when translated code gives the thread back: its time slice is up at a loop's head
 * (code 5), or its calls are deep and the next one starts afresh (code 6). Registers are in their globals; it goes
 * on at `address`.
 */
export class Preempted {
  declare readonly address: bigint;
  declare readonly code: number;
  constructor(address: bigint | number, code: number) { this.address = BigInt.asUintN(64, BigInt(address)); this.code = code; }
}
export const TRAP_YIELD = 5, TRAP_UNWIND = 6;
/**
 * A thread's time slice: about SLICE_MS of guest code, counted as the loops it goes round and the calls it makes
 * (translated code counts them down), so the kernel looks at timers, signals and other threads that often. How many
 * fit in it is learnt from the last one; SLICE_LOOPS is the first guess.
 */
export const SLICE_MS = 1, SLICE_LOOPS = 1 << 16;
export const nextSlice = (loops: number, ms: number): number => Math.max(1 << 10, Math.min(1 << 26, Math.round(loops * Math.sqrt(SLICE_MS / Math.max(ms, SLICE_MS / 64)))));
/** Where translated code looks for the kernel's call to look in (sods' abi.rs INTERRUPT): a word, and whether its process shares memory with another. */
export const INTERRUPT = 0x100, SHARES = INTERRUPT + 4;
/** The low words the kernel writes for translated code (INTERRUPT, SHARES): below Linux's vm.mmap_min_addr. */
const LOW_WORDS = 0x10000;
/** What goes below the least rsp written down without a write to rsp: pushes, the red zone (Process.written). */
const STACK_SLACK = 64 << 10;
export const trapOrPreempt = (address: bigint | number, code: number): never => {
  if (code === TRAP_YIELD || code === TRAP_UNWIND) throw new Preempted(address, code);
  throw new GuestTrap(address, code);
};

/** What attempt() says of a call that waits. */
const WAITS = Symbol('waits');
/** The bytes of a process with no memory (none yet, or gone). */
const EMPTY = new ArrayBuffer(0);
/** The memory a futex word of a process with none is keyed by. */
const NO_MEMORY = new WebAssembly.Memory({initial: 0});

const u64s = (module: WebAssembly.Module, name: string): BigUint64Array => {
  const [s] = WebAssembly.Module.customSections(module, name);
  return s ? new BigUint64Array(s.slice(0)) : new BigUint64Array(0);
};

/**
 * A loaded program: its first module, its loader facts, and the code reached
 * later. A jump to code the first translation did not find asks the host
 * (the module's `miss`), which translates from there into one more module
 * that shares everything with the first; every process of the program then
 * uses it, and nothing is translated twice.
 */
export class Image implements Program {
  declare readonly module: WebAssembly.Module;
  declare segments: Segment[] | null;
  declare source: (() => Uint8Array) | null;
  declare size: number;
  declare readonly facts: Facts;
  declare readonly known: Set<bigint>;
  declare slots: number;
  declare firstSlots: number;
  declare readonly extras: Extra[];
  declare readonly entries: Map<bigint, bigint>;
  declare file?: ImageEntry;
  declare origin?: string;
  declare wasm?: Uint8Array<ArrayBuffer> | null;
  declare told?: number;
  declare mainTold?: boolean;
  declare opened?: () => boolean;
  /** Its file changed before the code it reached later was read from it (readLater): what it reaches is this run's
   * alone, never kept as the file's for a later Prompt. */
  declare changed?: boolean;
  constructor(module: WebAssembly.Module, source: (() => Uint8Array) | null = null, size = 0, segments: Segment[] | null = null) {
    this.module = module;
    // Its data, when kept outside the module (share.ts): exec lays it in memory, and an instance writes nothing.
    this.segments = segments;
    this.source = source; // () => the ELF's bytes, for code reached later
    this.size = size; // bytes of wasm made for it (what its translations hold, before the engine compiles them)
    const section = (name: string): string => utf8(WebAssembly.Module.customSections(module, name)[0] ?? new ArrayBuffer(0));
    this.facts = JSON.parse(section('sods.facts'));
    this.known = new Set(u64s(module, 'sods.starts'));
    this.slots = this.known.size; // the first module's table, then with each module of code reached later
    this.firstSlots = this.slots;
    this.extras = []; // {module, base, count, bytes}
    this.entries = new Map(); // address -> function slot << 32 | block, for code reached later
  }

  /** Translate the code at `address` into one more module; false if there is none to be had. */
  more(translateMore: NonNullable<Translator['more']> | null, address: bigint, prepare: (w: Uint8Array<ArrayBuffer>) => {wasm: Uint8Array<ArrayBuffer>} = (w) => ({wasm: w})): boolean {
    if (!translateMore || !this.source) return false;
    let t = steady();
    // The starts known go as they are: the translator reads them only when it opens the ELF (it keeps them after).
    const wasm = prepare(translateMore(this.source(), [address], this.known, this.slots)).wasm;
    PROFILE.translate += steady() - t; t = steady();
    const module = new WebAssembly.Module(wasm);
    PROFILE.compile += steady() - t; PROFILE.modules++; PROFILE.bytes += wasm.length;
    const starts = u64s(module, 'sods.starts');
    if (!starts.length) return false;
    const entries = u64s(module, 'sods.entries');
    for (let k = 0; k < entries.length; k += 2) this.entries.set(entries[k], entries[k + 1]);
    for (const a of starts) this.known.add(a);
    this.extras.push({module, base: this.slots, count: starts.length, bytes: wasm});
    this.size += wasm.length;
    this.slots += starts.length;
    return this.entries.has(address);
  }

  /**
   * Code another run of this program reached later: its modules as `more` made them there, from this same first
   * module, in the order made ([{module, bytes, base}], `base` the table slot each began at). Taken in as if reached
   * here, so none of it is translated again; it stops at the first that does not follow on from what is here (made
   * from another start, or from code this run has reached already). How many were taken.
   */
  adopt(list: {module: WebAssembly.Module; bytes: Uint8Array; base: number}[]): number {
    let n = 0;
    for (const {module, bytes, base} of list) {
      if (base !== this.slots) break;
      const starts = u64s(module, 'sods.starts');
      if (!starts.length) break;
      const entries = u64s(module, 'sods.entries');
      for (let k = 0; k < entries.length; k += 2) this.entries.set(entries[k], entries[k + 1]);
      for (const a of starts) this.known.add(a);
      this.extras.push({module, base: this.slots, count: starts.length, bytes});
      this.size += bytes.length;
      this.slots += starts.length;
      n++;
    }
    return n;
  }
}

/**
 * The bytes of `node` for `image`, a translation taken ready-made (kept from an earlier Prompt, or given with its
 * program), read only once code it never reached is reached. They are the bytes it was made from only while the file
 * is as it was when it was taken: changed before they were read (a write, or one through a shared mapping, which
 * reading them settles), the image is that file's no longer (`changed`, no origin), so what it reaches from them is
 * this run's, and nothing of it is kept for a later Prompt as the file's.
 */
function readLater(node: File, image: Image): () => Uint8Array {
  const version = node.version;
  let pending: File | null = node, view: Uint8Array | null = null;
  return () => {
    if (view) return view;
    // Before capture this closure owns a source reference. A failed load keeps
    // it for retry; after capture only the independent/COW bytes are needed.
    const source = pending!, bytes = source.share();
    if (source.version !== version) { image.changed = true; image.origin = undefined; }
    view = bytes;
    pending = null;
    return view;
  };
}

/** What a kernel asks of the translations kept from earlier runs (keeper.ts gives one). */
export interface Keeper { has(origin: string): boolean; take(origin: string): Taken | null | undefined }

/** What a kernel is made with: its filesystem, its translator, its console, translations kept (Keeper), the machine. */
export interface Made {
  vfs?: Vfs;
  translate?: Translator;
  console: Console;
  keeper?: Keeper | null;
  /** What lies past this machine's network (sys-net.ts Outside): whoever answers a connection or a datagram that leaves it. None: its loopback alone. */
  outside?: Outside | null;
  machine?: Machine;
  consolidateIdle?: boolean;
  /** The translator's module, its x87 an instance of (x87.ts); else the translator's own (`translate.module`). */
  x87?: WebAssembly.Module;
}

/** A possibly partial transaction. No guest errno, rollback, Worker stop or
 * release is implied. Retained references are for ownership evidence,
 * not authorization to retry a failed operation. */
export class ExecCommitError extends Error {
  declare readonly process: Process;
  declare readonly phase: ExecPhase;
  declare readonly owners: ExecOwners<Task>;
  constructor(process: Process, phase: ExecPhase, cause: unknown, owners: ExecOwners<Task> = {}) {
    super(`Exec transaction could not complete (${phase})`, {cause});
    this.name = 'ExecCommitError';
    this.process = process;
    this.phase = phase;
    this.owners = owners;
  }
}

export class Kernel implements Kern {
  /** Unresolved preparation evidence. Lazily allocated only on failed cleanup;
   * no automatic cleanup retry or tree disposal is authorized by these roots. */
  declare failedPreparations?: Set<Process>;
  declare failedExecs?: Set<ExecCommitError>;
  #executionEpoch: object = {};
  #starting = false;
  get executionEpoch(): object { return this.#executionEpoch; }
  protected invalidateExecPreparation(): void { this.#executionEpoch = {}; }
  declare readonly vfs: Vfs;
  declare readonly consolidateIdle: boolean;
  declare readonly due: Map<File, Kept>;
  declare readonly machine: Machine;
  declare readonly translate: Translator | undefined;
  declare readonly keeper: Keeper | null;
  declare readonly outside: Outside | null;
  declare readonly translateMore: NonNullable<Translator['more']> | null;
  declare readonly console: Console;
  #rootConsoleGuest: RootConsoleGuest | undefined;
  declare readonly images: Map<File, Kept>;
  declare uses: number;
  declare budget: number;
  declare readonly procs: Map<number, Process>;
  declare readonly tasks: Map<number, Task>;
  declare readonly runq: Task[];
  declare readonly blocked: Set<Task>;
  declare readonly futexes: Map<WebAssembly.Memory | File, Map<number, Set<FutexWaiter>>>;
  declare dirty: boolean;
  declare current: Task | null;
  declare tty: Tty;
  declare status: number | null;
  declare shared: boolean;
  declare readonly timers: Set<Timer>;
  declare readonly spareMemories: Mem[];
  /** A pid namespace's init (remote.ts's kernels: the first process theirs). */
  declare initPid?: number;
  /** Everything ended (remote.ts hears of it). */
  declare stopped?: () => void;
  declare inputs?: number;
  declare readonly root: Place;
  declare readonly spaces: Spaces;
  declare readonly numbers: Numbers;
  /** The next number the first pid namespace gives. */
  get nextPid(): number { return this.spaces.children.last + 1; }
  /** The cgroups: the tree's root, and the file system it is. */
  declare readonly cgroups: {root: Cgroup; sb: Super};
  declare readonly terminals: Mount;
  declare loopbackTraffic?: {bytes: number; packets: number};
  declare readonly cpu: Cpu;
  /** Calls made, so that one in CALL_SAMPLE is timed. */
  declare calls: number;
  declare readonly x87Module: WebAssembly.Module | null;
  /**
   * vfs: the filesystem. translate(bytes) -> wasm bytes for an ELF.
   * console: {write(fd, bytes), read(n) -> Uint8Array | null (nothing yet), ready?(), interactive?, screen?, cols?,
   * rows?} (`screen`: its output is shown as a terminal's screen, `cols` by `rows`, though keys come a line at a time).
   */
  constructor({vfs = new Vfs(), translate, console, keeper = null, outside = null, machine: host = machine(), consolidateIdle = false, x87}: Made) {
    checkExecTree(vfs);
    this.vfs = vfs;
    // The x87 its threads run (x87.ts), made when the first is.
    this.x87Module = x87 ?? translate?.module ?? null;
    // A program due to be translated again as one module (consolidate): at once as it is run again, or, where the
    // host has idle time to give (a Prompt waiting for its next line), only then (consolidateDue), so no
    // run waits on it. Each due one: its node -> its entry.
    this.consolidateIdle = consolidateIdle;
    this.due = new Map();
    // The memory and storage the host says it has (machine.ts): what meminfo, sysinfo and statfs tell programs.
    this.machine = host;
    this.translate = translate;
    // Translations kept from earlier runs, by a root file's origin (pack.ts): {has(origin), take(origin)}. take gives
    // {module, segments, size, more} once read, null when it cannot be had, or undefined while it is being read
    // (the exec that wants it waits; the keeper wakes the kernel when it is read).
    this.keeper = keeper;
    this.outside = outside;
    // Code reached later, when the translator can do it: translate.more(elf, seeds, known, base).
    this.translateMore = translate?.more ?? null;
    this.console = console;
    this.numbers = new Map();
    this.images = new Map(); // File node -> {version, image, used, kept}
    this.uses = 0; // counts loads, so the least recently used image is known
    // What may be kept for programs run again (translations, the translator, root files read) once nothing runs them.
    this.budget = 256 << 20;
    this.procs = new Map(); // pid -> Process (live, or a zombie until waited for)
    this.tasks = new Map(); // tid -> Task
    this.runq = []; // threads that can run here, in turn
    this.blocked = new Set(); // threads in a call that waits
    this.futexes = new Map(); // a memory or a file -> Map(address or offset -> Set of waiters)
    this.dirty = false; // something changed that a waiting call may be waiting for
    this.current = null; // the thread running here, if any
    // The console as a terminal: its session and the group in front (Ctrl-C goes to it).
    this.tty = {sid: 0, fg: 0};
    this.status = null; // init's wait status once it ended
    this.shared = false; // memories are SharedArrayBuffers (remote.ts)
    this.timers = new Set(); // {at, fire}: alarms (steady() ms)
    this.cpu = {user: 0, sys: 0}; // all the time threads ran their programs, and the kernel made their calls (ms)
    this.calls = 0;
    // Memories processes let go of (exec, exit), for the next to take: a new one costs its pages faulted in and the
    // old one collected; a used one costs zeroing what is given out of it (Kernel.takeMemory).
    this.spareMemories = [];
    // The tree as its first process sees it: this kernel's own mounts of it (another kernel on the same tree has
    // its own), under a first namespace of each kind.
    const root = copy(vfs.mount, vfs.root, {deep: true, whole: true}) as Mount;
    // (a cgroup's processes are read and written by the numbers the one who reads or writes calls them)
    const viewer = (): PidNs => this.current?.proc.pidns ?? this.spaces.children;
    this.cgroups = cgroups({find: (nr) => this.procs.get(byNr(viewer(), nr)), nr: (p) => nrIn(this.numbers, viewer(), p.pid),
      kill: (p) => { send(this, p, SIG.KILL, {signo: SIG.KILL, code: SI.KERNEL}); }});
    this.spaces = firstSpaces(firstSpace(root, HOST), new CgroupNs(HOST, this.cgroups.root));
    this.root = vfs.who.root = {mnt: root, node: vfs.root};
    // What a program reads of the machine and of its processes: /proc and /sys, made from this kernel as they are
    // read, and the cgroups where Linux has them.
    const most = MNT.NOSUID | MNT.NODEV | MNT.NOEXEC;
    this.mount('/proc', new Mount(this.spaces.children.proc = procfs(this), undefined, most));
    this.mount('/sys', new Mount(this.spaces.net.sys = sysfs(this), undefined, most));
    this.mount('/sys/fs/cgroup', cgroupMount(this.cgroups.sb, this.cgroups.root));
    // The terminals programs make (/dev/pts); the console is the first of them by name, /dev/pts/0.
    const pts = devpts(null, 'devpts', 'mode=620,ptmxmode=666', 1);
    (pts.data as Instance).others.set('0', vfs.terminal);
    this.mount('/dev/pts', this.terminals = new Mount(pts, undefined, MNT.NOSUID | MNT.NOEXEC));
    // As on Linux: /dev/fd and the standard streams through /proc/self.
    const dev = vfs.dir('/dev');
    for (const [name, target] of [['fd', '/proc/self/fd'], ['stdin', '/proc/self/fd/0'], ['stdout', '/proc/self/fd/1'], ['stderr', '/proc/self/fd/2']]) {
      if (!dev.entries.has(name)) dev.entries.set(name, new Link(target));
    }
  }

  /** `m` mounted at `path` of the first process's tree (a directory that is there). */
  mount(path: string, m: Mount): void {
    const at = this.vfs.resolve(path);
    put(m, {mnt: at.mnt, node: at.node!}, at.parent, at.name);
  }

  /** Whether `node` is a root file, unchanged, whose translation is kept (so it is not read to be translated). */
  keptFor(node: File): boolean { return node.version === 0 && !!node.origin && !!this.keeper?.has(node.origin); }
  /** Whether this version of `node` is translated already (image). */
  translated(node: File): boolean { return this.images.get(node)?.version === node.version; }

  /**
   * The image for an executable file, translating it once per version. `wait`: inside a call, which may wait for a
   * translation kept from an earlier run to be read (Wait is thrown, and the call is made again once it is).
   */
  image(node: File, wait = false): Image {
    if (node.maps) node.settle(); // Normal mapping observation precedes the source revision.
    const revision = node.version;
    const cached = this.images.get(node);
    if (cached && cached.version === revision) {
      cached.used = ++this.uses;
      try { this.consolidateIfDue(node, cached); }
      finally { sourceRevision(node, revision); }
      return cached.image;
    }
    let kept = false;
    if (wait && this.keeper && node.origin) {
      try { kept = this.keptFor(node); }
      finally { sourceRevision(node, revision); }
    }
    if (kept && this.keeper && node.origin) {
      let got: Taken | null | undefined;
      try { got = this.keeper.take(node.origin); }
      finally { sourceRevision(node, revision); }
      if (got === undefined) throw new Wait();
      if (got) {
        // The file's bytes only if code it never reached before is reached now.
        const image = new Image(got.module, null, got.size, got.segments);
        const source = readLater(node, image);
        let opened = false;
        image.source = () => { const bytes = source(); opened = true; return bytes; };
        image.origin = node.origin;
        image.opened = () => opened;
        image.told = image.adopt(got.more);
        image.mainTold = true;
        PROFILE.kept++;
        sourceRevision(node, revision);
        const entry: Kept = {version: revision, image, used: ++this.uses, kept: false};
        this.remember(node, entry);
        // Kept from an earlier run: it is run again, so the code that run reached later is gathered now.
        try { this.consolidateIfDue(node, entry); }
        finally { sourceRevision(node, revision); }
        return entry.image;
      }
    }
    // A view of the file, not a copy: a later write to it changes a copy (File.share).
    let bytes: Uint8Array;
    try { bytes = node.share(); }
    finally { sourceRevision(node, revision); }
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new FsError(E.NOEXEC);
    if (!this.translate) throw new FsError(E.NOEXEC);
    let t = steady();
    // What the translator says is no program it takes (an ELF cut short, of another machine, not an executable) is
    // the file's fault and the exec's failure, as a file with no ELF header's is: ENOEXEC. What else it throws is
    // its own fault, and stays the host's error.
    let translated: Uint8Array;
    try { translated = this.translate(bytes); }
    catch (error) {
      sourceRevision(node, revision); // Do not run an error classifier on an already-invalid source.
      let rejected: boolean | undefined;
      try { rejected = this.translate.notProgram?.(error); }
      finally { sourceRevision(node, revision); }
      if (rejected) throw new FsError(E.NOEXEC);
      throw error;
    } finally { sourceRevision(node, revision); }
    const {wasm, segments} = this.prepare(translated);
    PROFILE.translate += steady() - t; t = steady();
    // Code reached later is read from the very bytes this was translated from (and the translator keeps them parsed by identity).
    const image = new Image(new WebAssembly.Module(wasm), () => bytes, wasm.length, segments);
    PROFILE.compile += steady() - t; PROFILE.images++;
    // A root file unchanged: its translation can be kept (the host hears of it once the kernel pauses: ricebox/distribution/runtime/worker.ts).
    sourceRevision(node, revision);
    if (revision === 0 && node.origin) { image.origin = node.origin; image.wasm = wasm; image.told = 0; image.mainTold = false; }
    this.remember(node, {version: revision, image, used: ++this.uses, kept: false});
    return image;
  }

  /**
   * A program run again that had reached much of its code later (CONSOLIDATE modules of it or more): translated
   * once more, from every start it reached, as one module. Each process of it from here on is one instance, not one
   * per module, and its jumps among that code are found in its own table, not asked of the host. What runs it
   * now goes on with what it has. The new translation is kept as the program's (the page hears of it as of any).
   */
  /**
   * Consolidate a program run again once much of what it runs is in modules of later code (a quarter as many functions
   * as its first module has), not each time a few more are reached. `idle`: nothing waits on it (it is gathered to be
   * kept), so once it has any such modules.
   */
  consolidateIfDue(node: File, cached: Kept, idle = false): void {
    const im = cached.image;
    const due = idle ? im.extras.length > 0 : im.extras.length >= CONSOLIDATE && (im.slots - im.firstSlots) * 4 >= im.firstSlots;
    if (!due || !this.translate?.seeded || !im.source) return;
    if (this.consolidateIdle && !idle) this.due.set(node, cached);
    else this.consolidate(node, cached);
  }

  /**
   * The host has time (nothing runs, and it waits for a person): each program due is translated again as one module
   * (consolidate), unless it changed or went since; the process that ran it goes on with what it has. How many were.
   */
  consolidateDue(): number {
    let n = 0;
    for (const [node, cached] of this.due) {
      this.due.delete(node);
      if (this.images.get(node) !== cached || cached.version !== node.version || !cached.image.extras.length) continue;
      this.consolidate(node, cached);
      n++;
    }
    return n;
  }

  consolidate(_node: File, cached: Kept): void {
    const old = cached.image, seeded = this.translate?.seeded;
    if (!old.source || !seeded) return;
    const bytes = old.source();
    let t = steady();
    const {wasm, segments} = this.prepare(seeded(bytes, [...old.known]));
    PROFILE.translate += steady() - t; t = steady();
    const image = new Image(new WebAssembly.Module(wasm), () => bytes, wasm.length, segments);
    PROFILE.compile += steady() - t; PROFILE.images++; PROFILE.consolidated++;
    if (old.origin) { image.origin = old.origin; image.wasm = wasm; image.told = 0; image.mainTold = false; }
    image.file = cached;
    cached.image = image;
  }

  /** `entry` is the image of this version of `node`: its images (it, and one consolidated from it) say so (`file`). */
  remember(node: File, entry: Kept): void {
    entry.image.file = entry;
    this.images.set(node, entry);
    // With a translation it is one of those keeping its tree's files (sources), until it ends (ended).
    this.vfs.loaded.keepers.add(this);
  }

  /** A translation as it is run here: {wasm, segments} (share.ts; shared memory when threads run apart). */
  prepare(wasm: Uint8Array): {wasm: Uint8Array<ArrayBuffer>; segments: Segment[] | null} { return prepare(wasm, {shared: this.shared}); }

  /**
   * A file whose translation was made ahead of time (by the same translator,
   * from exactly these bytes). It holds only while the file is unchanged; a
   * write makes it translate again.
   */
  prebuilt(node: File, module: WebAssembly.Module, segments: Segment[] | null = null): void {
    this.rememberPrebuilt(node, this.makePrebuilt(node, module, segments));
  }

  private makePrebuilt(node: File, module: WebAssembly.Module, segments: Segment[] | null): Image {
    const image = new Image(module, null, 0, segments);
    image.source = readLater(node, image);
    return image;
  }

  private rememberPrebuilt(node: File, image: Image): void {
    // Kept: nothing here could make it again.
    this.remember(node, {version: node.version, image, used: ++this.uses, kept: true});
  }

  /**
   * Attach only to the captured canonical inode, never a path's replacement.
   * Stale metadata declines before touching the source. Mapping observation is
   * the same as image(); dirty mappings invalidate the captured revision. An
   * unusual still-lazy mapped file declines rather than reading its payload.
   * This is association, not exec authorization or artifact authentication.
   */
  prebuiltSource(source: ExecutableSource, module: WebAssembly.Module, segments: Segment[] | null = null): Image | null {
    const captured = executableSourceFor(source, this.vfs), {node} = captured;
    if (!unchangedExecutableSource(captured)) return null;
    if (node.maps) {
      // Rust-owned lazy files keep source state outside File.load. Residency
      // metadata is enough to decline, without invoking either loader.
      if (node.load || node.heldBytes() < node.size) return null;
      node.settle();
      if (!unchangedExecutableSource(captured)) return null;
    }
    const image = this.makePrebuilt(node, module, segments);
    if (!unchangedExecutableSource(captured)) return null;
    this.rememberPrebuilt(node, image);
    return image;
  }

  /** Every live process. */
  live(): Process[] { return [...this.procs.values()].filter((p) => p.state === 'live'); }

  /** Bytes of guest memory the running processes hold (their wasm memories, each once). */
  memoryBytes(): number {
    return [...new Set(this.live().map((p) => p.memory))].reduce((n, m) => n + (m?.buffer.byteLength ?? 0), 0);
  }

  /**
   * A memory of at least `pages` wasm pages from those let go of, or null. Its first `pages` are zero when given;
   * what lies past them may still hold what its last process left, up to `dirty` (bytes): Process.cover zeroes each
   * part of that as it is mapped. Of its first pages, `over` ([[start, end]]) is not zeroed: the caller writes it whole.
   */
  takeMemory(pages: number, image: Image | null = null, over: Range[] = [], took?: (memory: Mem) => void): Mem | null {
    // One that last ran `image` first: what of the program no correct run can change is in it already (as a page
    // cache gives a program its file), and is neither zeroed nor laid again (`keeps`).
    const same = (m: Mem): boolean => !!image && !!m.imageOf && (m.imageOf === image || (!!image.file && m.imageOf.file === image.file));
    // Before those, one an instance of `image` is kept on: that may go on too (Task.load, goesOn), best on one that
    // last ran it; and of those without, one no other program's instance is kept on, so that one is there for its
    // program's next process.
    const order = image ? [(m: Mem) => same(m) && this.keepsInstance(m, image), (m: Mem) => this.keepsInstance(m, image), (m: Mem) => same(m) && !this.keepsInstance(m), same] : [];
    let k = -1;
    for (const f of order) if ((k = this.spareMemories.findLastIndex(f)) >= 0) break;
    if (k < 0) k = this.spareMemories.length - 1;
    if (k < 0) return null;
    const [m] = this.spareMemories.splice(k, 1);
    took?.(m); // An exec owns this take even if growth or reuse fails.
    retireMemoryView(m);
    const have = m.buffer.byteLength / WASM_PAGE;
    if (have < pages) m.grow(pages - have);
    m.keeps = same(m);
    m.exact = !!image && m.imageOf === image;
    PROFILE.memoriesReused++;
    if (m.keeps) PROFILE.imagesKept++;
    clean(m, pages, [...m.keeps && image ? keptImageRanges(image, m.exact) : [], ...over]);
    this.reuseMemory(m);
    return m;
  }
  /**
   * `memory` goes on under its process into a new run of the image it ran (an exec of the same program): zeroed as
   * it would be let go of and taken back, and not let go of, so what is instantiated over it stays (Task.renew).
   */
  renew(memory: Mem, written: Range[] | null, pages: number, image: Image, over: Range[] = []): void {
    retireMemoryView(memory);
    memory.written = merge([...memory.written, ...written ?? []]);
    memory.keeps = true;
    memory.exact = memory.imageOf === image;
    memory.imageOf = image;
    memory.deepest = undefined;
    clean(memory, pages, [...keptImageRanges(image, memory.exact), ...over]);
    PROFILE.renewed++;
  }
  /**
   * `memory` is no longer one process's: kept for another when nothing else can run on it (no other process, no
   * thread left in guest code). `written`: where its last process may have written ([[start, end]], its kernel words,
   * image, stack and mappings: Process.written); what lies outside them is still zero, and is not zeroed again.
   */
  letGo(memory: Mem | null, written: Range[] | null = null): void {
    retireMemoryView(memory);
    if (!memory || --memory.users > 0) return;
    if (memory.tainted) { this.forget(memory); return; }
    memory.written = merge([...memory.written, ...written ?? [[0, memory.buffer.byteLength] as Range]]);
    // A few, and none so large that keeping it would hold much of what the host has to spare.
    if (this.spareMemories.length < SPARE_MEMORIES && memory.buffer.byteLength <= SPARE_MEMORY_BYTES) this.spareMemories.push(memory);
    else this.forget(memory);
  }
  /** `memory` is let go of for good (not kept for another process): nothing more to do here (remote.ts forgets it in its Workers). */
  forget(_memory: Mem): void {}
  /** Whether an instance of `image` (of any, without one) is kept on `memory`, for a process of it to go on with (Task.load; remote.ts: a Worker's). */
  keepsInstance(memory: Mem, image: Image | null = null): boolean { return !!memory.pooled?.some((x) => !image || x.image === image); }
  /** A memory let go of is taken again (the backend forgets what it kept for it: remote.ts's lock). */
  reuseMemory(_memory: Mem): void {}

  /**
   * What this kernel holds, by kind, and how much of it can go without
   * stopping anything: `guest` (the running processes' memories, exact),
   * `translations` (the wasm made for each program; the engine's compiled
   * code is more, and not visible), `translator` (its memory, exact) and
   * `files` (bytes of root files read, exact). `spare` is what can go:
   * translations no running process uses, the translator's memory (a
   * running program parses its ELF again on its next miss), and files no
   * kept translation reads from.
   */
  held(): Held {
    const using = new Set<Program>(this.live().map((p) => p.image));
    let translations = 0, spareTranslations = 0;
    for (const e of this.images.values()) {
      translations += e.image.size;
      if (!e.kept && !using.has(e.image)) spareTranslations += e.image.size;
    }
    const keep = this.keptFiles();
    let files = 0, spareFiles = 0;
    for (const f of this.vfs.loaded.files) {
      files += f.heldBytes();
      if (!keep.has(f)) spareFiles += f.releasableBytes();
    }
    const guest = this.memoryBytes(), translator = this.translate?.held?.() ?? 0, spareTranslator = this.translate?.spare?.() ?? translator;
    const spareGuest = this.spareMemories.reduce((n, m) => n + m.buffer.byteLength, 0);
    return {guest: guest + spareGuest, translations, translator, files, spare: spareTranslations + spareTranslator + spareFiles + spareGuest,
      total: guest + spareGuest + translations + translator + files, spareTranslator};
  }

  /**
   * Give back what nothing running needs, least recently used first, until
   * what can go is at most `budget` bytes (0: all of it). Returns what was
   * held before and after.
   */
  free(budget = 0): {before: Held; after: Held} {
    const before = this.held();
    if (before.spare <= budget) return {before, after: before};
    const using = new Set<Program>(this.live().map((p) => p.image));
    let over = before.spare - budget;
    // Memories let go of first: they hold the most, and cost only their faults to make again.
    while (over > 0) {
      const m = this.spareMemories.pop();
      if (!m) break;
      over -= m.buffer.byteLength;
      this.forget(m);
    }
    const spare = [...this.images].filter(([, e]) => !e.kept && !using.has(e.image)).sort((a, b) => a[1].used - b[1].used);
    for (const [node, e] of spare) {
      if (over <= 0) break;
      this.images.delete(node);
      // (A kept translation whose file was never read has nothing open in the translator.)
      if (e.image.opened?.() !== false) this.translate?.close?.(e.image.known);
      over -= e.image.size;
    }
    if (over > 0 && before.spareTranslator > 0 && this.translate?.renew?.()) over -= before.spareTranslator;
    // A translation that went leaves its program's file spare too: with no budget, every such file goes.
    if (over > 0 || budget === 0) {
      const keep = this.keptFiles();
      for (const f of [...this.vfs.loaded.files]) if ((over > 0 || budget === 0) && !keep.has(f)) over -= f.release();
    }
    return {before, after: this.held()};
  }

  /** The files whose translations it keeps or runs: their bytes are not spare, to it or to another kernel on its tree. */
  sources(): Set<File> {
    const using = new Set<Program>(this.live().map((p) => p.image));
    return new Set([...this.images].filter(([, e]) => e.kept || using.has(e.image)).map(([node]) => node));
  }
  /**
   * The files of its tree that are not spare: its own sources, and those of every other kernel running on the same
   * tree (a tree is shared by a rehearsal and the run after it: what one still reads the other does not let go).
   */
  keptFiles(): Set<File> {
    const keep = this.sources();
    for (const k of this.vfs.loaded.keepers) if (k !== this) for (const f of k.sources()) keep.add(f);
    return keep;
  }
  /** Its run is over: it keeps nothing of its tree from going any longer (and the tree does not keep it). */
  ended(): void {
    this.invalidateExecPreparation();
    this.vfs.loaded.keepers.delete(this);
  }

  /** Explicit embedding-owner action, never automatic process exit cleanup.
   * Caller must prevent future execution and confirm host stop where required.
   * Raw aliases and guest-created namespace copies are NOT invalidated or proven
   * released. Only this initial tree's structural mount edges are retired. */
  retireInitialMounts(): boolean {
    // Closing an nsfs descriptor does not prove raw File/Place/bind aliases
    // disappeared. Do not infer namespace ownership from mount refs alone.
    if (namespaceWasExposed(this.spaces.mnt)) return false;
    if (this.current || this.tasks.size || this.procs.size || this.runq.length || this.blocked.size || this.failedPreparations?.size || this.failedExecs?.size
      || this.vfs.loaded.keepers.has(this)) return false;
    const restore = this.vfs.who.root === this.root;
    const base = this.vfs.mount;
    // Restore only the original, unattached Vfs base. Never restore a saved
    // walker that might itself belong to an already-retired namespace.
    if (restore && (base.space || base.parent || base.point)) return false;
    if (!retireInitialTree(this.spaces.mnt)) return false;
    if (restore) this.vfs.who.root = {mnt: base, node: this.vfs.root};
    return true;
  }

  /** A new thread of `proc` (the backend's kind). */
  newTask(proc: Process): Task {
    if (proc.kernel !== this) throw new TypeError('Task process belongs to another kernel');
    return new Task(proc);
  }

  /**
   * A number for a new thread of `proc`: the kernel's own, and, made in a pid namespace that is not the first, one
   * there and in each above (kept: space.ts). Now and then the numbers that are no one's any more are let go of.
   */
  numbered(proc: Process): number {
    const space = proc.pidns, nrs = number(space), id = nrs[0];
    if (space.parent) {
      const record = {space, nrs};
      try {
        this.numbers.set(id, record);
        if (this.numbers.size > 2 * this.tasks.size + 64) {
          const used = new Set<number>(this.tasks.keys());
          for (const p of this.procs.values()) used.add(p.pid).add(p.pgid).add(p.sid);
          used.add(id);
          forget(this.numbers, used);
        }
      } catch (error) {
        failedInitialReservation(space, nrs);
        const failures = [error];
        let owns = false;
        try {
          const current = this.numbers.get(id);
          if (current === record) {
            if (!this.numbers.delete(id)) throw new Error('failed Kernel PID registration could not confirm record removal');
          }
          else if (current !== undefined) throw new Error('failed Kernel PID registration changed record ownership');
          owns = true;
        } catch (cleanup) { failures.push(cleanup); }
        // If another record adopted the same ID, or outer retirement failed,
        // an inner numeric match alone cannot prove our ownership. Retain it.
        if (owns) failures.push(...discardNumberLookups(space, nrs));
        if (failures.length > 1) throw new AggregateError(failures, 'Kernel PID registration and lookup cleanup failed');
        throw error;
      }
    }
    return id;
  }

  /** Create the first process (pid 1, a session and group of its own, in front on the console). */
  start(path: string, argv: string[], env: string[], cwd = '/'): void {
    checkExecTree(this.vfs);
    if (this.#starting) throw new Error('Initial process preparation is already in progress');
    this.#starting = true;
    try { this.startInitial(path, argv, env, cwd); }
    finally { this.#starting = false; }
  }

  private startInitial(path: string, argv: string[], env: string[], cwd: string): void {
    // The candidate owns its private Fs and descriptors, but no runnable
    // process, cgroup member or PID is published while input can still fail.
    const p = new Process(this, null, false, false, null, null, false);
    let task: Task | undefined, committed = false;
    try {
      const at = walk(p, cwd, p.fs.pwd);
      if (typeof at !== 'number' && at.node) p.fs.go({mnt: at.mnt, node: at.node});
      ['stdin', 'stdout', 'stderr'].forEach((name, fd) => p.fds.install(new Description('console', {path: name}), {fd}));
      replaceExec<Process, Image, Task>(p, {path, argv, env}, () => {
        const t = task = this.newTask(p);
        p.pid = p.pgid = p.sid = t.tid;
        p.tasks.add(t);
        return p.task = t;
      });
      committed = true;
      const t = task!;
      enter(p, p.cgroup);
      this.procs.set(p.pid, p);
      this.tasks.set(t.tid, t);
      this.tty = {sid: p.sid, fg: p.pgid};
      this.ready(t);
    } catch (cause) {
      if (p.execFailure) throw cause; // Preparation/commit already retained its owner.
      if (committed) p.retainExecFailure('initial-publication', cause, {task, newMemory: p.memory ?? undefined, newFds: p.fds});
      const failures = [cause];
      const retire = (action: () => void): void => { try { action(); } catch (cleanup) { failures.push(cleanup); } };
      // No child was published or sent to a Worker. Do not run ordinary exit
      // (no status, signals, or startup event for the failed candidate).
      if (task) retire(() => task!.end());
      retire(() => p.fs.drop());
      retire(() => p.fds.letGo());
      if (failures.length > 1) p.retainExecFailure('initial-preparation', new AggregateError(failures), {task, newFds: p.fds});
      throw cause;
    }
  }

  // ---- threads in turn (the backend here) ----

  ready(t: Task): void { if (!t.dead) { t.state = 'ready'; this.blocked.delete(t); this.runq.push(t); } }
  block(t: Task): void { t.state = 'blocked'; this.blocked.add(t); }

  /**
   * Run until every process has exited or every thread waits (for input, a
   * child, or until a time: `until`, in steady() ms, the soonest a
   * waiting call times out or a sleep ends). Returns {waiting: true, until?}
   * or {status} of the first process.
   */
  /** `bytes` written to the console (fd 1 or 2), after what was written there before. */
  say(fd: number, bytes: Uint8Array): void { this.console.write(fd, bytes); }

  pump(): Pumped {
    // The host runs it again because something may have changed (input came, a time passed).
    this.dirty = true;
    for (;;) {
      if (this.status !== null) return {status: this.status};
      this.retry();
      const t = this.runq.shift();
      if (!t) {
        if (this.status !== null) return {status: this.status};
        const until = this.deadline();
        return until === undefined ? {waiting: true} : {waiting: true, until};
      }
      this.run(t);
    }
  }

  /** Run `t` here until it waits, yields, or ends. */
  run(t: Task): void {
    if (t.proc.execTransition) execMayRun(t.proc);
    if (t.dead || t.proc.stopped) { t.state = t.dead ? 'dead' : 'stopped'; return; }
    this.current = t;
    t.state = 'running';
    t.sliceStart = steady();
    try {
      // A call it was made to wait at for this turn, first.
      if (t.call) {
        const call = t.call;
        const v = this.attempt(t, call);
        if (v === WAITS) { this.block(t); return; }
        this.resumeWith(t, call, v, false);
        if (t.dead || t.state !== 'running') return;
      } else if (deliverable(t)) {
        take(this, t, t.context());
        if (t.dead || t.proc.stopped) { if (!t.dead) t.state = 'stopped'; return; }
      }
      for (;;) {
        try {
          t.attach();
          const x = t.exports;
          // A full time slice, and no frames yet.
          if (x.budget) x.budget.value = t.slice;
          if (x.depth) x.depth.value = 0;
          t.ranAt = t.since = steady();
          x.run(t.resumeAt);
        } catch (e) {
          if (e instanceof Preempted) {
            const now = steady();
            this.lap(t, now);
            t.resumeAt = e.address;
            // What it wrote and the console gathered goes on its way at a turn, not only once every thread waits.
            this.console.flush?.(false);
            if (e.code === TRAP_YIELD) t.slice = nextSlice(t.slice, now - t.ranAt);
            if (t.proc.maps.length) t.proc.syncShared();
            // Its time is up: due timers, a signal for it and other threads first; else it goes on at once.
            if (e.code === TRAP_YIELD && (this.runq.length || deliverable(t) || [...this.timers].some((x) => x.at <= now))) { this.ready(t); return; }
            continue;
          }
          if (e instanceof Exec || e instanceof Redirect) continue;
          if (e instanceof Wait || e instanceof Exit) return;
          // A fault ends this process only, as a signal would: the shell, and
          // anything else, runs on and sees how it ended.
          const sig = fault(e);
          if (sig) {
            // What the translator cannot run yet is said, so it is not taken for the program's own fault.
            if (translatorsLimit(e)) this.say(2, enc.encode(`sods: ${e.message}\n`));
            if (TRACE_FAULTS) console.error(`[${t.tid}] ${t.proc.argv?.[0] ?? ''} fault: ${e instanceof Error ? e.stack : e}`);
            this.exitProcess(t.proc, sig);
            return;
          }
          throw e;
        }
      }
    } finally {
      this.current = null;
    }
  }

  /**
   * A system call from guest code (here: the module's `syscall` import).
   * Done at once: its value, or the thread goes elsewhere (Redirect, Exit,
   * Exec thrown). To wait: Wait is thrown, and the thread goes on after
   * the call once it is done.
   */
  enter(t: Task, nr: bigint, args: bigint[], next: bigint): bigint {
    // Timed (one in CALL_SAMPLE): when it began, so its time is owed to the kernel's side once it ends. Its thread's
    // time is counted then, and whenever its run here ends at the call (it waits, ends, goes elsewhere).
    const at = ++this.calls % CALL_SAMPLE === 0 ? steady() : 0;
    let runsOn = false;
    try {
      t.resumeAt = next;
      const call: Call = {nr: Number(nr), args, next, state: {}};
      if (TRACE_SYSCALLS) trace(t, call);
      // Another's turn, if this one has had its time: it makes this call when it runs again.
      if (YIELDS.has(call.nr) && (call.nr === 24 || (at && at - t.sliceStart > SLICE)) && (this.runq.length || this.dirty)) {
        t.call = call;
        this.ready(t);
        throw new Wait();
      }
      const v = this.attempt(t, call);
      if (v === WAITS) { t.call = call; this.block(t); throw new Wait(); }
      if (!t.dead && !t.proc.stopped && !deliverable(t)) { runsOn = true; return v; }
      this.resumeWith(t, call, v, true);
      if (t.dead) throw new Exit(0);
      if (t.state !== 'running') throw new Wait();
      if (t.redirected) throw new Redirect();
      runsOn = true;
      return v;
    } finally {
      if (at || !runsOn) {
        const now = steady();
        if (at) t.owed += (now - at) * CALL_SAMPLE;
        this.lap(t, now);
      }
    }
  }

  /** The x87 of the threads run here (x87.ts): one, from the translator's module. */
  get x87(): X87 {
    if (!this.x87Module) throw new Error('no x87: a kernel made without the translator\'s module runs no x87 code');
    return x87Of(this.x87Module);
  }

  /**
   * `t`'s time from `since` to `now` is counted, and counts from `now` on: the kernel's as far as it is owed that (its
   * timed calls, CALL_SAMPLE), its program's the rest.
   */
  lap(t: Task, now: number): void {
    const ran = now - t.since, sys = Math.min(ran, t.owed);
    t.owed -= sys;
    this.charge(t, ran - sys, sys);
    t.since = now;
  }

  /**
   * Time `t` ran its program (`user`) and the kernel spent on its calls (`sys`), in ms: counted to it, or to its process
   * once it ended (what it had went there: endTask), and to the machine's.
   */
  charge(t: Task, user: number, sys: number): void {
    const c = t.dead ? t.proc.cpu : t.cpu;
    c.user += user;
    c.sys += sys;
    this.cpu.user += user;
    this.cpu.sys += sys;
  }

  /**
   * `call` asked of `t`'s filters (seccomp.ts), before it is made: null where it may be made; else what it is
   * answered instead, the call not made. One that ends its thread or its process does (Exit goes through).
   */
  screened(t: Task, call: Call): bigint | null {
    const p = t.proc;
    if (t.strict && !STRICT.has(call.nr)) { this.exitProcess(p, SIG.KILL); throw new Exit(SIG.KILL); }
    if (!t.filters) return null;
    const said = verdict(t.filters, call.nr, call.args, call.next), action = (said & 0xffff0000) >>> 0, word = said & 0xffff;
    switch (action) {
      case RET.ALLOW: case RET.LOG: return null;
      case RET.ERRNO: return BigInt(-Math.min(word, 4095));
      // (No tracer is attached, and nothing listens: as Linux answers a filter that asks for either.)
      case RET.TRACE: case RET.USER_NOTIF: return BigInt(-E.NOSYS);
      case RET.TRAP: {
        // SIGSYS to this thread, saying which call from where; the call is as if never made (its number is what it
        // comes back with). Blocked or not taken, it ends the process: a filter's signal is not put off.
        const a = actionOf(p, SIG.SYS);
        if (t.mask & bit(SIG.SYS) || a.handler <= 1n) { this.exitProcess(p, SIG.SYS); throw new Exit(SIG.SYS); }
        send(this, p, SIG.SYS, {code: 1 /* SYS_SECCOMP */, errno: word, addr: call.next, syscall: call.nr, arch: ARCH}, t);
        return BigInt(call.nr);
      }
      default:
        // Its thread ended (KILL_THREAD, where it has others), or its process: asked for, or its last thread, or an
        // action no kernel knows.
        if (action === RET.KILL_THREAD && p.tasks.size > 1) this.exitThread(t, SIG.SYS); else this.exitProcess(p, SIG.SYS);
        throw new Exit(SIG.SYS);
    }
  }

  /** Make `call` for `t`: its value, or WAITS. Exit, Exec and Redirect go through. */
  attempt(t: {proc: Process; tid: number}, call: Call): bigint | typeof WAITS {
    const p = t.proc;
    if (p.execTransition) execMayRun(p);
    if (t instanceof Task) p.task = t;
    p.call = call;
    if (t instanceof Task && (t.filters || t.strict) && !call.state.screened) {
      const held = this.screened(t, call);
      if (held !== null) return held;
      call.state.screened = true;
    }
    const handler = CALLS[call.nr];
    if (!handler) return BigInt(-E.NOSYS);
    const shares = p.maps.length > 0;
    if (shares) p.syncShared();
    // Whose call this is, while it is made: what /proc's "self" leads to. (A thread run here is `current` as it runs;
    // one in a Worker of its own is only while the kernel answers it.)
    const was = this.current;
    if (t instanceof Task) this.current = t;
    try {
      const r = handler.apply(p, call.args);
      if (!QUIET[call.nr]) this.dirty = true;
      const v = typeof r === 'bigint' ? r : BigInt(r);
      if (TRACE_SYSCALLS) console.error(`[${t.tid}]   = ${BigInt.asIntN(64, v)}`);
      return v;
    } catch (error) {
      if (error instanceof ReadLifetimeError) {
        try {
          // The callback may have replaced or renewed memory. Ordinary unmap
          // would settle unrelated/new bytes into the old file's canonical data.
          const invalid = p.maps; p.maps = [];
          for (const m of invalid) m.node.abandon(m);
          this.exitProcess(p, SIG.KILL);
        } catch (cleanup) { error.cleanupFailure = cleanup; p.state = 'zombie'; p.stopped = SIG.KILL; }
        throw error; // A failed cleanup must not disguise the original lost-identity failure.
      }
      if (error instanceof FsError) {
        this.dirty = true;
        if (TRACE_SYSCALLS) console.error(`[${t.tid}]   = -${error.errno}`);
        return BigInt(-error.errno);
      }
      if (error instanceof Wait) return WAITS;
      if (error instanceof Exit || error instanceof Exec || error instanceof Redirect) this.dirty = true;
      throw error;
    } finally {
      this.current = was;
      p.call = null;
      // What the call wrote into shared memory (a read into it, a futex word) is seen by the others.
      if (shares && p.state === 'live' && !p.execTransition) p.syncShared();
    }
  }

  /**
   * `call` of `t` is done with `v`: it goes on after the call, through a
   * handler for a signal it can take now, or not at all (it ended, or its
   * process is stopped). `now`: it is the thread running (enter).
   */
  resumeWith(t: Task, call: Call, v: bigint, now: boolean): void {
    t.call = null;
    this.blocked.delete(t);
    t.redirected = false;
    t.setReg(0, v);
    t.resumeAt = call.next;
    if (deliverable(t)) take(this, t, t.context());
    if (t.dead) return;
    if (t.proc.stopped) { t.state = 'stopped'; return; }
    if (!now) this.go(t);
  }

  /** A thread whose call is done goes on (here: it runs in turn). */
  go(t: Task): void { if (this.current === t) t.state = 'running'; else this.ready(t); }
  /** A thread of `p` running guest code is wanted (a signal, a stop): here none runs while the kernel does. */
  lookIn(_p: Process): void {}

  addTimer(at: number, fire: () => void): Timer { const timer = {at, fire}; this.timers.add(timer); this.dirty = true; return timer; }
  removeTimer(timer: Timer): void { this.timers.delete(timer); }

  /** Make the waiting calls again while something changed; the ones done go on. */
  retry(): void {
    if (this.timers.size) {
      const now = steady();
      for (const timer of [...this.timers]) if (timer.at <= now) { this.timers.delete(timer); timer.fire(); }
    }
    for (let pass = 0; pass < 64; pass++) {
      // None waits: nothing to make again (what changed is seen by the next call that would wait for it).
      if (!this.blocked.size) { this.dirty = false; return; }
      if (!this.dirty && !this.timedOut()) return;
      this.dirty = false;
      for (const t of [...this.blocked]) {
        if (!t.call || t.dead || t.proc.stopped || !this.blocked.has(t)) continue;
        const call = t.call;
        let v: bigint | typeof WAITS;
        try { v = this.attempt(t, call); } catch (e) {
          if (e instanceof Exit) continue;
          if (e instanceof Redirect || e instanceof Exec) { t.call = null; this.blocked.delete(t); this.go(t); continue; }
          throw e;
        }
        if (v === WAITS) continue;
        this.resumeWith(t, call, v, false);
      }
    }
  }

  /** Whether a waiting call's time is up. */
  timedOut(): boolean {
    let now: number | undefined;
    for (const t of this.blocked) {
      const d = t.call?.state.deadline;
      if (d !== undefined && d <= (now ??= steady())) return true;
    }
    return false;
  }

  /** The soonest a waiting call times out (steady() ms), if any does. */
  deadline(): number | undefined {
    let until: number | undefined;
    for (const timer of this.timers) if (until === undefined || timer.at < until) until = timer.at;
    for (const t of this.blocked) {
      const d = t.call?.state.deadline;
      if (d !== undefined && !t.proc.stopped && (until === undefined || d < until)) until = d;
    }
    return until;
  }

  /**
   * A signal `t` can take came while it waits in a call. One with a handler
   * interrupts the call: what it moved already is its value, or it is made
   * again after the handler (SA_RESTART, for a call Linux restarts), or it
   * says EINTR; then the thread goes on in the handler.
   */
  interruptCall(t: Task): void {
    const call = t.call;
    if (!call || t.dead || t.proc.stopped) return;
    const sig = this.peek(t);
    if (!sig) return;
    const a = actionOf(t.proc, sig);
    if (a.handler <= 1n) return; // ignored, or its default (which send() did already if it ends or stops)
    const s = call.state;
    s.cancel?.();
    t.call = null;
    this.blocked.delete(t);
    const ctx = t.context();
    if (s.done && s.done > 0) { ctx.regs[0] = BigInt(s.done); ctx.rip = call.next; }
    else if (a.flags & SA.RESTART && RESTARTS.has(call.nr) && !s.timed) { ctx.regs[0] = BigInt(call.nr); ctx.rip = call.next - 2n; }
    else { ctx.regs[0] = BigInt(-E.INTR); ctx.rip = call.next; s.interrupted?.(); }
    t.setContext(ctx.regs, ctx.rip);
    t.redirected = false;
    take(this, t, t.context());
    if (t.dead) return;
    if (t.proc.stopped) { t.state = 'stopped'; return; }
    this.go(t);
  }

  /** The signal `t` would take next, without taking it. */
  peek(t: Thread): number {
    const m = (t.pending.mask | t.proc.pending.mask) & ~t.mask;
    for (let sig = 1; sig <= 64; sig++) if (m & bit(sig)) return sig;
    return 0;
  }

  // ---- processes coming and going ----

  /** The live processes of group `pgid`. */
  group(pgid: number): Process[] { return this.live().filter((p) => p.pgid === pgid); }

  /** Whether group `pgid` is there in session `sid`: as on Linux, a member that ended and is not yet waited for keeps it
   * (the first of a pipeline done before the last joins its group and is put in front). */
  hasGroup(pgid: number, sid: number): boolean { return [...this.procs.values()].some((p) => p.pgid === pgid && p.sid === sid); }

  /** One thread ends: its tid is cleared and woken for (CLONE_CHILD_CLEARTID), its robust futexes marked; the last one ends its process. */
  exitThread(t: Task, status: number): void {
    if (t.dead) return;
    const p = t.proc;
    this.endTask(t);
    p.tasks.delete(t);
    if (!p.tasks.size) { this.exitProcess(p, status); return; }
    // Its instance stays with the memory its process goes on with, for the process's next thread (Task.load, goesOn):
    // a thread made one at a time (a pool's worker, a spawn's child) is not instantiated each time.
    const m = p.memory;
    if (m && t.instance && t.slot) {
      m.pooled = [{image: t.image, instance: t.instance, slot: t.slot, attached: t.attached}, ...(m.pooled ?? []).filter((x) => x.image !== t.image)]
        .slice(0, KEEP_INSTANCES);
    }
  }

  endTask(t: Task): void {
    if (t.dead) return;
    t.dead = true;
    t.state = 'dead';
    // Its time on the processor is its process's now (getrusage, times, wait4 count it there).
    t.proc.cpu.user += t.cpu.user;
    t.proc.cpu.sys += t.cpu.sys;
    t.cpu = {user: 0, sys: 0};
    t.call?.state.cancel?.();
    t.call = null;
    this.blocked.delete(t);
    const at = this.runq.indexOf(t);
    if (at >= 0) this.runq.splice(at, 1);
    this.tasks.delete(t.tid);
    t.fs.drop();
    if (t.x87) { this.x87.free(t.x87); t.x87 = 0; }
    const p = t.proc;
    if (p.memory) {
      try { robustExit(this, t); } catch { /* a list it broke is its own */ }
      if (t.clearTid) {
        try { p.view.setInt32(t.clearTid, 0, true); } catch { /* gone */ }
        this.futexWake(p.futexKey(t.clearTid), 1, -1);
      }
    }
    t.end();
    this.dirty = true;
  }

  /**
   * `p`'s one thread's instance stays with the memory it leaves (it ends, or execs another program): a fork that takes
   * the memory for the same program runs on it again, instead of instantiating it and every module made for it since
   * (Task.load), and so does the next vfork child of a parent `p` shared it with (a spawn's). A shell's forks are of
   * the shell, each exec'ing a command.
   */
  leaveInstance(p: Process): void {
    const only = p.tasks.size === 1 ? [...p.tasks][0] : null, m = p.memory;
    if (!m || !only?.instance || !only.slot) return;
    const kept = {image: only.image, instance: only.instance, slot: only.slot, attached: only.attached};
    m.pooled = [kept, ...(m.pooled ?? []).filter((x) => x.image !== only.image)].slice(0, KEEP_INSTANCES);
  }

  /** A process ends with wait status `status`: its threads, its files; its parent is told, and its children go to init. */
  exitProcess(p: Process, status: number): void {
    // A failed irreversible exec is not an ordinary second retirement.
    // Backends may separately request worker stop; this still owns evidence.
    execMayRun(p);
    if (p.state !== 'live') return;
    // Ended by a signal in front of the terminal: the shell gets it back as it had it (sys-file.ts handed).
    if (status & 0x7f && p.pgid === this.tty.fg) this.tty.cut = p.pgid;
    p.state = 'zombie';
    p.exitStatus = status;
    p.stopped = 0;
    if (p.alarm) { this.removeTimer(p.alarm.timer); p.alarm = null; }
    // (What it wrote is known from its threads: before they go.)
    const written = p.memory ? p.written() : null;
    this.leaveInstance(p);
    for (const t of [...p.tasks]) this.endTask(t);
    p.tasks.clear();
    // Only enter this continuation after every existing task end succeeded.
    // A failed backend stop is not permission to recycle its memory.
    const retiring = new Retirement();
    retiring.attempt(() => p.retireShared());
    const memory = p.memory;
    p.memory = null; // Reentrant exit cannot release this owner twice.
    retiring.attempt(() => { if (memory) this.letGo(memory, written); });
    // Its table of descriptors is let go of: closed, unless another process holds it too (clone's CLONE_FILES).
    retiring.attempt(() => p.fds.letGo());
    retiring.attempt(() => { if (!p.taken) p.fs0.drop(); });
    p.cgroup.procs.delete(p);
    retiring.attempt(() => this.releaseVfork(p));
    this.dirty = true;
    // The first process of a pid namespace of its own is gone: everything in it goes with it, and nothing more is made there.
    const space = p.pidns;
    if (space.parent && space.init === p.pid) {
      space.ended = true;
      const inside = (q: Process): boolean => { for (let ns: PidNs | null = q.pidns; ns; ns = ns.parent) if (ns === space) return true; return false; };
      for (const q of [...this.procs.values()]) if (q !== p && inside(q)) {
        try { this.exitProcess(q, SIG.KILL); } catch (error) { retiring.abort(error); }
        // (no one in it is left to wait for them)
        this.procs.get(q.ppid)?.children.delete(q);
        this.procs.delete(q.pid);
      }
    }
    if (p.pid === 1 || p.pid === this.initPid) {
      // Init is gone: everything else goes with it (a PID namespace's end).
      for (const q of this.live()) {
        try { this.exitProcess(q, SIG.KILL); } catch (error) { retiring.abort(error); }
      }
      this.status = status;
      this.procs.clear();
      this.runq.length = 0;
      this.blocked.clear();
      retiring.attempt(() => this.ended());
      if (!retiring.failed) retiring.attempt(() => this.stopped?.());
      retiring.finish();
      return;
    }
    // Its children go to the nearest process above it that asked for orphans and is alive (prctl
    // PR_SET_CHILD_SUBREAPER), else to init, as Linux hands them on (find_new_reaper): the one that asked waits for
    // them. (Before: always to pid 1, whoever had asked.)
    const reaper = this.reaperOf(p);
    for (const c of p.children) {
      c.ppid = reaper?.pid ?? 1;
      if (reaper) {
        reaper.children.add(c);
        // One already ended, whose parent never waited for it: its new parent is told, as its parent was (Linux's
        // reparent_leader), or it goes at once where that one keeps no zombies.
        if (c.state === 'zombie') {
          const a = actionOf(reaper, SIG.CHLD);
          if (a.handler === 1n || a.flags & SA.NOCLDWAIT) { reaper.children.delete(c); this.procs.delete(c.pid); }
          else {
            const how = (c.exitStatus ?? 0) & 0x7f;
            retiring.attempt(() => send(this, reaper, SIG.CHLD, {signo: SIG.CHLD, code: how ? CLD.KILLED : CLD.EXITED, pid: c.pid, uid: 0, status: how ? how : (c.exitStatus ?? 0) >> 8}));
          }
        }
      } else if (c.state === 'zombie') this.procs.delete(c.pid);
      // Its parent gone: the signal it asked for then (prctl PR_SET_PDEATHSIG).
      if (c.state === 'live' && c.deathSignal) retiring.attempt(() => send(this, c, c.deathSignal!, {code: SI.USER, pid: p.pid, uid: 0}));
    }
    p.children.clear();
    const parent = this.procs.get(p.ppid);
    const signalled = status & 0x7f;
    const info = {signo: SIG.CHLD, code: signalled ? CLD.KILLED : CLD.EXITED, pid: p.pid, uid: 0, status: signalled ? signalled : status >> 8};
    if (!parent || parent.state !== 'live') { this.procs.delete(p.pid); retiring.finish(); return; }
    const a = actionOf(parent, SIG.CHLD);
    // A parent that ignores SIGCHLD (or says SA_NOCLDWAIT) leaves no zombie (POSIX).
    if (a.handler === 1n || a.flags & SA.NOCLDWAIT) { parent.children.delete(p); this.procs.delete(p.pid); }
    if (p.exitSignal) retiring.attempt(() => send(this, parent, p.exitSignal, info));
    retiring.finish();
  }

  /** The pid namespace's init: pid 1, or the one a backend names (initPid). */
  initOf(): Process | undefined {
    return this.procs.get(1) ?? (this.initPid === undefined ? undefined : this.procs.get(this.initPid));
  }

  /** Who `p`'s children go to when it ends: the nearest live process above it that asked for orphans, else init; none alive, no one. */
  reaperOf(p: Process): Process | null {
    // (one that asked for orphans is asked within the pid namespace `p` is in, and no further up)
    const seen = new Set<Process>([p]);
    for (let up = this.procs.get(p.ppid); up && !seen.has(up) && up.pidns === p.pidns; up = this.procs.get(up.ppid)) {
      if (up.state === 'live' && up.subreaper) return up;
      seen.add(up);
    }
    const init = p.pidns.parent ? this.procs.get(p.pidns.init) : this.initOf();
    return init && init !== p && init.state === 'live' ? init : null;
  }

  /** A child made with CLONE_VFORK exec'd or ended: its parent goes on. */
  releaseVfork(p: Process): void {
    if (p.vfork) { p.vfork.released = true; p.vfork = null; this.dirty = true; }
  }

  stopProcess(p: Process, sig: number): void {
    if (p.state !== 'live' || p.stopped) return;
    if (p.pgid === this.tty.fg) this.tty.cut = p.pgid;
    p.stopped = sig;
    p.report = {kind: 'stopped', sig, seen: false};
    for (const t of p.tasks) {
      const at = this.runq.indexOf(t);
      if (at >= 0) { this.runq.splice(at, 1); t.state = 'stopped'; }
      t.stop?.();
    }
    this.dirty = true;
    const parent = this.procs.get(p.ppid);
    if (parent?.state === 'live' && !(actionOf(parent, SIG.CHLD).flags & SA.NOCLDSTOP)) send(this, parent, SIG.CHLD, {code: CLD.STOPPED, pid: p.pid, uid: 0, status: sig});
  }

  continueProcess(p: Process): void {
    if (!p.stopped) return;
    p.stopped = 0;
    p.report = {kind: 'continued', seen: false};
    for (const t of p.tasks) {
      if (t.dead || t.state !== 'stopped') continue;
      if (t.call) this.block(t); else this.go(t);
      t.cont?.();
    }
    this.dirty = true;
    const parent = this.procs.get(p.ppid);
    if (parent?.state === 'live' && !(actionOf(parent, SIG.CHLD).flags & SA.NOCLDSTOP)) send(this, parent, SIG.CHLD, {code: CLD.CONTINUED, pid: p.pid, uid: 0, status: SIG.CONT});
  }

  // ---- futexes ----

  // A futex is keyed by where its word is: [space, at], a memory and an address in it, or a file and an offset
  // (a shared mapping, which other processes can wait on too: Process.futexKey).

  futexQueue([space, at]: FutexKey): Set<FutexWaiter> {
    let m = this.futexes.get(space);
    if (!m) this.futexes.set(space, (m = new Map()));
    let q = m.get(at);
    if (!q) m.set(at, (q = new Set()));
    return q;
  }

  /** Wake up to `n` waiters on `key` whose bitset meets `bitset`; how many. */
  futexWake([space, at]: FutexKey, n: number, bitset: number): number {
    const q = this.futexes.get(space)?.get(at);
    if (!q) return 0;
    let woken = 0;
    for (const w of q) {
      if (woken >= n) break;
      if (!(w.bitset & bitset)) continue;
      q.delete(w);
      w.woken = true;
      woken++;
    }
    if (!q.size) this.futexes.get(space)?.delete(at);
    if (woken) this.dirty = true;
    return woken;
  }

  /** Move up to `n` waiters from one key to another; how many. */
  futexRequeue([space, at]: FutexKey, to: FutexKey, n: number): number {
    const q = this.futexes.get(space)?.get(at);
    if (!q) return 0;
    let moved = 0;
    for (const w of q) {
      if (moved >= n) break;
      q.delete(w);
      w.key = to;
      this.futexQueue(to).add(w);
      moved++;
    }
    if (!q.size) this.futexes.get(space)?.delete(at);
    return moved;
  }

  // ---- the console ----

  /**
   * Ctrl-C: SIGINT to the group in front on the console (the shell's own,
   * unless a shell with job control put a job there). An interactive shell
   * survives it; what it runs does not, as at a terminal. False when there
   * was nobody to send it to.
   */
  interrupt(sig: number = SIG.INT): boolean {
    const group = this.group(this.tty.fg);
    if (!group.length) return false;
    for (const p of group) send(this, p, sig, {code: SI.KERNEL});
    return true;
  }

  /**
   * Follow one Worker-owned terminal session. Its trusted launcher is the
   * kernel's initial process; pin its first published direct child, then
   * admit only that child's completed exec. Never infer ownership from names,
   * numeric IDs, waiting state, or a later reparented descendant.
   */
  watchRootConsoleGuest(): {state(): 'inactive' | 'live' | 'closed'; close(): void} {
    if (this.#rootConsoleGuest) throw new Error('Root console already observed');
    const lease: RootConsoleGuest = {closed: false, child: null};
    this.#rootConsoleGuest = lease;
    return {
      state: () => {
        if (lease.closed) return 'closed';
        if (!lease.child) return 'inactive';
        const guest = lease.child.process.deref(), launcher = lease.child.launcher.deref();
        if (guest?.state !== 'live' || this.procs.get(guest.pid) !== guest ||
            launcher?.state !== 'live' || this.initOf() !== launcher ||
            guest.ppid !== launcher.pid || !launcher.children.has(guest)) return 'closed';
        return lease.child.executed ? 'live' : 'inactive';
      },
      close() { lease.closed = true; lease.child = null; },
    };
  }

  /** Called when a process has been published, before it can first run. */
  noteRootConsoleChild(launcher: Process, child: Process): void {
    const lease = this.#rootConsoleGuest;
    if (!lease || lease.closed || lease.child || this.initOf() !== launcher ||
        child.ppid !== launcher.pid) return;
    lease.child = {launcher: new WeakRef(launcher), process: new WeakRef(child), executed: false};
  }

  /** Called only after Process.execve has committed successfully. */
  noteRootConsoleExec(p: Process): void {
    const child = this.#rootConsoleGuest?.child;
    if (child?.process.deref() === p) child.executed = true;
  }

  /**
   * Host window geometry for the existing root terminal, not a devpts peer.
   * A host with a serialized display stream can publish the applied size
   * before notifying the guest; a host detached during publication can
   * suppress the notification.
   */
  resizeConsole(cols: number, rows: number, beforeNotify?: () => boolean): boolean {
    const console = this.console;
    if (!validConsoleWindow(cols, rows) || !console.interactive || !console.screen) return false;
    if ((console.cols ?? 80) === cols && (console.rows ?? 24) === rows) return false;
    console.cols = cols;
    console.rows = rows;
    if (!beforeNotify || beforeNotify()) this.interrupt(SIG.WINCH);
    // No Worker input or output epoch is changed by this terminal signal.
    return true;
  }

  /** Everything ends now, as when init is killed (a PID namespace's end). */
  halt(): void {
    const init = [...this.procs.values()].find((p) => p.pid === 1 || p.pid === this.initPid);
    if (init) this.exitProcess(init, SIG.KILL);
    // An unpublished initial candidate may still own a partial exec.
    const pending = this.failedExecs?.values().next();
    if (pending && !pending.done) throw pending.value;
    this.ended();
  }

  /** Start and run to the end; for hosts whose input is all known up front (a sleep is waited out here). Its wait status
   * (remote.ts's, once it is served: a promise of it). */
  spawn(path: string, argv: string[], env: string[], cwd = '/'): number | Promise<number> {
    this.start(path, argv, env, cwd);
    let r = this.pump();
    while (r.waiting && r.until !== undefined) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, r.until - steady()));
      r = this.pump();
    }
    if (r.waiting) throw new Error(`process waits for input that will never come (${[...this.blocked].map((t) => `${t.tid}:${t.call?.nr}`).join(' ')})`);
    return r.status ?? 0;
  }
}

/** On a thread's exit, each robust futex it holds says its owner died, and one waiter is woken (Linux's exit_robust_list). */
function robustExit(kernel: Kernel, t: Task): void {
  if (!t.robust) return;
  const p = t.proc, v = p.view;
  const head = t.robust;
  const offset = Number(v.getBigInt64(head + 8, true));
  const pending = Number(v.getBigUint64(head + 16, true) & ~1n);
  const mark = (entry: number): void => {
    const at = entry + offset;
    const word = v.getUint32(at, true);
    if ((word & 0x3fffffff) !== t.tid) return;
    v.setUint32(at, (word & 0x80000000) | 0x40000000, true); // FUTEX_OWNER_DIED, waiters kept
    if (word & 0x80000000) kernel.futexWake(p.futexKey(at), 1, -1);
  };
  let entry = Number(v.getBigUint64(head, true) & ~1n);
  for (let n = 0; entry !== head && entry && n < 2048; n++) {
    const next = Number(v.getBigUint64(entry, true) & ~1n);
    if (entry !== pending) mark(entry);
    entry = next;
  }
  if (pending) mark(pending);
}

/** The parts of [from, to) outside the ranges `keep` ([[start, end]], any order). */
function gaps(from: number, to: number, keep: Range[]): Range[] {
  const out: Range[] = [];
  let at = from;
  for (const [a, b] of [...keep].sort((x, y) => x[0] - y[0])) {
    if (b <= at || a >= to) continue;
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < to) out.push([at, to]);
  return out;
}
/** `ranges` ([[start, end]]) sorted, and those that meet made one. */
function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [a, b] of [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
/** The parts of (merged) `ranges` within [from, to), and those outside it. */
const clip = (ranges: Range[] | undefined, from: number, to: number): Range[] => (ranges ?? []).map(([a, b]): Range => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
const cut = (ranges: Range[] | undefined, from: number, to: number): Range[] => (ranges ?? []).flatMap(([a, b]): Range[] => [[a, Math.min(b, from)], [Math.max(a, to), b]]).filter(([a, b]) => b > a);
/** What a process wrote in `m` and nothing zeroed since, up to `pages`, zeroed but for `keep`; the rest goes as it is mapped (cover). */
function clean(m: Mem, pages: number, keep: Range[]): void {
  const end = pages * WASM_PAGE;
  for (const [a, b] of clip(m.written, 0, end)) PROFILE.zeroed += zeroExcept(m, a, b, keep);
  m.written = cut(m.written, 0, end);
}
/** Zero [from, to) of `memory` but for the ranges `keep`; how many bytes it zeroed. */
function zeroExcept(memory: Mem, from: number, to: number, keep: Range[]): number {
  let n = 0;
  for (const [a, b] of gaps(from, to, keep)) { zero(memory, a, b); n += b - a; }
  return n;
}
/** Whether data segment `s` ({offset, bytes}) lies within one of `ranges`. */

/** Each process mapping `node`: whether it shares memory with another, where its threads see it (SHARES). */
function markShares(node: File): void {
  // (Every mapping of a file is a process's: Process.mapShared.)
  for (const m of (node.maps ?? []) as Set<Shared>) m.proc.view.setInt32(SHARES, m.proc.maps.some((x) => (x.node.maps?.size ?? 0) > 1) ? 1 : 0, true);
}

/** A shared file mapping a process made (Process.mapShared): its process and file, and where. */
type Shared = Mapping & {proc: Process; node: File};

type PreparationRetirement = Record<'backend' | 'x87' | 'fs' | 'fds' | 'memory' | 'cgroup', 'not-attempted' | 'returned' | 'uncertain'>;

export class Process implements Proc {
  /** Failure evidence only, not permission to retry release: some resources
   * may already have retired before a callback failed. No record on success. */
  declare failedPreparation?: {task: Task; memory: Mem; x87Owner: X87 | null; x87Handle: number; retirement: PreparationRetirement; error: unknown};
  declare readonly kernel: Kernel;
  declare pid: number;
  declare ppid: number;
  declare pgid: number;
  declare sid: number;
  declare fds: FdTable;
  /**
   * Where it is in the tree, its namespaces and who it is are each thread's own (a thread may leave what the others
   * share: unshare, setns, set*id), and a process's are those of the thread that calls. What it is made with, until
   * its first thread has them (`fs0`, `ns0`, `alone`; `taken`: that thread has).
   */
  declare fs0: Fs;
  declare ns0: Spaces;
  declare alone?: Cred;
  declare taken: boolean;
  declare pidns: PidNs;
  declare cgroup: Cgroup;
  declare nice: number;
  declare limits: [bigint, bigint][];
  declare comm: string | null;
  declare noNewPrivs: boolean;
  declare dumpable: boolean;
  declare subreaper?: boolean;
  declare deathSignal?: number;
  declare readonly children: Set<Process>;
  declare readonly tasks: Set<Task>;
  declare readonly actions: Map<number, SigAction>;
  declare readonly pending: Pending;
  declare state: 'live' | 'zombie';
  declare started: number;
  declare maps: Shared[];
  declare exe: string;
  declare exeAt?: {mnt: Mount; node: File; dir: Dir; name: string};
  declare env: string[];
  declare argv: string[];
  declare exitStatus: number | undefined;
  declare exitSignal: number;
  declare stopped: number;
  /** A synchronous irreversible replacement or retained uncertainty. */
  execTransition?: true | ExecCommitError;
  get execFailure(): ExecCommitError | undefined { return this.execTransition === true ? undefined : this.execTransition; }
  declare report: {kind: 'stopped' | 'continued'; sig?: number; seen: boolean} | null;
  declare vfork: {released: boolean} | null;
  declare alarm?: {at: number; interval: number; timer: Timer} | null;
  declare cpu: Cpu;
  declare waited: Cpu;
  declare task: Task;
  declare call: Call | null;
  private memory0: Mem | null = null;
  private image0!: Image;
  private readGeneration: object = {};
  get memory(): Mem | null { return this.memory0; }
  set memory(value: Mem | null) { this.readGeneration = {}; this.memory0 = value; }
  get image(): Image { return this.image0; }
  set image(value: Image) { this.readGeneration = {}; this.image0 = value; }
  /** Capture identity, not a guest view. Shared byte stores do not retire it. */
  readIdentity(): () => void {
    const generation = this.readGeneration, memory = this.memory, buffer = memory?.buffer;
    const epoch = memoryEpoch(memory), state = this.state;
    return () => {
      if (this.readGeneration !== generation || this.memory !== memory || memory?.buffer !== buffer
        || memoryEpoch(memory) !== epoch || this.state !== state) throw new ReadLifetimeError();
    };
  }
  declare stackLow: number;
  declare stackTop: number;
  declare mapBase: number;
  declare mapEnd: number;
  declare free: {start: number; length: number}[];
  declare fixed: {start: number; length: number}[];
  declare bytesBuffer: ArrayBufferLike | undefined;
  declare bytesOf: Uint8Array;
  declare viewOf: DataView;
  constructor(kernel: Kernel, parent: Process | null, files = false, fs = false, ns: Spaces | null = null, cgroup: Cgroup | null = null, publishMembership = true) {
    this.kernel = kernel;
    this.pid = 0;
    this.ppid = parent?.pid ?? 0;
    this.pgid = parent?.pgid ?? 0;
    this.sid = parent?.sid ?? 0;
    this.ns0 = ns ?? parent?.ns ?? kernel.spaces;
    this.taken = false;
    // The pid namespace it is made in is the one its parent's children are made in: its own, from here on.
    this.pidns = this.ns0.children;
    const group = cgroup ?? parent?.cgroup ?? kernel.cgroups.root;
    // How nice it is (-20 to 19), as getpriority says and a child takes: no scheduling here weighs it.
    this.nice = parent?.nice ?? 0;
    this.limits = (parent?.limits ?? RLIMITS).map(([soft, hard]): [bigint, bigint] => [soft, hard]); // getrlimit's, kept across exec
    this.comm = parent?.comm ?? null; // its name, when prctl(PR_SET_NAME) gave it one (else its program's)
    this.dumpable = parent?.dumpable ?? true;
    this.noNewPrivs = parent?.noNewPrivs ?? false; // PR_SET_NO_NEW_PRIVS: once said, for it and all it starts
    this.children = new Set(); // Process
    this.tasks = new Set(); // its threads
    this.actions = new Map(parent?.actions ?? []); // signal -> {handler, flags, restorer, mask}
    this.pending = new Pending();
    this.state = 'live'; // or 'zombie', once it ended and until it is waited for
    this.started = steady(); // for /proc/PID/stat's start time
    this.cpu = {user: 0, sys: 0}; // its threads' time on the processor, once each ended (ms)
    this.waited = {user: 0, sys: 0}; // its children's that it waited for, theirs and what they waited for
    this.maps = []; // its MAP_SHARED file mappings, {proc, node, start, length, off} (fs.ts File.map)
    this.exe = parent?.exe ?? ''; // what it runs, and with what environment (/proc/PID/exe, environ)
    this.exeAt = parent?.exeAt;
    this.env = parent?.env ?? [];
    this.exitStatus = undefined;
    this.exitSignal = SIG.CHLD;
    this.stopped = 0; // the signal that stopped it
    this.report = null; // a stop or continue not yet waited for
    this.vfork = null; // {released}: its parent waits on this (CLONE_VFORK)
    this.call = null; // the call its thread (`task`) makes now: {nr, args, next, state}
    this.memory = null;
    // Prepare metadata before acquiring external owners; publish only a complete process.
    // Its descriptors: the parent's own table where it is to be shared (clone's CLONE_FILES), else a copy of it. Which
    // is known before either is taken (before: a copy always, thrown away for the shared one with every description
    // in it still held).
    this.fds = parent ? (files ? parent.fds.share() : parent.fds.fork()) : new FdTable();
    // Where it is in the tree: its parent's own where that is to be shared (CLONE_FS), else one like it.
    const acquiredFds = this.fds;
    try { this.fs0 = parent ? (fs ? (parent.fs.users++, parent.fs) : parent.fs.copy()) : new Fs(kernel.root); }
    catch (error) {
      // Fs acquisition never completed: return exactly this new FD-table owner,
      // not the parent's current table after a reentrant embedding callback.
      // No process, PID or cgroup has been published at this boundary.
      try { acquiredFds.letGo(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'process Fs preparation and FD cleanup failed'); }
      throw error;
    }
    if (publishMembership) enter(this, group); else this.cgroup = group;
  }

  /** Make one system call as this process's thread (or as a thread of it that has none yet), as the dispatcher does. */
  /** The thread whose it is, where one of its is asked for: the one that calls, or its first. */
  get own(): Task | undefined {
    if (this.task) return this.task;
    for (const t of this.tasks) return t;
    return undefined;
  }
  get fs(): Fs { return this.own?.fs ?? this.fs0; }
  set fs(fs: Fs) { const t = this.own; if (t) t.fs = fs; else this.fs0 = fs; }
  get ns(): Spaces { return this.own?.ns ?? this.ns0; }
  set ns(ns: Spaces) { const t = this.own; if (t) t.ns = ns; else this.ns0 = ns; }
  get root(): Place { return this.fs.root; }
  /** Whether it may change its network (CAP_NET_ADMIN over the user namespace that owns its network namespace). */
  mayAdministerNet(): boolean { return capable(this.cred, CAP.NET_ADMIN, this.ns.net.owner); }
  get umask(): number { return this.fs.umask; }
  set umask(mask: number) { this.fs.umask = mask; }
  /** Who the thread that calls is (a process with no thread yet: root). */
  get cred(): Cred { return this.own?.cred ?? this.alone ?? ROOT; }
  set cred(c: Cred) { const t = this.own; if (t) t.cred = c; else this.alone = c; }

  syscall(nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next = 0n): bigint {
    const t = [...this.tasks][0] ?? {proc: this, tid: this.pid};
    const v = this.kernel.attempt(t, {nr: Number(nr), args: [a, b, c, d, e, f], next, state: {}});
    if (v === WAITS) throw new Wait();
    return v;
  }

  // ---- memory ----

  /**
   * Its memory as bytes: the one view, made again only when the memory grew (another buffer). What a call reaches
   * for outside it is the call's EFAULT (guest.ts).
   */
  get bytes(): Uint8Array {
    const b = this.memory?.buffer ?? EMPTY;
    if (b !== this.bytesBuffer) { this.bytesBuffer = b; this.bytesOf = new GuestBytes(b); this.viewOf = new GuestView(b); }
    return this.bytesOf;
  }
  /** Its memory as a DataView: the one, as `bytes` (a call reads and writes through it, and made anew it cost each). */
  get view(): DataView { void this.bytes; return this.viewOf; }

  /** The string at `address`, as far as its NUL: one that begins outside the memory, or runs off its end with none, is EFAULT. */
  cstring(address: number): string {
    const b = this.bytes, end = address >= 0 && address < b.length ? b.indexOf(0, address) : -1;
    if (end < 0) throw new FsError(E.FAULT);
    return utf8(b.subarray(address, end));
  }

  /** NULL-terminated array of string pointers. */
  strings(address: number): string[] {
    const out: string[] = [];
    if (!address) return out;
    for (let at = address; ; at += 8) {
      const p = Number(this.view.getBigUint64(at, true));
      if (!p) return out;
      out.push(this.cstring(p));
    }
  }

  reserve(length: number): number {
    retireMemoryView(this.memory);
    length = Math.ceil(length / PAGE) * PAGE;
    const k = this.free.findIndex((r) => r.length >= length);
    if (k >= 0) {
      const r = this.free[k];
      this.free.splice(k, 1);
      if (r.length > length) this.free.push({start: r.start + length, length: r.length - length});
      if (this.memory) zero(this.memory, r.start, r.start + length);
      return r.start;
    }
    const start = this.mapEnd;
    this.cover(start + length);
    return start;
  }

  /** Memory up to `end` is mapped (mapEnd moves past it): grown as it must be. */
  cover(end: number): void {
    retireMemoryView(this.memory);
    const m = this.memory;
    if (!m) return;
    const need = end - m.buffer.byteLength;
    // Grown in steps of an eighth of what it has (up to 16 MiB): a grow costs a millisecond or more however small,
    // and a program that maps a page at a time would pay it each time; past that, a larger memory than is mapped
    // is more to copy for a fork and to zero for the next process that takes it.
    if (need > 0) {
      const have = m.buffer.byteLength / WASM_PAGE;
      m.grow(Math.min(65536 - have, Math.max(Math.ceil(need / WASM_PAGE), Math.min(have >> 3, 256))));
    }
    // A memory another process used: what it left past the mapped part goes as that part grows over it.
    if (m.written.length && end > this.mapEnd) {
      for (const [a, b] of clip(m.written, this.mapEnd, end)) { zero(m, a, b); PROFILE.zeroed += b - a; }
      m.written = cut(m.written, this.mapEnd, end);
    }
    this.mapEnd = Math.max(this.mapEnd, end);
  }

  release(start: number, length: number): void {
    retireMemoryView(this.memory);
    if (start >= this.mapBase) this.free.push({start, length: Math.ceil(length / PAGE) * PAGE});
  }

  /** Bytes [start, start + length) of memory are `node`'s from `off` on, both ways (MAP_SHARED). */
  mapShared(node: File, start: number, length: number, off: number): void {
    retireMemoryView(this.memory);
    const m: Shared = {proc: this, node, start, length, off};
    node.map(m);
    this.maps.push(m);
    markShares(node);
  }
  /**
   * What this process wrote through its shared mappings goes to their files and to the other processes mapping them
   * (all its mappings; else those another mapping shares): at each system call and time slice's end, so a process
   * sees another's writes once that one has made a call (futex, a pipe, its exit) or had its turn.
   */
  syncShared(all = false): void {
    for (const m of this.maps) if (all || (m.node.maps?.size ?? 0) > 1) m.node.settle(m.off, m.off + m.length, m);
  }
  /** Where a futex word is, as Linux keys it: a file and offset in a shared mapping, else this memory and address. */
  futexKey(address: number): FutexKey {
    const m = this.maps.find((x) => address >= x.start && address < x.start + x.length);
    return m ? [m.node, m.off + address - m.start] : [this.memory ?? NO_MEMORY, address];
  }
  /** The shared file mappings over any of [start, start + length). */
  sharedIn(start: number, length: number): Shared[] { return this.maps.filter((m) => m.start < start + length && start < m.start + m.length); }
  /** [start, start + length) is no longer mapped: what was written there through a mapping stays in its file. */
  unmapShared(start = 0, length = Infinity): void {
    retireMemoryView(this.memory);
    for (const m of this.sharedIn(start, length)) {
      m.node.unmap(m);
      this.maps.splice(this.maps.indexOf(m), 1);
      markShares(m.node);
      if (!this.maps.length && this.memory) this.view.setInt32(SHARES, 0, true);
      const end = start + length, mend = m.start + m.length;
      if (m.start < start) this.mapShared(m.node, m.start, start - m.start, m.off);
      if (end < mend) this.mapShared(m.node, end, mend - end, m.off + end - m.start);
    }
  }

  /** Permanent retirement of an address space (exit or exec). Failed writeback is reported, but its
   * observation is abandoned so it cannot later publish from recycled memory. */
  retireShared(): void {
    retireMemoryView(this.memory);
    const retiring = new Retirement(), maps = this.maps;
    this.maps = [];
    for (const m of maps) {
      retiring.attempt(() => m.node.unmap(m));
      retiring.attempt(() => m.node.abandon(m));
      retiring.attempt(() => markShares(m.node));
    }
    retiring.attempt(() => { if (!this.maps.length && this.memory && this.memory.users === 1) this.view.setInt32(SHARES, 0, true); });
    retiring.finish();
  }

  /**
   * A memory for this process of `pages` wasm pages (shared between threads where the backend runs them apart); `over`:
   * ranges ([[start, end]]) the caller writes whole before it is used, left as they are meanwhile.
   */
  newMemory(pages: number, image: Image | null = null, over: Range[] = [], took?: (memory: Mem) => void): Mem {
    // What a process wrote that is not zeroed yet (Kernel.letGo): none, in a new one.
    const m: Mem = this.kernel.takeMemory(pages, image, over, took)
      ?? Object.assign(new WebAssembly.Memory({initial: pages, maximum: 65536, ...(this.kernel.shared ? {shared: true} : {})}), {users: 0, written: [], keeps: false, imageOf: null});
    m.users = 1;
    m.deepest = undefined; // how deep its stack has been written (Process.written): its process's to say
    m.imageOf = image;
    return m;
  }

  // ---- images ----

  /** Retain the exact owners; a partial commit cannot resume or lend its tree. */
  retainExecFailure(phase: ExecPhase, cause: unknown, owners: ExecOwners<Task>): never {
    const failure = new ExecCommitError(this, phase, cause, owners);
    this.execTransition = failure;
    blockExecTree(this.kernel.vfs);
    (this.kernel.failedExecs ??= new Set()).add(failure);
    throw failure;
  }

  /** Replace the calling process's image through the same transaction as start(). */
  execve(path: string, argv: string[], env: string[]): void { replaceExec<Process, Image, Task>(this, {path, argv, env}); }

  // ---- fork ----

  /**
   * Copy what this process can be using into `child`: the image, the stack
   * from just under the stack pointer (the 128-byte red zone) to its top,
   * everything mapped, and fixed mappings placed elsewhere. The untouched
   * rest of the 8 MiB stack and the room below the image stay zero, as
   * they are in the parent.
   */
  /**
   * Where this process may have written ([[start, end]]): the kernel's low words, its image, what it mapped, and of
   * its stack what it used: down to the least rsp its threads had (translated code keeps it, sods' abi.rs G_LOW) or the
   * kernel wrote at (Memory.deepest), less STACK_SLACK for what goes below rsp with no write to it (pushes, the red
   * zone); all of the stack, and the guard under it, where that is not known. The memory keeps what was learnt, for
   * another process on it (a vfork child's depth is its parent's memory's).
   */
  written(): Range[] {
    const f: Partial<Facts> = this.image?.facts ?? {}, m = this.memory;
    let deepest = m?.deepest ?? -Infinity;
    for (const t of this.tasks) {
      const low = t.low?.();
      if (low === null || low === undefined) { deepest = -Infinity; break; }
      const at = Number(BigInt.asUintN(64, low));
      if (at >= this.stackTop) continue; // not moved, or a stack elsewhere (a thread's, mapped)
      deepest = at < this.stackLow ? -Infinity : Math.min(deepest, at); // below the stack: not known how far
    }
    if (m) m.deepest = deepest;
    const stack = deepest === -Infinity ? f.imageEnd ?? this.stackLow : Math.max(this.stackLow, deepest - STACK_SLACK);
    const out: Range[] = [[0, LOW_WORDS], [f.imageStart ?? 0, f.imageEnd ?? 0], [stack, this.stackTop], [this.mapBase, this.mapEnd]];
    for (const r of this.fixed) out.push([r.start, r.start + r.length]);
    return out;
  }

  copyLive(child: Process, live = this.copied()): void {
    const from = this.bytes, to = child.bytes, memory = child.memory;
    const span = ([a, b]: Range): void => { if (b > a) to.set(from.subarray(a, b), a); };
    // What no correct run changes, a memory that ran the same program has already.
    for (const r of gaps(...live.image, memory?.keeps ? keptImageRanges(this.image, !!memory.exact) : [])) span(r);
    for (const r of live.rest) span(r);
    if (memory) memory.deepest = live.low; // its stack is written from here up (Process.written), as its own calls go deeper
  }
  /**
   * What copyLive copies ([start, end]): `image`, and the `rest` (the stack from `low`, what is mapped (the memory past
   * it is grown ahead, and zero), fixed mappings placed elsewhere).
   */
  copied(): {image: Range; rest: Range[]; low: number} {
    const f = this.image.facts;
    const sp = Number(BigInt.asUintN(64, this.task.reg(4)));
    const low = sp > this.stackLow && sp <= this.stackTop ? Math.max(this.stackLow, (sp - 128) & ~15) : this.stackLow;
    const rest: Range[] = [[low, this.mapBase], [this.mapBase, Math.min(this.memory?.buffer.byteLength ?? 0, this.mapEnd)],
      ...this.fixed.map((r): Range => [r.start, Math.min(r.start + r.length, this.mapBase)])];
    return {image: [f.imageStart ?? 0, Math.min(f.imageEnd, this.stackLow)], rest, low};
  }

  /**
   * A new process from this one (fork, vfork, clone without CLONE_THREAD),
   * starting at `resume` with `stack` (0: the caller's) and rax 0. Its
   * memory is a copy, or this very memory with CLONE_VM. It is ready to run.
   */
  forkProcess(resume: bigint, {stack = 0n, vm = false, files = false, fs = false, ns = null, cred = null, cgroup = null, exitSignal = SIG.CHLD, tls = null, clearTid = 0, parent = false, prepareNamespaces}: ForkOptions = {}): Process {
    const k = this.kernel, t = this.task;
    const unchanged = forkIdentity(this);
    try { this.syncShared(true); }
    catch (error) { forkFailure(error, unchanged); }
    unchanged();
    // Exactly one all-mapping publication precedes syscall namespace creation.
    // Accepted file writes are not rolled back if later preparation fails.
    if (prepareNamespaces) ({ns, cred} = prepareNamespaces());
    const child = new Process(k, this, files, fs, ns, cgroup);
    const up = parent ? k.procs.get(this.ppid) ?? this : this;
    child.ppid = up.pid;
    const ct = k.newTask(child);
    const reservation = k.numbers.get(ct.tid);
    ct.screen(t.filters, t.strict);
    ct.cred = cred ?? t.cred;
    child.pid = ct.tid;
    child.exitSignal = exitSignal;
    child.image = this.image;
    child.stackLow = this.stackLow;
    child.stackTop = this.stackTop;
    child.mapBase = this.mapBase;
    child.mapEnd = this.mapEnd;
    child.argv = this.argv;
    child.free = this.free.map((r) => ({...r}));
    child.fixed = this.fixed.map((r) => ({...r}));
    // What of the parent's it gets a copy of (not zeroed first, as what else its memory's last process wrote is).
    const live = vm ? null : this.copied(), memory = this.memory ?? this.newMemory(1);
    let made: Mem;
    if (!live) { made = child.memory = memory; memory.users++; }
    else {
      made = child.memory = child.newMemory(memory.buffer.byteLength / WASM_PAGE, this.image, [live.image, ...live.rest]);
      // Instantiating writes the image's first data; the parent's memory goes
      // over it afterwards, so the child sees what the parent changed.
    }
    ct.mask = t.mask;
    const preparedFds = child.fds, preparedFs = ct.fs, preparedGroup = child.cgroup;
    const preparedPool = made.pooled, preparedX87Module = k.x87Module;
    const preparedEpoch = memoryEpoch(made), preparedBuffer = made.buffer;
    let loadCompleted = false, loadedX87: X87 | null = null, loadedFpu = 0;
    try {
      ct.load(this.image, made, t);
      loadCompleted = true; loadedX87 = ct.x87Owner; loadedFpu = ct.x87;
      if (live) {
        this.copyLive(child, live);
        for (const m of this.maps) child.mapShared(m.node, m.start, m.length, m.off);
      }
      const regs = t.context().regs;
      regs[0] = 0n;
      if (stack) regs[4] = stack;
      if (tls !== null) regs[16] = tls;
      ct.setContext(regs, resume);
      ct.redirected = false;
      ct.clearTid = clearTid;
      // Do not establish init while executable/memory preparation can still fail.
      // Recheck admission for reservations obtained before a reentrant failure.
      publishInitialPid(child.pidns, child.pid, k.numbers, reservation);
      child.tasks.add(ct);
      up.children.add(child);
      k.procs.set(child.pid, child);
      k.tasks.set(ct.tid, ct);
      k.noteRootConsoleChild(this, child);
      k.go(ct);
      return child;
    }
    catch (error) {
      const preparedX87 = loadCompleted ? loadedX87 : ct.x87Owner, preparedFpu = loadCompleted ? loadedFpu : ct.x87;
      // A failed *new instance* has not returned exports. Do not generalize this
      // to a partially taken pooled instance, a published child, or later fork
      // preparation. Those paths need their own ownership proof.
      const failures = [error];
      let returnedMemory = false, retiredX87 = false;
      const retirement: PreparationRetirement = {backend: 'not-attempted', x87: 'not-attempted', fs: 'not-attempted',
        fds: 'not-attempted', memory: 'not-attempted', cgroup: 'not-attempted'};
      const retainFailure = (failure: unknown): never => {
        child.failedPreparation = {task: ct, memory: made, x87Owner: preparedX87, x87Handle: preparedFpu,
          retirement: {...retirement}, error: failure};
        (k.failedPreparations ??= new Set()).add(child);
        throw failure;
      };
      // A returned instance may already be shared, partially published or running.
      // Preserve evidence only; no stop, rollback or resource return is proven here.
      if (loadCompleted) retainFailure(error);
      const unexposed = (): void => {
        if (ct.instance || ct.memory !== made || made.pooled !== preparedPool || child.memory !== (returnedMemory ? null : made)
          || !returnedMemory && (memoryEpoch(made) !== preparedEpoch || made.buffer !== preparedBuffer)
          || child.fds !== preparedFds || ct.fs !== preparedFs || child.cgroup !== preparedGroup
          || k.x87Module !== preparedX87Module || ct.x87Owner !== preparedX87 || ct.x87 !== (retiredX87 ? 0 : preparedFpu) || ct.x87 !== 0 && !preparedX87
          || child.maps.length || child.tasks.size || child.children.size
          || up.children.has(child) || k.procs.has(child.pid) || k.tasks.has(ct.tid)
          || k.runq.includes(ct) || k.blocked.has(ct) || k.current === ct)
          throw new Error('failed child load no longer has exclusive preparation ownership');
      };
      try {
        unexposed();
        retirement.backend = 'uncertain';
        ct.end(); // No ordinary exit: no signals, robust-list writes or parent notification.
        unexposed();
        if (made.tainted) throw new Error('failed child load has unconfirmed memory readers');
        retirement.backend = 'returned';
        ct.dead = true; ct.state = 'dead';
        child.state = 'zombie'; // No further ordinary execution may start it.
      } catch (cleanup) {
        retainFailure(new AggregateError([error, cleanup], 'child load failed without safe preparation retirement'));
      }
      const retire = (kind: keyof PreparationRetirement, action: () => void): void => {
        unexposed();
        retirement[kind] = 'uncertain';
        try { action(); retirement[kind] = 'returned'; } catch (cleanup) { failures.push(cleanup); }
        unexposed(); // Cleanup callbacks cannot grant ownership of a replacement.
      };
      try {
        ct.x87 = 0; retiredX87 = true;
        retire('x87', () => { if (preparedFpu) preparedX87!.free(preparedFpu); });
        retire('fs', () => preparedFs.drop());
        retire('fds', () => preparedFds.letGo());
        retire('memory', () => {
          if (live ? made.users !== 1 : made.users < 2) throw new Error('failed child load lost its exclusive memory acquisition');
          child.memory = null; returnedMemory = true;
          // Returning this extra shared owner must not invalidate the parent's
          // pending read epoch. Discard a failed private instance's memory:
          // an uncertain forget must never leave it in the ordinary reuse pool.
          if (!live) made.users--;
          else { made.tainted = true; k.letGo(made); }
        });
        if (failures.length === 1) {
          retirement.cgroup = 'uncertain';
          if (!preparedGroup.procs.has(child)) throw new Error('failed child load has no cgroup membership');
          if (!preparedGroup.procs.delete(child)) throw new Error('failed child load lost its cgroup membership');
          retirement.cgroup = 'returned';
        }
      } catch (cleanup) { failures.push(cleanup); }
      if (failures.length > 1) retainFailure(new AggregateError(failures, 'child load and preparation cleanup failed'));
      throw error;
    }
  }

  /** A new thread of this process (clone with CLONE_THREAD): the caller's registers, rax 0, on `stack`. */
  newThread(resume: bigint, stack: bigint, tls: bigint | null): Task {
    const k = this.kernel, t = this.task;
    const nt = k.newTask(this);
    nt.mask = t.mask;
    nt.screen(t.filters, t.strict);
    nt.load(this.image, this.memory ?? this.newMemory(1), t);
    const regs = t.context().regs;
    regs[0] = 0n;
    if (stack) regs[4] = stack;
    if (tls !== null) regs[16] = tls;
    nt.setContext(regs, resume);
    nt.redirected = false;
    this.tasks.add(nt);
    k.tasks.set(nt.tid, nt);
    return nt;
  }
}

/** A thread: its registers (a wasm instance's globals here), its signal mask and pending signals, its x87. */
export class Task implements Thread {
  declare slice: number;
  declare readonly proc: Process;
  declare readonly kernel: Kernel;
  declare readonly tid: number;
  declare mask: bigint;
  declare savedMask: bigint | null;
  declare readonly pending: Pending;
  declare altstack: AltStack;
  declare clearTid: number;
  declare robust: number;
  /** The filters over its calls, the first set first, and whether it is in strict mode (seccomp.ts). */
  declare filters: readonly Filter[] | null;
  declare strict: boolean;
  declare cred: Cred;
  declare ns: Spaces;
  declare fs: Fs;
  declare call: Call | null;
  declare resumeAt: bigint;
  declare redirected: boolean;
  declare state: 'new' | 'ready' | 'running' | 'blocked' | 'stopped' | 'dead';
  declare dead: boolean;
  /** SODS_BLOCKS's last 256 blocks entered, where kept (cpu.ts). */
  declare trail: (bigint | number)[] | null;
  declare trailAt: number;
  declare image: Image;
  /** Its x87 registers' handle (x87.ts); 0 before it has any. */
  declare x87: number;
  /** Allocator that established the handle; preparation cleanup must not reread
   * a possibly replaced kernel allocator after calling external hooks. */
  declare x87Owner: X87 | null;
  declare memory: Mem;
  declare slot: Slot;
  declare instance: WebAssembly.Instance;
  declare attached: number;
  declare sliceStart: number;
  declare ranAt: number;
  /**
   * Its time on the processor (Kernel.charge), since when it is not counted yet (steady() ms), and how much of
   * what is to be counted is the kernel's (Kernel.lap: its timed calls, each as CALL_SAMPLE calls).
   */
  declare cpu: Cpu;
  declare since: number;
  declare owed: number;
  declare bytesBuffer: ArrayBufferLike | undefined;
  declare bytesOf: Uint8Array;
  /** The backend's: it stopped (SIGSTOP), it goes on (SIGCONT). */
  declare stop?: () => void;
  declare cont?: () => void;
  /** Its process took a table of descriptors of its own in place of `was` (exec, from one shared): the backend's, where it follows the table (remote.ts). */
  tableLeft(_was: FdTable): void {}
  constructor(proc: Process, tid?: number) {
    this.slice = SLICE_LOOPS; // loops and calls in its next time slice (nextSlice)
    this.proc = proc;
    this.kernel = proc.kernel;
    this.mask = 0n;
    this.savedMask = null; // the mask to come back to after a handler (rt_sigsuspend)
    this.pending = new Pending();
    this.altstack = {sp: 0n, size: 0n, flags: 2};
    this.clearTid = 0; // CLONE_CHILD_CLEARTID / set_tid_address
    this.robust = 0; // set_robust_list
    this.filters = null;
    this.strict = false;
    // Who it is, its namespaces and where it is in the tree: the thread's that makes it (its process's, where it
    // is the first), until it goes its own way.
    const from = proc.own;
    this.cred = from?.cred ?? proc.alone ?? ROOT;
    this.ns = from?.ns ?? proc.ns0;
    this.fs = from?.fs ?? proc.fs0;
    this.call = null; // the call it waits in: {nr, args, next, state}
    this.resumeAt = 0n;
    this.redirected = false; // its registers were replaced since its call
    this.state = 'new';
    this.dead = false;
    this.cpu = {user: 0, sys: 0};
    this.since = 0;
    this.owed = 0;
    this.trail = null;
    this.x87 = 0;
    this.x87Owner = null;
    // Complete metadata/object preparation before acquiring PID and Fs owners.
    // An explicit tid retains the raw constructor's existing numbering contract.
    this.tid = tid ?? this.kernel.numbered(proc);
    if (from) this.fs.users++; else proc.taken = true;
  }

  /** `filters` are over its calls from here on (and strict mode, when said): what it starts starts with them. */
  screen(filters: readonly Filter[] | null, strict = this.strict): void {
    this.filters = filters;
    this.strict = strict;
  }

  /** Run `image` over `memory` from here on (exec, or a new thread or process copying `from`). */
  load(image: Image, memory: Mem, from: Task | null = null): void {
    this.image = image;
    // Its x87: a copy of the one it is made from (a new thread or process), or as they start (an exec, the first).
    const x87 = this.kernel.x87;
    x87.check(namesIn(image.module));
    if (from) { if (this.x87) x87.free(this.x87); this.x87 = x87.make(from.x87); } else if (this.x87) x87.reset(this.x87); else this.x87 = x87.make();
    this.x87Owner = x87;
    this.memory = memory;
    // A memory an exited process of the same program left its instance on: that instance goes on, its globals as a
    // fresh one's, the modules made since attached, where nothing instantiating would write is wanted (goesOn).
    const pooled = goesOn(image, from) ? memory.pooled?.find((x) => x.image === image) : null;
    if (pooled) {
      memory.pooled = memory.pooled?.filter((x) => x !== pooled);
      this.slot = pooled.slot;
      this.slot.task = this;
      this.instance = pooled.instance;
      for (const [g, v] of this.slot.initial) g.value = v;
      if (this.exports.x87) this.exports.x87.value = this.x87;
      this.attached = pooled.attached;
      PROFILE.instancesKept++;
      this.attach();
      return;
    }
    // A module that carries its data writes it as it is instantiated: over a memory in use (a thread's, a vfork
    // child's), what the image holds now is put back.
    const keep = from && !image.segments && from.memory === memory ? this.bytes.slice(image.facts.imageStart ?? 0, image.facts.imageEnd) : null;
    this.slot = {task: this, initial: []};
    try { this.instance = new WebAssembly.Instance(image.module, this.imports()); }
    finally {
      // Data initialization precedes start: a trapping start may already have
      // overwritten the live parent's image. Restore even without an instance,
      // into the supplied memory (and its current buffer after possible grow).
      if (keep) new Uint8Array(memory.buffer).set(keep, image.facts.imageStart ?? 0);
    }
    // Its globals as they start, for when it goes on under another task (a vector register is not read from here,
    // nor need be: none is kept across a call into the kernel).
    for (const g of Object.values(this.instance.exports)) {
      if (!(g instanceof WebAssembly.Global)) continue;
      try { this.slot.initial.push([g, g.value]); } catch { /* v128 */ }
    }
    if (this.exports.x87) this.exports.x87.value = this.x87;
    this.attached = 0;
    this.attach();
  }

  /** Its memory as bytes: the one view, made again only when the memory grew (another buffer). */
  get bytes(): Uint8Array {
    const b = this.memory.buffer;
    if (b !== this.bytesBuffer) { this.bytesBuffer = b; this.bytesOf = new Uint8Array(b); }
    return this.bytesOf;
  }

  /** Its image starts again on its memory (Process.execve): the instance stays; its x87 and its stack's depth start afresh. */
  renew(): void {
    this.kernel.x87.reset(this.x87);
    const low = this.exports.low;
    if (low) low.value = -1n;
  }

  /** What its instance imports: each call to the task it runs under now (`slot`: a pooled instance changes task). */
  /** What its instance exports. */
  get exports(): Translation { return this.instance.exports as unknown as Translation; }

  imports(): WebAssembly.Imports {
    const slot = this.slot;
    return {env: {
      memory: this.memory,
      // A read of the clock is answered at once (clock.ts), as Linux's vDSO does.
      syscall: (nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint) => {
        const t = slot.task as Task;
        // (A read of the clock is answered here, without the kernel: not for a thread with a filter over its calls.)
        return ((nr === 228n || nr === 96n || nr === 201n) && !t.filters && !t.strict ? answerTime(t.memory, CLOCK, nr, a, b) : null) ?? t.kernel.enter(t, nr, [a, b, c, d, e, f], next);
      },
      trap: trapOrPreempt,
      div128: (hi: bigint, lo: bigint, d: bigint, signed: number) => div128(hi, lo, d, signed),
      clock: () => BigInt(Math.round(steady() * 1e6)),
      // Wasm to wasm, the x87's own (x87.ts): the instance's x87 global names whose registers.
      fpu: this.kernel.x87.fpu,
      trace: (address: bigint | number) => {
        const t = slot.task as Task;
        if (TRACE_BLOCKS) console.error(`[${t.tid}] block 0x${BigInt.asUintN(64, BigInt(address)).toString(16)}`); else if (t.trail) t.trail[t.trailAt++ & 255] = address;
      },
      miss: (address: bigint) => (slot.task as Task).miss(address),
      // clock_gettime of a wall or steady clock, answered in the translated code (sods' integer.rs clock_gettime), as above.
      // (Not said to a thread with a filter over its calls: its clock_gettime is a call, asked of the filter.)
      time: (id: number) => { const t = slot.task as Task; return t.filters || t.strict ? NaN : CLOCK.readMs(id) ?? NaN; },
    }};
  }

  /** Instantiate the modules made since this thread last looked (by it or another). */
  attach(): void {
    const extras = this.image.extras;
    if (this.attached >= extras.length) return;
    const {table} = this.exports;
    const env = this.imports().env;
    for (; this.attached < extras.length; this.attached++) {
      const x = extras[this.attached];
      // Doubling, so a program reaching its code a function at a time grows the table a few times, not once a module.
      if (table.length < x.base + x.count) table.grow(Math.max(x.base + x.count - table.length, table.length));
      const own = new WebAssembly.Instance(x.module, {env, main: this.instance.exports}).exports.table as WebAssembly.Table;
      for (let k = 0; k < x.count; k++) table.set(x.base + k, own.get(k));
    }
  }

  /** dispatch found no translated code at `address`: find or make it, else -1. */
  miss(address: bigint): bigint {
    let at = this.image.entries.get(address);
    if (at === undefined && this.image.more(this.kernel.translateMore, address, (w) => this.kernel.prepare(w))) at = this.image.entries.get(address);
    if (at === undefined) return -1n;
    this.attach();
    return at;
  }

  // ---- registers: 0..15 as x86 numbers them (rax, rcx, rdx, rbx, rsp, rbp, rsi, rdi, r8..r15), 16 fs, 17 the flags, 18 the rest of rflags and MXCSR ----

  reg(n: number): bigint { return this.exports[REG[n]]?.value ?? 0n; }
  /** How deep its stack has gone (sods' abi.rs G_LOW: all ones before it moved); null for a translation without it. */
  low(): bigint | null { return this.instance ? this.exports.low?.value ?? null : null; }
  setReg(n: number, v: bigint | number): void { const g = this.exports[REG[n]]; if (g) g.value = BigInt.asIntN(64, BigInt(v)); }
  /** Its registers and where it goes on. */
  context(): {regs: bigint[]; rip: bigint} { return {regs: REG.map((_, n) => this.reg(n)), rip: this.resumeAt}; }
  /** Go on at `rip` with `regs`. */
  setContext(regs: bigint[], rip: bigint): void {
    regs.forEach((v, n) => this.setReg(n, v));
    this.resumeAt = BigInt(rip);
    this.redirected = true;
  }
  /** It ended (the backend lets go of what ran it). */
  end(): void {}
}

/**
 * The instances kept on a memory its processes ended on, each of its own program (Task.load; a Worker's, remote.ts
 * and cpu.ts): a shell's fork child and the command it runs take turns on one memory.
 */
export const KEEP_INSTANCES = 2;

/**
 * Whether an instance of `image` made before on the memory it is to run on may run it in place of a new one
 * (Task.load, and a Worker's kept one: remote.ts): nothing a new instance would write is wanted. A fork's own copy of
 * its parent's memory has the parent's copied over all of it (Process.copyLive); a thread's (or a vfork child's)
 * memory is its parent's, in use, which a new instance wrote the image's data over (and was put back after:
 * Task.load's keep); an exec (or a first process) lays the image's data itself when its module was made without it
 * (share.ts), and such a module writes nothing as it is instantiated.
 */
export const goesOn = (image: Image, from: Task | null): boolean => !!from || !!image.segments;


/** Where the time went (run.ts prints it with SODS_TIMING=1): translating, compiling wasm, how much, and what a pack root fetched. */
export const PROFILE = {images: 0, modules: 0, bytes: 0, translate: 0, compile: 0, fetches: 0, fetched: 0, kept: 0, consolidated: 0, memoriesReused: 0, imagesKept: 0, instancesKept: 0, zeroed: 0, renewed: 0, offered: 0};
/** Modules of code reached later past which a program run again is translated again as one (Kernel.consolidate). */
const CONSOLIDATE = 16;
/** Memories let go of that are kept for the next process, and the largest kept (Kernel.letGo). */
const SPARE_MEMORIES = 4, SPARE_MEMORY_BYTES = 256 << 20;
/** SODS_SYSCALLS=1 lists every system call on stderr (node only). */
export const TRACE_SYSCALLS = !!said('SODS_SYSCALLS');
/** SODS_FAULTS=1 says what each fault that ends a process was (node only). */
const TRACE_FAULTS = !!said('SODS_FAULTS');
/** SODS_BLOCKS=1 lists every block entered (node only; run.ts then translates with --trace). */
const TRACE_BLOCKS = !!said('SODS_BLOCKS');
/** Which argument of a call names a path (0: the first, 1: the second, after a directory). */
const PATH_ARG: Record<number, number> = {2: 0, 4: 0, 6: 0, 21: 0, 59: 0, 80: 0, 83: 0, 84: 0, 87: 0, 89: 0, 257: 1, 262: 1, 263: 1, 269: 1, 439: 1};

export function trace(t: {proc: Process; tid: number}, call: Call): void {
  // A path in the first argument (or the second, for the *at calls) is shown as text.
  const at = PATH_ARG[call.nr];
  let path = '';
  try { if (at !== undefined) path = ` "${t.proc.cstring(Number(BigInt.asUintN(64, call.args[at])))}"`; } catch { /* not a string */ }
  console.error(`[${t.tid}] syscall ${call.nr}${CALLS[call.nr] ? '' : ' (none)'} ${call.args.slice(0, 3).map((x) => '0x' + BigInt.asUintN(64, x).toString(16)).join(' ')}${path}`);
}

export function div128(hi: bigint, lo: bigint, d: bigint, signed: number): [bigint, bigint] {
  let n = (BigInt.asUintN(64, hi) << 64n) | BigInt.asUintN(64, lo);
  let divisor = BigInt.asUintN(64, d);
  if (signed) { n = BigInt.asIntN(128, n); divisor = BigInt.asIntN(64, divisor); }
  if (divisor === 0n) throw new GuestTrap(0n, 4);
  const q = n / divisor, r = n % divisor;
  if (signed ? BigInt.asIntN(64, q) !== q : BigInt.asUintN(64, q) !== q) throw new GuestTrap(0n, 4);
  return [BigInt.asIntN(64, q), BigInt.asIntN(64, r)];
}
