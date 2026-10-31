// A commit's tree as git keeps one (0023; DESIGN.md, "What scales worst", 1): each folder a node named by the digest of
// its entries, kept once in its repo, and a commit names its root. A commit is made by writing anew only the folders on
// the paths it changed (edit), the rest being its parent's; a tree without a parent's to share is built whole (build).
//
// A node is the folder's entries by name: a file (`f`, its blob), a folder (`t`, its node), or the name listed as a
// folder itself (`n`: a null in a flat tree). A name may be a file and a folder both, in a tree made before that was
// refused: the node says both, as the flat tree did.

import {sha256} from './request.ts';
import type {Tree} from './schema.ts';

export type Entry = {f?: string; t?: string; n?: 1};
export type Node = Record<string, Entry>;

const enc = new TextEncoder();
/** A node's name: the digest of its entries, each [name, file, folder, named], in one order. */
export const nodeId = (n: Node) => sha256(enc.encode(JSON.stringify(Object.keys(n).sort().map((k) => [k, n[k].f ?? null, n[k].t ?? null, n[k].n ?? 0]))));

export const parentOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const depth = (f: string) => (f ? f.split('/').length : 0);
/** Every folder above `p`, the root ('') first. */
export const above = (p: string) => { const out = ['']; for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i)); return out; };
/** Whether `p` is `at` or under it. */
export const within = (p: string, at: string) => p === at || p.startsWith(`${at}/`);

/** What a flat tree's paths changed, as a commit says it (0009 tree_change): the files that differ, and the folders they are in, by their first. */
export function changes(was: Tree, now: Tree, paths: Iterable<string> = new Set([...Object.keys(was), ...Object.keys(now)])) {
  const files: string[] = [];
  for (const p of paths) {
    const a = p in was ? was[p] : undefined, b = p in now ? now[p] : undefined;
    if (a !== b && (typeof a === 'string' || typeof b === 'string')) files.push(p);
  }
  files.sort();
  return {files: files.length, folders: [...new Set(files.map(parentOf))]};
}

/** What a flat tree takes as JSON, as Postgres writes a jsonb out (repos.ts entryBytes): a key and its value, and their marks. */
export const flatBytes = (t: Tree, keys: Iterable<string> = Object.keys(t)) => {
  let n = 0;
  for (const k of keys) if (k in t) n += enc.encode(JSON.stringify(k)).length + enc.encode(JSON.stringify(t[k])).length + 4;
  return n;
};

/**
 * The nodes of the folders at and under `at`, from the flat paths under it (`flat`: whole paths, each under `at`),
 * the deepest first: `at`'s own node's name (null: nothing under it), and each node made, by its name.
 */
export async function build(flat: Tree, at = '', made = new Map<string, Node>()): Promise<{id: string | null; made: Map<string, Node>}> {
  const folders = new Map<string, Node>([[at, {}]]);
  const node = (f: string) => { let n = folders.get(f); if (!n) folders.set(f, n = {}); return n; };
  for (const [p, v] of Object.entries(flat)) {
    if (p === at) continue;
    const e = (node(parentOf(p))[nameOf(p)] ??= {});
    if (typeof v === 'string') e.f = v; else e.n = 1;
    for (let f = parentOf(p); f !== at && f; f = parentOf(f)) node(parentOf(f))[nameOf(f)] ??= {};
  }
  const order = [...folders.keys()].sort((a, b) => depth(b) - depth(a));
  let id: string | null = null;
  for (const f of order) {
    const n = folders.get(f)!;
    const named = Object.keys(n).length ? await nodeId(n) : null;
    if (named) made.set(named, n);
    if (f === at) { id = named; break; }
    const e = node(parentOf(f))[nameOf(f)];
    if (named) e.t = named; else delete e.t;
  }
  return {id, made};
}

/** A subtree edited: the path and all under it as `now` has them. A path edited: the path alone (its folder, if it is one, kept). */
export interface Edit { path: string; subtree: boolean }

/**
 * A tree edited where it changed. `old` holds the parent's nodes by the folders' paths: each folder above an edit, and
 * every folder under a subtree edit (an absent one is a folder the parent has not). `now` holds the values at and under
 * the edits as they are to be. Returns the new root's name, the nodes made on the way (each folder on an edited path,
 * the rest shared), the paths whose values changed (old and new), and each name made a file and a folder at once by an
 * edit of a path alone (a subtree edit lays down what is: the draft's own).
 */
export async function edit(old: Map<string, Node>, edits: Edit[], now: Tree) {
  // A subtree edit within another is the outer's; an edit of a path alone within a subtree edit is the subtree's.
  const subs = edits.filter((e) => e.subtree).map((e) => e.path).sort();
  const outer = subs.filter((p, i) => !subs.slice(0, i).some((q) => within(p, q)));
  const paths = [...new Set(edits.filter((e) => !e.subtree && !outer.some((q) => within(e.path, q))).map((e) => e.path))];

  // What was at and under each edit, flat, from the parent's nodes.
  const was: Tree = {};
  const entryOf = (p: string): Entry | undefined => old.get(parentOf(p))?.[nameOf(p)];
  const flatten = (f: string) => {
    for (const [name, e] of Object.entries(old.get(f) ?? {})) {
      const p = f ? `${f}/${name}` : name;
      if (e.f !== undefined) was[p] = e.f; else if (e.n) was[p] = null;
      if (e.t) flatten(p);
    }
  };
  for (const t of outer) {
    const e = entryOf(t);
    if (e?.f !== undefined) was[t] = e.f; else if (e?.n) was[t] = null;
    if (e?.t) flatten(t);
  }
  for (const p of paths) { const e = entryOf(p); if (e?.f !== undefined) was[p] = e.f; else if (e?.n) was[p] = null; }

  // Each folder above an edit, as it is to be (copied from the parent's, then changed).
  const work = new Map<string, Node>();
  const nodeAt = (f: string) => { let n = work.get(f); if (!n) work.set(f, n = Object.fromEntries(Object.entries(old.get(f) ?? {}).map(([k, e]) => [k, {...e}]))); return n; };
  const made = new Map<string, Node>();
  const clashes: string[] = [];
  for (const t of outer) {
    const e: Entry = {};
    if (typeof now[t] === 'string') e.f = now[t] as string; else if (t in now) e.n = 1;
    const under: Tree = {};
    for (const [p, v] of Object.entries(now)) if (p.startsWith(`${t}/`)) under[p] = v;
    const sub = await build(under, t, made);
    if (sub.id) e.t = sub.id;
    const parent = nodeAt(parentOf(t));
    if (e.f !== undefined || e.n || e.t) parent[nameOf(t)] = e; else delete parent[nameOf(t)];
  }
  for (const p of paths) {
    const parent = nodeAt(parentOf(p));
    const e = {...(parent[nameOf(p)] ?? {})};
    delete e.f; delete e.n;
    if (typeof now[p] === 'string') e.f = now[p] as string; else if (p in now) e.n = 1;
    if (e.f !== undefined || e.n || e.t) parent[nameOf(p)] = e; else delete parent[nameOf(p)];
  }
  // Every folder above an edit, the deepest first, named anew; one left empty goes from its parent (unless named there).
  const folders = new Set<string>([''].concat([...outer, ...paths].flatMap((p) => above(p))));
  for (const f of [...folders].sort((a, b) => depth(b) - depth(a))) {
    const n = nodeAt(f);
    if (f === '') break;
    const named = Object.keys(n).length ? await nodeId(n) : null;
    if (named) made.set(named, n);
    const parent = nodeAt(parentOf(f)), e = {...(parent[nameOf(f)] ?? {})};
    if (named) e.t = named; else delete e.t;
    if (e.f !== undefined || e.n || e.t) parent[nameOf(f)] = e; else delete parent[nameOf(f)];
  }
  // A path set, as the tree is after every edit: a name on its way a file and a folder at once is a clash (taken away,
  // a path makes none).
  for (const p of paths.filter((x) => x in now)) {
    for (const f of [...above(p).slice(1), p]) { const e = nodeAt(parentOf(f))[nameOf(f)]; if (e?.f !== undefined && e.t) clashes.push(f); }
  }
  const root = nodeAt('');
  const rootId = await nodeId(root);
  made.set(rootId, root);
  const is: Tree = {};
  for (const [p, v] of Object.entries(now)) if (outer.some((t) => within(p, t)) || paths.includes(p)) is[p] = v;
  return {root: rootId, made, was, now: is, clashes: [...new Set(clashes)].sort(), edited: {subtrees: outer, paths}};
}
