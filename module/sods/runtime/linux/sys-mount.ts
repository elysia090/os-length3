// The calls that change what is mounted and where a process's root is: mount, umount2, pivot_root, chroot, and the
// calls that take a mount by a descriptor (open_tree, move_mount, mount_setattr). Each is refused as Linux refuses
// it, in Linux's order; what they do to the mounts is mount.ts, and what each kind of file system is, here.

import {CAP, MAY, capable, idOf, may, type UserNs} from './cred.ts';
import {Description} from './fd.ts';
import {Dir, E, FsError, MNT, Mount, Super, WALK, down, walk} from './fs.ts';
import type {Entry, Found, Place} from './fs.ts';
import {SPREAD, copy, pivot, put, setSpread, take, tree} from './mount.ts';
import type {Space} from './mount.ts';
import type {Calls, Proc} from './parts.ts';
import {procfs} from './procfs.ts';
import {devpts} from './pty.ts';
import {sysfs} from './sysfs.ts';

const N = (x: bigint): number => Number(BigInt.asIntN(64, x));
const fail = (errno: number): never => { throw new FsError(errno); };
const AT_FDCWD = -100, O_CLOEXEC = 0x80000, O_PATH = 0x200000;
const AT = {SYMLINK_NOFOLLOW: 0x100, NO_AUTOMOUNT: 0x800, EMPTY_PATH: 0x1000, RECURSIVE: 0x8000};

/** mount(2)'s flags. */
const MS = {RDONLY: 1, NOSUID: 2, NODEV: 4, NOEXEC: 8, SYNCHRONOUS: 16, REMOUNT: 32, MANDLOCK: 64, DIRSYNC: 128, NOSYMFOLLOW: 256, NOATIME: 1024,
  NODIRATIME: 2048, BIND: 4096, MOVE: 8192, REC: 16384, SILENT: 32768, RELATIME: 1 << 21, STRICTATIME: 1 << 24, LAZYTIME: 1 << 25};
const SPREADS = SPREAD.SHARED | SPREAD.PRIVATE | SPREAD.SLAVE | SPREAD.UNBINDABLE;
/** Those of a mount's flags that a namespace from a more privileged one may not loosen. */
const LOCKS = MNT.RDONLY | MNT.NODEV | MNT.NOSUID | MNT.NOEXEC;

/** A mount's flags, as mount(2)'s say them. */
const mntFlags = (ms: number): number => (ms & MS.RDONLY ? MNT.RDONLY : 0) | (ms & MS.NOSUID ? MNT.NOSUID : 0) | (ms & MS.NODEV ? MNT.NODEV : 0) | (ms & MS.NOEXEC ? MNT.NOEXEC : 0) |
  (ms & MS.NOATIME ? MNT.NOATIME : ms & MS.STRICTATIME ? MNT.STRICTATIME : 0) | (ms & MS.NODIRATIME ? MNT.NODIRATIME : 0) | (ms & MS.NOSYMFOLLOW ? MNT.NOSYMFOLLOW : 0);

/** Whether `p` may change what is mounted in its namespace at all (CAP_SYS_ADMIN over the namespace's owner). */
const mayMount = (p: Proc): boolean => capable(p.cred, CAP.SYS_ADMIN, p.ns.mnt.owner);
/** Whether mount `m` is in `p`'s namespace. */
const mine = (p: Proc, m: Mount): boolean => m.space === p.ns.mnt;
/** Whether `m`'s flags may become `flags`: none of those locked on it loosened, its times of access not changed where they are locked. */
const mayBecome = (m: Mount, flags: number): boolean => !(m.lockedFlags & LOCKS & ~flags) && !(m.lockedFlags & MNT.ATIME && (m.flags & MNT.ATIME) !== (flags & MNT.ATIME));

function text(p: Proc, address: bigint): string { return N(address) ? p.cstring(N(address)) : ''; }

// ---- The kinds of file system. Each makes, for a mount asked of it, the file system mounted (one made new, or the
// one there is of its kind for the namespace the caller is in) and the node of it the mount shows.

/** A kind's options ("a=b,c"), each known to it or refused (EINVAL). */
function options(data: string, known: Record<string, (value: string) => void>): void {
  for (const word of data.split(',')) {
    if (!word) continue;
    const at = word.indexOf('='), key = at < 0 ? word : word.slice(0, at), take = known[key];
    if (!take) fail(E.INVAL);
    take(at < 0 ? '' : word.slice(at + 1));
  }
}
const octal = (v: string): number => (/^[0-7]+$/.test(v) ? parseInt(v, 8) & 0o7777 : fail(E.INVAL));
/** A size as tmpfs takes it: a number of bytes, with k, m or g; shown in kibibytes. */
function size(v: string): number {
  const m = /^(\d+)([kmg]?)$/i.exec(v) ?? fail(E.INVAL);
  return Number(m[1]) * ({'': 1, k: 1024, m: 1 << 20, g: 2 ** 30} as Record<string, number>)[m[2].toLowerCase()];
}
/** An id an option names, as the caller's user namespace numbers it. */
const id = (p: Proc, v: string, group: boolean): number => { const k = /^\d+$/.test(v) ? idOf(p.cred.ns, Number(v), group) : -1; return k < 0 ? fail(E.INVAL) : k; };

interface Kind {
  /** One in a user namespace of its own may mount it (FS_USERNS_MOUNT); else only one with CAP_SYS_ADMIN over the machine. */
  boxed: boolean;
  /** A new mount of it shows the processes or the machine (proc, sysfs): one in a user namespace is given it only where it sees one whole already. */
  reveals?: boolean;
  /** The file system, the node of it the mount shows (its root, unless said), and whether it was made for this mount (`fresh`) or was there. */
  make(p: Proc, source: string, data: string): {sb: Super; root?: Entry; fresh?: boolean};
}
const KINDS: Record<string, Kind> = {
  tmpfs: {boxed: true, make(p, source, data) {
    const root = new Dir(0o1777), said: string[] = [];
    let bytes = -1, inodes = -1;
    root.uid = p.cred.fsuid, root.gid = p.cred.fsgid;
    const set = {uid: false, gid: false};
    options(data, {
      size: (v) => { bytes = v.endsWith('%') ? -1 : size(v); }, nr_blocks: () => undefined, nr_inodes: (v) => { inodes = size(v); },
      mode: (v) => { root.mode = (root.mode & ~0o7777) | octal(v); }, uid: (v) => { root.uid = id(p, v, false); set.uid = true; }, gid: (v) => { root.gid = id(p, v, true); set.gid = true; },
      huge: () => undefined, mpol: () => undefined, noswap: () => undefined, inode32: () => undefined, inode64: () => undefined,
    });
    if (bytes >= 0) said.push(`size=${Math.ceil(bytes / 1024)}k`);
    if (inodes >= 0) said.push(`nr_inodes=${inodes}`);
    if ((root.mode & 0o7777) !== 0o1777) said.push(`mode=${(root.mode & 0o7777).toString(8).padStart(3, '0')}`);
    if (set.uid && root.uid) said.push(`uid=${root.uid}`);
    if (set.gid && root.gid) said.push(`gid=${root.gid}`);
    const sb = new Super('tmpfs', 0x01021994, root, source);
    sb.options = [...said, 'inode64'].join(',');
    return {sb, fresh: true};
  }},
  ramfs: {boxed: false, make(p, source, data) {
    const root = new Dir(0o755);
    options(data, {mode: (v) => { root.mode = (root.mode & ~0o7777) | octal(v); }});
    void p;
    return {sb: new Super('ramfs', 0x858458f6, root, source), fresh: true};
  }},
  proc: {boxed: true, reveals: true, make(p, source, data) {
    options(data, {hidepid: () => undefined, gid: () => undefined, subset: () => undefined});
    const ns = p.ns.children;
    return {sb: ns.proc ??= named(procfs(p.kernel, ns), source)};
  }},
  sysfs: {boxed: true, reveals: true, make(p, source, data) {
    options(data, {});
    return {sb: p.ns.net.sys ??= named(sysfs(p.kernel), source)};
  }},
  devtmpfs: {boxed: false, make(p) { return {sb: p.kernel.vfs.devices.sb}; }},
  devpts: {boxed: true, make(p, source, data) { return {sb: devpts(p, source, data), fresh: true}; }},
  mqueue: {boxed: true, make(p, source, data) {
    options(data, {});
    return {sb: p.ns.ipc.queues ??= new Super('mqueue', 0x19800202, new Dir(0o1777), source)};
  }},
  cgroup2: {boxed: true, make(p, _source, data) {
    options(data, {nsdelegate: () => undefined, memory_localevents: () => undefined, memory_recursiveprot: () => undefined, favordynmods: () => undefined, nofavordynmods: () => undefined});
    return {sb: p.kernel.cgroups.sb, root: p.ns.cgroup.root.dir};
  }},
};
const named = (sb: Super, source: string): Super => { sb.source = source || sb.kind; return sb; };

/**
 * Whether one whose namespace of mounts is `space` sees a file system of `sb`'s kind whole already, so that a new
 * mount of it shows it nothing more (Linux's mnt_already_visible): a mount of all of one, as read-only and with the
 * times of access the new one would have where those are locked, nothing locked onto it but on empty directories.
 */
function seenWhole(space: Space, sb: Super, flags: number): boolean {
  for (const m of tree(space.top)) {
    if (m.sb.kind !== sb.kind || m.root !== m.sb.root) continue;
    const locked = m.lockedFlags | (m.sb.readonly ? MNT.RDONLY : 0);
    if (locked & MNT.RDONLY && !(flags & MNT.RDONLY)) continue;
    if (locked & MNT.ATIME && (m.flags & MNT.ATIME) !== (flags & MNT.ATIME)) continue;
    if ([...m.children].some((c) => c.locked && !(c.point instanceof Dir && c.point.entries.size === 0))) continue;
    return true;
  }
  return false;
}

/** The mount last put on what a walk came to: where a new mount there goes. */
const topOf = (r: Found): Place => down(r.mnt, r.node!);

/** mount(2). */
function mount(p: Proc, sourceAt: bigint, targetAt: bigint, kindAt: bigint, flagWord: bigint, dataAt: bigint): number {
  let flags = Number(BigInt.asUintN(32, flagWord));
  if ((flags & 0xffff0000) === 0xc0ed0000) flags &= 0xffff; // (the magic old programs put above them)
  const r = walk(p, text(p, targetAt) || fail(E.NOENT), p.fs.pwd);
  if (typeof r === 'number') return fail(r);
  if (!r.node) return fail(E.NOENT);
  if (!mayMount(p)) fail(E.PERM);
  const at = topOf(r), m = at.mnt, isRoot = at.node === m.root;
  const next = mntFlags(flags);

  if (flags & MS.REMOUNT) {
    // How a mount there already is mounted: its own flags alone (with MS_BIND), or its file system's too.
    if (!isRoot || !mine(p, m)) fail(E.INVAL);
    if (!mayBecome(m, next)) fail(E.PERM);
    if (!(flags & MS.BIND)) {
      if (!capable(p.cred, CAP.SYS_ADMIN, (m.sb.owner as UserNs | null) ?? undefined)) fail(E.PERM);
      m.sb.readonly = (flags & MS.RDONLY) !== 0;
    }
    m.flags = next;
    return 0;
  }
  if (flags & MS.BIND) {
    // Another mount of what is at `source`, with what is mounted under it where MS_REC says so.
    const from = walk(p, text(p, sourceAt) || fail(E.NOENT), p.fs.pwd);
    if (typeof from === 'number') return fail(from);
    if (!from.node) return fail(E.NOENT);
    if (!mine(p, m) || (!mine(p, from.mnt) && from.mnt.sb.kind !== 'nsfs')) fail(E.INVAL);
    const c = copy(from.mnt, from.node, {deep: (flags & MS.REC) !== 0}, from.parent, from.name);
    if (typeof c === 'number') return fail(c);
    return done(put(c, at, r.parent, r.name));
  }
  if (flags & SPREADS) {
    // How what is mounted under it spreads: one way, of a mount's root; of all under it with MS_REC.
    const how = flags & SPREADS;
    if (!isRoot || !mine(p, m) || (how & (how - 1)) !== 0) fail(E.INVAL);
    for (const x of flags & MS.REC ? tree(m) : [m]) setSpread(x, how);
    return 0;
  }
  if (flags & MS.MOVE) {
    const from = walk(p, text(p, sourceAt) || fail(E.NOENT), p.fs.pwd);
    if (typeof from === 'number') return fail(from);
    if (!from.node) return fail(E.NOENT);
    return moved(p, {mnt: from.mnt, node: from.node}, at, r);
  }
  // A file system mounted anew.
  const name = text(p, kindAt), kind = KINDS[name] ?? fail(E.NODEV);
  if (!mine(p, m)) fail(E.INVAL);
  if (!(kind.boxed ? capable(p.cred, CAP.SYS_ADMIN, p.cred.ns) : capable(p.cred, CAP.SYS_ADMIN))) fail(E.PERM);
  const made = kind.make(p, text(p, sourceAt) || name, text(p, dataAt));
  if (!made.sb.owner) made.sb.owner = p.cred.ns;
  // One in a user namespace is given a new proc or sysfs only where it sees one whole already.
  if (kind.reveals && p.ns.mnt.owner.parent && !seenWhole(p.ns.mnt, made.sb, next)) fail(E.PERM);
  // (the same file system is not mounted twice on the same place)
  if (m.sb === made.sb && isRoot && (made.root ?? made.sb.root) === m.root) fail(E.BUSY);
  if (made.fresh) {
    made.sb.readonly = (flags & MS.RDONLY) !== 0;
    // (a file system of a user namespace's own holds no device that is one, but for the terminals of a devpts)
    made.sb.nodev = p.cred.ns.parent !== null && made.sb.kind !== 'devpts';
  }
  const fresh = new Mount(made.sb, made.root ?? made.sb.root, next);
  return done(put(fresh, at, r.parent, r.name));
}
const done = (errno: number): number => (errno ? fail(errno) : 0);

/**
 * A mount moved (mount(2)'s MS_MOVE, move_mount): `from`, a mount's root, onto `at`. One in the caller's namespace,
 * from a parent that is not shared, and not onto itself or under itself; or a copy open_tree made, put somewhere.
 */
function moved(p: Proc, from: Place, at: Place, r: {parent: Dir; name: string}): number {
  const old = from.mnt;
  if (!mine(p, at.mnt)) fail(E.INVAL);
  const attached = old.parent !== null;
  if (attached ? !mine(p, old) : old.space !== null) fail(E.INVAL);
  if (old.locked || from.node !== old.root) fail(E.INVAL);
  if ((old.root instanceof Dir) !== (at.node instanceof Dir)) fail(E.INVAL);
  if (attached && old.parent!.group) fail(E.INVAL);
  if (at.mnt.group && tree(old).some((x) => x.unbindable)) fail(E.INVAL);
  for (let up: Mount | null = at.mnt; up; up = up.parent) if (up === old) fail(E.LOOP);
  if (attached) {
    const over = old.point!.covered!;
    over.splice(over.indexOf(old), 1);
    if (!over.length) old.point!.covered = null;
    old.parent!.children.delete(old);
    old.parent = old.point = old.pointDir = null;
  }
  return done(put(old, at, r.parent, r.name));
}

/** What a call names by a descriptor and a path from it (the descriptor itself, with an empty path where `empty` allows): where it came to. */
function fromFd(p: Proc, dirfd: bigint, address: bigint, follow: boolean, empty: boolean, how = 0): Found {
  const name = text(p, address), fd = Number(BigInt.asIntN(32, dirfd));
  if (!name) {
    if (!empty) return fail(E.NOENT);
    if (fd === AT_FDCWD) { const at = p.fs.pwd; return {mnt: at.mnt, node: at.node, parent: at.node as Dir, name: '', up: at.mnt}; }
    const d = p.fds.get(fd) ?? fail(E.BADF);
    if (!d.mnt || !d.node) return fail(E.BADF);
    const at = how & WALK.DOWN ? down(d.mnt, d.node) : {mnt: d.mnt, node: d.node};
    return {mnt: at.mnt, node: at.node, parent: d.dir ?? (d.node as Dir), name: d.name, up: d.mnt};
  }
  let from = p.fs.pwd;
  if (name.charCodeAt(0) !== 47 && fd !== AT_FDCWD) {
    const d = p.fds.get(fd) ?? fail(E.BADF);
    from = d.mnt && d.node ? {mnt: d.mnt, node: d.node} : fail(E.NOTDIR);
  }
  const r = walk(p, name, from, (follow ? WALK.FOLLOW : 0) | how);
  if (typeof r === 'number') return fail(r);
  return r.node ? r : fail(E.NOENT);
}

export const MOUNT_CALLS: Calls = {
  165(source, target, kind, flags, data) { return mount(this, source, target, kind, flags, data); },
  166(target, flagWord) { // umount2: what is mounted at `target` taken away
    const flags = N(flagWord), FORCE = 1, DETACH = 2, EXPIRE = 4, NOFOLLOW = 8;
    if (flags & ~(FORCE | DETACH | EXPIRE | NOFOLLOW)) fail(E.INVAL);
    if (!mayMount(this)) fail(E.PERM);
    const r = walk(this, text(this, target) || fail(E.NOENT), this.fs.pwd, (flags & NOFOLLOW ? 0 : WALK.FOLLOW) | WALK.DOWN);
    if (typeof r === 'number') return fail(r);
    if (!r.node) return fail(E.NOENT);
    if (r.node !== r.mnt.root || !mine(this, r.mnt)) fail(E.INVAL);
    if (flags & FORCE && !capable(this.cred, CAP.SYS_ADMIN)) fail(E.PERM);
    return done(take(r.mnt, (flags & DETACH) !== 0));
  },
  155(freshAt, oldAt) { // pivot_root: a mount under the root made the root, the old root put on a directory under it
    if (!mayMount(this)) fail(E.PERM);
    const fresh = walk(this, text(this, freshAt) || fail(E.NOENT), this.fs.pwd), old = typeof fresh === 'number' ? fail(fresh) : walk(this, text(this, oldAt) || fail(E.NOENT), this.fs.pwd);
    if (typeof fresh === 'number' || typeof old === 'number') return fail(typeof old === 'number' ? old : E.NOENT);
    if (!fresh.node || !old.node) return fail(E.NOENT);
    const root = this.fs.root, to = {mnt: fresh.mnt, node: fresh.node};
    done(pivot(root, to, {mnt: old.mnt, node: old.node}, old.parent, old.name));
    // Everyone whose root, or the place it works, was the old root is at the new one.
    const seen = new Set<object>();
    for (const t of this.kernel.tasks.values()) {
      const fs = t.fs;
      if (seen.has(fs)) continue;
      seen.add(fs);
      if (fs.pwd.mnt === root.mnt && fs.pwd.node === root.node) fs.go(to);
      if (fs.root.mnt === root.mnt && fs.root.node === root.node) fs.turn(to);
    }
    return 0;
  },
  161(nameAt) { // chroot: its root a directory it may search, by one who may (CAP_SYS_CHROOT in its user namespace)
    const r = walk(this, text(this, nameAt) || fail(E.NOENT), this.fs.pwd);
    if (typeof r === 'number') return fail(r);
    if (!r.node) return fail(E.NOENT);
    if (!(r.node instanceof Dir)) return fail(E.NOTDIR);
    if (!may(this.cred, r.node, MAY.EXEC)) fail(E.ACCES);
    if (!capable(this.cred, CAP.SYS_CHROOT, this.cred.ns)) fail(E.PERM);
    this.fs.turn({mnt: r.mnt, node: r.node});
    return 0;
  },
  428(dirfd, name, flagWord) { // open_tree: a place in the tree as a descriptor; with OPEN_TREE_CLONE, a copy of what is mounted there, in no namespace
    const flags = N(flagWord), CLONE = 1;
    if (flags & ~(CLONE | O_CLOEXEC | AT.EMPTY_PATH | AT.NO_AUTOMOUNT | AT.RECURSIVE | AT.SYMLINK_NOFOLLOW)) fail(E.INVAL);
    if ((flags & (AT.RECURSIVE | CLONE)) === AT.RECURSIVE) fail(E.INVAL);
    if (flags & CLONE && !mayMount(this)) fail(E.PERM);
    const fd = this.fds.lowest();
    if (fd < 0) fail(E.MFILE);
    const r = fromFd(this, dirfd, name, !(flags & AT.SYMLINK_NOFOLLOW), (flags & AT.EMPTY_PATH) !== 0), node = r.node!;
    let mnt = r.mnt, dir: Dir | null = r.parent, at = r.name;
    if (flags & CLONE) {
      if (!mine(this, mnt)) fail(E.INVAL);
      const c = copy(mnt, node, {deep: (flags & AT.RECURSIVE) !== 0}, r.parent, r.name);
      if (typeof c === 'number') return fail(c);
      mnt = c, dir = null, at = '';
    }
    const d = new Description(node.isDir ? 'dir' : 'file', {node, flags: O_PATH, mnt, dir, name: at});
    if (flags & CLONE) d.tree = true;
    return this.fds.install(d, {fd, cloexec: (flags & O_CLOEXEC) !== 0});
  },
  429(fromFdNr, fromName, toFd, toName, flagWord) { // move_mount: a mount (open_tree's copy, or one mounted here) put on a place
    const flags = N(flagWord), F_SYMLINKS = 1, F_AUTOMOUNTS = 2, F_EMPTY = 4, T_SYMLINKS = 0x10, T_AUTOMOUNTS = 0x20, T_EMPTY = 0x40;
    if (flags & ~(F_SYMLINKS | F_AUTOMOUNTS | F_EMPTY | T_SYMLINKS | T_AUTOMOUNTS | T_EMPTY)) fail(E.INVAL);
    if (!mayMount(this)) fail(E.PERM);
    const from = fromFd(this, fromFdNr, fromName, (flags & F_SYMLINKS) !== 0, (flags & F_EMPTY) !== 0);
    const to = fromFd(this, toFd, toName, (flags & T_SYMLINKS) !== 0, (flags & T_EMPTY) !== 0);
    return moved(this, {mnt: from.mnt, node: from.node!}, topOf(to), to);
  },
  442(dirfd, name, flagWord, attrAt, sizeWord) { // mount_setattr: a mount's flags and how it spreads, set on it (and, with AT_RECURSIVE, on all under it)
    const flags = N(flagWord), n = N(sizeWord), a = N(attrAt), v = this.view;
    if (flags & ~(AT.EMPTY_PATH | AT.RECURSIVE | AT.SYMLINK_NOFOLLOW | AT.NO_AUTOMOUNT)) fail(E.INVAL);
    if (n < 32) fail(E.INVAL);
    if (n > 4096 || this.bytes.subarray(a + 32, a + n).some((b) => b !== 0)) fail(E.TOOBIG);
    const set = v.getBigUint64(a, true), clear = v.getBigUint64(a + 8, true), spread = Number(v.getBigUint64(a + 16, true));
    if (!set && !clear && !spread) return 0;
    const VALID = BigInt(MNT.RDONLY | MNT.NOSUID | MNT.NODEV | MNT.NOEXEC | MNT.ATIME | MNT.NODIRATIME | MNT.NOSYMFOLLOW);
    if ((set | clear) & ~VALID) fail(E.INVAL);
    if (spread & ~SPREADS || (spread & (spread - 1)) !== 0) fail(E.INVAL);
    // (the times of access are one of three, not flags: set only where all of them are cleared, and then to one)
    const s = Number(set), c = Number(clear);
    if (c & MNT.ATIME) { if ((c & MNT.ATIME) !== MNT.ATIME || (s & MNT.ATIME) === 0x30 || (s & MNT.ATIME) > MNT.STRICTATIME) fail(E.INVAL); }
    else if (s & MNT.ATIME) fail(E.INVAL);
    if (!mayMount(this)) fail(E.PERM);
    const r = fromFd(this, dirfd, name, !(flags & AT.SYMLINK_NOFOLLOW), (flags & AT.EMPTY_PATH) !== 0), m = r.mnt;
    if (r.node !== m.root) fail(E.INVAL);
    if (m.space ? !mine(this, m) : false) fail(E.INVAL);
    const all = flags & AT.RECURSIVE ? tree(m) : [m];
    for (const x of all) if (!mayBecome(x, (x.flags & ~c) | s)) fail(E.PERM);
    for (const x of all) { x.flags = (x.flags & ~c) | s; if (spread) setSpread(x, spread); }
    return 0;
  },
};
