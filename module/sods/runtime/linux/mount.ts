// The mounts of a namespace, as Linux has them: a tree of mounts under one hidden root, each a look at a file system
// from a place in the one above it. What makes one, copies one (a bind, open_tree, a new namespace), puts one
// somewhere, takes one away, turns the root (pivot_root), and how what is mounted under one spreads to its peers and
// to those that follow it. What a path is walked by is fs.ts; the calls are sys-mount.ts.

import {Dir, E, MNT, Mount, Super, attach, detach, pathOf} from './fs.ts';
import type {Entry, Place} from './fs.ts';
import {spaceId, type UserNs} from './cred.ts';

/** A mount namespace: its hidden first mount (what the root a process sees is mounted on), and whose it is. */
export class Space {
  readonly id = spaceId();
  declare readonly top: Mount;
  declare readonly owner: UserNs;
  constructor(top: Mount, owner: UserNs) { this.top = top; this.owner = owner; top.space = this; }
}

/** A first namespace: `root` (a tree's mount, with what is mounted in it already) on a hidden mount of nothing. */
export function firstSpace(root: Mount, owner: UserNs): Space {
  const under = new Dir(0o755);
  const space = new Space(new Mount(new Super('rootfs', 0x858458f6, under, 'rootfs')), owner);
  attach(root, space.top, under, null, '/');
  for (const m of tree(root)) m.space = space;
  return space;
}

/** `m` and every mount under it, a mount before what is mounted in it. */
export function tree(m: Mount): Mount[] {
  const out = [m];
  for (let i = 0; i < out.length; i++) out.push(...out[i].children);
  return out;
}

/** Whether `node` is `under` or lies beneath it (by the directories it lies in; a file by the one it was reached through). */
function beneath(under: Entry, node: Entry, dir: Dir | null): boolean {
  if (node === under) return true;
  for (let d = node instanceof Dir ? node.parent : dir ?? undefined; d; d = d.parent) if (d === under) return true;
  return false;
}

// ---- How mounts spread. A shared mount is one of a group of peers: what is mounted under one is mounted under
// each. A mount may follow a group (its master): it receives what the group's mounts receive, and gives nothing
// back. A mount that is neither is private.
let groups = 0;
const peers = new Map<number, Set<Mount>>();
const followers = new Map<number, Set<Mount>>();
const into = (map: Map<number, Set<Mount>>, id: number, m: Mount): void => { if (id) { let s = map.get(id); if (!s) map.set(id, s = new Set()); s.add(m); } };
const outOf = (map: Map<number, Set<Mount>>, id: number, m: Mount): void => { const s = map.get(id); if (s?.delete(m) && !s.size) map.delete(id); };

export const SPREAD = {SHARED: 1 << 20, PRIVATE: 1 << 18, SLAVE: 1 << 19, UNBINDABLE: 1 << 17};
/** `m` made a peer of group `group` (0: of none) and a follower of `master` (0: of none). */
function spreads(m: Mount, group: number, master: number): void {
  outOf(peers, m.group, m), outOf(followers, m.master, m);
  m.group = group, m.master = master;
  into(peers, group, m), into(followers, master, m);
}
/**
 * How `m` spreads changed, as mount(2)'s MS_SHARED, MS_PRIVATE, MS_SLAVE and MS_UNBINDABLE say. Made a follower, a
 * shared mount follows the group it leaves, where another of that group is left to follow; else it follows what it
 * followed before, or is private.
 */
export function setSpread(m: Mount, how: number): void {
  m.unbindable = how === SPREAD.UNBINDABLE;
  if (how === SPREAD.SHARED) { if (!m.group) spreads(m, ++groups, m.master); return; }
  if (how === SPREAD.SLAVE) {
    const left = m.group && (peers.get(m.group)?.size ?? 0) > 1 ? m.group : m.master;
    // (those that followed it alone now follow what it follows)
    if (m.group && (peers.get(m.group)?.size ?? 0) <= 1) for (const f of [...followers.get(m.group) ?? []]) spreads(f, f.group, left);
    spreads(m, 0, left);
    return;
  }
  if (m.group && (peers.get(m.group)?.size ?? 0) <= 1) for (const f of [...followers.get(m.group) ?? []]) spreads(f, f.group, m.master);
  spreads(m, 0, 0);
}

/** A mount ended: it is in no group, and follows none. */
function ended(m: Mount): void { spreads(m, 0, 0); }

/**
 * The mounts that receive what is mounted under `parent`, each with whether it receives it as a follower: its
 * peers, those that follow its group, their peers and followers in turn.
 */
function receivers(parent: Mount): {to: Mount; follows: boolean}[] {
  const out: {to: Mount; follows: boolean}[] = [], seen = new Set<Mount>([parent]);
  const from = (group: number, follows: boolean): void => {
    for (const to of peers.get(group) ?? []) if (!seen.has(to)) { seen.add(to); out.push({to, follows}); }
    for (const to of followers.get(group) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      out.push({to, follows: true});
      if (to.group) from(to.group, true);
    }
  };
  if (parent.group) from(parent.group, false);
  return out;
}

/** How a copy differs from what it is a copy of. */
export interface Copying {
  /** What is mounted under it too. */
  deep?: boolean;
  /** For a namespace of another, less privileged user namespace: what was shared is followed, and each mount and its flags are locked. */
  lesser?: boolean;
  /** Each copy by what it is a copy of (a namespace's: a process's root and where it works are found in the copy; and what may not be bound is copied too). */
  made?: Map<Mount, Mount>;
  whole?: boolean;
}

/**
 * A copy of `m` from `root` down (a node of its tree, which lies in `dir` as `name` where it is no directory):
 * another mount of the same nodes. With `deep`, of what is mounted under that node as well; without, a mount locked
 * under it is in the way (EINVAL), as is one that may not be copied (unbindable).
 */
export function copy(m: Mount, root: Entry, how: Copying = {}, dir: Dir | null = m.rootDir, name = m.rootName): Mount | number {
  if (m.unbindable && !how.whole) return E.INVAL;
  const inside = (c: Mount): boolean => c.point !== null && beneath(root, c.point, c.pointDir);
  if (!how.deep) for (const c of m.children) if (c.locked && inside(c)) return E.INVAL;
  const one = (from: Mount, at: Entry): Mount => {
    const c = new Mount(from.sb, at, from.flags);
    c.rootDir = from.rootDir, c.rootName = from.rootName;
    c.lockedFlags = from.lockedFlags;
    if (how.lesser) {
      c.lockedFlags |= MNT.ATIME | (from.flags & (MNT.RDONLY | MNT.NODEV | MNT.NOSUID | MNT.NOEXEC));
      spreads(c, 0, from.group || from.master);
    } else spreads(c, from.group, from.master);
    how.made?.set(from, c);
    return c;
  };
  const top = one(m, root);
  top.rootDir = dir, top.rootName = name;
  if (how.deep) {
    const under = (from: Mount, to: Mount): void => {
      for (const c of from.children) {
        if (from === m && !inside(c)) continue;
        if (c.unbindable && !how.whole) continue;
        const k = one(c, c.root);
        k.locked = c.locked || !!how.lesser;
        attach(k, to, c.point!, c.pointDir, c.pointName);
        k.space = null;
        under(c, k);
      }
    };
    under(m, top);
  }
  return top;
}

/** A namespace like `old`, for one whose user namespace is `owner`: every mount of it copied. */
export function copySpace(old: Space, owner: UserNs): {space: Space; made: Map<Mount, Mount>} {
  const made = new Map<Mount, Mount>();
  const top = copy(old.top, old.top.root, {deep: true, lesser: owner !== old.owner, made, whole: true}) as Mount;
  top.locked = false;
  const space = new Space(top, owner);
  for (const m of tree(top)) m.space = space;
  return {space, made};
}

/** What is mounted at `point` of `parent`: the one mount whose place that is. */
const mountedAt = (parent: Mount, point: Entry): Mount | undefined => point.covered?.findLast((m) => m.parent === parent);

/**
 * `m` (with what is mounted in it) put on `at`, a place in a namespace: on the directory itself, where one is
 * mounted on one, a file on a file. And on the same node of every mount that receives what `at`'s mount does, a
 * copy each. ENOTDIR where one is a directory and the other not.
 */
export function put(m: Mount, at: Place, dir: Dir | null, name: string): number {
  if ((m.root instanceof Dir) !== (at.node instanceof Dir)) return E.NOTDIR;
  const parent = at.mnt, to = receivers(parent).filter((r) => beneath(r.to.root, at.node, dir) && !mountedAt(r.to, at.node));
  // (what is mounted under a shared mount is shared, so that the copies made of it are its peers)
  if (parent.group) for (const x of tree(m)) if (!x.group) spreads(x, ++groups, x.master);
  attach(m, parent, at.node, dir, name);
  for (const x of tree(m)) x.space = parent.space;
  const following = new Map<number, Map<Mount, number>>();
  for (const r of to) {
    const made = new Map<Mount, Mount>();
    const c = copy(m, m.root, {deep: true, made});
    if (typeof c === 'number') continue;
    if (r.follows) {
      // Copies that follow: each follows what it is a copy of, and is a peer of the other copies under its own peers.
      const key = r.to.group;
      let ids = following.get(key);
      if (!ids) following.set(key, ids = new Map());
      for (const [from, k] of made) {
        let id = 0;
        if (key) { id = ids.get(from) ?? 0; if (!id) ids.set(from, id = ++groups); }
        spreads(k, id, from.group);
      }
    }
    attach(c, r.to, at.node, dir, name);
    for (const x of tree(c)) x.space = r.to.space;
  }
  return 0;
}

/** `m` and all in it, out of its namespace: nothing reaches it by a path again; what holds it still has it. */
function out(m: Mount): void {
  detach(m);
  for (const x of tree(m)) { x.space = null; x.locked = false; ended(x); }
}

/**
 * `m` taken away (umount2). Not the hidden first mount, nor one locked where it is (EINVAL); with `lazy`
 * (MNT_DETACH) whatever holds it or is mounted in it, else only where nothing does and nothing is (EBUSY). And the
 * mounts that received a copy of it lose theirs, where nothing is mounted in them.
 */
export function take(m: Mount, lazy: boolean): number {
  if (!m.parent || !m.point || !m.space || m.locked) return E.INVAL;
  if (!lazy && (m.children.size || m.refs > 0)) return E.BUSY;
  for (const r of receivers(m.parent)) {
    const c = mountedAt(r.to, m.point);
    if (c && c !== m && !c.children.size && !c.locked && (lazy || c.refs <= 0)) out(c);
  }
  out(m);
  return 0;
}

/**
 * The root turned (pivot_root): `fresh`, the root of a mount under `root` (the caller's root, itself a mount's
 * root), takes that root's place, and the old root's mount is put on `old`, a directory at or under `fresh`. As
 * Linux refuses it: EINVAL where one is not a mount's root or `old` is not under `fresh`, or where what would move
 * is shared (it would move for its peers too); EBUSY where `fresh` or `old` is in the root's own mount.
 */
export function pivot(root: Place, fresh: Place, old: Place, oldDir: Dir | null, oldName: string): number {
  const was = root.mnt, now = fresh.mnt;
  if (!(fresh.node instanceof Dir) || !(old.node instanceof Dir)) return E.NOTDIR;
  if (!now.space || now.space !== was.space || old.mnt.space !== was.space) return E.INVAL;
  if (now === was || old.mnt === was) return E.BUSY;
  if (fresh.node !== now.root || root.node !== was.root) return E.INVAL;
  if (!was.parent || !was.point || !now.parent) return E.INVAL;
  if (was.group || now.parent.group || was.parent.group) return E.INVAL;
  if (now.locked) return E.INVAL;
  // `old` at or under `fresh`: up from it, through the mounts it is in, to the new root.
  let reached = false;
  for (let m: Mount | null = old.mnt, d: Entry = old.node, dir = oldDir; m; ) {
    if (m === now && beneath(now.root, d, dir)) { reached = true; break; }
    if (!m.parent || !m.point) break;
    d = m.point, dir = m.pointDir, m = m.parent;
  }
  if (!reached) return E.INVAL;
  const {parent, point, pointDir, pointName} = was;
  detach(now);
  detach(was);
  attach(was, old.mnt, old.node, oldDir, oldName);
  attach(now, parent, point, pointDir, pointName);
  // (a root that was locked where it is: the new root is, in its place, and the old one may be taken away)
  if (was.locked) { now.locked = true; was.locked = false; }
  return 0;
}

/** A mount's flags as mountinfo and /proc/mounts say them, after "rw" or "ro". */
export function flagsText(flags: number): string {
  return (flags & MNT.RDONLY ? 'ro' : 'rw') + (flags & MNT.NOSUID ? ',nosuid' : '') + (flags & MNT.NODEV ? ',nodev' : '') + (flags & MNT.NOEXEC ? ',noexec' : '') +
    ((flags & MNT.ATIME) === MNT.NOATIME ? ',noatime' : '') + (flags & MNT.NODIRATIME ? ',nodiratime' : '') + ((flags & MNT.ATIME) === 0 ? ',relatime' : '') +
    (flags & MNT.NOSYMFOLLOW ? ',nosymfollow' : '');
}
/** A name as those files write it: a space, a tab, a line feed and a backslash by their octal numbers. */
const escaped = (s: string): string => s.replace(/[ \t\n\\]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'));

/** The mounts one whose root is `root` can reach by a path, a mount before what is mounted in it, each with where it is. */
export function reachable(root: Place): {m: Mount; at: string}[] {
  const out: {m: Mount; at: string}[] = [];
  const from = (m: Mount, at: string): void => {
    out.push({m, at});
    for (const c of m.children) {
      if (!c.point || (m === root.mnt && !beneath(root.node, c.point, c.pointDir))) continue;
      from(c, pathOf(root, c, c.root));
    }
  };
  from(root.mnt, '/');
  return out;
}

/** /proc/PID/mountinfo for one whose root is `root`. */
export function mountinfo(root: Place): string {
  return reachable(root).map(({m, at}) => {
    const within = m.root === m.sb.root ? '/' : pathOf({mnt: bare(m), node: m.sb.root}, bare(m), m.root, m.rootDir, m.rootName);
    const spread = (m.group ? ` shared:${m.group}` : '') + (m.master ? ` master:${m.master}` : '') + (m.unbindable ? ' unbindable' : '');
    return `${m.id} ${m.parent?.id ?? m.id} ${m.sb.dev >> 8 & 0xfff}:${m.sb.dev & 0xff} ${escaped(within)} ${escaped(at)} ${flagsText(m.flags)}${spread} - ${m.sb.kind} ${escaped(m.sb.source)} ${superText(m.sb)}\n`;
  }).join('');
}
/** A mount of all of `m`'s file system, to name a node of it from that file system's own root. */
const whole = new WeakMap<Super, Mount>();
const bare = (m: Mount): Mount => { let b = whole.get(m.sb); if (!b) whole.set(m.sb, b = new Mount(m.sb)); return b; };
const superText = (sb: Super): string => (sb.readonly ? 'ro' : 'rw') + (sb.options ? ',' + sb.options : '');

/** /proc/mounts (and /proc/PID/mounts), for one whose root is `root`. */
export function mountsText(root: Place): string {
  return reachable(root).map(({m, at}) => `${escaped(m.sb.source)} ${escaped(at)} ${m.sb.kind} ${flagsText(m.flags)}${m.sb.options ? ',' + m.sb.options : ''} 0 0\n`).join('');
}
