// Files, directories and links that are made as they are looked at: what /proc, /sys, a devpts and the cgroups are
// made of. Each says what the kernel is now, not what was written once.

import {Dir, E, File, FsError, Link} from './fs.ts';
import type {Entry, Mount} from './fs.ts';

const enc = new TextEncoder();

/** A file whose text is made when it is opened; and, where it takes one, what a write to it does (`put`: the text written, whole). */
export class Made extends File {
  declare readonly make: () => string;
  declare readonly put?: (text: string) => void;
  constructor(make: () => string, mode = 0o444, put?: (text: string) => void) { super(new Uint8Array(0), mode); this.make = make; if (put) this.put = put; }
  /** What an open reads: the text as it is now, a file of its own (its inode this one's), which knows what it is of. */
  snapshot(): File {
    const f = new File(enc.encode(this.make()), this.mode & 0o7777);
    f.ino = this.ino, f.uid = this.uid, f.gid = this.gid;
    (f as File & {of?: Made}).of = this;
    return f;
  }
}
/** The made file an open's snapshot is of (a write to the open is a write to it). */
export const madeOf = (f: unknown): Made | undefined => (f as {of?: Made}).of;

/**
 * A directory whose entries are made each time it is looked in. Nothing is made in it or taken from it by name
 * (`refuses`: the errno that says so), but for a directory where its kind has that mean something (`mkdir`, `rmdir`:
 * a cgroup made, and taken away).
 */
export class Listing extends Dir {
  declare readonly list: () => Map<string, Entry>;
  refuses = E.PERM;
  mkdir?: (name: string, mode: number) => void;
  rmdir?: (name: string) => void;
  constructor(list: () => Map<string, Entry>, mode = 0o555) { super(mode); this.list = list; }
  override get entries(): Map<string, Entry> { return this.list(); }
}

/**
 * A directory's entries found one at a time where a name is asked for (a path walked through it), made whole only
 * where they are listed or counted: /proc made every process's directory for each look at /proc/self.
 */
export class Lazy extends Map<string, Entry> {
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

/** Where a link that leads to what something holds goes: a place, or what has no node (`held`); or the errno. */
export type Leap = () => {mnt?: Mount; node?: Entry; held?: unknown} | number;
/**
 * A link whose target is made each time it is read. With `leap` it leads to what something holds (a descriptor,
 * where a process works, its program, its root, a namespace), not along the path it reads as: Linux's "magic link".
 */
export class Pointer extends Link {
  declare readonly make: () => string;
  constructor(target: () => string, leap?: Leap) { super(''); this.make = target; if (leap) this.leap = leap; }
  override get target(): string { return this.make(); }
}

/** A write that is not what a made file takes. */
export const refuse = (errno = E.INVAL): never => { throw new FsError(errno); };
