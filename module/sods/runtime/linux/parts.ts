// What the kernel's parts are to each other: a process, a thread, the kernel and a loaded program as the calls
// (sys-*.ts, signal.ts, procfs.ts) and the backends (cpu.ts, remote.ts) see them. process.ts makes them (its classes
// are these, each merged with its interface here), and imports the calls; so what the calls know of it is said here,
// under both, and each part that keeps state of its own on the kernel or a description says so where it is made
// (sys-net.ts: its sockets).

import type {Cgroup} from './cgroup.ts';
import type {Cred} from './cred.ts';
import type {FdTable} from './fd.ts';
import type {Dir, File, Mapping, Mount, Place, Super, Vfs} from './fs.ts';
import type {Machine} from './machine.ts';
import type {Fs, Numbers, PidNs, Spaces} from './space.ts';

// ---- signals ----

/** What a signal says (siginfo_t's fields that are used). */
export interface SigInfo {
  signo: number;
  code: number;
  errno?: number;
  pid?: number;
  uid?: number;
  status?: number;
  value?: bigint | number;
  addr?: bigint | number;
  /** A filter's SIGSYS: the call it was for, and the machine it was made for (with `addr`, where it was made from). */
  syscall?: number;
  arch?: number;
}
/** What a process does with a signal (sigaction). */
export interface SigAction { handler: bigint; flags: number; restorer: bigint; mask: bigint }
/** A thread's alternate signal stack (sigaltstack). */
export interface AltStack { sp: bigint; size: bigint; flags: number }
/** Signals waiting to be taken (signal.ts Pending). */
export interface PendingSet {
  mask: bigint;
  readonly info: Map<number, SigInfo[]>;
  add(sig: number, info: SigInfo): boolean;
  take(sig: number): SigInfo;
  drop(mask: bigint): void;
}

// ---- calls ----

/**
 * What a call that waits keeps across its attempts (each call's own; the kernel reads `deadline`, `done`, `timed`,
 * `cancel` and `interrupted`).
 */
export interface CallState {
  /** When it times out (steady() ms). */
  deadline?: number;
  /** What it moved already (its value, should a handler interrupt it). */
  done?: number;
  /** A stream send's descriptors went with its first byte (sys-net.ts transmit): not passed again as it goes on. */
  passed?: boolean;
  /** Its thread's filters were asked, and let it be made (seccomp.ts): not asked again as it waits and is made again. */
  screened?: boolean;
  /** Whether a timeout was asked (a call so timed is not restarted after a handler). */
  timed?: boolean;
  /** Let go of what it waits on (it was interrupted, or its thread ended). */
  cancel?(): void;
  /** It was interrupted (EINTR). */
  interrupted?(): void;
  /** The mask it waits under was swapped in (ppoll, pselect, epoll_pwait, rt_sigsuspend). */
  swapped?: boolean;
  started?: boolean;
  consumed?: number;
  total?: number;
  offset?: number;
  waiter?: FutexWaiter;
  waitFor?: bigint;
  vfork?: {released: boolean};
  child?: Proc;
}
/** A system call being made: its number, arguments, where the thread goes on after it, and its state. */
export interface Call { nr: number; args: bigint[]; next: bigint; state: CallState }

/** A filter over a thread's calls (seccomp.ts): its instructions, each a code, two jumps and a word. */
export interface Filter { readonly code: Uint16Array; readonly jt: Uint8Array; readonly jf: Uint8Array; readonly k: Uint32Array }

/** Where a futex word is: a memory and an address in it, or a file and an offset (a shared mapping). */
export type FutexKey = [WebAssembly.Memory | File, number];
/** A thread waiting on a futex. */
export interface FutexWaiter { task: Thread; bitset: number; woken: boolean; key: FutexKey }

/** A timer the kernel fires (alarms, timeouts): at `at` (steady() ms). */
export interface Timer { at: number; fire(): void }

/** A system call's handler: `this` is the calling process; its arguments the registers, as BigInts. */
export type Handler = (this: Proc, ...args: bigint[]) => bigint | number;
/** System calls by number. */
export type Calls = Record<number, Handler>;

// ---- memory ----

/** A run of addresses [start, end). */
export type Range = [number, number];

/** An instance of a program kept on a memory, for a process of it to go on with (Task.load). */
export interface Pooled { image: Program; instance: WebAssembly.Instance; slot: Slot; attached: number }
/** What a pooled instance runs as: the thread it is a part of now, and its globals as they started. */
export interface Slot { task: Thread; initial: [WebAssembly.Global, unknown][] }

/** A process's memory, as the kernel keeps it. */
export interface Mem extends WebAssembly.Memory {
  /** How many processes run on it (a vfork child and its parent, threads' processes made with CLONE_VM). */
  users: number;
  /** Where a process wrote that is not zeroed yet. */
  written: Range[];
  /** How deep its stack has been written. */
  deepest?: number;
  /** It ran the program it is given to (what of the program no correct run changes is in it already). */
  keeps: boolean;
  /** It ran this very translation of it, whose own table and cache (Facts.derived) are in it already. */
  exact?: boolean;
  imageOf: Program | null;
  /** Instances kept on it (Task.load). */
  pooled?: Pooled[];
  /** It cannot be kept for another (a Worker of it went wrong). */
  tainted?: boolean;
}

// ---- a loaded program ----

/** The loader's facts of a translation (image.rs's sods.facts). */
export interface Facts {
  entry: number;
  phdr: number;
  phent: number;
  phnum: number;
  imageStart?: number;
  imageEnd: number;
  /** What no correct run writes ([[start, end]]). */
  readOnly?: Range[];
  /** The translation's own entry table and dispatch cache, past the image: the same in every process of it. */
  derived?: Range;
}
/** A module of code reached later: its module, its first slot in the table, how many, and its bytes. */
export interface Extra { module: WebAssembly.Module; base: number; count: number; bytes: Uint8Array }
/** A program's image, as process.ts's Image is (the parts the calls and backends read). */
export interface Program {
  readonly module: WebAssembly.Module;
  readonly facts: Facts;
  readonly extras: Extra[];
  readonly entries: Map<bigint, bigint>;
  readonly known: Set<bigint>;
  segments: {offset: number; bytes: Uint8Array}[] | null;
  size: number;
  slots: number;
  firstSlots: number;
  source: (() => Uint8Array) | null;
  /** Its file's entry (Kernel.images), once remembered. */
  file?: ImageEntry;
  /** A root file's: where its bytes are, what was made of them, and how much of it the host has been told of. */
  origin?: string;
  wasm?: Uint8Array<ArrayBuffer> | null;
  told?: number;
  mainTold?: boolean;
  opened?(): boolean;
}
/** A file's translation, as the kernel keeps it: of which version, the image, when last used, and whether kept for good. */
export interface ImageEntry { version: number; image: Program; used: number; kept: boolean }

// ---- the console ----

/**
 * Where a kernel's console is: what it writes (`write`), what is typed (`read`: null, nothing yet), and how it is a
 * terminal (`screen`: its output shown as a terminal's screen, `cols` by `rows`).
 */
export interface Console {
  write(fd: number, bytes: Uint8Array): void;
  read(n: number): Uint8Array | null;
  ready?(): boolean;
  pending?(): number;
  flush?(all: boolean): void;
  full?(): boolean;
  interactive?: boolean;
  screen?: boolean;
  cols?: number;
  rows?: number;
  /** How the terminal reads keys and puts out lines changed (raw, echo): the host, which reads the keys, hears of it. */
  mode?(setting: {iflag: number; oflag: number; lflag: number}): void;
}

/** The console as a terminal: its session and the group in front; termios and what the shell left set. */
export interface Tty {
  sid: number;
  fg: number;
  /** The group in front a signal cut short (sys-file.ts handed). */
  cut?: number;
  /** How a job cut short left it (put back when it is in front again), and how the shell had it. */
  left?: {pgid: number; setting: Termios} | null;
  shell?: Termios;
  termios?: Termios;
}
/** A terminal's settings (termios), and ECHO as the rest last set it (the shell only hushing it). */
export interface Termios { iflag: number; oflag: number; cflag: number; lflag: number; echo: number; cc: Uint8Array }

// ---- a process ----

/**
 * Time on the processor, in ms: its program run (user) and the kernel making its calls (sys). A thread's, a process's
 * (the threads it had), the children a process waited for (theirs and what they waited for), the machine's.
 */
export interface Cpu { user: number; sys: number }

/** A process as the calls see it (process.ts Process). */
export interface Proc {
  readonly kernel: Kern;
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  fds: FdTable;
  /** Where it is in the tree: its root, where it works, its umask (space.ts): its own, or shared with what CLONE_FS made. */
  fs: Fs;
  /** Its root (fs.root): what a path of its from the root is walked from. */
  readonly root: Place;
  umask: number;
  /** Who the thread that calls is (cred.ts): its ids, its capabilities, its user namespace. */
  cred: Cred;
  /** The namespaces it is in (space.ts), and the cgroup. */
  ns: Spaces;
  cgroup: Cgroup;
  /** The pid namespace it was made in: what it calls processes by. */
  pidns: PidNs;
  nice: number;
  limits: [bigint, bigint][];
  comm: string | null;
  noNewPrivs: boolean;
  dumpable: boolean;
  subreaper?: boolean;
  deathSignal?: number;
  readonly children: Set<Proc>;
  readonly tasks: Set<Thread>;
  readonly actions: Map<number, SigAction>;
  readonly pending: PendingSet;
  state: 'live' | 'zombie';
  started: number;
  maps: (Mapping & {proc: Proc; node: File})[];
  exe: string;
  /** Where the program it runs is (its /proc exe leads there). */
  exeAt?: {mnt: Mount; node: File; dir: Dir; name: string};
  env: string[];
  argv: string[];
  exitStatus: number | undefined;
  exitSignal: number;
  stopped: number;
  report: {kind: 'stopped' | 'continued'; sig?: number; seen: boolean} | null;
  vfork: {released: boolean} | null;
  alarm?: {at: number; interval: number; timer: Timer} | null;
  /** Its threads' time on the processor, once each ended; its children's that it waited for (getrusage, times). */
  cpu: Cpu;
  waited: Cpu;
  /** The thread whose call runs now, and that call (none between calls). */
  task: Thread;
  call: Call | null;
  /** Its memory (none before its first exec, nor once it ended). */
  memory: Mem | null;
  image: Program;
  stackLow: number;
  stackTop: number;
  mapBase: number;
  mapEnd: number;
  free: {start: number; length: number}[];
  fixed: {start: number; length: number}[];

  readonly bytes: Uint8Array;
  readonly view: DataView;
  cstring(address: number): string;
  strings(address: number): string[];
  reserve(length: number): number;
  cover(end: number): void;
  release(start: number, length: number): void;
  mapShared(node: File, start: number, length: number, off: number): void;
  syncShared(all?: boolean): void;
  futexKey(address: number): FutexKey;
  sharedIn(start: number, length: number): (Mapping & {proc: Proc; node: File})[];
  unmapShared(start?: number, length?: number): void;
  execve(path: string, argv: string[], env: string[]): void;
  written(): Range[];
  forkProcess(resume: bigint, how?: {stack?: bigint; vm?: boolean; files?: boolean; fs?: boolean; ns?: Spaces | null; cred?: Cred | null; cgroup?: Cgroup | null; exitSignal?: number; tls?: bigint | null; clearTid?: number; parent?: boolean}): Proc;
  newThread(resume: bigint, stack: bigint, tls: bigint | null): Thread;
}

// ---- a thread ----

/** A thread as the calls see it (process.ts Task; cpu.ts and remote.ts's own). */
export interface Thread {
  readonly proc: Proc;
  readonly kernel: Kern;
  readonly tid: number;
  mask: bigint;
  savedMask: bigint | null;
  readonly pending: PendingSet;
  altstack: AltStack;
  clearTid: number;
  robust: number;
  call: Call | null;
  resumeAt: bigint;
  redirected: boolean;
  state: 'new' | 'ready' | 'running' | 'blocked' | 'stopped' | 'dead';
  dead: boolean;
  /** Who it is (cred.ts), its namespaces and where it is in the tree (space.ts): its own, where it left what its process's threads share. */
  cred: Cred;
  ns: Spaces;
  fs: Fs;
  /** The filters over its calls, the first set first (seccomp.ts); null: none. And whether it is in strict mode. */
  filters: readonly Filter[] | null;
  strict: boolean;
  /** Put `filters` over its calls from here on (and strict mode, when said). */
  screen(filters: readonly Filter[] | null, strict?: boolean): void;
  /** Its time on the processor so far (to `since`: Kern.lap). */
  cpu: Cpu;
  /** Its x87 registers' handle in the kernel's x87 (x87.ts); 0 where it has none here. */
  x87: number;
  image: Program;
  memory: Mem;
  readonly bytes: Uint8Array;
  reg(n: number): bigint;
  setReg(n: number, v: bigint | number): void;
  context(): {regs: bigint[]; rip: bigint};
  setContext(regs: bigint[], rip: bigint): void;
  /** How deep its stack has gone; null where that is not known. */
  low(): bigint | null;
  stop?(): void;
  cont?(): void;
  end(): void;
}

// ---- the kernel ----

/** What a kernel holds, by kind (Kernel.held). */
export interface Held { guest: number; translations: number; translator: number; files: number; spare: number; total: number; spareTranslator: number }

/** The kernel as the calls see it (process.ts Kernel; remote.ts's). */
export interface Kern {
  readonly vfs: Vfs;
  readonly machine: Machine;
  readonly console: Console;
  readonly procs: Map<number, Proc>;
  readonly tasks: Map<number, Thread>;
  readonly runq: Thread[];
  readonly blocked: Set<Thread>;
  readonly futexes: Map<WebAssembly.Memory | File, Map<number, Set<FutexWaiter>>>;
  readonly timers: Set<Timer>;
  readonly nextPid: number;
  /** The numbers of what was not made in the first pid namespace (space.ts). */
  readonly numbers: Numbers;
  dirty: boolean;
  current: Thread | null;
  tty: Tty;
  status: number | null;
  shared: boolean;
  initPid?: number;
  /** Keys typed so far (what a poll of the console counts as a change). */
  inputs?: number;
  /** The first process's root, namespaces and cgroup: what a process made of nothing starts in. */
  readonly root: Place;
  readonly spaces: Spaces;
  /** The cgroups: the tree's root, and the file system it is. */
  readonly cgroups: {root: Cgroup; sb: Super};
  /** What has moved over lo (net-view.ts). */
  loopbackTraffic?: {bytes: number; packets: number};
  /** All the time its threads have had on the processor (/proc/stat). */
  readonly cpu: Cpu;

  live(): Proc[];
  group(pgid: number): Proc[];
  hasGroup(pgid: number, sid: number): boolean;
  memoryBytes(): number;
  say(fd: number, bytes: Uint8Array): void;
  go(t: Thread): void;
  /** `t`'s time up to `now` (steady() ms) counted to it (process.ts Kernel.lap). */
  lap(t: Thread, now: number): void;
  lookIn(p: Proc): void;
  addTimer(at: number, fire: () => void): Timer;
  removeTimer(timer: Timer): void;
  interruptCall(t: Thread): void;
  exitThread(t: Thread, status: number): void;
  exitProcess(p: Proc, status: number): void;
  stopProcess(p: Proc, sig: number): void;
  continueProcess(p: Proc): void;
  futexQueue(key: FutexKey): Set<FutexWaiter>;
  futexWake(key: FutexKey, n: number, bitset: number): number;
  futexRequeue(key: FutexKey, to: FutexKey, n: number): number;
}
