// Git in the issues' terms (core/src/git.rs): changes not yet cut, grouped by
// folder; cutting them into history under an issue (a commit named after it
// and tied to its file); and the cuts so far. A cut is also the push: the
// history that counts is the Remote's (sync.ts). In the app it is the
// repo's own git first, then the Remote; a browser has no git, so its
// changes are this copy against the cut it came from, and its cuts are the
// Remote's.

import {isNative} from './host.ts';
import {counts, lineOps} from './linediff.ts';
import {store} from './repos.ts';
import * as sync from './sync.ts';
import {kindOf} from './text.ts';

export interface FileChange { path: string; status: 'added' | 'modified' | 'removed' | 'renamed'; added: number; removed: number; binary: boolean }
export interface Folder { folder: string; files: FileChange[]; added: number; removed: number }
export interface Changes { git: boolean; folders: Folder[]; files: number; added: number; removed: number }
export interface Commit { id: string; issue: string | null; kind: string | null; title: string; author: string; time: number; folders: string[]; files: number; added: number; removed: number }

export interface DiffLine { kind: 'hunk' | 'add' | 'del' | 'same'; text: string }
export interface FileDiff { path: string; status: FileChange['status']; binary: boolean; lines: DiffLine[]; more: number }

/** Whether this checkout can cut: the app always (its git), a browser once it has a Remote. */
export const canCut = () => isNative || sync.connection() !== null;

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** A cut, and what became of its push. */
export type Cut = Commit & {push: {id: string} | {error: string} | null};

export const changes = (repo: string) => (isNative ? call<Changes>('git_changes', {repo}) : webChanges(repo));

/**
 * Cut under `issue` (its file name in issue/), or without one, named by
 * `line`; then push it, unless `push` is false (a cut that came from the Remote).
 */
export async function cut(repo: string, issue: string | null, line: string, note: string, push = true): Promise<Cut> {
  const words = await wordsFor(repo, issue, line);
  if (!isNative) return webCut(repo, issue, words, note);
  const c = await call<Commit>('git_cut', {repo, issue, line, note});
  if (!push || !sync.connection()) return {...c, push: null};
  const result = await sync.push(repo, {kind: c.kind ?? words.kind, title: c.title, issue: c.issue ?? '', note})
    .then(({id}) => ({id}), (e: unknown) => ({error: e instanceof Error ? e.message : String(e)}));
  return {...c, push: result};
}

export const log = (repo: string) => (isNative ? call<Commit[]>('git_log', {repo}) : webLog(repo));
/** The changes not yet cut, line by line. */
export const diff = (repo: string) => (isNative ? call<FileDiff[]>('git_diff', {repo}) : webDiff(repo));

/** The words a cut goes by: the issue's first line, or the line given. */
async function wordsFor(repo: string, issue: string | null, line: string): Promise<{kind: string; title: string}> {
  const c = issue ? await store.read(repo, `issue/${issue}`).catch(() => null) : null;
  const {kind, title} = kindOf(c?.text?.split('\n')[0] ?? line);
  return {kind: kind ?? '', title};
}

// ---- a checkout without git: this copy against its base on the Remote ----

interface Pair { path: string; status: FileChange['status']; before: string; after: string }

async function pairs(repo: string): Promise<Pair[]> {
  const base = sync.baseOf(repo)?.tree ?? {};
  const {tree} = await sync.treeOf(repo);
  const out: Pair[] = [];
  for (const path of sync.differ(tree, base)) {
    const was = base[path], now = tree[path];
    if (was === null || now === null) continue; // folders count through their files
    const before = was ? await sync.blobText(was) : '';
    const after = now ? (await store.read(repo, path)).text ?? '' : '';
    out.push({path, status: !was ? 'added' : !now ? 'removed' : 'modified', before, after});
  }
  return out;
}

async function webChanges(repo: string): Promise<Changes> {
  const folders = new Map<string, Folder>();
  let added = 0, removed = 0, files = 0;
  for (const p of await pairs(repo)) {
    const n = counts(lineOps(p.before, p.after));
    const at = p.path.lastIndexOf('/');
    const name = at < 0 ? '' : p.path.slice(0, at);
    const f = folders.get(name) ?? {folder: name, files: [], added: 0, removed: 0};
    f.files.push({path: p.path, status: p.status, ...n, binary: false});
    f.added += n.added; f.removed += n.removed;
    folders.set(name, f);
    added += n.added; removed += n.removed; files++;
  }
  return {git: false, folders: [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder)), files, added, removed};
}

async function webDiff(repo: string): Promise<FileDiff[]> {
  return (await pairs(repo)).map((p) => {
    const ops = lineOps(p.before, p.after);
    // Three lines either side of a change, as git shows them.
    const keep = ops.map((o, i) => o.kind !== 'same' || ops.slice(Math.max(0, i - 3), i + 4).some((x) => x.kind !== 'same'));
    const lines: DiffLine[] = [];
    ops.forEach((o, i) => {
      if (!keep[i]) return;
      if (i > 0 && !keep[i - 1]) lines.push({kind: 'hunk', text: '…'});
      lines.push({kind: o.kind, text: o.text});
    });
    return {path: p.path, status: p.status, binary: false, lines: lines.slice(0, 400), more: Math.max(0, lines.length - 400)};
  });
}

async function webCut(repo: string, issue: string | null, words: {kind: string; title: string}, note: string): Promise<Cut> {
  const c = await changes(repo);
  if (!c.files) throw new Error('区切る変更がありません');
  const {id} = await sync.push(repo, {kind: words.kind, title: words.title, issue: issue ? `issue/${issue}` : '', note});
  return {id, issue: issue ? `issue/${issue}` : null, kind: words.kind || null, title: words.title, author: '', time: Date.now(),
    folders: c.folders.map((f) => f.folder), files: c.files, added: c.added, removed: c.removed, push: {id}};
}

async function webLog(repo: string): Promise<Commit[]> {
  const cuts = await sync.remoteLog(repo);
  return cuts.map((c, i) => {
    const parent = cuts[i + 1]?.tree ?? {};
    const changed = sync.differ(c.tree, parent);
    const folders = [...new Set(changed.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')))];
    return {id: c.id, issue: c.issue || null, kind: c.kind || null, title: c.title, author: '', time: c.time, folders, files: changed.length, added: 0, removed: 0};
  });
}

/** How a status reads: a word, not a letter. */
export const STATUS_WORD: Record<FileChange['status'], string> = {added: '追加', modified: '変更', removed: '削除', renamed: '名前変更'};
