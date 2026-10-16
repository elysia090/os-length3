// History in the issues' terms (core/src/history.rs): the draft is always on
// the Remote; 区切る makes it history, a cut named like an issue and tied to
// its file. What is not cut yet is the draft against the last cut, grouped
// by folder. The app asks its core; a browser does the same here.

import {baseOf, blobText, headTree, setHead, sync, type Tree} from './draft.ts';
import {isNative} from './host.ts';
import {counts, lineOps} from './linediff.ts';
import {api, connection, json, RemoteError} from './remote.ts';
import {store} from './repos.ts';
import {kindOf} from './text.ts';

export interface FileChange { path: string; status: 'added' | 'modified' | 'removed'; added: number; removed: number; binary: boolean }
export interface Folder { folder: string; files: FileChange[]; added: number; removed: number }
export interface Changes { connected: boolean; folders: Folder[]; files: number; added: number; removed: number }
export interface Cut { id: string; issue: string | null; kind: string | null; title: string; note: string; time: number; folders: string[]; files: number; added: number; removed: number }
export interface DiffLine { kind: 'hunk' | 'add' | 'del' | 'same'; text: string }
export interface FileDiff { path: string; status: FileChange['status']; binary: boolean; lines: DiffLine[]; more: number }

/** How a status reads: a word, not a letter. */
export const STATUS_WORD: Record<FileChange['status'], string> = {added: '追加', modified: '変更', removed: '削除'};

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// ---- a browser: the copy here against the head's tree ----

interface Pair { path: string; status: FileChange['status']; before: string | null; after: string | null; binary: boolean }

async function hereTree(repo: string): Promise<Record<string, string>> {
  // Only files count; a file's text is compared, not its digest, so no hashing here.
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const e of await store.tree(repo, dir)) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') await walk(path);
      else { const c = await store.read(repo, path).catch(() => null); if (c?.text != null) out[path] = c.text; }
    }
  };
  await walk('');
  return out;
}

async function pairs(repo: string): Promise<Pair[]> {
  const then: Tree = connection() ? await headTree(repo).catch(() => ({})) : {};
  const away = new Set(baseOf(repo)?.away ?? []);
  const now = await hereTree(repo);
  const out: Pair[] = [];
  for (const path of [...new Set([...Object.keys(then), ...Object.keys(now)])].sort()) {
    const was = then[path], is = now[path];
    if (was === null || (was === undefined && is === undefined) || away.has(path)) continue;
    const before = typeof was === 'string' ? await blobText(was) : '';
    if (before === null) { if (is === undefined) out.push({path, status: 'removed', before: null, after: null, binary: true}); continue; }
    if (is !== undefined && before === is && typeof was === 'string') continue;
    out.push({path, status: was === undefined ? 'added' : is === undefined ? 'removed' : 'modified', before, after: is ?? '', binary: false});
  }
  return out;
}

function group(files: FileChange[], connected: boolean): Changes {
  const by = new Map<string, Folder>();
  for (const f of files) {
    const k = folderOf(f.path);
    const g = by.get(k) ?? {folder: k, files: [], added: 0, removed: 0};
    g.files.push(f); g.added += f.added; g.removed += f.removed;
    by.set(k, g);
  }
  const folders = [...by.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  return {connected, folders, files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0)};
}

async function webChanges(repo: string): Promise<Changes> {
  const files = (await pairs(repo)).map((p): FileChange => ({path: p.path, status: p.status, binary: p.binary,
    ...(p.binary ? {added: 0, removed: 0} : counts(lineOps(p.before ?? '', p.after ?? '')))}));
  return group(files, connection() !== null);
}

async function webDiff(repo: string): Promise<FileDiff[]> {
  return (await pairs(repo)).map((p) => {
    if (p.binary) return {path: p.path, status: p.status, binary: true, lines: [], more: 0};
    const ops = lineOps(p.before ?? '', p.after ?? '');
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

/** The words a cut goes by: an issue's first line, or the line given. */
async function wordsFor(repo: string, issue: string | null, line: string): Promise<{kind: string; title: string}> {
  const c = issue ? await store.read(repo, `issue/${issue}`).catch(() => null) : null;
  const {kind, title} = kindOf(c?.text?.split('\n')[0] ?? line);
  return {kind: kind ?? '', title};
}

async function webCut(repo: string, issue: string | null, line: string, note: string): Promise<Cut> {
  if (!connection()) throw new RemoteError(0, '区切りは Remote に残ります。先に Remote に入ってください');
  const words = await wordsFor(repo, issue, line);
  if (!words.title.trim()) throw new RemoteError(0, '区切るには件名がいります（例: Fix：件名）');
  for (let round = 0; round < 4; round++) {
    const s = await sync(repo);
    const c = await webChanges(repo);
    if (!c.files) throw new RemoteError(0, 'まだ区切っていない変更がありません');
    const r = await api(`/v1/repos/${encodeURIComponent(repo)}/cuts`, {method: 'POST', body: JSON.stringify({
      version: s.version, parent: baseOf(repo)?.head ?? null, kind: words.kind, title: words.title.trim(),
      issue: issue ? `issue/${issue}` : '', note: note.trim(), added: c.added, removed: c.removed,
    })});
    const body = await r.json() as {id?: string; time?: number; head?: string | null};
    if (r.status === 201 && body.id) {
      await setHead(repo, body.id);
      return {id: body.id, issue: issue ? `issue/${issue}` : null, kind: words.kind || null, title: words.title.trim(), note: note.trim(),
        time: body.time ?? Date.now(), folders: c.folders.map((f) => f.folder), files: c.files, added: c.added, removed: c.removed};
    }
    // Another device moved the draft or cut first: in step again, and once more.
    await setHead(repo, body.head ?? null);
  }
  throw new RemoteError(409, 'Remote が動き続けていて区切れませんでした');
}

interface RemoteCut { id: string; parent: string | null; tree: Tree; kind: string; title: string; issue: string; note: string; time: number; added: number; removed: number }

async function webLog(repo: string): Promise<Cut[]> {
  if (!connection()) return [];
  const r = await api(`/v1/repos/${encodeURIComponent(repo)}/log?limit=50`);
  if (r.status === 404) return [];
  const cuts = await r.json() as RemoteCut[];
  const trees = new Map(cuts.map((c) => [c.id, c.tree]));
  return cuts.map((c) => {
    const parent = (c.parent && trees.get(c.parent)) || {};
    const changed = [...new Set([...Object.keys(c.tree), ...Object.keys(parent)])]
      .filter((p) => c.tree[p] !== parent[p] && (typeof c.tree[p] === 'string' || typeof parent[p] === 'string'));
    const folders = [...new Set(changed.map(folderOf))];
    return {id: c.id, issue: c.issue || null, kind: c.kind || null, title: c.title, note: c.note, time: c.time, folders, files: changed.length, added: c.added, removed: c.removed};
  });
}

// ---- the same on either host ----

/** Whether this device can cut: only with a Remote, where history is kept. */
export const canCut = () => connection() !== null;

export const changes = (repo: string) => (isNative ? invoke<Changes>('history_changes', {repo}) : webChanges(repo));
export const diff = (repo: string) => (isNative ? invoke<FileDiff[]>('history_diff', {repo}) : webDiff(repo));
export const log = (repo: string) => (isNative ? invoke<Cut[]>('history_log', {repo}) : webLog(repo));

/** 区切る under `issue` (its file name in issue/), or without one, named by `line`. */
export const cut = (repo: string, issue: string | null, line: string, note: string): Promise<Cut> =>
  isNative ? invoke<Cut>('history_cut', {repo, issue, line, note}) : webCut(repo, issue, line, note);

/** One cut from the Remote, for a page that shows it. */
export const cutById = (repo: string, id: string) => json<RemoteCut>(`/v1/repos/${encodeURIComponent(repo)}/cuts/${id}`);
