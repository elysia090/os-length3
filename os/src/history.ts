// History in the issues' terms (core/src/history.rs, issue #17). An issue
// is the unit of work; its branch and worktree are the OS's to keep. The
// operations are Commit, Push, Change (again: the next version;
// Reset takes it back), Review (of one version), and the receiver's Merge
// and Reject. What is not committed is the draft against the work's last
// commit, by folder. The app asks its core; a browser does the same here.

import {at, baseOf, blobText, headTree, lineOf, setHead, showLine, sync, treeAt, type Tree} from './draft.ts';
import {isNative, native} from './host.ts';
import {counts, hunks, lineOps, type DiffLine} from './linediff.ts';
import {api, connection, json, RemoteError} from './remote.ts';
import {store} from './repos.ts';
import {kindOf} from './text.ts';
import {t} from './i18n.ts';

export interface FileChange { path: string; status: 'added' | 'modified' | 'removed'; added: number; removed: number; binary: boolean }
export interface Folder { folder: string; files: FileChange[]; added: number; removed: number }
export interface Changes { connected: boolean; folders: Folder[]; files: number; added: number; removed: number }
export interface Cut { id: string; issue: string | null; kind: string | null; title: string; note: string; time: number; folders: string[]; files: number; added: number; removed: number; merged: string | null }
export type {DiffLine} from './linediff.ts';
export interface FileDiff { path: string; status: FileChange['status']; binary: boolean; lines: DiffLine[]; more: number }

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
      // Gone between the listing and the reading: it is not part of what is here.
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
    return {path: p.path, status: p.status, binary: false, ...hunks(lineOps(p.before ?? '', p.after ?? ''))};
  });
}

/** The words a cut goes by: an issue's first line, or the line given. */
async function wordsFor(repo: string, issue: string | null, line: string): Promise<{kind: string; title: string}> {
  // Work on an issue commits under it.
  issue ??= lineOf(repo) === 'main' ? null : `${lineOf(repo)}.md`;
  // The issue's file gone (removed in the work): the line given names the cut instead.
  const c = issue ? await store.read(repo, `issue/${issue}`).catch(() => null) : null;
  const {kind, title} = kindOf(c?.text?.split('\n')[0] ?? line);
  return {kind: kind ?? '', title};
}

async function webCut(repo: string, issue: string | null, line: string, note: string): Promise<Cut> {
  if (!connection()) throw new RemoteError(0, t('Commits are kept on the Remote. Sign in to it first.'));
  const words = await wordsFor(repo, issue, line);
  issue ??= lineOf(repo) === 'main' ? null : `${lineOf(repo)}.md`;
  if (!words.title.trim()) throw new RemoteError(0, t('A commit needs a title (for example Fix：title)'));
  for (let round = 0; round < 4; round++) {
    const s = await sync(repo);
    const c = await webChanges(repo);
    if (!c.files) throw new RemoteError(0, t('Nothing to commit'));
    const r = await api(at(repo, '/cuts'), {method: 'POST', body: JSON.stringify({
      version: s.version, parent: baseOf(repo)?.head ?? null, kind: words.kind, title: words.title.trim(),
      issue: issue ? `issue/${issue}` : '', note: note.trim(), added: c.added, removed: c.removed,
    })});
    const body = await r.json() as {id?: string; time?: number; head?: string | null};
    if (r.status === 201 && body.id) {
      await setHead(repo, body.id);
      return {id: body.id, issue: issue ? `issue/${issue}` : null, kind: words.kind || null, title: words.title.trim(), note: note.trim(),
        time: body.time ?? Date.now(), folders: c.folders.map((f) => f.folder), files: c.files, added: c.added, removed: c.removed, merged: null};
    }
    // Another device moved the draft or cut first: in step again, and once more.
    await setHead(repo, body.head ?? null);
  }
  throw new RemoteError(409, t('The Remote kept moving; could not commit'))
}

// A cut is named by the sha256 of what it holds, so its tree never changes:
// each is read once a page (the newest few kept), however often Git draws.
const trees = new Map<string, Promise<Tree>>();
function cutTree(repo: string, id: string | null): Promise<Tree> {
  if (!id) return Promise.resolve({});
  const k = `${repo}\0${id}`;
  let p = trees.get(k);
  if (!p) {
    p = treeAt(repo, id);
    p.catch(() => trees.delete(k));
    trees.set(k, p);
    if (trees.size > 64) trees.delete(trees.keys().next().value!);
  }
  return p;
}

interface RemoteCut { id: string; parent: string | null; merged?: string | null; tree: Tree; kind: string; title: string; issue: string; note: string; time: number; added: number; removed: number }

async function webLog(repo: string): Promise<Cut[]> {
  if (!connection()) return [];
  const r = await api(at(repo, '/log?limit=50', lineOf(repo)));
  if (r.status === 404) return [];
  const cuts = await r.json() as RemoteCut[];
  const trees = new Map(cuts.map((c) => [c.id, c.tree]));
  return cuts.map((c) => {
    const parent = (c.parent && trees.get(c.parent)) || {};
    const changed = [...new Set([...Object.keys(c.tree), ...Object.keys(parent)])]
      .filter((p) => c.tree[p] !== parent[p] && (typeof c.tree[p] === 'string' || typeof parent[p] === 'string'));
    const folders = [...new Set(changed.map(folderOf))];
    return {id: c.id, issue: c.issue || null, kind: c.kind || null, title: c.title, note: c.note, time: c.time, folders, files: changed.length, added: c.added, removed: c.removed, merged: c.merged ?? null};
  });
}

// ---- the same on either host ----

export const changes = (repo: string) => (isNative ? native<Changes>('history_changes', {repo}) : webChanges(repo));
export const diff = (repo: string) => (isNative ? native<FileDiff[]>('history_diff', {repo}) : webDiff(repo));
export const log = (repo: string) => (isNative ? native<Cut[]>('history_log', {repo}) : webLog(repo));

/** Commit under `issue` (its file name in issue/), or without one, named by `line`. */
export const cut = (repo: string, issue: string | null, line: string, note: string): Promise<Cut> =>
  isNative ? native<Cut>('history_cut', {repo, issue, line, note}) : webCut(repo, issue, line, note);

// ---- the work on an issue, and what it hands to main ----

export interface Review { version: number; verdict: 'approve' | 'changes' | 'comment'; note: string; marks: string[]; by: string; time: number }
export interface Change {
  id: string; repo: string; line: string; issue: string; kind: string; title: string; version: number;
  base: string | null; head: string; state: 'open' | 'merged' | 'rejected' | 'reset'; note: string;
  submittedBy: string; updatedAt: number; reviews: Review[]; folders: string[]; files: number;
}
export interface Work { line: string; issue: string | null; started_by: string; started_at: number; commits: number; unpushed: number; change: Change | null }
export interface Line { line: string; issue: string; head: string | null; pushed: string | null; base: string | null; startedBy: string; startedAt: number }

const repoPath = (repo: string, rest: string) => `/v1/repos/${encodeURIComponent(repo)}${rest}`;

/** The folders a change touches (each once) and how many files. */
function places(then: Tree, now: Tree): {folders: string[]; files: number} {
  const folders: string[] = [];
  let files = 0;
  for (const p of [...new Set([...Object.keys(then), ...Object.keys(now)])].sort()) {
    if (then[p] === now[p] || !(typeof then[p] === 'string' || typeof now[p] === 'string')) continue;
    files++;
    const f = folderOf(p);
    if (!folders.includes(f)) folders.push(f);
  }
  return {folders, files};
}

async function webChangesOf(repo: string): Promise<Change[]> {
  const r = await api(repoPath(repo, '/changes'));
  if (r.status === 404) return [];
  const list = await r.json() as Change[];
  await Promise.all(list.map(async (c) => Object.assign(c, places(...await Promise.all([cutTree(repo, c.base), cutTree(repo, c.head)])))));
  return list;
}

async function webWork(repo: string, known?: Promise<Change[]>): Promise<Work> {
  const line = lineOf(repo);
  if (line === 'main') return {line, issue: null, started_by: '', started_at: 0, commits: 0, unpushed: 0, change: null};
  const [l, log] = await Promise.all([json<Line>(repoPath(repo, `?line=${encodeURIComponent(line)}`)), webLog(repo)]);
  const mine: Cut[] = [];
  for (const c of log) { if (c.id === l.base) break; mine.push(c); }
  let unpushed = 0;
  for (const c of mine) { if (c.id === l.pushed) break; unpushed++; }
  const change = (await (known ?? webChangesOf(repo))).find((c) => c.line === line) ?? null;
  return {line, issue: l.issue, started_by: l.startedBy, started_at: l.startedAt, commits: mine.length, unpushed, change};
}

function refused(r: Response, body: Record<string, unknown>): never {
  if (Array.isArray(body.conflicts)) throw new RemoteError(409, t('Both changed these files; fix them in the work, push and make the change again: {files}', {files: (body.conflicts as string[]).join(', ')}));
  if (typeof body.version === 'number') throw new RemoteError(409, t('The change has a newer version ({n}); look at it first', {n: body.version}));
  // Anything else, the Remote's own sentence (push first, nothing committed yet, not open any more).
  throw new RemoteError(r.status, t(String(body.error ?? r.status)));
}

async function changeCall(repo: string, id: string, verb: string, body: Record<string, unknown>): Promise<Change> {
  const r = await api(repoPath(repo, `/changes/${id}/${verb}`), {method: 'POST', body: JSON.stringify(body)});
  const out = await r.json() as Record<string, unknown>;
  if (!r.ok) refused(r, out);
  return out as unknown as Change;
}

/** Work on `issue` (its file name in issue/): the repo then shows that work's copy. */
export async function startWork(repo: string, issue: string): Promise<void> {
  // The work starts from the Remote's main: what was just written here (the issue itself, often) goes there first.
  await sync(repo);
  if (isNative) { await native('work_start', {repo, issue: `issue/${issue}`}); store.changedOutside(repo, 'work'); return; }
  const r = await api(repoPath(repo, '/lines'), {method: 'POST', body: JSON.stringify({issue: `issue/${issue}`})});
  if (!r.ok) throw new RemoteError(r.status, t('Could not start the work ({why})', {why: t(String(((await r.json()) as {error?: string}).error ?? r.status))}));
  await showLine(repo, issue.replace(/\.md$/, ''));
}

/** Show main (or another work) where the repo is seen. */
export const switchWork = (repo: string, line: string) => showLine(repo, line);
/** The work the repo shows, and where it stands. */
export const work = (repo: string): Promise<Work> => (isNative ? native<Work>('work_state', {repo}) : webWork(repo));
/** Every issue's work on the Remote (main not among them). */
export const lines = (repo: string): Promise<Line[]> =>
  isNative ? native<Line[]>('work_lines', {repo}) : connection() ? json<Line[]>(repoPath(repo, '/lines')) : Promise.resolve([]);
/** The changes handed to the repo's main, newest first. */
export const changesOf = (repo: string): Promise<Change[]> => (isNative ? native<Change[]>('changes_list', {repo}) : webChangesOf(repo));

/** Where a repo stands in one go: the work it shows, every issue's work, the changes (each read once). */
export async function standing(repo: string): Promise<{work: Work; lines: Line[]; changes: Change[]}> {
  const changes = changesOf(repo);
  const [shown, lineList, list] = await Promise.all([isNative ? work(repo) : webWork(repo, changes), lines(repo), changes]);
  return {work: shown, lines: lineList, changes: list};
}

/** Push: the work's commits become its state on the Remote. */
export async function push(repo: string): Promise<void> {
  if (isNative) { await native('history_push', {repo}); return; }
  const line = lineOf(repo);
  if (line === 'main') throw new RemoteError(0, t('main takes changes by merging them; work on an issue to push'));
  await sync(repo);
  const r = await api(repoPath(repo, `/lines/${encodeURIComponent(line)}/push`), {method: 'POST', body: JSON.stringify({head: baseOf(repo)?.head ?? null})});
  if (!r.ok) throw new RemoteError(r.status, t('Could not push; try again'));
}

/** Change: what the work pushed is handed to main (again: its next version). */
export async function submit(repo: string, note = ''): Promise<Change> {
  if (isNative) return native<Change>('history_submit', {repo, note});
  const line = lineOf(repo);
  const words = await wordsFor(repo, null, '');
  const r = await api(repoPath(repo, '/changes'), {method: 'POST', body: JSON.stringify({line, kind: words.kind, title: words.title, note})});
  const out = await r.json() as Record<string, unknown>;
  if (!r.ok) refused(r, out);
  const c = out as unknown as Change;
  return Object.assign(c, places(...await Promise.all([cutTree(repo, c.base), cutTree(repo, c.head)])));
}

/** Reset: take back the change this work handed in. */
export async function reset(repo: string): Promise<Change> {
  if (isNative) return native<Change>('history_reset', {repo});
  const c = (await webChangesOf(repo)).find((x) => x.line === lineOf(repo));
  if (!c) throw new RemoteError(404, t('This work has no change yet'));
  return changeCall(repo, c.id, 'reset', {});
}

/** A review of the change's version: a verdict, or a comment alone; `marks` are lines marked in its diff ("path:index"). */
export const review = (repo: string, c: Change, verdict: Review['verdict'], note = '', marks: string[] = []): Promise<Change> =>
  isNative ? native<Change>('change_review', {repo, id: c.id, verdict, note, marks}) : changeCall(repo, c.id, 'reviews', {version: c.version, verdict, note, marks});
export const merge = (repo: string, c: Change): Promise<Change> =>
  isNative ? native<Change>('change_merge', {repo, id: c.id}) : changeCall(repo, c.id, 'merge', {version: c.version});
export const reject = (repo: string, c: Change, note = ''): Promise<Change> =>
  isNative ? native<Change>('change_reject', {repo, id: c.id, note}) : changeCall(repo, c.id, 'reject', {note});

/** A change's diff against where it began. */
export async function changeDiff(repo: string, c: Change): Promise<FileDiff[]> {
  if (isNative) return native<FileDiff[]>('change_diff', {repo, id: c.id});
  const [then, now] = await Promise.all([cutTree(repo, c.base), cutTree(repo, c.head)]);
  const out: FileDiff[] = [];
  for (const path of [...new Set([...Object.keys(then), ...Object.keys(now)])].sort()) {
    const a = then[path], b = now[path];
    if (a === b || !(typeof a === 'string' || typeof b === 'string')) continue;
    const before = typeof a === 'string' ? await blobText(a) : '', after = typeof b === 'string' ? await blobText(b) : '';
    const status: FileChange['status'] = typeof a !== 'string' ? 'added' : typeof b !== 'string' ? 'removed' : 'modified';
    if (before === null || after === null) { out.push({path, status, binary: true, lines: [], more: 0}); continue; }
    out.push({path, status, binary: false, ...hunks(lineOps(before, after))});
  }
  return out;
}
