// Normalized inventory values and pure comparisons; no filesystem operations.
import type {About, Index} from './manifest.ts';

/** One path of a tree: a directory, a file (its size and digest), a link (its target), or what no root holds. */
export interface Entry {
  path: string;
  type: 'dir' | 'file' | 'link' | 'other';
  mode: number;
  target?: string;
  size?: number;
  sha256?: string;
  /** A hard link: the file it is another name of. */
  same?: string;
}
export interface Tree { entries: Entry[]; manifest?: string; about?: About; index?: Index }
export const byPath = (a: Entry, b: Entry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What is compared: one line a path, its type, mode, link target and the sha256 of its bytes. */
export const lineOf = (e: Entry) => `${e.path}\t${e.type}\t${e.mode.toString(8).padStart(4, '0')}\t${e.type === 'link' ? e.target : e.type === 'file' ? `${e.size}\t${e.sha256}` : ''}`;
export const manifestOf = (tree: Tree) => tree.entries.map(lineOf).join('\n') + '\n';

/** How two trees differ: {missing (in a, not b), extra (in b, not a), changed: [{path, a, b}]}. */
export function differences(a: Tree, b: Tree) {
  const by = (t: Tree) => new Map(t.entries.map((e) => [e.path, lineOf(e)]));
  const [x, y] = [by(a), by(b)];
  const missing = [...x.keys()].filter((p) => !y.has(p));
  const extra = [...y.keys()].filter((p) => !x.has(p));
  const changed = [...x.keys()].filter((p) => y.has(p) && x.get(p) !== y.get(p)).map((p) => ({path: p, a: x.get(p) ?? '', b: y.get(p) ?? ''}));
  return {missing, extra, changed, same: !missing.length && !extra.length && !changed.length};
}

/** {files, dirs, links, bytes} of a tree. */
export const counts = (t: Tree) => ({
  files: t.entries.filter((e) => e.type === 'file').length,
  dirs: t.entries.filter((e) => e.type === 'dir').length,
  links: t.entries.filter((e) => e.type === 'link').length,
  bytes: t.entries.reduce((n, e) => n + (e.type === 'file' ? e.size ?? 0 : 0), 0),
});
