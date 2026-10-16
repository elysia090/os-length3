// Repos the app manages. Natively they are directories under the app's data
// directory; in a plain browser they live in memory for this page only,
// and `persistent` says so.

import {isNative} from './host.ts';

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

export type Template = 'standard' | 'c' | 'empty';

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
}

export const TEMPLATES: readonly {id: Template; label: string; files: readonly string[]}[] = [
  {id: 'standard', label: '標準', files: ['README.md', 'docs/', 'issue/']},
  {id: 'c', label: 'C', files: ['README.md', 'docs/', 'issue/', 'src/main.c', 'Makefile']},
  {id: 'empty', label: '最小', files: ['README.md']},
];

/** Same rule as the native side: a plain directory name. */
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
}

/** Files of a new repo, mirroring the native templates. Inbox and TODO
 * belong to the app, so no template carries them. */
export function templateFiles(name: string, template: Template): Map<string, string | null> {
  const files = new Map<string, string | null>([['README.md', `# ${name}\n`]]);
  if (template !== 'empty') {
    files.set('docs', null);
    files.set('issue', null);
  }
  if (template === 'c') {
    files.set('src/main.c', '#include <stdio.h>\n\nint main(void) {\n    puts("hello");\n    return 0;\n}\n');
    files.set('Makefile', `${name}: src/main.c\n\tcc -O2 -o $@ src/main.c\n`);
  }
  return files;
}

export class MemoryStore implements RepoStore {
  readonly persistent = false;
  private repos = new Map<string, {files: Map<string, string | null>; modified: number}>();

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
    return new TextEncoder().encode(text).length;
  }
  async add(repo: string, dir: string, name: string, text: string) {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`no repo ${repo}`);
    if (!name || name.startsWith('.') || name.includes('/')) throw new Error(`invalid file name ${name}`);
    const hasDir = r.files.get(dir) === null || [...r.files.keys()].some((p) => p.startsWith(`${dir}/`));
    if (!hasDir) throw new Error(`no directory ${dir}`);
    const path = `${dir}/${name}`;
    if (r.files.has(path)) throw new Error(`${path} already exists`);
    r.files.set(path, text);
    r.modified = Date.now();
    return new TextEncoder().encode(text).length;
  }
}

export const store: RepoStore = isNative ? new NativeStore() : new MemoryStore();
