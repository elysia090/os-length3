// Repos the OS manages: directories under its data directory, kept by the core (core/src/repos.rs), the
// app's own or the same built for the web, over the files this browser keeps (core-client.ts). Either way
// a repo is the same thing, read and written by the same code.

import {core} from './host.ts';
import {onElsewhere} from './core-client.ts';
import shared from '../shared/templates.json' with {type: 'json'};

export interface RepoSummary {
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

export interface RepoStore {
  list(): Promise<RepoSummary[]>;
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
   * Give a file or folder a new name in the folder it is in (`name` one plain
   * part, as a new file's); never replaces what is there.
   */
  rename(repo: string, path: string, name: string): Promise<void>;
  /** Write `path` whole as these bytes, of any size or kind, its folders made (what a Prompt wrote back). */
  put(repo: string, path: string, bytes: Uint8Array): Promise<number>;
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

/** Same rule as the native side: a plain directory name. */
export function validName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name);
}

class CoreStore implements RepoStore {
  list() { return core<RepoSummary[]>('repo_list'); }
  create(name: string, template: Template) { return core<RepoSummary>('repo_create', {name, template}); }
  tree(repo: string, path: string) { return core<Entry[]>('repo_tree', {repo, path}); }
  read(repo: string, path: string) { return core<Contents>('repo_read', {repo, path}); }
  write(repo: string, path: string, text: string) { return core<number>('repo_write', {repo, path, text}); }
  add(repo: string, dir: string, name: string, text: string) { return core<number>('repo_add', {repo, dir, name, text}); }
  mkdir(repo: string, path: string) { return core<void>('repo_mkdir', {repo, path}); }
  remove(repo: string, path: string) { return core<void>('repo_remove', {repo, path}); }
  rename(repo: string, path: string, name: string) { return core<void>('repo_rename', {repo, path, name}); }
  put(repo: string, path: string, bytes: Uint8Array) { return core<number>('repo_put', {repo, path, bytes: base64(bytes)}); }
  async bytes(repo: string, path: string) { return Uint8Array.from(atob(await core<string>('repo_bytes', {repo, path})), (c) => c.charCodeAt(0)); }
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

/** A change made through the store: a file's new text, a new directory, or a removal (a rename is told as the old path removed, then what is at the new one). */
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
   * A rename is the old path gone and the new one made: those who keep a copy
   * (the shell's) take it as any removal and new files, and the Remote gets it
   * as any other change.
   */
  async rename(repo: string, path: string, name: string, by?: string) {
    await this.inner.rename(repo, path, name);
    const to = renamed(path.replace(/\/+$/, ''), name);
    if (to === path) return;
    this.tell({repo, path, what: 'removed', by});
    await this.made(repo, to, by);
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
}
/** Who wrote, when it was another tab of this browser. */
export const ELSEWHERE = 'elsewhere';

export const store = new Observed(new CoreStore());
// Another tab of this browser changed what is kept: every repo shown is read again.
onElsewhere(() => void store.list().then((all) => { for (const r of all) store.changedOutside(r.name, ELSEWHERE); }, () => {}));

/** Hear every change made through the store; returns the way to stop. */
export function onChange(listen: (c: Change) => void): () => void {
  const f = (e: Event) => listen((e as CustomEvent<Change>).detail);
  store.changes.addEventListener('change', f);
  return () => store.changes.removeEventListener('change', f);
}
