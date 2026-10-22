// Repos the app manages. Natively they are directories under the app's data
// directory. In a plain browser they are kept in this browser's storage
// (KeptStore, IndexedDB), so closing or reloading the tab ends only what
// runs; the work stays until the site's data is cleared. MemoryStore is
// the same without keeping, for tests.

import {askToKeep, core, isNative} from './host.ts';
import {t} from './i18n.ts';
import * as tabs from './tabs.ts';
import type {Message} from './tabs.ts';
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
  /**
   * Give a file or folder a new name in the folder it is in (`name` one plain
   * part, as a new file's); never replaces what is there.
   */
  rename(repo: string, path: string, name: string): Promise<void>;
  /**
   * Set a path as the Remote has it: a file's text (made or replaced, its
   * folders made), or null for an empty folder. For taking in a draft; a
   * browser's copy only, since the app's is taken in natively.
   */
  put?(repo: string, path: string, text: string | null): Promise<void>;
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
const touchesGit = (path: string) => path.split('/').some(isGitName);

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

class NativeStore implements RepoStore {
  readonly persistent = true;
  list() { return core<RepoSummary[]>('repo_list'); }
  create(name: string, template: Template) { return core<RepoSummary>('repo_create', {name, template}); }
  tree(repo: string, path: string) { return core<Entry[]>('repo_tree', {repo, path}); }
  read(repo: string, path: string) { return core<Contents>('repo_read', {repo, path}); }
  write(repo: string, path: string, text: string) { return core<number>('repo_write', {repo, path, text}); }
  add(repo: string, dir: string, name: string, text: string) { return core<number>('repo_add', {repo, dir, name, text}); }
  mkdir(repo: string, path: string) { return core<void>('repo_mkdir', {repo, path}); }
  remove(repo: string, path: string) { return core<void>('repo_remove', {repo, path}); }
  rename(repo: string, path: string, name: string) { return core<void>('repo_rename', {repo, path, name}); }
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

export interface Kept { files: [string, string | null][]; modified: number }

export class MemoryStore implements RepoStore {
  readonly persistent: boolean = false;
  protected repos = new Map<string, {files: Map<string, string | null>; modified: number}>();
  /**
   * The work each repo shows: main, or an issue's line (work.rs). Each work
   * has its own copy, kept under `repo\u0001line`; the repo's name always
   * reaches the one it shows, as File, Forge and the Prompt expect.
   */
  protected lines = new Map<string, string>();
  /** Where `repo`'s files are now. */
  protected key(repo: string) { const l = this.lines.get(repo); return l && l !== 'main' ? `${repo}\u0001${l}` : repo; }
  /** Show `line`'s copy as `repo` (made empty when there is none yet); returns whether it was made. */
  showLine(repo: string, line: string): boolean {
    if (line === 'main') { this.lines.delete(repo); return false; }
    this.lines.set(repo, line);
    if (this.repos.has(this.key(repo))) return false;
    this.repos.set(this.key(repo), {files: new Map(), modified: Date.now()});
    this.touched(repo);
    return true;
  }
  lineOf(repo: string) { return this.lines.get(repo) ?? 'main'; }
  /** Every work's copy of `repo` held here (main's included), by line. */
  copies(repo: string): string[] {
    return [...this.repos.keys()].filter((k) => k === repo || k.startsWith(`${repo}\u0001`)).map((k) => (k === repo ? 'main' : k.split('\u0001')[1]));
  }
  /** Called after each change to `repo`'s copy, with the paths it changed (none: all of it); KeptStore keeps it. */
  protected touched(_repo: string, _paths?: string[]) {}

  async list() {
    return [...this.repos].filter(([name]) => !name.includes('\u0001')).map(([name]) => this.summary(name, this.repos.get(this.key(name)) ?? this.repos.get(name)!))
      .sort((a, b) => b.modified - a.modified);
  }
  private summary(name: string, r: {files: Map<string, string | null>; modified: number}): RepoSummary {
    const texts = [...r.files.values()].filter((v): v is string => v !== null);
    return {name, files: texts.length, bytes: texts.reduce((n, t) => n + new TextEncoder().encode(t).length, 0),
      modified: r.modified};
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
    const r = this.repos.get(this.key(repo));
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
    const text = this.repos.get(this.key(repo))?.files.get(path);
    if (text === undefined || text === null) throw new Error(`no file ${path}`);
    return {text, size: new TextEncoder().encode(text).length, truncated: false};
  }
  async write(repo: string, path: string, text: string) {
    const r = this.repos.get(this.key(repo));
    const old = r?.files.get(path);
    if (!r || old === undefined || old === null) throw new Error(`no file ${path}`);
    r.files.set(path, text);
    r.modified = Date.now();
    this.touched(repo, [path]);
    return new TextEncoder().encode(text).length;
  }
  async mkdir(repo: string, path: string) {
    const r = this.repos.get(this.key(repo));
    if (!r) throw new Error(`no repo ${repo}`);
    const clean = path.replace(/\/+$/, '');
    if (!clean || clean.split('/').some((p) => p === '..' || !p) || touchesGit(clean)) throw new Error(`path ${path} leaves the repo`);
    const parts = clean.split('/');
    const made: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      if (typeof r.files.get(at) === 'string') throw new Error(`${at} is in the way of a file`);
      if (!r.files.has(at)) { r.files.set(at, null); made.push(at); }
    }
    r.modified = Date.now();
    this.touched(repo, made);
  }
  async remove(repo: string, path: string) {
    const r = this.repos.get(this.key(repo));
    const clean = path.replace(/\/+$/, '');
    if (!r || !clean || touchesGit(clean) || clean.split('/').includes('..')) throw new Error(`cannot remove ${path}`);
    const gone = [...r.files.keys()].filter((p) => p === clean || p.startsWith(`${clean}/`));
    if (!gone.length) throw new Error(`no ${path}`);
    for (const p of gone) r.files.delete(p);
    r.modified = Date.now();
    this.touched(repo, gone);
  }
  async rename(repo: string, path: string, name: string) {
    const r = this.repos.get(this.key(repo));
    const clean = path.replace(/\/+$/, '');
    if (!r || !clean || touchesGit(clean) || clean.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error(`cannot rename ${path}`);
    if (!plainPart(name)) throw new Error(`invalid file name ${name}`);
    const to = renamed(clean, name);
    const moving = [...r.files.keys()].filter((p) => p === clean || p.startsWith(`${clean}/`));
    if (!moving.length) throw new Error(`no ${path}`);
    if (to === clean) return;
    if ([...r.files.keys()].some((p) => p === to || p.startsWith(`${to}/`))) throw new Error(`${to} already exists`);
    // Each path keeps its place in the map's order, under its new name.
    const files = new Map<string, string | null>();
    for (const [p, v] of r.files) files.set(p === clean ? to : p.startsWith(`${clean}/`) ? to + p.slice(clean.length) : p, v);
    r.files = files;
    r.modified = Date.now();
    this.touched(repo, [...moving, ...moving.map((p) => to + p.slice(clean.length))]);
  }
  async put(repo: string, path: string, text: string | null) {
    const r = this.repos.get(this.key(repo));
    if (!r) throw new Error(`no repo ${repo}`);
    const parts = path.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..') || touchesGit(path)) throw new Error(`path ${path} leaves the repo`);
    // A file where a folder of the path would be, or a folder in the file's place, is refused.
    for (let i = 1; i < parts.length; i++) if (typeof r.files.get(parts.slice(0, i).join('/')) === 'string') throw new Error(t('{path}: a file is in the way', {path}));
    if (text !== null && [...r.files.keys()].some((p) => p.startsWith(`${path}/`))) throw new Error(t('{path}: a folder is there', {path}));
    // Parent folders are implied by their files; an empty folder is kept as null.
    const implied: string[] = [];
    for (let i = 1; i < parts.length; i++) { const at = parts.slice(0, i).join('/'); if (r.files.get(at) === null) { r.files.delete(at); implied.push(at); } }
    if (text === null && r.files.get(path) !== undefined) { if (implied.length) this.touched(repo, implied); return; }
    r.files.set(path, text);
    r.modified = Date.now();
    this.touched(repo, [...implied, path]);
  }
  async add(repo: string, dir: string, name: string, text: string) {
    const r = this.repos.get(this.key(repo));
    if (!r) throw new Error(`no repo ${repo}`);
    if (!name || name.startsWith('.') || name.includes('/') || isGitName(name) || touchesGit(dir)) throw new Error(`invalid file name ${name}`);
    // '' is the repo's own top.
    const hasDir = dir === '' || r.files.get(dir) === null || [...r.files.keys()].some((p) => p.startsWith(`${dir}/`));
    if (!hasDir) throw new Error(`no directory ${dir}`);
    const path = dir ? `${dir}/${name}` : name;
    if (r.files.has(path)) throw new Error(`${path} already exists`);
    r.files.set(path, text);
    r.modified = Date.now();
    this.touched(repo, [path]);
    return new TextEncoder().encode(text).length;
  }
}

/**
 * What changed in one copy, to be laid over what is kept for it: each path's
 * value here (undefined: gone), or `whole`, the copy as it is.
 */
export interface Keep { set?: [string, string | null | undefined][]; whole?: [string, string | null][]; modified: number }

/** Where a KeptStore keeps repos: one record per copy (a repo, or one work of it). */
export interface Shelf {
  all(): Promise<[string, Kept][]>;
  get(name: string): Promise<Kept | undefined>;
  /**
   * Lay `change` over what is kept for `name` in one step, so a path another
   * tab kept meanwhile is never written over with what this tab last read.
   * Resolves once it is kept, rejects (the storage is full, say) when not.
   */
  merge(name: string, change: Keep): Promise<void>;
  /**
   * Keep `change` while the page is being left: begun and asked to commit
   * before this returns (a browser ends the page before anything later is
   * kept), and laid over its copy at the next read. False: it cannot be now.
   */
  note(name: string, change: Keep): boolean;
  /** Remove these repos; the work starts synchronously, so it can run while the page is left. */
  drop(names: string[]): Promise<void>;
}

/** Who writes when another tab's change is taken into this one, so listeners can tell it from a person here. */
export const TAB = 'tab';

/** A copy's key: the repo, or `repo\u0001line` for one work of it. */
const repoOfKey = (key: string) => key.split('\u0001')[0];

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Repos kept in this browser: read whole at start, and each change written
 * back shortly after (or at once when the page is being left), so closing
 * or reloading the tab loses nothing that was saved. A change the browser
 * will not keep (its storage full) stays waiting here, is tried again, and
 * is said (trouble). Every tab of the app keeps the same copy: a tab writes
 * only the paths it changed, and the others take them in (tabs.ts).
 */
export class KeptStore extends MemoryStore {
  override readonly persistent = true;
  /** For each copy, the paths changed here and not kept yet ('all': the whole copy). */
  private dirty = new Map<string, Set<string> | 'all'>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shelf: Shelf;
  readonly ready: Promise<void>;
  /** Why the last keeping failed (the storage is full, or cannot be read); null while it works. */
  trouble: string | null = null;
  /** Hears each change another tab made to a copy here: the repo, the copy's key, and the paths (none: the copy came or went). */
  heard: (repo: string, key: string, paths: string[] | null) => void = () => {};
  private troubled = new Set<() => void>();
  private tabs: {post(m: Message): void; hear(fn: (m: Message) => void): unknown};
  constructor(shelf: Shelf, tabs: {post(m: Message): void; hear(fn: (m: Message) => void): unknown} = {post() {}, hear() {}}) {
    super();
    this.shelf = shelf;
    this.tabs = tabs;
    this.ready = shelf.all().then((all) => {
      for (const [name, r] of all) if (validName(repoOfKey(name))) this.repos.set(name, {files: new Map(r.files), modified: r.modified});
    }, (e: unknown) => this.say(t('This browser\'s storage could not be read ({why})', {why: why(e)})));
    tabs.hear((m) => {
      if (m.kind === 'kept') void this.ready.then(() => this.took(m.key, m.paths)).catch(() => {});
      if (m.kind === 'gone') void this.ready.then(() => this.went(m.keys));
    });
  }

  /** Hear when keeping starts or stops failing; returns how to stop. */
  onTrouble(fn: () => void): () => void { this.troubled.add(fn); return () => this.troubled.delete(fn); }
  private say(trouble: string | null) {
    if (trouble === this.trouble) return;
    this.trouble = trouble;
    for (const fn of [...this.troubled]) fn();
  }

  protected override touched(repo: string, paths?: string[]) {
    const key = this.key(repo);
    const was = this.dirty.get(key);
    if (!paths || was === 'all') this.dirty.set(key, 'all');
    else { const s = was ?? new Set<string>(); for (const p of paths) s.add(p); this.dirty.set(key, s); }
    // Written while the page is being left (a field saving itself as the tab closes): kept at once.
    if (this.leaving) this.leave(); else this.soon(300);
  }

  /** The page is being left: nothing written after this waits for a timer. */
  private leaving = false;
  /**
   * The page is being left (pagehide): every change still waiting is kept
   * now, each in one request begun and committed before this returns, which
   * is all a closing tab is given time for. What cannot be is tried as usual.
   */
  leave() {
    this.leaving = true;
    clearTimeout(this.timer);
    for (const [key, paths] of [...this.dirty]) {
      const r = this.repos.get(key);
      if (!r) { this.dirty.delete(key); continue; }
      const change: Keep = paths === 'all' ? {whole: [...r.files], modified: r.modified}
        : {set: [...paths].map((p) => [p, r.files.has(p) ? r.files.get(p) : undefined]), modified: r.modified};
      if (!this.shelf.note(key, change)) { void this.flush().catch(() => {}); return; }
      this.dirty.delete(key);
      this.tabs.post({kind: 'kept', key, paths: paths === 'all' ? undefined : [...paths]});
    }
  }
  /** The page is shown again (from the back-forward cache): writes wait for their timer again. */
  back() { this.leaving = false; }

  private soon(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), ms);
  }

  /** Put back what could not be kept, so the next flush tries it again. */
  private undo(key: string, paths: Set<string> | 'all') {
    const now = this.dirty.get(key);
    if (paths === 'all' || now === 'all') { this.dirty.set(key, 'all'); return; }
    const s = now ?? new Set<string>();
    for (const p of paths) s.add(p);
    this.dirty.set(key, s);
  }

  /**
   * Let these repos go from this browser (their copy holds nothing the
   * Remote lacks). Started at once, so it runs while the page is left.
   */
  letGo(names: string[]): Promise<void> {
    // Every work's copy of each goes with it.
    const keys = names.flatMap((n) => this.copies(n).map((l) => (l === 'main' ? n : `${n}\u0001${l}`)));
    for (const k of keys) { this.repos.delete(k); this.dirty.delete(k); }
    for (const n of names) this.lines.delete(n);
    const done = this.shelf.drop(keys);
    this.tabs.post({kind: 'gone', keys});
    return done;
  }

  /** Whether `repo` has changes not yet written to the shelf. */
  waiting(repo: string) { return this.copies(repo).some((l) => this.dirty.has(l === 'main' ? repo : `${repo}\u0001${l}`)); }

  /**
   * Write every change made here now, path by path over what is kept. One
   * that cannot be kept stays waiting, is tried again shortly, and is said
   * (trouble); the promise then rejects with why.
   */
  async flush() {
    clearTimeout(this.timer);
    const work = [...this.dirty];
    this.dirty.clear();
    const failed: unknown[] = [];
    await Promise.all(work.map(async ([key, paths]) => {
      const r = this.repos.get(key);
      if (!r) return;
      const change: Keep = paths === 'all' ? {whole: [...r.files], modified: r.modified}
        : {set: [...paths].map((p) => [p, r.files.has(p) ? r.files.get(p) : undefined]), modified: r.modified};
      try {
        await this.shelf.merge(key, change);
        this.tabs.post({kind: 'kept', key, paths: paths === 'all' ? undefined : [...paths]});
      } catch (e) {
        this.undo(key, paths);
        failed.push(e);
      }
    }));
    if (failed.length) {
      this.say(t('This browser could not keep the latest changes ({why}); they are kept in this tab until it can', {why: why(failed[0])}));
      this.soon(5000);
      throw new Error(this.trouble!);
    }
    if (work.length) this.say(null);
  }

  /**
   * Take in what another tab kept of `repo`'s copy since this one read it,
   * leaving alone what was changed here and is not kept yet. Returns the
   * paths taken. Run before a sync, so it starts from the copy as kept.
   */
  async reload(repo: string): Promise<string[]> {
    await this.ready;
    return this.took(this.key(repo));
  }

  /** Take in `key`'s copy as kept (only `paths` of it, when given). */
  private async took(key: string, paths?: string[]): Promise<string[]> {
    const kept = await this.shelf.get(key);
    // Nothing kept for it (never flushed, or let go elsewhere): what is here is all there is.
    if (!kept) return [];
    const mine = this.dirty.get(key);
    if (mine === 'all') return [];
    const r = this.repos.get(key);
    if (!r) {
      // A copy made in another tab (a new repo, or a work brought here).
      this.repos.set(key, {files: new Map(kept.files), modified: kept.modified});
      this.heard(repoOfKey(key), key, null);
      return kept.files.map(([p]) => p);
    }
    const there = new Map(kept.files);
    const taken: string[] = [];
    for (const p of paths ?? [...new Set([...there.keys(), ...r.files.keys()])]) {
      if (mine?.has(p)) continue;
      if (there.has(p) === r.files.has(p) && there.get(p) === r.files.get(p)) continue;
      if (there.has(p)) r.files.set(p, there.get(p)!); else r.files.delete(p);
      taken.push(p);
    }
    if (taken.length) { r.modified = Math.max(r.modified, kept.modified); this.heard(repoOfKey(key), key, taken); }
    return taken;
  }

  /** Copies another tab let go: gone here too, unless this tab changed one and has not kept it (it is kept whole again). */
  private went(keys: string[]) {
    const repos = new Set<string>();
    for (const k of keys) {
      if (this.dirty.has(k)) { this.dirty.set(k, 'all'); this.soon(300); continue; }
      this.repos.delete(k);
      repos.add(repoOfKey(k));
    }
    for (const n of repos) {
      if (!this.copies(n).length) this.lines.delete(n);
      this.heard(n, n, null);
    }
  }

  /** The files of one copy of `repo` (`line`'s), as held here; for telling whether a copy not shown has changes. */
  copyOf(repo: string, line: string): ReadonlyMap<string, string | null> | undefined {
    return this.repos.get(line === 'main' ? repo : `${repo}\u0001${line}`)?.files;
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
  override async rename(repo: string, path: string, name: string) { await this.ready; return super.rename(repo, path, name); }
  override async put(repo: string, path: string, text: string | null) { await this.ready; return super.put(repo, path, text); }
}

/** A change kept while the page is being left, beside the copies (no repo is named so): laid over its copy at the next read. */
interface Note extends Keep { key: string }
const NOTE = '\u0002note\u0002';
const NOTES = typeof IDBKeyRange === 'undefined' ? null : IDBKeyRange.bound(NOTE, '\u0002note\u0003');
let noted = 0;

/** `change` laid over `was` (nothing kept yet: undefined). */
export function lay(was: Kept | undefined, change: Keep): Kept {
  if (change.whole) return {files: change.whole, modified: change.modified};
  const files = new Map(was?.files ?? []);
  for (const [p, v] of change.set ?? []) if (v === undefined) files.delete(p); else files.set(p, v);
  return {files: [...files], modified: Math.max(change.modified, was?.modified ?? 0)};
}

/** IndexedDB, as a Shelf. */
function indexedShelf(name = 'length3-repos'): Shelf {
  let opened: IDBDatabase | null = null;
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('repos');
    req.onsuccess = () => { opened = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
  const done = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  /**
   * Run `f` in one read-write transaction; resolves once it is kept, rejects (the storage is full, say) when it
   * is not. A write that fails within it (`fail`, from a request's handler too) ends it, and is why.
   */
  const writing = async (f: (s: IDBObjectStore, fail: (e: unknown) => void) => void) => {
    const d = await db;
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('repos', 'readwrite');
      let failed: unknown;
      const fail = (e: unknown) => { failed = e; try { tx.abort(); } catch { /* over already */ } };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failed ?? tx.error ?? new Error('aborted'));
      try { f(tx.objectStore('repos'), fail); } catch (e) { fail(e); }
    });
  };
  /** Notes for `key` (all of them: undefined) and the copy kept for it, read in `s`; then `then` with them. */
  const withNotes = (s: IDBObjectStore, then: (notes: [IDBValidKey, Note][]) => void) => {
    const keys = s.getAllKeys(NOTES!), values = s.getAll(NOTES!);
    values.onsuccess = () => then((keys.result ?? []).map((k, i) => [k, values.result[i] as Note]));
  };
  return {
    async all() {
      const d = await db;
      const s = d.transaction('repos').objectStore('repos');
      const [keys, values] = await Promise.all([done(s.getAllKeys()), done(s.getAll())]);
      const copies = new Map<string, Kept>(), notes: [IDBValidKey, Note][] = [];
      keys.forEach((k, i) => { if (String(k).startsWith(NOTE)) notes.push([k, values[i] as Note]); else copies.set(String(k), values[i] as Kept); });
      if (!notes.length) return [...copies];
      // What was kept while a page was left is laid over its copy, in the order it was kept; a note for a copy
      // let go since is nothing (unless it is a whole copy, made then).
      const touched = new Set<string>();
      for (const [, n] of notes) {
        if (!n.whole && !copies.has(n.key)) continue;
        copies.set(n.key, lay(copies.get(n.key), n));
        touched.add(n.key);
      }
      // Kept as copies now, the notes go; if that fails they are laid again next time, to the same end.
      await writing((w) => { for (const k of touched) w.put(copies.get(k), k); for (const [k] of notes) w.delete(k); }).catch(() => {});
      return [...copies];
    },
    async get(n) {
      const d = await db;
      return new Promise<Kept | undefined>((resolve, reject) => {
        const tx = d.transaction('repos');
        tx.onerror = () => reject(tx.error);
        const s = tx.objectStore('repos');
        const g = s.get(n);
        withNotes(s, (notes) => {
          let kept = g.result as Kept | undefined;
          for (const [, note] of notes) if (note.key === n && (note.whole || kept)) kept = lay(kept, note);
          resolve(kept);
        });
      });
    },
    merge(n, change) {
      // Read and written in one transaction, so what another tab kept meanwhile (or a note) is laid under this change, never lost.
      return writing((s, fail) => {
        const g = s.get(n);
        withNotes(s, (notes) => {
          try {
            let kept = g.result as Kept | undefined;
            for (const [k, note] of notes) if (note.key === n) { if (note.whole || kept) kept = lay(kept, note); s.delete(k); }
            s.put(lay(kept, change), n);
          } catch (e) { fail(e); }
        });
      });
    },
    note(n, change) {
      // The page is being left: what is written now must be a whole request made at once, asked to commit
      // at once, or the browser ends the page before it is kept.
      if (!opened) return false;
      try {
        const tx = opened.transaction('repos', 'readwrite');
        tx.objectStore('repos').put({...change, key: n} satisfies Note, `${NOTE}${Date.now().toString(36).padStart(10, '0')}-${(noted++).toString(36).padStart(6, '0')}`);
        (tx as IDBTransaction & {commit?: () => void}).commit?.();
        return true;
      } catch { return false; }
    },
    async drop(names) {
      const s = (await db).transaction('repos', 'readwrite').objectStore('repos');
      await Promise.all(names.map((n) => done(s.delete(n))));
    },
  };
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
  async put(repo: string, path: string, text: string | null, by?: string) {
    if (!this.inner.put) throw new Error('this store takes in natively');
    await this.inner.put(repo, path, text);
    this.tell({repo, path, what: text === null ? 'dir' : 'file', text: text ?? undefined, by});
  }
  /** Show the copy of `line`'s work as `repo` (a browser's copy; the app does this natively). */
  showLine(repo: string, line: string): boolean {
    const inner = this.inner as Partial<MemoryStore>;
    const made = inner.showLine ? inner.showLine.call(this.inner, repo, line) : false;
    this.tell({repo, path: '', what: 'repo', by: 'work'});
    return made;
  }
  lineOf(repo: string): string { const inner = this.inner as Partial<MemoryStore>; return inner.lineOf ? inner.lineOf.call(this.inner, repo) : 'main'; }
  copies(repo: string): string[] { const inner = this.inner as Partial<MemoryStore>; return inner.copies ? inner.copies.call(this.inner, repo) : ['main']; }
  /** Something outside the store changed `repo` (a Prompt on the root writes it directly). */
  changedOutside(repo: string, by?: string) { this.tell({repo, path: '', what: 'repo', by}); }
  /** Another tab changed these paths of the copy `repo` shows (none: the copy came or went); said as they are now. */
  async changedInTab(repo: string, paths: string[] | null) {
    if (!paths) { this.tell({repo, path: '', what: 'repo', by: TAB}); return; }
    for (const path of paths) {
      const c = await this.inner.read(repo, path).catch(() => null);
      if (c) { this.tell({repo, path, what: 'file', text: c.text ?? undefined, by: TAB}); continue; }
      // Not a file: a folder (made or emptied), or gone.
      const dir = await this.inner.tree(repo, path).then(() => true, () => false);
      this.tell({repo, path, what: dir ? 'dir' : 'removed', by: TAB});
    }
  }
}

export const kept = isNative || typeof indexedDB === 'undefined' ? null : new KeptStore(indexedShelf(), tabs);
// Leaving the page keeps what is still waiting, at once (KeptStore.leave).
if (kept) {
  addEventListener('pagehide', () => kept.leave());
  addEventListener('pageshow', () => kept.back());
  // Hidden (another tab, the window put away; on a phone, often the last a page hears): kept now, not in a while.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void kept.flush().catch(() => {}); });
}
export const store = new Observed(isNative ? new NativeStore() : kept ?? new MemoryStore());
// What another tab kept is shown here as it is, when it is of the copy shown.
if (kept) kept.heard = (repo, key, paths) => { if (!paths || key === (kept.lineOf(repo) === 'main' ? repo : `${repo}\u0001${kept.lineOf(repo)}`)) void store.changedInTab(repo, paths); };

/** Hear every change made through the store; returns the way to stop. */
export function onChange(listen: (c: Change) => void): () => void {
  const f = (e: Event) => listen((e as CustomEvent<Change>).detail);
  store.changes.addEventListener('change', f);
  return () => store.changes.removeEventListener('change', f);
}
