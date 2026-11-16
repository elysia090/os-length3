// Who a thread is, as Linux has it: its user and group ids (real, effective, saved, and the one files are asked by),
// its other groups, its capabilities, and the user namespace all of these are in. An id is kept as the first
// namespace's (the kernel's own: what a file's owner is too), and is another number to one in a namespace that maps
// it, or no one's (65534) to one in a namespace that does not. A capability is over what its namespace owns, and
// over nothing above it.
//
// A Cred is not changed once made: a thread that becomes someone else takes a new one (as Linux's commit_creds), so
// a fork, a thread and a file that remembers who opened it share one without a copy.

import {S_IFDIR, S_IFMT, guard} from './fs.ts';
import type {Dir, Node} from './fs.ts';

/** The capabilities, by Linux's numbers. */
export const CAP = {CHOWN: 0, DAC_OVERRIDE: 1, DAC_READ_SEARCH: 2, FOWNER: 3, FSETID: 4, KILL: 5, SETGID: 6, SETUID: 7, SETPCAP: 8,
  LINUX_IMMUTABLE: 9, NET_BIND_SERVICE: 10, NET_BROADCAST: 11, NET_ADMIN: 12, NET_RAW: 13, IPC_LOCK: 14, IPC_OWNER: 15, SYS_MODULE: 16,
  SYS_RAWIO: 17, SYS_CHROOT: 18, SYS_PTRACE: 19, SYS_PACCT: 20, SYS_ADMIN: 21, SYS_BOOT: 22, SYS_NICE: 23, SYS_RESOURCE: 24, SYS_TIME: 25,
  SYS_TTY_CONFIG: 26, MKNOD: 27, LEASE: 28, AUDIT_WRITE: 29, AUDIT_CONTROL: 30, SETFCAP: 31, MAC_OVERRIDE: 32, MAC_ADMIN: 33, SYSLOG: 34,
  WAKE_ALARM: 35, BLOCK_SUSPEND: 36, AUDIT_READ: 37, PERFMON: 38, BPF: 39, CHECKPOINT_RESTORE: 40};
/** The last capability this kernel has (/proc/sys/kernel/cap_last_cap), and all of them. */
export const CAP_LAST = 40;
export const CAPS = (1n << BigInt(CAP_LAST + 1)) - 1n;
const bit = (cap: number): bigint => 1n << BigInt(cap);
/** Those that are over files: what an id for files of 0 has, and another has not (cap_task_fix_setuid). */
const FS_CAPS = bit(CAP.CHOWN) | bit(CAP.MKNOD) | bit(CAP.DAC_OVERRIDE) | bit(CAP.DAC_READ_SEARCH) | bit(CAP.FOWNER) | bit(CAP.FSETID) | bit(CAP.LINUX_IMMUTABLE) | bit(CAP.MAC_OVERRIDE);

/** The id of one a namespace has no number for (overflowuid, overflowgid). */
export const NOBODY = 65534;

/** A run of ids of a namespace mapped onto a run of its parent's: `n` of them, `inside` on `outside`. */
export interface Span { inside: number; outside: number; n: number }

let spaces = 0xeffffffb;
/** A number for a namespace, as its file under /proc/PID/ns says it (its inode there): Linux's start at 4026531836. */
export const spaceId = (): number => ++spaces;

/** A user namespace: who made it, which ids of its parent's are ids in it, and whether groups may be set in it. */
export class UserNs {
  readonly id = spaceId();
  declare readonly parent: UserNs | null;
  declare readonly level: number;
  /** Who made it (the first namespace's ids): the one whose capabilities in its parent are capabilities over it. */
  declare readonly owner: number;
  declare readonly group: number;
  /** Its ids on its parent's (null: not written yet, and no id is one of its own). The first namespace's are themselves. */
  uids: Span[] | null = null;
  gids: Span[] | null = null;
  /** setgroups(2) may be asked in it ("allow"), until it is denied; once its groups are mapped, that is not changed. */
  setgroups = true;
  constructor(parent: UserNs | null, owner = 0, group = 0) {
    this.parent = parent;
    this.level = parent ? parent.level + 1 : 0;
    this.owner = owner;
    this.group = group;
  }
}

/** The first user namespace: the kernel's own ids. */
export const HOST = new UserNs(null);

const mapDown = (spans: Span[] | null, id: number): number => {
  for (const s of spans ?? []) if (id >= s.inside && id - s.inside < s.n) return s.outside + (id - s.inside);
  return -1;
};
const mapUp = (spans: Span[] | null, id: number): number => {
  for (const s of spans ?? []) if (id >= s.outside && id - s.outside < s.n) return s.inside + (id - s.outside);
  return -1;
};
/** The kernel's own id for `id` of namespace `ns` (a group's with `group`): -1 where `ns` has no such id. */
export function idOf(ns: UserNs, id: number, group = false): number {
  for (let at: UserNs = ns; at.parent && id >= 0; at = at.parent) id = mapDown(group ? at.gids : at.uids, id);
  return id;
}
/** What `ns` calls the kernel's `id` (a group's with `group`): -1 where it has no number for it. */
export function idIn(ns: UserNs, id: number, group = false): number {
  if (!ns.parent) return id;
  const up = idIn(ns.parent, id, group);
  return up < 0 ? -1 : mapUp(group ? ns.gids : ns.uids, up);
}
/** As `idIn`, the id no one is where there is none: what a stat, a getuid and /proc say. */
export const shownIn = (ns: UserNs, id: number, group = false): number => { const x = idIn(ns, id, group); return x < 0 ? NOBODY : x; };

/** Whether `ns` is `of`, or a namespace made in it, however far down. */
export function within(ns: UserNs, of: UserNs): boolean {
  for (let at: UserNs | null = ns; at; at = at.parent) if (at === of) return true;
  return false;
}

export class Cred {
  declare readonly ns: UserNs;
  declare readonly uid: number;
  declare readonly euid: number;
  declare readonly suid: number;
  declare readonly fsuid: number;
  declare readonly gid: number;
  declare readonly egid: number;
  declare readonly sgid: number;
  declare readonly fsgid: number;
  declare readonly groups: readonly number[];
  declare readonly permitted: bigint;
  declare readonly effective: bigint;
  declare readonly inheritable: bigint;
  declare readonly bounding: bigint;
  declare readonly ambient: bigint;
  /** Its capabilities stay when it stops being root (PR_SET_KEEPCAPS), until it runs a program. */
  declare readonly keep: boolean;
  /** It is asked nothing of a file's mode: every capability over files, in the first namespace (what most processes here are). */
  declare readonly over: boolean;
  constructor(from: Partial<Cred> & {ns: UserNs}) {
    this.ns = from.ns;
    this.uid = from.uid ?? 0, this.euid = from.euid ?? 0, this.suid = from.suid ?? 0, this.fsuid = from.fsuid ?? 0;
    this.gid = from.gid ?? 0, this.egid = from.egid ?? 0, this.sgid = from.sgid ?? 0, this.fsgid = from.fsgid ?? 0;
    this.groups = from.groups ?? [];
    this.permitted = from.permitted ?? CAPS, this.effective = from.effective ?? CAPS, this.inheritable = from.inheritable ?? 0n;
    this.bounding = from.bounding ?? CAPS, this.ambient = from.ambient ?? 0n;
    this.keep = from.keep ?? false;
    const both = bit(CAP.DAC_OVERRIDE) | bit(CAP.DAC_READ_SEARCH);
    this.over = !this.ns.parent && (this.effective & both) === both;
  }
  /** This one, with `change` of it another. */
  with(change: Partial<Cred>): Cred { return new Cred({...this, ...change}); }
}

/** Root of the first namespace, with every capability: what the first process is. */
export const ROOT = new Cred({ns: HOST});

/**
 * Whether one who is `c` has capability `cap` over what namespace `over` owns: it has it in that very namespace, or
 * made that namespace (or one above it) in its own, where whoever made a namespace has every capability over it.
 */
export function capable(c: Cred, cap: number, over: UserNs = HOST): boolean {
  for (let ns = over; ;) {
    if (ns === c.ns) return (c.effective & bit(cap)) !== 0n;
    if (ns.level <= c.ns.level || !ns.parent) return false;
    if (ns.parent === c.ns && ns.owner === c.euid) return true;
    ns = ns.parent;
  }
}

const inGroup = (c: Cred, gid: number): boolean => c.fsgid === gid || c.groups.includes(gid);
/** Whether `c`'s capabilities are over `node` at all: its owner and its group are ids `c`'s namespace has. */
const reaches = (c: Cred, node: Node): boolean => !c.ns.parent || (idIn(c.ns, node.uid) >= 0 && idIn(c.ns, node.gid, true) >= 0);
/** Capability `cap` over the file `node` (Linux's capable_wrt_inode_uidgid). */
export const capableOver = (c: Cred, node: Node, cap: number): boolean => (c.effective & bit(cap)) !== 0n && reaches(c, node);

export const MAY = {EXEC: 1, WRITE: 2, READ: 4};
/**
 * Whether `c` may do `want` (MAY, added) to `node`, by its mode and who owns it: as its owner, as one of its group,
 * or as anyone else, the first that it is and no other; and past that by capability, which reads and writes anything
 * (CAP_DAC_OVERRIDE), runs what anyone at all may run, and reads and searches what it cannot write (CAP_DAC_READ_SEARCH).
 */
export function may(c: Cred, node: Node, want: number): boolean {
  if (c.over && (!(want & MAY.EXEC) || (node.mode & S_IFMT) === S_IFDIR || node.mode & 0o111)) return true;
  const mode = node.mode, bits = c.fsuid === node.uid ? mode >> 6 : inGroup(c, node.gid) ? mode >> 3 : mode;
  if ((bits & want) === want) return true;
  if (!reaches(c, node)) return false;
  const override = (c.effective & bit(CAP.DAC_OVERRIDE)) !== 0n, search = (c.effective & bit(CAP.DAC_READ_SEARCH)) !== 0n;
  if ((mode & S_IFMT) === S_IFDIR) return override || (search && !(want & MAY.WRITE));
  if (override && (!(want & MAY.EXEC) || mode & 0o111)) return true;
  return search && want === MAY.READ;
}
guard.search = (c, dir: Dir): boolean => (c as Cred).over || may(c as Cred, dir, MAY.EXEC);

/** Whether `c` is `node`'s owner, or stands for it (CAP_FOWNER): what a chmod, a utime and an unlink in a sticky directory ask. */
export const owns = (c: Cred, node: Node): boolean => c.fsuid === node.uid || capableOver(c, node, CAP.FOWNER);

/**
 * `c` with its user ids changed to `next` (as set*id leave them), its capabilities following as Linux's do
 * (cap_task_fix_setuid): one that was root by any of its three and is by none loses them all, unless it keeps them
 * (PR_SET_KEEPCAPS); its effective ones go as its effective id leaves root and come back as it returns; and those over
 * files follow the id files are asked by.
 */
export function asUser(c: Cred, next: {uid: number; euid: number; suid: number; fsuid: number}): Cred {
  const root = idOf(c.ns, 0);
  let {permitted, effective, ambient} = c;
  const was = c.uid === root || c.euid === root || c.suid === root, is = next.uid === root || next.euid === root || next.suid === root;
  if (was && !is) {
    if (!c.keep) permitted = 0n, effective = 0n;
    ambient = 0n;
  }
  if (c.euid === root && next.euid !== root) effective = 0n;
  if (c.euid !== root && next.euid === root) effective = permitted;
  if (c.fsuid === root && next.fsuid !== root) effective &= ~FS_CAPS;
  if (c.fsuid !== root && next.fsuid === root) effective |= permitted & FS_CAPS;
  return c.with({...next, permitted, effective, ambient});
}

/**
 * `c` as it runs a program (execve): with no capabilities kept in files here, root's program has what it may inherit
 * and all its bounding set allows, and effective at once where its effective id is root; another's has its ambient
 * ones alone. `setuid`, `setgid`: the ids the file's mode says it runs as (the kernel's own; -1, none), which undo
 * the ambient ones. Its saved ids are its effective ones, and it keeps no capabilities past root again.
 */
export function asProgram(c: Cred, setuid = -1, setgid = -1): Cred {
  const root = idOf(c.ns, 0);
  const euid = setuid >= 0 ? setuid : c.euid, egid = setgid >= 0 ? setgid : c.egid;
  const ambient = setuid >= 0 || setgid >= 0 ? 0n : c.ambient;
  const full = euid === root || c.uid === root;
  const permitted = (full ? c.inheritable | c.bounding : 0n) | ambient;
  const effective = euid === root ? permitted : ambient;
  return c.with({euid, suid: euid, fsuid: euid, egid, sgid: egid, fsgid: egid, permitted, effective, ambient, keep: false});
}

/** What `c` is in a user namespace it makes: itself, with every capability there and none kept from above. */
export const inNew = (c: Cred, ns: UserNs): Cred => c.with({ns, permitted: CAPS, effective: CAPS, inheritable: 0n, bounding: CAPS, ambient: 0n, keep: false});

/**
 * An id map as it is written to /proc/PID/uid_map or gid_map: lines of "inside outside count". Null where it is not
 * one: no line or more than 340, a count of nothing, a run past the last id, two runs that overlap on either side.
 */
export function spans(text: string): Span[] | null {
  const out: Span[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) return null;
    const s = {inside: Number(m[1]), outside: Number(m[2]), n: Number(m[3])};
    if (!s.n || s.inside + s.n > 0xffffffff || s.outside + s.n > 0xffffffff) return null;
    for (const o of out) {
      if (s.inside < o.inside + o.n && o.inside < s.inside + s.n) return null;
      if (s.outside < o.outside + o.n && o.outside < s.outside + s.n) return null;
    }
    out.push(s);
  }
  return out.length && out.length <= 340 ? out : null;
}
