// /proc as Linux has it: made from the kernel's own processes each time it is read, not files written once.
//
// Each process is a directory by its pid (stat, status, cmdline, comm, environ, maps, cwd, exe, fd/, task/); /proc/self
// is the process that asks. What is read is made when the file is opened (a snapshot, as Linux's seq files give it),
// so a reader sees one consistent text however it reads it; stat says 0 bytes, as Linux does. The machine-wide files
// (uptime, loadavg, stat, meminfo, cpuinfo, mounts, version, sys/..., net/...) say what this kernel is doing.

import {Dir, File, Link, S_IFREG, E, FsError} from './fs.ts';
import {cpuOf} from './clock.ts';
import {procNet} from './net-view.ts';
import {CAPS, uuid} from './flow.ts';
import type {Description} from './fd.ts';
import type {Entry} from './fs.ts';
import type {Kern, Proc} from './parts.ts';
import {epoch, processors, steady} from '../host.ts';

const enc = new TextEncoder();
const HZ = 100;
const PAGE = 4096;

/** A file whose text is made when it is opened. */
class Made extends File {
  declare readonly make: () => string;
  constructor(make: () => string, mode = 0o444) { super(new Uint8Array(0), mode); this.make = make; }
  /** What an open reads: the text as it is now, a file of its own (its inode this one's). */
  snapshot(): File { const f = new File(enc.encode(this.make()), this.mode & 0o7777); f.ino = this.ino; return f; }
}

/** A directory whose entries are made each time it is looked in. */
class Listing extends Dir {
  declare readonly list: () => Map<string, Entry>;
  constructor(list: () => Map<string, Entry>, mode = 0o555) { super(mode); this.list = list; }
  override get entries(): Map<string, Entry> { return this.list(); }
}

/**
 * A directory's entries found one at a time where a name is asked for (a path walked through it), made whole only
 * where they are listed or counted: /proc made every process's directory for each look at /proc/self.
 */
class Found extends Map<string, Entry> {
  declare readonly find: (name: string) => Entry | undefined;
  declare readonly whole: () => Map<string, Entry>;
  constructor(find: (name: string) => Entry | undefined, whole: () => Map<string, Entry>) {
    super();
    this.find = find;
    this.whole = whole;
  }
  override get(name: string): Entry | undefined { return this.find(name); }
  override has(name: string): boolean { return this.find(name) !== undefined; }
  override get size(): number { return this.whole().size; }
  override keys(): MapIterator<string> { return this.whole().keys(); }
  override values(): MapIterator<Entry> { return this.whole().values(); }
  override entries(): MapIterator<[string, Entry]> { return this.whole().entries(); }
  override [Symbol.iterator](): MapIterator<[string, Entry]> { return this.whole()[Symbol.iterator](); }
  override forEach(fn: (value: Entry, key: string, map: Map<string, Entry>) => void, self?: unknown): void { this.whole().forEach(fn, self); }
}

/** A link whose target is made each time it is followed. */
class Pointer extends Link {
  declare readonly make: () => string;
  constructor(target: () => string) { super(''); this.make = target; }
  override get target(): string { return this.make(); }
}

const comm = (p: Proc): string => (p.comm ?? (p.argv?.[0] ?? 'init').split('/').at(-1) ?? '').slice(0, 15);
const state = (k: Kern, p: Proc): 'R' | 'S' | 'Z' | 'T' => p.state === 'zombie' ? 'Z' : p.stopped ? 'T' : k.current?.proc === p ? 'R' : 'S';
const STATE = {R: 'R (running)', S: 'S (sleeping)', Z: 'Z (zombie)', T: 'T (stopped)'};
const memoryBytes = (p: Proc): number => p.memory?.buffer?.byteLength ?? 0;
const hex = (bits: bigint): string => bits.toString(16).padStart(16, '0');

/** Signals a process ignores and catches, as Linux's status masks. */
function signalMasks(p: Proc): {ign: bigint; cgt: bigint} {
  let ign = 0n, cgt = 0n;
  for (const [sig, h] of p.actions) {
    const bit = 1n << BigInt(sig - 1);
    if (h.handler === 1n) ign |= bit; else if (h.handler > 1n) cgt |= bit;
  }
  return {ign, cgt};
}

/**
 * What one of a process's descriptors points at, as /proc/PID/fd/N says it. A directory: where it lies now (renamed
 * since it was opened, its new place; removed, where it lay, "(deleted)"), not the path it was opened by.
 */
function pointsAt(kernel: Kern, d: Description): string {
  switch (d.kind) {
    case 'dir': return (d.node instanceof Dir ? kernel.vfs.shown(d.node) : undefined) ?? (d.path || '/');
    case 'file': case 'device': return d.path || '/';
    case 'pipe-r': case 'pipe-w': return `pipe:[${d.pipe?.id ?? 0}]`;
    case 'console': return '/dev/pts/0';
    case 'eventfd': return 'anon_inode:[eventfd]';
    case 'epoll': return 'anon_inode:[eventpoll]';
    case 'socket': return `socket:[${d.sock?.ino ?? 0}]`;
    default: return `anon_inode:[${d.kind}]`;
  }
}

/** Mount /proc on `kernel.vfs`, made from `kernel`. */
export function mountProc(kernel: Kern): void {
  const vfs = kernel.vfs;
  const booted = steady();
  const bootEpoch = Math.floor(epoch() / 1000);
  const cpus = processors();
  const ticks = (ms: number): number => Math.floor(ms * HZ / 1000);
  const uptime = () => (steady() - booted) / 1000;
  /** Every processor's time since it began that no thread had (ms). */
  const idle = () => Math.max(0, (steady() - booted) * cpus - kernel.cpu.user - kernel.cpu.sys);
  const total = kernel.machine.memory; // the machine's (machine.ts)
  const caller = () => kernel.current?.proc ?? kernel.procs.get(1);
  const live = () => [...kernel.procs.values()];
  const inspect = (target: Proc): void => {
    const from = caller();
    if (from && from !== target && !target.dumpable && !(from.caps.effective & (1n << 19n))) throw new FsError(E.ACCES);
  };

  const stat = (p: Proc): string => {
    const mem = memoryBytes(p);
    const tty = p.sid && p.sid === kernel.tty.sid ? 34816 : 0;
    // Its time on the processor and its waited-for children's (utime, stime, cutime, cstime): ps's TIME, top's %CPU.
    const c = cpuOf(p), w = p.waited;
    const f = [p.pid, `(${comm(p)})`, state(kernel, p), p.ppid, p.pgid, p.sid, tty, tty ? kernel.tty.fg : -1, 4194560,
      0, 0, 0, 0, ticks(c.user), ticks(c.sys), ticks(w.user), ticks(w.sys), 20, 0, Math.max(1, p.tasks.size), 0, ticks(p.started - booted),
      mem, Math.ceil(mem / PAGE), '18446744073709551615', 0, 0, p.stackTop ?? 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, p.exitStatus ?? 0];
    return f.join(' ') + '\n';
  };
  const status = (p: Proc): string => {
    const {ign, cgt} = signalMasks(p);
    const kb = Math.ceil(memoryBytes(p) / 1024);
    return [`Name:\t${comm(p)}`, `Umask:\t${p.umask.toString(8).padStart(4, '0')}`, `State:\t${STATE[state(kernel, p)]}`,
      `Tgid:\t${p.pid}`, 'Ngid:\t0', `Pid:\t${p.pid}`, `PPid:\t${p.ppid}`, 'TracerPid:\t0', 'Uid:\t0\t0\t0\t0', 'Gid:\t0\t0\t0\t0',
      `FDSize:\t${Math.max(64, p.fds.slots.size)}`, 'Groups:\t', `VmPeak:\t${kb} kB`, `VmSize:\t${kb} kB`, `VmRSS:\t${kb} kB`,
      `Threads:\t${Math.max(1, p.tasks.size)}`, 'SigQ:\t0/63432', `SigPnd:\t${hex(0n)}`, `ShdPnd:\t${hex(0n)}`, `SigBlk:\t${hex(0n)}`,
      `SigIgn:\t${hex(ign)}`, `SigCgt:\t${hex(cgt)}`, `CapInh:\t${hex(p.caps.inheritable)}`, `CapPrm:\t${hex(p.caps.permitted)}`,
      `CapEff:\t${hex(p.caps.effective)}`, `CapBnd:\t${hex(CAPS)}`, `CapAmb:\t${p.ambient.toString(16).padStart(16, '0')}`, `NoNewPrivs:\t${p.noNewPrivs ? 1 : 0}`,
      `Seccomp:\t${p.task?.strict ? 1 : p.task?.filters ? 2 : 0}`, `Seccomp_filters:\t${p.task?.filters?.length ?? 0}`, `Cpus_allowed_list:\t0-${cpus - 1}`, ''].join('\n');
  };
  const maps = (p: Proc): string => { inspect(p);
    const exe = p.exe;
    const facts = p.image?.facts;
    const lo = facts?.imageStart ?? 0x400000, hi = facts?.imageEnd ?? lo;
    const line = (a: number, b: number, perm: string, name: string): string => `${a.toString(16).padStart(8, '0')}-${b.toString(16).padStart(8, '0')} ${perm} 00000000 00:00 0${name ? ' '.repeat(18) + name : ''}`;
    const out: string[] = [];
    if (hi > lo) out.push(line(lo, hi, 'r-xp', exe));
    if (p.stackTop) out.push(line(p.stackLow, p.stackTop, 'rw-p', '[stack]'));
    if (p.mapEnd > p.mapBase) out.push(line(p.mapBase, p.mapEnd, 'rw-p', ''));
    return out.join('\n') + '\n';
  };
  const fdDir = (p: Proc): Listing => new Listing(() => new Map([...p.fds.slots].map(([fd, s]) => [String(fd), new Pointer(() => { inspect(p); return pointsAt(kernel, s.description); })])), 0o500);

  // Each process's directory, kept while it is there (its inode stays the same between looks).
  const dirs = new Map<number, {proc: Proc; dir: Listing}>();
  const dirOf = (p: Proc): Listing => {
    const kept = dirs.get(p.pid);
    if (kept?.proc === p) return kept.dir;
    const files = new Map<string, Entry>([
      ['stat', new Made(() => stat(p))],
      ['status', new Made(() => status(p))],
      ['cmdline', new Made(() => p.state === 'zombie' ? '' : (p.argv ?? []).map((a) => a + '\0').join(''))],
      ['comm', new Made(() => comm(p) + '\n')],
      ['environ', new Made(() => { inspect(p); return p.env.map((e) => e + '\0').join(''); }, 0o400)],
      ['maps', new Made(() => maps(p))],
      ['statm', new Made(() => { const pg = Math.ceil(memoryBytes(p) / PAGE); return `${pg} ${pg} 0 0 0 ${pg} 0\n`; })],
      ['limits', new Made(() => limits(p))],
      // Its user namespace's: the one id it maps, 0, the person's own outside (core/src/launch.rs).
      ['uid_map', new Made(() => idMap)], ['gid_map', new Made(() => idMap)], ['setgroups', new Made(() => 'deny\n')],
      ['mounts', new Made(() => mounts())],
      ['cwd', new Pointer(() => { inspect(p); return typeof p.here === 'string' ? p.here : kernel.vfs.shown(p.here) ?? '/'; })],
      ['exe', new Pointer(() => { inspect(p); return p.exe; })],
      ['root', new Pointer(() => { inspect(p); return '/'; })],
    ]);
    const dir = new Listing(() => {
      files.set('fd', fdDir(p));
      files.set('net', net);
      files.set('task', new Listing(() => new Map([...p.tasks].map((t) => [String(t.tid), new Listing(() => new Map<string, Entry>([
        ['stat', new Made(() => stat(p).replace(/^\d+/, String(t.tid)))], ['status', new Made(() => status(p))], ['comm', new Made(() => comm(p) + '\n')],
      ]))]))));
      return files;
    });
    dirs.set(p.pid, {proc: p, dir});
    return dir;
  };

  // Its resource limits as Linux's table says them (sys-proc.ts keeps them; RLIMIT_CPU on, in its order).
  const LIMITS: [string, string][] = [['Max cpu time', 'seconds'], ['Max file size', 'bytes'], ['Max data size', 'bytes'], ['Max stack size', 'bytes'],
    ['Max core file size', 'bytes'], ['Max resident set', 'bytes'], ['Max processes', 'processes'], ['Max open files', 'files'],
    ['Max locked memory', 'bytes'], ['Max address space', 'bytes'], ['Max file locks', 'locks'], ['Max pending signals', 'signals'],
    ['Max msgqueue size', 'bytes'], ['Max nice priority', ''], ['Max realtime priority', ''], ['Max realtime timeout', 'us']];
  const limits = (p: Proc): string => {
    const say = (x: bigint): string => (x === 0xffffffffffffffffn ? 'unlimited' : String(x));
    return 'Limit                     Soft Limit           Hard Limit           Units     \n' + LIMITS.map(([name, unit], k) => {
      const [soft, hard] = p.limits[k] ?? [0xffffffffffffffffn, 0xffffffffffffffffn];
      return `${name.padEnd(26)}${say(soft).padEnd(21)}${say(hard).padEnd(21)}${unit ? unit.padEnd(10) : ''}\n`;
    }).join('');
  };
  const idMap = `${'0'.padStart(10)} ${'1000'.padStart(10)} ${'1'.padStart(10)}\n`;
  // /proc/net (and each process's: one network here), made from net-view.ts.
  const netFiles = procNet(kernel);
  const net = new Listing(() => new Map(Object.entries(netFiles).map(([name, make]) => [name, new Made(make)])));

  const mounts = () => 'rootfs / rootfs rw 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev 0 0\ndevtmpfs /dev devtmpfs rw,nosuid 0 0\n';
  const used = () => live().reduce((n, p) => n + (p.state === 'live' ? memoryBytes(p) : 0), 0);
  const sys = new Map<string, Entry>([
    ['kernel', new Listing(() => new Map<string, Entry>([
      ['ostype', new Made(() => 'Linux\n')], ['osrelease', new Made(() => '6.1.0\n')], ['version', new Made(() => '#1 muk\n')],
      ['hostname', new Made(() => `${kernel.hostname ?? 'length3'}\n`)], ['pid_max', new Made(() => '4194304\n')], ['threads-max', new Made(() => '63432\n')],
      ['random', new Listing(() => new Map<string, Entry>([['uuid', new Made(() => uuid() + '\n')], ['boot_id', new Made(() => bootId + '\n')]]))],
    ]))],
    ['vm', new Listing(() => new Map<string, Entry>([['overcommit_memory', new Made(() => '0\n')], ['max_map_count', new Made(() => '65530\n')]]))],
    ['fs', new Listing(() => new Map<string, Entry>([['file-max', new Made(() => '9223372036854775807\n')], ['nr_open', new Made(() => '1048576\n')]]))],
  ]);
  const bootId = uuid();
  const machine = new Map<string, Entry>([
    ['uptime', new Made(() => { const u = uptime(); return `${u.toFixed(2)} ${(idle() / 1000).toFixed(2)}\n`; })],
    ['loadavg', new Made(() => { const r = Math.max(1, kernel.runq.length); const l = Math.min(r, cpus).toFixed(2); return `${l} ${l} ${l} ${r}/${live().length} ${kernel.nextPid - 1}\n`; })],
    ['stat', new Made(() => {
      // The time the threads ran their programs and the kernel their calls, and the rest of every processor's: idle.
      const user = ticks(kernel.cpu.user / cpus), sys = ticks(kernel.cpu.sys / cpus), rest = ticks(idle() / cpus);
      const cpu = (n: string, k = 1): string => `${n} ${user * k} 0 ${sys * k} ${rest * k} 0 0 0 0 0 0`;
      return [cpu('cpu ', cpus), ...Array.from({length: cpus}, (_, k) => cpu(`cpu${k}`)), 'intr 0', 'ctxt 0', `btime ${bootEpoch}`,
        `processes ${kernel.nextPid - 1}`, `procs_running ${Math.max(1, kernel.runq.length)}`, `procs_blocked ${kernel.blocked.size}`, ''].join('\n');
    })],
    ['meminfo', new Made(() => {
      // Linux's fields in Linux's order (tools look for several of them together, BusyBox's free for Cached,
      // SReclaimable and MemAvailable before it says what is available).
      const kb = (b: number): string => `${Math.floor(b / 1024)}`.padStart(8) + ' kB';
      const held = used(), free = Math.max(0, total - held);
      return ([['MemTotal', total], ['MemFree', free], ['MemAvailable', free], ['Buffers', 0], ['Cached', 0], ['SwapCached', 0],
        ['Active', held], ['Inactive', 0], ['Unevictable', 0], ['Mlocked', 0], ['SwapTotal', 0], ['SwapFree', 0], ['Dirty', 0],
        ['Writeback', 0], ['AnonPages', held], ['Mapped', 0], ['Shmem', 0], ['KReclaimable', 0], ['Slab', 0], ['SReclaimable', 0],
        ['SUnreclaim', 0], ['KernelStack', 0], ['PageTables', 0], ['CommitLimit', total], ['Committed_AS', held], ['VmallocTotal', 0],
        ['VmallocUsed', 0], ['HugePages_Total', null], ['Hugepagesize', 2 << 20]] as [string, number | null][])
        .map(([k, v]) => v === null ? `${k}:       0` : `${(k + ':').padEnd(16)}${kb(v)}`).join('\n') + '\n';
    })],
    ['cpuinfo', new Made(() => Array.from({length: cpus}, (_, k) => `processor\t: ${k}\nvendor_id\t: GenuineIntel\nmodel name\t: sods x86-64\ncpu MHz\t\t: 3000.000\ncpu cores\t: ${cpus}\nflags\t\t: fpu tsc cx8 cmov sse sse2 ssse3 sse4_1 sse4_2 popcnt\n\n`).join(''))],
    ['mounts', new Made(mounts)],
    ['version', new Made(() => 'Linux version 6.1.0 (muk) #1 muk\n')],
    ['filesystems', new Made(() => 'nodev\tproc\nnodev\ttmpfs\nnodev\tdevtmpfs\n')],
    ['cmdline', new Made(() => 'console=ttyS0\n')],
    ['self', new Pointer(() => String(caller()?.pid ?? 1))],
    ['net', new Link('self/net')],
    ['thread-self', new Pointer(() => { const t = kernel.current; return t ? `${t.proc.pid}/task/${t.tid}` : '1'; })],
    ['sys', new Listing(() => sys)],
  ]);
  const prune = (): void => { for (const pid of dirs.keys()) if (!kernel.procs.has(pid)) dirs.delete(pid); };
  const entries = new Found((name) => {
    const m = machine.get(name);
    if (m || !/^[1-9]\d*$/.test(name)) return m;
    const p = kernel.procs.get(Number(name));
    // (Those of processes gone are let go of now and then, as a listing lets them go.)
    if (dirs.size > 2 * kernel.procs.size + 64) prune();
    return p ? dirOf(p) : undefined;
  }, () => {
    const m = new Map<string, Entry>(machine);
    for (const [pid, p] of kernel.procs) m.set(String(pid), dirOf(p));
    prune();
    return m;
  });
  const proc = new Listing(() => entries);
  vfs.root.entries.set('proc', proc);
  // As on Linux: /dev/fd and the standard streams through /proc/self.
  const dev = vfs.mkdirp('/dev');
  for (const [name, target] of [['fd', '/proc/self/fd'], ['stdin', '/proc/self/fd/0'], ['stdout', '/proc/self/fd/1'], ['stderr', '/proc/self/fd/2']]) {
    if (!dev.entries.has(name)) dev.entries.set(name, new Link(target));
  }
}

/** A /proc/PID/fd/N an open names: that process and descriptor (opening it opens what the descriptor has open). */
export function procDescriptor(kernel: Kern, path: string): Description | null {
  const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path);
  if (!m) return null;
  const p = kernel.procs.get(Number(m[1]));
  const from = kernel.current?.proc ?? kernel.procs.get(1);
  if (p && from && from !== p && !p.dumpable && !(from.caps.effective & (1n << 19n))) throw new FsError(E.ACCES);
  return p?.fds.get(Number(m[2])) ?? null;
}

export {Made, S_IFREG};
