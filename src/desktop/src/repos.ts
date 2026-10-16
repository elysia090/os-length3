// Repos the app manages. Natively they are directories under the app's data
// directory. In a plain browser they are kept in this browser's storage
// (KeptStore, IndexedDB), so closing or reloading the tab ends only what
// runs; the work stays until the site's data is cleared. MemoryStore is
// the same without keeping, for tests.

import {askToKeep, isNative} from './host.ts';
import shared from '../shared/templates.json' with {type: 'json'};

export interface RepoSummary {
  name: string;
  files: number;
  bytes: number;
  modified: number;
  git: boolean;
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
  readonly persistent: boolean;
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
}

interface SharedTemplate { id: string; label: string; dirs: string[]; files: [string, string][] }

/** Templates as l3 and the native side read them: shared/templates.json. */
export const TEMPLATES: readonly {id: Template; label: string; files: readonly string[]}[] =
  (shared as SharedTemplate[]).map((t) => ({id: t.id, label: t.label, files: [...t.files.map(([p]) => p), ...t.dirs.map((d) => `${d}/`)]}));

/** Same rule as the native side: a plain directory name. */
/**
 * Whether a path part names a repo's .git however it is spelt (core's
 * is_git_name): case, trailing dots and spaces, the short name git~1 and
 * invisible code points do not make it something else.
 */
export function isGitName(part: string): boolean {
  const name = part.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toLowerCase().replace(/[. ]+$/, '');
  return name === '.git' || name === 'git~1';
}
const touchesGit = (path: string) => path.split('/').some(isGitName);

export function validName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(name);
}

class NativeStore implements RepoStore {
  readonly persistent = true;
  private async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const {invoke} = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
  list() { return this.call<RepoSummary[]>('repo_list'); }
  create(name: string, template: Template) { return this.call<RepoSummary>('repo_create', {name, template}); }
  tree(repo: string, path: string) { return this.call<Entry[]>('repo_tree', {repo, path}); }
  read(repo: string, path: string) { return this.call<Contents>('repo_read', {repo, path}); }
  write(repo: string, path: string, text: string) { return this.call<number>('repo_write', {repo, path, text}); }
  add(repo: string, dir: string, name: string, text: string) { return this.call<number>('repo_add', {repo, dir, name, text}); }
  mkdir(repo: string, path: string) { return this.call<void>('repo_mkdir', {repo, path}); }
  remove(repo: string, path: string) { return this.call<void>('repo_remove', {repo, path}); }
}

/** Files of a new repo, from the same shared/templates.json as the native
 * side and l3. Inbox and TODO belong to the OS, so no template carries them.
 * Directories map to null. */
export function templateFiles(name: string, template: Template): Map<string, string | null> {
  const t = (shared as SharedTemplate[]).find((x) => x.id === template);
  if (!t) throw new Error(`unknown template ${template}`);
  const files = new Map<string, string | null>(t.files.map(([p, text]) => [p, text.replaceAll('{name}', name)]));
  for (const d of t.dirs) files.set(d, null);
  return files;
}

export interface Kept { files: [string, string | null][]; modified: number }

export class MemoryStore implements RepoStore {
  readonly persistent: boolean = false;
  protected repos = new Map<string, {files: Map<string, string | null>; modified: number}>();
  /** Called after each change to `repo` (KeptStore keeps it). */
  protected touched(_repo: string) {}

  async list() {
    return [...this.repos].map(([name, r]) => this.summary(name, r)).sort((a, b) => b.modified - a.modified);
  }
  private summary(name: string, r: {files: Map<string, string | null>; modified: number}): RepoSummary {
    const texts = [...r.files.values()].filter((v): v is string => v !== null);
    return {name, files: texts.length, bytes: texts.reduce((n, t) => n + new TextEncoder().encode(t).length, 0),
      modified: r.modified, git: false};
  }
  async create(name: string, template: Template) {
    if (!validName(name)) throw new Error(`invalid repo name ${name}`);
    if (this.repos.has(name)) throw new Error(`repo ${name} already exists`);
    const r = {files: templateFiles(name, template), modified: Date.now()};
    this.repos.set(name, r);
    this.touched(name);
    return this.summary(name, r);
  }
  async tree(repo: string, path: string) {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`no repo ${repo}`);
    const prefix = path ? path.replace(/\/$/, '') + '/' : '';
    // Like the native side: a directory that is not there is an error, not an empty list.
    if (path && r.files.get(path.replace(/\/$/, '')) !== null && ![...r.files.keys()].some((p) => p.startsWith(prefix))) {
      throw new Error(`no directory ${path}`);
    }
    const seen = new Map<string, Entry>();
    for (const [p, v] of r.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length), [head, ...tail] = rest.split('/');
      if (!head) continue;
      const dir = tail.length > 0 || v === null;
      seen.set(head, {name: head, kind: dir ? 'dir' : 'file', size: dir ? 0 : new TextEncoder().encode(v!).length});
    }
    return [...seen.values()].sort((a, b) => Number(a.kind !== 'dir') - Number(b.kind !== 'dir') || a.name.localeCompare(b.name));
  }
  async read(repo: string, path: string) {
    const text = this.repos.get(repo)?.files.get(path);
    if (text === undefined || text === null) throw new Error(`no file ${path}`);
    return {text, size: new TextEncoder().encode(text).length, truncated: false};
  }
  async write(repo: string, path: string, text: string) {
    const r = this.repos.get(repo);
    const old = r?.files.get(path);
    if (!r || old === undefined || old === null) throw new Error(`no file ${path}`);
    r.files.set(path, text);
    r.modified = Date.now();
    this.touched(repo);
    return new TextEncoder().encode(text).length;
  }
  async mkdir(repo: string, path: string) {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`no repo ${repo}`);
    const clean = path.replace(/\/+$/, '');
    if (!clean || clean.split('/').some((p) => p === '..' || !p) || touchesGit(clean)) throw new Error(`path ${path} leaves the repo`);
    const parts = clean.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      if (typeof r.files.get(at) === 'string') throw new Error(`${at} is in the way of a file`);
      if (!r.files.has(at)) r.files.set(at, null);
    }
    r.modified = Date.now();
    this.touched(repo);
  }
  async remove(repo: string, path: string) {
    const r = this.repos.get(repo);
    const clean = path.replace(/\/+$/, '');
    if (!r || !clean || touchesGit(clean) || clean.split('/').includes('..')) throw new Error(`cannot remove ${path}`);
    const gone = [...r.files.keys()].filter((p) => p === clean || p.startsWith(`${clean}/`));
    if (!gone.length) throw new Error(`no ${path}`);
    for (const p of gone) r.files.delete(p);
    r.modified = Date.now();
    this.touched(repo);
  }
  async add(repo: string, dir: string, name: string, text: string) {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`no repo ${repo}`);
    if (!name || name.startsWith('.') || name.includes('/') || isGitName(name) || touchesGit(dir)) throw new Error(`invalid file name ${name}`);
    // '' is the repo's own top.
    const hasDir = dir === '' || r.files.get(dir) === null || [...r.files.keys()].some((p) => p.startsWith(`${dir}/`));
    if (!hasDir) throw new Error(`no directory ${dir}`);
    const path = dir ? `${dir}/${name}` : name;
    if (r.files.has(path)) throw new Error(`${path} already exists`);
    r.files.set(path, text);
    r.modified = Date.now();
    this.touched(repo);
    return new TextEncoder().encode(text).length;
  }
}

/** Where a KeptStore keeps repos: one record per repo. */
export interface Shelf {
  all(): Promise<[string, Kept][]>;
  put(name: string, repo: Kept): Promise<void>;
  /** Remove these repos; the work starts synchronously, so it can run while the page is left. */
  drop(names: string[]): Promise<void>;
}

/**
 * Repos kept in this browser: read whole at start, and each change written
 * back shortly after (or at once when the page is being left), so closing
 * or reloading the tab loses nothing that was saved.
 */
export class KeptStore extends MemoryStore {
  override readonly persistent = true;
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shelf: Shelf;
  readonly ready: Promise<void>;
  constructor(shelf: Shelf) {
    super();
    this.shelf = shelf;
    this.ready = shelf.all().then((all) => {
      for (const [name, r] of all) if (validName(name)) this.repos.set(name, {files: new Map(r.files), modified: r.modified});
    }, () => {});
  }
  protected override touched(repo: string) {
    this.dirty.add(repo);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }
  /**
   * Let these repos go from this browser (their copy holds nothing the
   * Remote lacks). Started at once, so it runs while the page is left.
   */
  letGo(names: string[]): Promise<void> {
    for (const n of names) { this.repos.delete(n); this.dirty.delete(n); }
    return this.shelf.drop(names);
  }

  /** Whether `repo` has changes not yet written to the shelf. */
  waiting(repo: string) { return this.dirty.has(repo); }

  /** Write every changed repo now. */
  async flush() {
    clearTimeout(this.timer);
    const names = [...this.dirty];
    this.dirty.clear();
    await Promise.all(names.map((n) => {
      const r = this.repos.get(n);
      return r ? this.shelf.put(n, {files: [...r.files], modified: r.modified}) : Promise.resolve();
    }));
  }
  // Nothing is answered before what was kept is read.
  override async list() { await this.ready; return super.list(); }
  override async create(name: string, template: Template) {
    await this.ready;
    const r = await super.create(name, template);
    // Work now exists here: ask the browser not to clear it when room runs short.
    void askToKeep();
    return r;
  }
  override async tree(repo: string, path: string) { await this.ready; return super.tree(repo, path); }
  override async read(repo: string, path: string) { await this.ready; return super.read(repo, path); }
  override async write(repo: string, path: string, text: string) { await this.ready; return super.write(repo, path, text); }
  override async add(repo: string, dir: string, name: string, text: string) { await this.ready; return super.add(repo, dir, name, text); }
  override async mkdir(repo: string, path: string) { await this.ready; return super.mkdir(repo, path); }
  override async remove(repo: string, path: string) { await this.ready; return super.remove(repo, path); }
}

/** IndexedDB, as a Shelf. */
export function indexedShelf(name = 'length3-repos'): Shelf {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('repos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const db = open();
  const done = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    async all() {
      const s = (await db).transaction('repos').objectStore('repos');
      const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
      return keys.map((k, i) => [String(k), values[i] as Kept]);
    },
    async put(n, repo) { await done((await db).transaction('repos', 'readwrite').objectStore('repos').put(repo, n)); },
    async drop(names) {
      const s = (await db).transaction('repos', 'readwrite').objectStore('repos');
      await Promise.all(names.map((n) => done(s.delete(n))));
    },
  };
}

/** A change made through the store: a file's new text, a new directory, or a removal. */
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
  get persistent() { return this.inner.persistent; }
  private tell(c: Change) { this.changes.dispatchEvent(new CustomEvent<Change>('change', {detail: c})); }
  list() { return this.inner.list(); }
  tree(repo: string, path: string) { return this.inner.tree(repo, path); }
  read(repo: string, path: string) { return this.inner.read(repo, path); }
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
  async mkdir(repo: string, path: string, by?: string) {
    await this.inner.mkdir(repo, path);
    this.tell({repo, path, what: 'dir', by});
  }
  async remove(repo: string, path: string, by?: string) {
    await this.inner.remove(repo, path);
    this.tell({repo, path, what: 'removed', by});
  }
  /** Something outside the store changed `repo` (a Prompt on the root writes it directly). */
  changedOutside(repo: string, by?: string) { this.tell({repo, path: '', what: 'repo', by}); }
}

export const kept = isNative || typeof indexedDB === 'undefined' ? null : new KeptStore(indexedShelf());
// Leaving the page writes what is still waiting.
if (kept) addEventListener('pagehide', () => void kept.flush());
export const store = new Observed(isNative ? new NativeStore() : kept ?? new MemoryStore());

/** Hear every change made through the store; returns the way to stop. */
export function onChange(listen: (c: Change) => void): () => void {
  const f = (e: Event) => listen((e as CustomEvent<Change>).detail);
  store.changes.addEventListener('change', f);
  return () => store.changes.removeEventListener('change', f);
}
