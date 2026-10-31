// /proc as Linux has it: made from the kernel's own processes each time it is read, not files written once.
//
// Each process is a directory by its pid (stat, status, cmdline, comm, environ, maps, cwd, exe, fd/, task/); /proc/self
// is the process that asks. What is read is made when the file is opened (a snapshot, as Linux's seq files give it),
// so a reader sees one consistent text however it reads it; stat says 0 bytes, as Linux does. The machine-wide files
// (uptime, loadavg, stat, meminfo, cpuinfo, mounts, version, sys/...) say what this kernel is doing.

import {Dir, File, Link, S_IFREG} from './fs.mjs';

const enc = new TextEncoder();
const HZ = 100;
const PAGE = 4096;

/** A file whose text is made when it is opened. */
class Made extends File {
  constructor(make, mode = 0o444) { super(new Uint8Array(0), mode); this.make = make; }
  /** What an open reads: the text as it is now, a file of its own. */
  snapshot() { const f = new File(enc.encode(this.make()), this.mode & 0o7777); f.ino = this.ino; return f; }
}

/** A directory whose entries are made each time it is looked in. */
class Listing extends Dir {
  constructor(list, mode = 0o555) { super(mode); this.list = list; }
  get entries() { return this.list(); }
  set entries(_) { /* made, not kept */ }
}

/** A link whose target is made each time it is followed. */
class Pointer extends Link {
  constructor(target) { super(''); this.make = target; }
  get target() { return this.make(); }
  set target(_) { /* made, not kept */ }
}

const comm = (p) => (p.argv?.[0] ?? 'init').split('/').pop().slice(0, 15);
const state = (k, p) => p.state === 'zombie' ? 'Z' : p.stopped ? 'T' : k.current?.proc === p ? 'R' : 'S';
const STATE = {R: 'R (running)', S: 'S (sleeping)', Z: 'Z (zombie)', T: 'T (stopped)'};
const memoryBytes = (p) => p.memory?.buffer?.byteLength ?? 0;
const hex = (bits) => bits.toString(16).padStart(16, '0');

/** Signals a process ignores and catches, as Linux's status masks. */
function signalMasks(p) {
  let ign = 0n, cgt = 0n;
  for (const [sig, h] of p.actions ?? []) {
    const bit = 1n << BigInt(sig - 1);
    if (h.handler === 1n) ign |= bit; else if (h.handler > 1n) cgt |= bit;
  }
  return {ign, cgt};
}

/** What one of a process's descriptors points at, as /proc/PID/fd/N says it. */
function pointsAt(d) {
  switch (d.kind) {
    case 'file': case 'dir': case 'device': return d.path || '/';
    case 'pipe-r': case 'pipe-w': return `pipe:[${d.pipe?.id ?? 0}]`;
    case 'console': return '/dev/pts/0';
    case 'eventfd': return 'anon_inode:[eventfd]';
    case 'epoll': return 'anon_inode:[eventpoll]';
    default: return `anon_inode:[${d.kind}]`;
  }
}

/** Mount /proc on `kernel.vfs`, made from `kernel`. */
export function mountProc(kernel) {
  const vfs = kernel.vfs;
  const booted = performance.now();
  const bootEpoch = Math.floor(Date.now() / 1000);
  const cpus = Math.max(1, Math.min(64, globalThis.navigator?.hardwareConcurrency ?? 1));
  const ticks = (ms) => Math.floor(ms * HZ / 1000);
  const uptime = () => (performance.now() - booted) / 1000;
  const total = kernel.machine.memory; // the machine's (machine.mjs)
  const caller = () => kernel.current?.proc ?? kernel.procs.get(1);
  const live = () => [...kernel.procs.values()];

  const stat = (p) => {
    const mem = memoryBytes(p);
    const tty = p.sid && p.sid === kernel.tty.sid ? 34816 : 0;
    const f = [p.pid, `(${comm(p)})`, state(kernel, p), p.ppid, p.pgid, p.sid, tty, tty ? kernel.tty.fg : -1, 4194560,
      0, 0, 0, 0, ticks(p.cpu ?? 0), 0, 0, 0, 20, 0, Math.max(1, p.tasks?.size ?? 1), 0, ticks((p.started ?? booted) - booted),
      mem, Math.ceil(mem / PAGE), '18446744073709551615', 0, 0, p.stackTop ?? 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, p.exitStatus ?? 0];
    return f.join(' ') + '\n';
  };
  const status = (p) => {
    const {ign, cgt} = signalMasks(p);
    const kb = Math.ceil(memoryBytes(p) / 1024);
    return [`Name:\t${comm(p)}`, `Umask:\t${(p.umask ?? 0o22).toString(8).padStart(4, '0')}`, `State:\t${STATE[state(kernel, p)]}`,
      `Tgid:\t${p.pid}`, 'Ngid:\t0', `Pid:\t${p.pid}`, `PPid:\t${p.ppid}`, 'TracerPid:\t0', 'Uid:\t0\t0\t0\t0', 'Gid:\t0\t0\t0\t0',
      `FDSize:\t${Math.max(64, p.fds?.slots?.size ?? 0)}`, 'Groups:\t', `VmPeak:\t${kb} kB`, `VmSize:\t${kb} kB`, `VmRSS:\t${kb} kB`,
      `Threads:\t${Math.max(1, p.tasks?.size ?? 1)}`, 'SigQ:\t0/63432', `SigPnd:\t${hex(0n)}`, `ShdPnd:\t${hex(0n)}`, `SigBlk:\t${hex(0n)}`,
      `SigIgn:\t${hex(ign)}`, `SigCgt:\t${hex(cgt)}`, `Cpus_allowed_list:\t0-${cpus - 1}`, ''].join('\n');
  };
  const maps = (p) => {
    const exe = p.exe ?? '';
    const lo = p.image?.facts?.imageStart ?? 0x400000, hi = p.image?.facts?.imageEnd ?? lo;
    const line = (a, b, perm, name) => `${a.toString(16).padStart(8, '0')}-${b.toString(16).padStart(8, '0')} ${perm} 00000000 00:00 0${name ? ' '.repeat(18) + name : ''}`;
    const out = [];
    if (hi > lo) out.push(line(lo, hi, 'r-xp', exe));
    if (p.stackTop) out.push(line(p.stackLow, p.stackTop, 'rw-p', '[stack]'));
    if (p.mapEnd > p.mapBase) out.push(line(p.mapBase, p.mapEnd, 'rw-p', ''));
    return out.join('\n') + '\n';
  };
  const fdDir = (p) => new Listing(() => new Map([...(p.fds?.slots ?? new Map()).entries()].map(([fd, s]) => [String(fd), new Pointer(() => pointsAt(s.description))])), 0o500);

  // Each process's directory, kept while it is there (its inode stays the same between looks).
  const dirs = new Map();
  const dirOf = (p) => {
    const kept = dirs.get(p.pid);
    if (kept?.proc === p) return kept.dir;
    const files = new Map([
      ['stat', new Made(() => stat(p))],
      ['status', new Made(() => status(p))],
      ['cmdline', new Made(() => p.state === 'zombie' ? '' : (p.argv ?? []).map((a) => a + '\0').join(''))],
      ['comm', new Made(() => comm(p) + '\n')],
      ['environ', new Made(() => (p.env ?? []).map((e) => e + '\0').join(''), 0o400)],
      ['maps', new Made(() => maps(p))],
      ['statm', new Made(() => { const pg = Math.ceil(memoryBytes(p) / PAGE); return `${pg} ${pg} 0 0 0 ${pg} 0\n`; })],
      ['limits', new Made(() => 'Limit                     Soft Limit           Hard Limit           Units     \nMax open files            1024                 1048576              files     \n')],
      ['mounts', new Made(() => mounts())],
      ['cwd', new Pointer(() => p.cwd)],
      ['exe', new Pointer(() => p.exe ?? '')],
      ['root', new Pointer(() => '/')],
      ['fd', null],
      ['task', null],
    ]);
    const dir = new Listing(() => {
      files.set('fd', fdDir(p));
      files.set('task', new Listing(() => new Map([...(p.tasks ?? [])].map((t) => [String(t.tid), new Listing(() => new Map([
        ['stat', new Made(() => stat(p).replace(/^\d+/, String(t.tid)))], ['status', new Made(() => status(p))], ['comm', new Made(() => comm(p) + '\n')],
      ]))]))));
      return files;
    });
    dirs.set(p.pid, {proc: p, dir});
    return dir;
  };

  const mounts = () => 'rootfs / rootfs rw 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev 0 0\ndevtmpfs /dev devtmpfs rw,nosuid 0 0\n';
  const used = () => live().reduce((n, p) => n + (p.state === 'live' ? memoryBytes(p) : 0), 0);
  const sys = new Map([
    ['kernel', new Listing(() => new Map([
      ['ostype', new Made(() => 'Linux\n')], ['osrelease', new Made(() => '6.1.0\n')], ['version', new Made(() => '#1 xlat\n')],
      ['hostname', new Made(() => 'length3\n')], ['pid_max', new Made(() => '4194304\n')], ['threads-max', new Made(() => '63432\n')],
      ['random', new Listing(() => new Map([['uuid', new Made(() => crypto.randomUUID() + '\n')], ['boot_id', new Made(() => bootId + '\n')]]))],
    ]))],
    ['vm', new Listing(() => new Map([['overcommit_memory', new Made(() => '0\n')], ['max_map_count', new Made(() => '65530\n')]]))],
    ['fs', new Listing(() => new Map([['file-max', new Made(() => '9223372036854775807\n')], ['nr_open', new Made(() => '1048576\n')]]))],
  ]);
  const bootId = crypto.randomUUID();
  const machine = new Map([
    ['uptime', new Made(() => { const u = uptime(); return `${u.toFixed(2)} ${(u * cpus * 0.95).toFixed(2)}\n`; })],
    ['loadavg', new Made(() => { const r = Math.max(1, kernel.runq?.length ?? 1); const l = Math.min(r, cpus).toFixed(2); return `${l} ${l} ${l} ${r}/${live().length} ${kernel.nextPid - 1}\n`; })],
    ['stat', new Made(() => {
      const busy = ticks(performance.now() - booted);
      const cpu = (n) => `${n} ${busy} 0 0 ${busy * 19} 0 0 0 0 0 0`;
      return [cpu('cpu '), ...Array.from({length: cpus}, (_, k) => cpu(`cpu${k}`)), 'intr 0', 'ctxt 0', `btime ${bootEpoch}`,
        `processes ${kernel.nextPid - 1}`, `procs_running ${Math.max(1, kernel.runq?.length ?? 1)}`, `procs_blocked ${kernel.blocked?.size ?? 0}`, ''].join('\n');
    })],
    ['meminfo', new Made(() => {
      // Linux's fields in Linux's order (tools look for several of them together, BusyBox's free for Cached,
      // SReclaimable and MemAvailable before it says what is available).
      const kb = (b) => `${Math.floor(b / 1024)}`.padStart(8) + ' kB';
      const held = used(), free = Math.max(0, total - held);
      return [['MemTotal', total], ['MemFree', free], ['MemAvailable', free], ['Buffers', 0], ['Cached', 0], ['SwapCached', 0],
        ['Active', held], ['Inactive', 0], ['Unevictable', 0], ['Mlocked', 0], ['SwapTotal', 0], ['SwapFree', 0], ['Dirty', 0],
        ['Writeback', 0], ['AnonPages', held], ['Mapped', 0], ['Shmem', 0], ['KReclaimable', 0], ['Slab', 0], ['SReclaimable', 0],
        ['SUnreclaim', 0], ['KernelStack', 0], ['PageTables', 0], ['CommitLimit', total], ['Committed_AS', held], ['VmallocTotal', 0],
        ['VmallocUsed', 0], ['HugePages_Total', null], ['Hugepagesize', 2 << 20]]
        .map(([k, v]) => v === null ? `${k}:       0` : `${(k + ':').padEnd(16)}${kb(v)}`).join('\n') + '\n';
    })],
    ['cpuinfo', new Made(() => Array.from({length: cpus}, (_, k) => `processor\t: ${k}\nvendor_id\t: GenuineIntel\nmodel name\t: xlat x86-64\ncpu MHz\t\t: 3000.000\ncpu cores\t: ${cpus}\nflags\t\t: fpu tsc cx8 cmov sse sse2 ssse3 sse4_1 sse4_2 popcnt\n\n`).join(''))],
    ['mounts', new Made(mounts)],
    ['version', new Made(() => 'Linux version 6.1.0 (xlat) #1 xlat\n')],
    ['filesystems', new Made(() => 'nodev\tproc\nnodev\ttmpfs\nnodev\tdevtmpfs\n')],
    ['cmdline', new Made(() => 'console=ttyS0\n')],
    ['self', new Pointer(() => String(caller()?.pid ?? 1))],
    ['thread-self', new Pointer(() => { const t = kernel.current; return t ? `${t.proc.pid}/task/${t.tid}` : '1'; })],
    ['sys', new Listing(() => sys)],
  ]);
  const proc = new Listing(() => {
    const m = new Map(machine);
    for (const [pid, p] of kernel.procs) m.set(String(pid), dirOf(p));
    for (const pid of dirs.keys()) if (!kernel.procs.has(pid)) dirs.delete(pid);
    return m;
  });
  vfs.root.entries.set('proc', proc);
  // As on Linux: /dev/fd and the standard streams through /proc/self.
  const dev = vfs.lookup('/dev', '/');
  for (const [name, target] of [['fd', '/proc/self/fd'], ['stdin', '/proc/self/fd/0'], ['stdout', '/proc/self/fd/1'], ['stderr', '/proc/self/fd/2']]) {
    if (!dev.entries.has(name)) dev.entries.set(name, new Link(target));
  }
}

/** A /proc/PID/fd/N an open names: that process and descriptor (opening it opens what the descriptor has open). */
export function procDescriptor(kernel, path) {
  const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path);
  if (!m) return null;
  const p = kernel.procs.get(Number(m[1]));
  return p?.fds?.get(Number(m[2])) ?? null;
}

export {Made, S_IFREG};
