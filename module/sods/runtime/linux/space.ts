// What a process is in, as Linux has it: where it is in the tree (its root and where it works: `Fs`), and its
// namespaces (`Spaces`): the mounts it sees, the processes it sees and what it calls them, the machine's names, its
// IPC, its network, its cgroups. Each is one thing held by every process in it, and another once a process is put in
// one of its own (clone, unshare) or joins one (setns); a process's user namespace is with who it is (cred.ts).
//
// Each namespace has a number and a file by it (/proc/PID/ns/NAME leads there): two that are one namespace are one
// file, and one held open is a namespace kept, to be joined.

import {File, Mount, Super} from './fs.ts';
import type {Place} from './fs.ts';
import {HOST, spaceId, type UserNs} from './cred.ts';
import type {Space} from './mount.ts';
import type {Cgroup} from './cgroup.ts';

/** Where a process is in the tree: its root, where it works, and the mode bits it makes nothing with. Shared by what clone(CLONE_FS) made. */
export class Fs {
  declare root: Place;
  declare pwd: Place;
  declare umask: number;
  /** How many processes have it. */
  users = 1;
  constructor(root: Place, pwd: Place = root, umask = 0o022) {
    this.root = root, this.pwd = pwd, this.umask = umask;
    root.mnt.refs++, pwd.mnt.refs++;
  }
  /** One like it, for a process that goes its own way from here. */
  copy(): Fs { return new Fs(this.root, this.pwd, this.umask); }
  /** It works at `to` from now on. */
  go(to: Place): void { to.mnt.refs++; this.pwd.mnt.refs--; this.pwd = to; }
  /** Its root is `to` from now on. */
  turn(to: Place): void { to.mnt.refs++; this.root.mnt.refs--; this.root = to; }
  /** A process that had it is gone, or has another. */
  drop(): void { if (--this.users === 0) { this.root.mnt.refs--; this.pwd.mnt.refs--; } }
}

// ---- namespaces ----

/** The file system the namespaces' files are in (nsfs): reached only through /proc's links and what is held open. */
const nsfs = new Mount(new Super('nsfs', 0x6e736673, new File(new Uint8Array(0), 0o444), 'nsfs'));
/** The kinds of namespace, as clone's flags name them and as /proc/PID/ns does. */
export const NS = {mnt: 0x00020000, cgroup: 0x02000000, uts: 0x04000000, ipc: 0x08000000, user: 0x10000000, pid: 0x20000000, net: 0x40000000, time: 0x00000080} as const;
export type Kind = keyof typeof NS;
/** Anything that is a namespace: its number. (Each but a user namespace is owned by one: `owner`.) */
export interface Named { readonly id: number }

const files = new WeakMap<Named, File>(), named = new WeakMap<File, {kind: Kind; ns: Named}>();
/** The file of namespace `ns` (of kind `kind`), and where it is: what /proc/PID/ns/KIND leads to. */
export function fileOf(kind: Kind, ns: Named): Place {
  let f = files.get(ns);
  if (!f) {
    f = new File(new Uint8Array(0), 0o444);
    f.ino = ns.id;
    files.set(ns, f);
    named.set(f, {kind, ns});
  }
  return {mnt: nsfs, node: f};
}
/** The namespace a file is (and of what kind), where it is one's file. */
export const spaceOf = (node: unknown): {kind: Kind; ns: Named} | undefined => (node instanceof File ? named.get(node) : undefined);

/** The machine's names (UTS). */
export class Uts implements Named {
  readonly id = spaceId();
  declare readonly owner: UserNs;
  declare hostname: string;
  declare domainname: string;
  constructor(owner: UserNs, hostname = 'length3', domainname = '(none)') { this.owner = owner; this.hostname = hostname; this.domainname = domainname; }
}
/** What processes share that is neither a file nor a socket (System V's and POSIX's queues); and the file system of its queues. */
export class Ipc implements Named {
  readonly id = spaceId();
  queues: Super | null = null;
  declare readonly owner: UserNs;
  constructor(owner: UserNs) { this.owner = owner; }
}
/** A network: its sockets' names and ports are its own (sys-net.ts keeps what is in it). */
export class Net implements Named {
  readonly id = spaceId();
  declare readonly owner: UserNs;
  /** Its /sys, once one is mounted (sysfs.ts): the one file system however often. */
  sys: Super | null = null;
  /** The first one: what is asked of it past this machine goes to the host's network. */
  declare readonly first: boolean;
  /** Its loopback is up (the first one's is; one made is made with it down, as Linux makes it, until it is brought up). */
  up: boolean;
  constructor(owner: UserNs, first = false) { this.owner = owner; this.first = first; this.up = first; }
}
/** A view of the cgroups: the one that is its root. */
export class CgroupNs implements Named {
  readonly id = spaceId();
  declare readonly owner: UserNs;
  declare readonly root: Cgroup;
  constructor(owner: UserNs, root: Cgroup) { this.owner = owner; this.root = root; }
}

/**
 * The processes one sees, and what it calls them. A process has a number in the namespace it was made in and in
 * each above it; the first process of one (its number there 1) is what those left without a parent in it are given
 * to, and when it ends the rest end with it and no more are made in it.
 */
export class PidNs implements Named {
  readonly id = spaceId();
  declare readonly parent: PidNs | null;
  declare readonly level: number;
  /** The last number given in it, and each given that is still someone's: the kernel's own number for it. */
  last = 0;
  readonly numbers = new Map<number, number>();
  /** Its first process's own number (the kernel's), once it has one; and whether that one has ended. */
  init = 0;
  ended = false;
  /** Its /proc, once one is mounted (procfs.ts): the one file system however often. */
  proc: Super | null = null;
  declare readonly owner: UserNs;
  constructor(parent: PidNs | null, owner: UserNs) { this.parent = parent; this.owner = owner; this.level = parent ? parent.level + 1 : 0; }
}

/** The numbers something has: in the namespace it was made in (the last), and in each above it (the first is the kernel's own). */
export interface Numbered { readonly space: PidNs; readonly nrs: readonly number[] }
/** Numbers for one made in `space`: the next in it, and in each namespace above (the first's is the kernel's own, and is kept by none). */
export function number(space: PidNs): number[] {
  const nrs: number[] = [];
  for (let ns: PidNs | null = space; ns; ns = ns.parent) nrs[ns.level] = ++ns.last;
  for (let ns: PidNs | null = space; ns?.parent; ns = ns.parent) ns.numbers.set(nrs[ns.level], nrs[0]);
  return nrs;
}
/** What the kernel keeps of those it numbers: each not made in the first namespace, by its own number there. */
export type Numbers = Map<number, Numbered>;
/** What one in `viewer` calls the process, thread, group or session the kernel numbers `id` (0: none such is seen from there). */
export function nrIn(all: Numbers, viewer: PidNs, id: number): number {
  const it = all.get(id);
  return it ? seenAs(viewer, it) : viewer.parent ? 0 : id;
}
/** The kernel's own number for what one in `viewer` calls `nr` (0: nothing there has that number). */
export const byNr = (viewer: PidNs, nr: number): number => (viewer.parent ? viewer.numbers.get(nr) ?? 0 : nr);
/** Those numbers no longer anyone's (`used`: every number still a thread's, a process's, a group's or a session's) are let go of. */
export function forget(all: Numbers, used: Set<number>): void {
  for (const [id, it] of all) {
    if (used.has(id)) continue;
    all.delete(id);
    for (let ns: PidNs | null = it.space; ns?.parent; ns = ns.parent) ns.numbers.delete(it.nrs[ns.level]);
  }
}
/** What one in `viewer` calls `it`: its number there, or 0 where it is not seen from there (it is in a namespace above, or beside). */
export function seenAs(viewer: PidNs, it: Numbered): number {
  let ns: PidNs | null = it.space;
  while (ns && ns.level > viewer.level) ns = ns.parent;
  return ns === viewer ? it.nrs[viewer.level] : 0;
}

/** The namespaces a process is in (its user namespace apart: cred.ts). What it starts is made in `children`. */
export interface Spaces {
  readonly mnt: Space;
  readonly uts: Uts;
  readonly ipc: Ipc;
  readonly net: Net;
  readonly cgroup: CgroupNs;
  /** The pid namespace what it starts is made in (its own is the one it was made in, and stays that). */
  readonly children: PidNs;
}

/** Those of `ns`, with `change` of them another. */
export const withSpaces = (ns: Spaces, change: Partial<Spaces>): Spaces => ({...ns, ...change});

/** The first of each, but the mounts' and the cgroups', which the kernel makes of its tree. */
export const firstSpaces = (mnt: Space, cgroup: CgroupNs): Spaces => ({mnt, uts: new Uts(HOST), ipc: new Ipc(HOST), net: new Net(HOST, true), cgroup, children: new PidNs(null, HOST)});
