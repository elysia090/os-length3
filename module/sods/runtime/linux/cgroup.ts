// The cgroups, as Linux's one tree of them (cgroup2): each a directory of the cgroup file system, the processes in
// it, and what it may use of the machine. What is counted and held here is processes and threads (the pids
// controller: pids.max, pids.current); no other controller is offered, so none is said to be.

import {E, MNT, Mount, Super} from './fs.ts';
import type {Entry} from './fs.ts';
import {Lazy, Listing, Made, refuse} from './made.ts';

/** What a cgroup knows of a process in it: whether it lives, its threads, and the cgroup it is in. */
export interface Member { readonly state: string; readonly tasks: ReadonlySet<unknown>; cgroup: Cgroup }

export class Cgroup {
  readonly children = new Map<string, Cgroup>();
  readonly procs = new Set<Member>();
  /** The controllers its children have (cgroup.subtree_control). */
  readonly gives = new Set<string>();
  /** The most processes and threads it and all under it may be (pids.max; Infinity: "max"), and the most they have been. */
  most = Infinity;
  peak = 0;
  /** How often one was refused for it (pids.events). */
  refused = 0;
  declare readonly dir: Listing;
  declare readonly parent: Cgroup | null;
  declare readonly name: string;
  constructor(parent: Cgroup | null, name: string, files: (g: Cgroup) => Listing) { this.parent = parent; this.name = name; this.dir = files(this); }
  /** Its path from the tree's root. */
  get path(): string { return this.parent ? `${this.parent.path === '/' ? '' : this.parent.path}/${this.name}` : '/'; }
  /** The controllers it has: those its parent gives. */
  get has(): Set<string> { return this.parent ? this.parent.gives : new Set(CONTROLLERS); }
  /** How many processes and threads it and all under it are. */
  get count(): number {
    let n = 0;
    for (const p of this.procs) if (p.state === 'live') n += Math.max(1, p.tasks.size);
    for (const c of this.children.values()) n += c.count;
    return n;
  }
  /** Whether any process is in it or under it. */
  get populated(): boolean { return this.procs.size > 0 || [...this.children.values()].some((c) => c.populated); }
}

const CONTROLLERS = ['pids'];
/** The cgroup a directory of the tree is. */
const dirs = new WeakMap<object, Cgroup>();
export const cgroupOf = (node: unknown): Cgroup | undefined => (node && typeof node === 'object' ? dirs.get(node) : undefined);

/**
 * Whether `g` and each above it has room for one more process or thread: where one has not, that is counted there
 * and the answer is no (EAGAIN to the fork or clone that asked).
 */
export function room(g: Cgroup): boolean {
  for (let at: Cgroup | null = g; at; at = at.parent) {
    if (at.most !== Infinity && at.count + 1 > at.most) { at.refused++; return false; }
  }
  return true;
}
/** One more is in `g`: the most each above has been is kept. */
export function counted(g: Cgroup): void {
  for (let at: Cgroup | null = g; at; at = at.parent) at.peak = Math.max(at.peak, at.count);
}

/** `p` moved into `g`. */
export function enter(p: Member, g: Cgroup): void {
  p.cgroup?.procs.delete(p);
  p.cgroup = g;
  g.procs.add(p);
  counted(g);
}

/** What the tree asks of the kernel it is in: a process by the number its reader calls it, and that number for a process. */
export interface Host<P extends Member = Member> { find(nr: number): P | undefined; nr(p: P): number; kill(p: P): void }

/** The tree: its root cgroup, and the file system it is. */
export function cgroups<P extends Member>(from: Host<P>): {root: Cgroup; sb: Super} {
  const host = from as unknown as Host;
  const files = (g: Cgroup): Listing => {
    const fixed = new Map<string, Entry>([
      ['cgroup.procs', new Made(() => [...g.procs].filter((p) => p.state === 'live').map((p) => host.nr(p)).filter((n) => n > 0).sort((a, b) => a - b).map((n) => `${n}\n`).join(''), 0o644, (text) => {
        const nr = Number(text.trim());
        if (!/^\d+\s*$/.test(text) && text.trim() !== '0') refuse();
        const p = host.find(nr) ?? refuse(E.SRCH);
        // (a cgroup that gives its children controllers holds no process itself: only the root may)
        if (g.parent && g.gives.size) refuse(E.BUSY);
        if (p.cgroup !== g && !room(g)) refuse(E.AGAIN);
        enter(p, g);
      })],
      ['cgroup.threads', new Made(() => [...g.procs].flatMap((p) => [...p.tasks].map(() => host.nr(p))).map((n) => `${n}\n`).join(''), 0o644, () => refuse(E.OPNOTSUPP))],
      ['cgroup.controllers', new Made(() => ([...g.has].join(' ') + '\n').replace(/^\n$/, '\n'))],
      ['cgroup.subtree_control', new Made(() => [...g.gives].join(' ') + '\n', 0o644, (text) => {
        const words = text.trim().split(/\s+/).filter(Boolean);
        for (const w of words) if (!/^[+-]/.test(w) || !g.has.has(w.slice(1))) refuse(w[0] === '+' || w[0] === '-' ? E.NOENT : E.INVAL);
        // (no controller for children while it holds processes itself: the root apart)
        if (g.parent && g.procs.size && words.some((w) => w[0] === '+')) refuse(E.BUSY);
        for (const w of words) {
          if (w[0] === '+') g.gives.add(w.slice(1));
          else {
            if ([...g.children.values()].some((c) => c.gives.has(w.slice(1)))) refuse(E.BUSY);
            g.gives.delete(w.slice(1));
            for (const c of g.children.values()) c.most = Infinity;
          }
        }
      })],
      ['cgroup.events', new Made(() => `populated ${g.populated ? 1 : 0}\nfrozen 0\n`)],
      ['cgroup.type', new Made(() => 'domain\n', 0o644, (text) => { if (text.trim() !== 'domain') refuse(E.OPNOTSUPP); })],
      ['cgroup.max.depth', new Made(() => 'max\n', 0o644, () => undefined)],
      ['cgroup.max.descendants', new Made(() => 'max\n', 0o644, () => undefined)],
      ['cgroup.stat', new Made(() => { const all = (x: Cgroup): number => [...x.children.values()].reduce((n, c) => n + 1 + all(c), 0); return `nr_descendants ${all(g)}\nnr_dying_descendants 0\n`; })],
      ['cgroup.kill', new Made(() => '', 0o200, (text) => {
        if (text.trim() !== '1') refuse();
        const all = (x: Cgroup): void => { for (const p of [...x.procs]) host.kill(p); for (const c of x.children.values()) all(c); };
        all(g);
      })],
    ]);
    if (!g.parent) for (const name of ['cgroup.events', 'cgroup.type', 'cgroup.kill']) fixed.delete(name);
    const pids = new Map<string, Entry>([
      ['pids.max', new Made(() => (g.most === Infinity ? 'max\n' : `${g.most}\n`), 0o644, (text) => {
        const t = text.trim();
        if (t !== 'max' && !/^\d+$/.test(t)) refuse();
        g.most = t === 'max' ? Infinity : Number(t);
      })],
      ['pids.current', new Made(() => `${g.count}\n`)],
      ['pids.peak', new Made(() => `${g.peak}\n`)],
      ['pids.events', new Made(() => `max ${g.refused}\n`)],
    ]);
    const whole = (): Map<string, Entry> => {
      const m = new Map<string, Entry>(fixed);
      if (g.parent && g.has.has('pids')) for (const [k, v] of pids) m.set(k, v);
      for (const [name, c] of g.children) m.set(name, c.dir);
      return m;
    };
    const entries = new Lazy((name) => g.children.get(name)?.dir ?? fixed.get(name) ?? (g.parent && g.has.has('pids') ? pids.get(name) : undefined), whole);
    const dir = new Listing(() => entries, 0o755);
    dirs.set(dir, g);
    dir.mkdir = (name) => { g.children.set(name, new Cgroup(g, name, files)); };
    dir.rmdir = (name) => {
      const c = g.children.get(name) ?? refuse(E.NOENT);
      if (c.procs.size || c.children.size) refuse(E.BUSY);
      g.children.delete(name);
    };
    return dir;
  };
  // (a directory's cgroup is known once the cgroup is made: `files` runs within its making)
  const root = new Cgroup(null, '', files);
  const sb = new Super('cgroup2', 0x63677270, root.dir, 'cgroup2');
  sb.options = 'nsdelegate';
  return {root, sb};
}

/** What a mount of the cgroups is, as its flags are by default. */
export const cgroupMount = (sb: Super, root: Cgroup): Mount => new Mount(sb, root.dir, MNT.NOSUID | MNT.NODEV | MNT.NOEXEC);
