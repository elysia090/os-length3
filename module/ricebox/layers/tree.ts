// The root's tree as its index has it, for whoever shows it: what each directory holds, by name; and what a
// directory at the top is made by: the distribution, the kernel (made when a box starts), or nothing (it starts
// empty in every box). The same tree a program in the root sees.
import type {Index} from './shape.ts';

export interface TreeEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'device';
  /** Absolute path. */
  path: string;
  size?: number;
  target?: string;
}

/** Every entry of the root under each directory, by the directory's path, each list by name. */
export function treeOf(index: Index): Map<string, TreeEntry[]> {
  const under = new Map<string, TreeEntry[]>();
  const add = (e: TreeEntry) => {
    const dir = e.path.slice(0, e.path.lastIndexOf('/')) || '/';
    if (!under.has(dir)) under.set(dir, []);
    under.get(dir)!.push(e);
  };
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  for (const d of index.dirs) add({name: name(d.path), kind: 'dir', path: d.path});
  for (const l of index.links) add({name: name(l.path), kind: 'link', path: l.path, target: l.target});
  for (const f of index.files) add({name: name(f.path), kind: 'file', path: f.path, size: f.size});
  for (const list of under.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return under;
}

/** What a directory at the top is made by, whatever the root has there. */
export type Made = 'distribution' | 'kernel' | 'empty';
const KERNEL = new Set(['dev', 'proc', 'sys']);
const EMPTY = new Set(['tmp', 'run']);
export const madeBy = (top: string): Made => (KERNEL.has(top) ? 'kernel' : EMPTY.has(top) ? 'empty' : 'distribution');

/** The devices every box has in its /dev (muk makes them), as a tree shows them. */
export const devices = (): TreeEntry[] => ['null', 'random', 'urandom', 'zero'].map((name) => ({name, kind: 'device', path: `/dev/${name}`}));
