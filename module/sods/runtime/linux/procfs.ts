// /proc as Linux has it: made from the kernel's own processes each time it is read, not files written once.
//
// Each process is a directory by its pid (stat, status, cmdline, comm, environ, maps, cwd, exe, fd/, task/); /proc/self
// is the process that asks. What is read is made when the file is opened (a snapshot, as Linux's seq files give it),
// so a reader sees one consistent text however it reads it; stat says 0 bytes, as Linux does. The machine-wide files
// (uptime, loadavg, stat, meminfo, cpuinfo, mounts, version, sys/..., net/...) say what this kernel is doing.

import {Link, S_IFREG, E, FsError, Super, pathOf} from './fs.ts';
import {cpuOf} from './clock.ts';
import {procNet} from './net-view.ts';
import {uuid} from './flow.ts';
import {CAP, CAP_LAST, capable, idIn, idOf, shownIn, spans, type UserNs} from './cred.ts';
import {Lazy, Listing, Made, Pointer, refuse} from './made.ts';
import {mountinfo, mountsText} from './mount.ts';
import {NS, byNr, fileOf, nrIn, type Kind, type Named, type PidNs} from './space.ts';
import type {Description} from './fd.ts';
import type {Entry, Place} from './fs.ts';
import type {Kern, Proc} from './parts.ts';
import {epoch, processors, steady} from '../host.ts';

const HZ = 100;
const PAGE = 4096;

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
 * What one of a process's descriptors points at, as /proc/PID/fd/N says it to one whose root is `root`: where it is
 * now (renamed since it was opened, its new place; removed, where it lay, "(deleted)"), not the path it was opened by.
 */
function pointsAt(root: Place, d: Description): string {
  if (d.mnt && d.node && d.kind !== 'console') return pathOf(root, d.mnt, d.node, d.dir, d.name);
  switch (d.kind) {
    case 'file': case 'dir': case 'device': return d.path || '/';
    case 'pipe-r': case 'pipe-w': case 'pipe-rw': return `pipe:[${d.pipe?.id ?? 0}]`;
    case 'console': return '/dev/pts/0';
    case 'eventfd': return 'anon_inode:[eventfd]';
    case 'epoll': return 'anon_inode:[eventpoll]';
    case 'socket': return `socket:[${d.sock?.ino ?? 0}]`;
    default: return `anon_inode:[${d.kind}]`;
  }
}

/**
 * An id map of user namespace `ns` written (/proc/PID/uid_map, gid_map; `group`: the groups'), by `writer`: once
 * only; by one in it or in its parent, with the capability to set ids in it; of its parent's ids that are someone's
 * there; and, by one with no such capability over the parent, of the one id it is itself and no other (its groups'
 * only once setgroups is denied there).
 */
function writeMap(ns: UserNs, text: string, group: boolean, writer: Proc): void {
  const w = writer.cred, cap = group ? CAP.SETGID : CAP.SETUID, parent = ns.parent ?? refuse(E.PERM);
  if (group ? ns.gids : ns.uids) refuse(E.PERM);
  if ((w.ns !== ns && w.ns !== parent) || !capable(w, cap, ns)) refuse(E.PERM);
  const map = spans(text) ?? refuse(E.INVAL);
  for (const m of map) if (idOf(parent, m.outside, group) < 0 || idOf(parent, m.outside + m.n - 1, group) < 0) refuse(E.PERM);
  if (!capable(w, cap, parent)) {
    if (map.length !== 1 || map[0].n !== 1 || idOf(parent, map[0].outside, group) !== (group ? w.egid : w.euid)) refuse(E.PERM);
    if (!group && w.euid !== ns.owner) refuse(E.PERM);
    if (group && ns.setgroups) refuse(E.PERM);
  }
  if (group) ns.gids = map; else ns.uids = map;
}
/** That map as it is read by one in `reader`: its ids, and what `reader` (or, read from inside, its parent) calls each. */
function readMap(ns: UserNs, group: boolean, reader: UserNs): string {
  const pad = (n: number): string => String(n).padStart(10);
  if (!ns.parent) return `${pad(0)} ${pad(0)} ${pad(4294967295)}\n`;
  const lower = reader === ns ? ns.parent : reader, up = ns.parent;
  return ((group ? ns.gids : ns.uids) ?? []).map((m) => {
    const out = idIn(lower, idOf(up, m.outside, group), group);
    return `${pad(m.inside)} ${pad(out < 0 ? 4294967295 : out)} ${pad(m.n)}\n`;
  }).join('');
}

/**
 * A /proc of `kernel` for pid namespace `space`: the file system, made from the kernel as it is read. The processes
 * in it are those that namespace sees, each by the number it has there.
 */
export function procfs(kernel: Kern, space: PidNs = kernel.spaces.children): Super {
  /** What this /proc calls the process, thread, group or session the kernel numbers `id` (0: it is not seen here). */
  const nr = (id: number): number => nrIn(kernel.numbers, space, id);
  const booted = steady();
  const bootEpoch = Math.floor(epoch() / 1000);
  const cpus = processors();
  const ticks = (ms: number): number => Math.floor(ms * HZ / 1000);
  const uptime = () => (steady() - booted) / 1000;
  /** Every processor's time since it began that no thread had (ms). */
  const idle = () => Math.max(0, (steady() - booted) * cpus - kernel.cpu.user - kernel.cpu.sys);
  const total = kernel.machine.memory; // the machine's (machine.ts)
  const caller = () => kernel.current?.proc ?? kernel.procs.get(1);
  /** The root of the one who reads: what a place is named from. */
  const rootOf = (): Place => caller()?.fs.root ?? kernel.root;
  const readerNs = (): UserNs => caller()?.cred.ns ?? kernel.root.mnt.sb.owner as UserNs;
  const live = () => [...kernel.procs.values()].filter((p) => nr(p.pid) > 0);
  const inspect = (target: Proc): void => {
    const from = caller();
    if (from && from !== target && !target.dumpable && !capable(from.cred, CAP.SYS_PTRACE, target.cred.ns)) throw new FsError(E.ACCES);
  };

  const stat = (p: Proc): string => {
    const mem = memoryBytes(p);
    const tty = p.sid && p.sid === kernel.tty.sid ? 34816 : 0;
    // Its time on the processor and its waited-for children's (utime, stime, cutime, cstime): ps's TIME, top's %CPU.
    const c = cpuOf(p), w = p.waited;
    const f = [nr(p.pid), `(${comm(p)})`, state(kernel, p), nr(p.ppid), nr(p.pgid), nr(p.sid), tty, tty ? nr(kernel.tty.fg) : -1, 4194560,
      0, 0, 0, 0, ticks(c.user), ticks(c.sys), ticks(w.user), ticks(w.sys), 20, 0, Math.max(1, p.tasks.size), 0, ticks(p.started - booted),
      mem, Math.ceil(mem / PAGE), '18446744073709551615', 0, 0, p.stackTop ?? 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, p.exitStatus ?? 0];
    return f.join(' ') + '\n';
  };
  const status = (p: Proc): string => {
    const {ign, cgt} = signalMasks(p);
    const kb = Math.ceil(memoryBytes(p) / 1024);
    const c = p.cred, ns = readerNs(), u = (id: number): number => shownIn(ns, id), g = (id: number): number => shownIn(ns, id, true);
    return [`Name:\t${comm(p)}`, `Umask:\t${p.umask.toString(8).padStart(4, '0')}`, `State:\t${STATE[state(kernel, p)]}`,
      `Tgid:\t${nr(p.pid)}`, 'Ngid:\t0', `Pid:\t${nr(p.pid)}`, `PPid:\t${nr(p.ppid)}`, 'TracerPid:\t0', `Uid:\t${u(c.uid)}\t${u(c.euid)}\t${u(c.suid)}\t${u(c.fsuid)}`, `Gid:\t${g(c.gid)}\t${g(c.egid)}\t${g(c.sgid)}\t${g(c.fsgid)}`,
      `FDSize:\t${Math.max(64, p.fds.slots.size)}`, `Groups:\t${c.groups.map((x) => `${g(x)} `).join('')}`, `VmPeak:\t${kb} kB`, `VmSize:\t${kb} kB`, `VmRSS:\t${kb} kB`,
      `Threads:\t${Math.max(1, p.tasks.size)}`, 'SigQ:\t0/63432', `SigPnd:\t${hex(0n)}`, `ShdPnd:\t${hex(0n)}`, `SigBlk:\t${hex(0n)}`,
      `SigIgn:\t${hex(ign)}`, `SigCgt:\t${hex(cgt)}`, `CapInh:\t${hex(c.inheritable)}`, `CapPrm:\t${hex(c.permitted)}`,
      `CapEff:\t${hex(c.effective)}`, `CapBnd:\t${hex(c.bounding)}`, `CapAmb:\t${hex(c.ambient)}`, `NoNewPrivs:\t${p.noNewPrivs ? 1 : 0}`,
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
  /** A link to what descriptor `d` of `p` has open: its mode what the descriptor may do (read, write), as Linux shows it. */
  const fdLink = (p: Proc, d: Description): Pointer => {
    const link = new Pointer(() => { inspect(p); return pointsAt(rootOf(), d); }, () => { inspect(p); return d.mnt && d.node ? {mnt: d.mnt, node: d.node, held: d} : {held: d}; });
    const access = d.flags & 3;
    link.mode = 0o120000 | (access !== 1 ? 0o500 : 0) | (access !== 0 ? 0o200 : 0);
    return link;
  };
  const fdDir = (p: Proc): Listing => {
    const entries = new Lazy((name) => { const d = /^\d+$/.test(name) ? p.fds.get(Number(name)) : undefined; return d ? fdLink(p, d) : undefined; },
      () => new Map([...p.fds.slots].map(([fd, s]) => [String(fd), fdLink(p, s.description)])));
    return new Listing(() => entries, 0o500);
  };
  /** /proc/PID/ns: a link to each namespace `p` is in, by its kind and number. */
  const spacesOf = (p: Proc): [string, Kind, Named][] => [['cgroup', 'cgroup', p.ns.cgroup], ['ipc', 'ipc', p.ns.ipc], ['mnt', 'mnt', p.ns.mnt], ['net', 'net', p.ns.net],
    ['pid', 'pid', p.pidns], ['pid_for_children', 'pid', p.ns.children], ['user', 'user', p.cred.ns], ['uts', 'uts', p.ns.uts]];
  const nsDir = (p: Proc): Listing => new Listing(() => new Map(spacesOf(p).map(([name, kind, ns]) =>
    [name, new Pointer(() => { inspect(p); return `${kind}:[${ns.id}]`; }, () => { inspect(p); return fileOf(kind, ns); })])), 0o511);
  void NS;

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
      // Its user namespace's maps, written once by the one who made it; and whether groups may be set in it.
      ['uid_map', new Made(() => readMap(p.cred.ns, false, readerNs()), 0o644, (text) => writeMap(p.cred.ns, text, false, caller() ?? p))],
      ['gid_map', new Made(() => readMap(p.cred.ns, true, readerNs()), 0o644, (text) => writeMap(p.cred.ns, text, true, caller() ?? p))],
      ['setgroups', new Made(() => (p.cred.ns.setgroups ? 'allow\n' : 'deny\n'), 0o644, (text) => {
        const ns = p.cred.ns, allow = text.trim() === 'allow';
        if (!allow && text.trim() !== 'deny') refuse();
        if (!capable((caller() ?? p).cred, CAP.SYS_ADMIN, ns)) refuse(E.PERM);
        if (allow ? !ns.setgroups : ns.gids !== null && ns.setgroups) refuse(E.PERM);
        if (!allow && !ns.parent) refuse(E.PERM);
        ns.setgroups = allow;
      })],
      ['mounts', new Made(() => mountsText(p.fs.root))],
      ['mountinfo', new Made(() => mountinfo(p.fs.root))],
      ['cgroup', new Made(() => { const base = (caller() ?? p).ns.cgroup.root.path, at = p.cgroup.path; return `0::${at === base ? '/' : at.startsWith(base === '/' ? '/' : base + '/') ? at.slice(base === '/' ? 0 : base.length) : '/..' + at}\n`; })],
      ['cwd', new Pointer(() => { inspect(p); const at = p.fs.pwd; return pathOf(rootOf(), at.mnt, at.node); }, () => { inspect(p); return p.fs.pwd; })],
      ['exe', new Pointer(() => { inspect(p); const at = p.exeAt; return at ? pathOf(rootOf(), at.mnt, at.node, at.dir, at.name) : p.exe; }, () => { inspect(p); return p.exeAt ?? E.NOENT; })],
      ['root', new Pointer(() => { inspect(p); const at = p.fs.root; return pathOf(rootOf(), at.mnt, at.node); }, () => { inspect(p); return p.fs.root; })],
    ]);
    for (const name of ['uid_map', 'gid_map', 'setgroups']) { const f = files.get(name)!; f.uid = p.cred.euid; f.gid = p.cred.egid; }
    const dir = new Listing(() => {
      files.set('fd', fdDir(p));
      files.set('ns', nsDir(p));
      files.set('net', net);
      files.set('task', new Listing(() => new Map([...p.tasks].map((t) => [String(nr(t.tid)), new Listing(() => new Map<string, Entry>([
        ['stat', new Made(() => stat(p).replace(/^\d+/, String(nr(t.tid))))], ['status', new Made(() => status(p))], ['comm', new Made(() => comm(p) + '\n')],
        ['children', new Made(() => [...p.children].filter((c) => c.state === 'live' && nr(c.pid) > 0).map((c) => `${nr(c.pid)} `).join(''))],
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
  // /proc/net (and each process's: one network here), made from net-view.ts.
  const netFiles = procNet(kernel);
  const net = new Listing(() => new Map(Object.entries(netFiles).map(([name, make]) => [name, new Made(make)])));

  const used = () => live().reduce((n, p) => n + (p.state === 'live' ? memoryBytes(p) : 0), 0);
  const sys = new Map<string, Entry>([
    ['kernel', new Listing(() => new Map<string, Entry>([
      ['ostype', new Made(() => 'Linux\n')], ['osrelease', new Made(() => '6.1.0\n')], ['version', new Made(() => '#1 muk\n')],
      ['hostname', new Made(() => `${(caller()?.ns ?? kernel.spaces).uts.hostname}\n`)], ['domainname', new Made(() => `${(caller()?.ns ?? kernel.spaces).uts.domainname}\n`)],
      ['pid_max', new Made(() => '4194304\n')], ['threads-max', new Made(() => '63432\n')],
      ['cap_last_cap', new Made(() => `${CAP_LAST}\n`)], ['ngroups_max', new Made(() => '65536\n')],
      ['overflowuid', new Made(() => '65534\n')], ['overflowgid', new Made(() => '65534\n')],
      // (what the machine does with a program that fails, and what loads its parts: kept as written, and nothing done by either)
      ['core_pattern', new Made(() => corePattern + '\n', 0o644, (text) => { corePattern = text.replace(/\n$/, ''); })],
      ['modprobe', new Made(() => modprobe + '\n', 0o644, (text) => { modprobe = text.replace(/\n$/, ''); })],
      ['random', new Listing(() => new Map<string, Entry>([['uuid', new Made(() => uuid() + '\n')], ['boot_id', new Made(() => bootId + '\n')]]))],
    ]))],
    ['vm', new Listing(() => new Map<string, Entry>([['overcommit_memory', new Made(() => '0\n')], ['max_map_count', new Made(() => '65530\n')]]))],
    ['fs', new Listing(() => new Map<string, Entry>([['file-max', new Made(() => '9223372036854775807\n')], ['nr_open', new Made(() => '1048576\n')]]))],
  ]);
  const bootId = uuid();
  let corePattern = 'core', modprobe = '/sbin/modprobe';
  const machine = new Map<string, Entry>([
    ['uptime', new Made(() => { const u = uptime(); return `${u.toFixed(2)} ${(idle() / 1000).toFixed(2)}\n`; })],
    ['loadavg', new Made(() => { const r = Math.max(1, kernel.runq.length); const l = Math.min(r, cpus).toFixed(2); return `${l} ${l} ${l} ${r}/${live().length} ${space.last}\n`; })],
    ['stat', new Made(() => {
      // The time the threads ran their programs and the kernel their calls, and the rest of every processor's: idle.
      const user = ticks(kernel.cpu.user / cpus), sys = ticks(kernel.cpu.sys / cpus), rest = ticks(idle() / cpus);
      const cpu = (n: string, k = 1): string => `${n} ${user * k} 0 ${sys * k} ${rest * k} 0 0 0 0 0 0`;
      return [cpu('cpu ', cpus), ...Array.from({length: cpus}, (_, k) => cpu(`cpu${k}`)), 'intr 0', 'ctxt 0', `btime ${bootEpoch}`,
        `processes ${space.last}`, `procs_running ${Math.max(1, kernel.runq.length)}`, `procs_blocked ${kernel.blocked.size}`, ''].join('\n');
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
    ['mounts', new Link('self/mounts')],
    ['sysrq-trigger', new Made(() => '', 0o200, () => undefined)],
    ['version', new Made(() => 'Linux version 6.1.0 (muk) #1 muk\n')],
    ['filesystems', new Made(() => ['sysfs', 'tmpfs', 'proc', 'cgroup2', 'devtmpfs', 'devpts', 'mqueue'].map((k) => `nodev\t${k}\n`).join(''))],
    ['cmdline', new Made(() => 'console=ttyS0\n')],
    ['self', new Pointer(() => String(nr(caller()?.pid ?? 1)))],
    ['net', new Link('self/net')],
    ['thread-self', new Pointer(() => { const t = kernel.current; return t ? `${nr(t.proc.pid)}/task/${nr(t.tid)}` : '1'; })],
    ['sys', new Listing(() => sys)],
  ]);
  const prune = (): void => { for (const pid of dirs.keys()) if (!kernel.procs.has(pid)) dirs.delete(pid); };
  const entries = new Lazy((name) => {
    const m = machine.get(name);
    if (m || !/^[1-9]\d*$/.test(name)) return m;
    const p = kernel.procs.get(byNr(space, Number(name)));
    // (Those of processes gone are let go of now and then, as a listing lets them go.)
    if (dirs.size > 2 * kernel.procs.size + 64) prune();
    return p ? dirOf(p) : undefined;
  }, () => {
    const m = new Map<string, Entry>(machine);
    for (const [pid, p] of kernel.procs) if (nr(pid) > 0) m.set(String(nr(pid)), dirOf(p));
    prune();
    return m;
  });
  const proc = new Listing(() => entries);
  proc.refuses = E.NOENT;
  return new Super('proc', 0x9fa0, proc, 'proc');
}

export {S_IFREG};
