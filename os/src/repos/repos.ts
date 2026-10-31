// Repos the OS manages: directories under its data directory, kept by the core (core/src/repos.rs), the
// app's own or the same built for the web, over the files this browser keeps (core/client.ts). Either way
// a repo is the same thing, read and written by the same code.

import {core} from '../app/host.ts';
import {home, onElsewhere} from '../core/client.ts';
import shared from '../../shared/templates.json' with {type: 'json'};

interface RepoSummary {
  name: string;
  files: number;
  bytes: number;
  modified: number;
}

export interface Entry {
  name: string;
  kind: 'dir' | 'file' | 'link';
  size: number;
}

export interface Contents {
  text: string | null;
  size: number;
  truncated: boolean;
}

export type Template = string;

/**
 * The most of a file Forge reads to edit and saves back (core/src/api.rs READ_LIMIT): one larger is read only in
 * part, so a text over it written in Forge is not saved as it is (editor.ts says what can be done instead).
 */
export const EDIT_LIMIT = 256 * 1024;

export interface RepoStore {
  /** Each repo with its size and when it last changed: every one walked to say so. */
  list(): Promise<RepoSummary[]>;
  /** The repos' names, in order, and nothing walked: what only names them, or looks for one, asks. */
  names(): Promise<string[]>;
  create(name: string, template: Template): Promise<RepoSummary>;
  tree(repo: string, path: string): Promise<Entry[]>;
  read(repo: string, path: string): Promise<Contents>;
  /** Replace the text of an existing file; returns its new size in bytes. */
  write(repo: string, path: string, text: string): Promise<number>;
  /** Make a new file `name` in the existing directory `dir`; never replaces one. */
  add(repo: string, dir: string, name: string, text: string): Promise<number>;
  /** Make a directory (and its parents) inside the repo. */
  mkdir(repo: string, path: string): Promise<void>;
  /** Remove a file, or a directory with all it holds, inside the repo (never the repo or its .git). */
  remove(repo: string, path: string): Promise<void>;
  /**
   * Give a file or folder a new name, or a new place in the repo: `to` is its path from the repo's top, each part
   * plain as a new file's name, the folders on its way made; never replaces what is there.
   */
  move(repo: string, path: string, to: string): Promise<void>;
  /** Write `path` whole as these bytes, of any size or kind, its folders made (what a Prompt wrote back). */
  put(repo: string, path: string, bytes: Uint8Array): Promise<number>;
  /**
   * Name the repo itself `to` on this device, with what this device keeps of it by its name; only one no Remote has
   * (core's remote::rename_repo). `open`: repos a Prompt has open in this page, which are never renamed.
   */
  renameRepo(repo: string, to: string, open: string[]): Promise<void>;
  /** Take the repo from this device whole, with every record of it; what a Remote holds is not touched. `open` as above. */
  deleteRepo(repo: string, open: string[]): Promise<void>;
  /** A file's bytes whole, whatever it holds (what a Prompt copies in). */
  bytes(repo: string, path: string): Promise<Uint8Array>;
}

interface SharedTemplate { id: string; label: string; dirs: string[]; files: [string, string][] }

/** Templates as l3 and the native side read them: shared/templates.json. */
export const TEMPLATES: readonly {id: Template; label: string; files: readonly string[]}[] =
  (shared as SharedTemplate[]).map((t) => ({id: t.id, label: t.label, files: [...t.files.map(([p]) => p), ...t.dirs.map((d) => `${d}/`)]}));

/**
 * Whether a path part names a repo's .git however it is spelt (core's
 * is_git_name): case, trailing dots and spaces, the short name git~1 and
 * invisible code points do not make it something else.
 */
export function isGitName(part: string): boolean {
  const name = part.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toLowerCase().replace(/[. ]+$/, '');
  return name === '.git' || name === 'git~1';
}

/** Whether `name` can name a new file or folder, or a renamed one, as core's add does: one plain part, not hidden, not .git. */
export function plainPart(name: string): boolean {
  return !!name && !name.startsWith('.') && !name.includes('/') && !name.includes('\\') && !isGitName(name);
}
/** `path` with its last part named `name`. */
export const renamed = (path: string, name: string) => (path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/${name}` : name);

/** Whether `path` can be where a file or folder is moved to in a repo, as core's move_to has it: plain parts joined by "/". */
export const plainPath = (path: string): boolean => !!path && path.split('/').every(plainPart);

/** Same rule as the native side: a plain directory name. */
export function validName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name);
}

class CoreStore implements RepoStore {
  list() { return core<RepoSummary[]>('repo_list'); }
  names() { return core<string[]>('repo_names'); }
  create(name: string, template: Template) { return core<RepoSummary>('repo_create', {name, template}); }
  tree(repo: string, path: string) { return core<Entry[]>('repo_tree', {repo, path}); }
  read(repo: string, path: string) { return core<Contents>('repo_read', {repo, path}); }
  write(repo: string, path: string, text: string) { return core<number>('repo_write', {repo, path, text}); }
  add(repo: string, dir: string, name: string, text: string) { return core<number>('repo_add', {repo, dir, name, text}); }
  mkdir(repo: string, path: string) { return core<void>('repo_mkdir', {repo, path}); }
  remove(repo: string, path: string) { return core<void>('repo_remove', {repo, path}); }
  move(repo: string, path: string, to: string) { return core<void>('repo_move', {repo, path, to}); }
  put(repo: string, path: string, bytes: Uint8Array) { return core<number>('repo_put', {repo, path, bytes: base64(bytes)}); }
  renameRepo(repo: string, to: string, open: string[]) { return core<void>('repo_rename', {repo, to, open}); }
  deleteRepo(repo: string, open: string[]) { return core<void>('repo_delete', {repo, open}); }
  async bytes(repo: string, path: string) { return unbase64(await core<string>('repo_bytes', {repo, path})); }
}

/**
 * Base64 as bytes: the engine's own where it has it, else each character's code laid into one array (not a
 * function called for each, which took a Prompt's copy of a large file a second).
 */
function unbase64(text: string): Uint8Array {
  const native = Uint8Array as unknown as {fromBase64?: (s: string) => Uint8Array};
  if (native.fromBase64) return native.fromBase64(text);
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Bytes as base64, a piece at a time (a large file would overflow one call's arguments). */
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Files of a new repo, from the same shared/templates.json as the native
 * side and l3. Inbox and TODO belong to the OS, so no template carries them.
 * Directories map to null. */
export function templateFiles(name: string, template: Template): Map<string, string | null> {
  // '' is no template at all: a repo whose files all come from the Remote.
  if (template === '') return new Map();
  const t = (shared as SharedTemplate[]).find((x) => x.id === template);
  if (!t) throw new Error(`unknown template ${template}`);
  const files = new Map<string, string | null>(t.files.map(([p, text]) => [p, text.replaceAll('{name}', name)]));
  for (const d of t.dirs) files.set(d, null);
  return files;
}

/** A change made through the store: a file's new text, a new directory, or a removal (a move is told as the old path removed, then what is at the new one). */
export interface Change {
  repo: string;
  path: string;
  what: 'file' | 'dir' | 'removed' | 'repo';
  text?: string;
  /** Who made it, so a listener can leave its own changes alone. */
  by?: string;
}

/**
 * Every write goes through here, and each one that succeeds is announced, so
 * the shell's copy, Forge, Git and File all see one repo. `by` names the
 * writer (a shell writing back its own changes passes its id).
 */
class Observed implements RepoStore {
  readonly changes = new EventTarget();
  private inner: RepoStore;
  constructor(inner: RepoStore) { this.inner = inner; }
  private tell(c: Change) { this.changes.dispatchEvent(new CustomEvent<Change>('change', {detail: c})); }
  list() { return this.inner.list(); }
  names() { return this.inner.names(); }
  tree(repo: string, path: string) { return this.inner.tree(repo, path); }
  read(repo: string, path: string) { return this.inner.read(repo, path); }
  bytes(repo: string, path: string) { return this.inner.bytes(repo, path); }
  async create(name: string, template: Template, by?: string) {
    const r = await this.inner.create(name, template);
    this.tell({repo: name, path: '', what: 'repo', by});
    return r;
  }
  async write(repo: string, path: string, text: string, by?: string) {
    const n = await this.inner.write(repo, path, text);
    this.tell({repo, path, what: 'file', text, by});
    return n;
  }
  async add(repo: string, dir: string, name: string, text: string, by?: string) {
    const n = await this.inner.add(repo, dir, name, text);
    this.tell({repo, path: dir ? `${dir}/${name}` : name, what: 'file', text, by});
    return n;
  }
  async put(repo: string, path: string, bytes: Uint8Array, by?: string) {
    const n = await this.inner.put(repo, path, bytes);
    await this.made(repo, path, by);
    return n;
  }
  async mkdir(repo: string, path: string, by?: string) {
    await this.inner.mkdir(repo, path);
    this.tell({repo, path, what: 'dir', by});
  }
  async remove(repo: string, path: string, by?: string) {
    await this.inner.remove(repo, path);
    this.tell({repo, path, what: 'removed', by});
  }
  /**
   * A rename or a move is the old path gone and the new one made: those who keep a copy (the shell's) take it as any
   * removal and new files, and the Remote gets it as any other change.
   */
  async move(repo: string, path: string, to: string, by?: string) {
    await this.inner.move(repo, path, to);
    to = to.replace(/^\/+|\/+$/g, '');
    if (to === path.replace(/\/+$/, '')) return;
    this.tell({repo, path, what: 'removed', by});
    await this.made(repo, to, by);
  }
  /**
   * The repo renamed: what holds it by its name hears it first (onRenamed: the band, where one left off, what was
   * half written for it), then it is told as the old one gone and the new one come, each as a repo that changed.
   */
  async renameRepo(repo: string, to: string, open: string[], by?: string) {
    await this.inner.renameRepo(repo, to, open);
    this.changes.dispatchEvent(new CustomEvent<{from: string; to: string}>('renamed', {detail: {from: repo, to}}));
    this.tell({repo, path: '', what: 'repo', by});
    this.tell({repo: to, path: '', what: 'repo', by});
  }
  async deleteRepo(repo: string, open: string[], by?: string) {
    await this.inner.deleteRepo(repo, open);
    this.tell({repo, path: '', what: 'repo', by});
  }
  /** Tell what is at `path` as made: a file with its text, or a folder and everything in it. */
  private async made(repo: string, path: string, by?: string) {
    const inside = await this.inner.tree(repo, path).catch(() => null);
    if (inside) {
      this.tell({repo, path, what: 'dir', by});
      for (const e of inside) await this.made(repo, `${path}/${e.name}`, by);
      return;
    }
    const c = await this.inner.read(repo, path).catch(() => null);
    // Not text, or only part of it: nothing to hand on but that the repo changed.
    if (!c || c.text === null || c.truncated) { this.tell({repo, path: '', what: 'repo', by}); return; }
    this.tell({repo, path, what: 'file', text: c.text, by});
  }
  /** Something outside the store changed `repo` (a Prompt on the root writes it directly, or another tab's core). */
  changedOutside(repo: string, by?: string) { this.tell({repo, path: '', what: 'repo', by}); }
  /** These paths of `repo` changed outside the store (the core took them in from the Remote): each said as it is now. */
  async changedPaths(repo: string, paths: string[], by?: string) {
    for (const path of paths) {
      const c = await this.inner.read(repo, path).catch(() => null);
      if (c) { this.tell({repo, path, what: 'file', text: c.text !== null && !c.truncated ? c.text : undefined, by}); continue; }
      // Not a file: a folder (made), or gone.
      const dir = await this.inner.tree(repo, path).then(() => true, () => false);
      this.tell({repo, path, what: dir ? 'dir' : 'removed', by});
    }
  }
}
/** Who wrote, when it was another tab of this browser. */
export const ELSEWHERE = 'elsewhere';

export const store = new Observed(new CoreStore());
// Another tab of this browser changed what is kept: each path it wrote is said as it is now, as the core's own
// sync says what it took in (a repo made or gone is the repo).
onElsewhere((paths) => {
  const at = `${home()}/repos/`;
  const byRepo = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!p.startsWith(at)) continue;
    const [repo, ...rest] = p.slice(at.length).split('/');
    if (!byRepo.has(repo)) byRepo.set(repo, new Set());
    if (rest.length) byRepo.get(repo)!.add(rest.join('/'));
  }
  for (const [repo, inside] of byRepo) {
    if (inside.size) void store.changedPaths(repo, [...inside], ELSEWHERE); else store.changedOutside(repo, ELSEWHERE);
  }
});

/**
 * Everything in a repo, folders and files, in the order a walk down it meets them (each folder's entries as the
 * store lists them, a folder's own before what comes after it): listed a level at a time, every folder of a level
 * asked at once, so a repo of many folders is as many trips to the core as it is deep.
 */
export async function walkRepo(repo: string): Promise<{path: string; entry: Entry}[]> {
  const listed = new Map<string, Entry[]>();
  for (let level = ['']; level.length;) {
    const lists = await Promise.all(level.map((dir) => store.tree(repo, dir)));
    level.forEach((dir, k) => listed.set(dir, lists[k]));
    level = level.flatMap((dir, k) => lists[k].filter((e) => e.kind === 'dir').map((e) => (dir ? `${dir}/${e.name}` : e.name)));
  }
  const out: {path: string; entry: Entry}[] = [];
  const walk = (dir: string) => {
    for (const entry of listed.get(dir) ?? []) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      out.push({path, entry});
      if (entry.kind === 'dir') walk(path);
    }
  };
  walk('');
  return out;
}

/**
 * `read` of each of `items`, in their order, in pieces of about `bytes` by `size` (one item at least), each piece
 * read at once: what the core sends in one message stays a few megabytes. Stops between pieces once `enough` of
 * what was read so far.
 */
export async function inPieces<T, R>(items: T[], size: (item: T) => number, read: (item: T) => Promise<R>, bytes = 4 << 20,
  enough: (got: R[]) => boolean = () => false): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length && !enough(out);) {
    let end = at, n = 0;
    while (end < items.length && (end === at || n + size(items[end]) <= bytes)) n += size(items[end++]);
    out.push(...await Promise.all(items.slice(at, end).map(read)));
    at = end;
  }
  return out;
}

/**
 * Hear each repo renamed (`from`, `to`): what is held by a repo's name while the app runs, or kept by it here, follows
 * it to the new name. Returns the way to stop.
 */
export function onRenamed(listen: (from: string, to: string) => void): () => void {
  const f = (e: Event) => { const {from, to} = (e as CustomEvent<{from: string; to: string}>).detail; listen(from, to); };
  store.changes.addEventListener('renamed', f);
  return () => store.changes.removeEventListener('renamed', f);
}

/** `map`'s entry at `from`, if it has one, at `to` instead (a repo renamed). */
export function rekey<V>(map: Map<string, V>, from: string, to: string) {
  if (!map.has(from)) return;
  map.set(to, map.get(from)!);
  map.delete(from);
}

/** Hear every change made through the store; returns the way to stop. */
export function onChange(listen: (c: Change) => void): () => void {
  const f = (e: Event) => listen((e as CustomEvent<Change>).detail);
  store.changes.addEventListener('change', f);
  return () => store.changes.removeEventListener('change', f);
}
