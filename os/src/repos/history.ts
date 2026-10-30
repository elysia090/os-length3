// History in the issues' terms (core/src/history.rs, issue #17). An issue
// is the unit of work; its branch and worktree are the OS's to keep. The
// operations are Commit, Push, Change (again: the next version;
// Reset takes it back), Review (of one version), and the receiver's Merge
// and Reject. What is not committed is the draft against the work's last
// commit, by folder. The core does each, the app's or the same in a browser.

import {showLine, sync} from '../remote/sync.ts';
import {core, failure} from '../app/host.ts';
import type {Answer} from '../core/client.ts';
import {restore} from './putback.ts';
import {store} from './repos.ts';
import type {DiffLine} from './linediff.ts';

export interface FileChange { path: string; status: 'added' | 'modified' | 'removed'; added: number; removed: number; binary: boolean }
export interface Folder { folder: string; files: FileChange[]; added: number; removed: number }
export interface Changes { connected: boolean; folders: Folder[]; files: number; added: number; removed: number }
export interface Cut { id: string; issue: string | null; kind: string | null; title: string; note: string; time: number; folders: string[]; files: number; added: number; removed: number; merged: string | null;
  /** On an issue's work: the version of its change it was handed in as, by itself. */
  handed?: number }
export type {DiffLine} from './linediff.ts';
export interface FileDiff { path: string; status: FileChange['status']; binary: boolean; lines: DiffLine[]; more: number }

export const changes = (repo: string) => core<Changes>('history_changes', {repo});
export const diff = (repo: string) => core<FileDiff[]>('history_diff', {repo});
export const log = (repo: string) => core<Cut[]>('history_log', {repo});

/** Commit under `issue` (its file name in issue/), or without one, named by `line`. */
export const cut = (repo: string, issue: string | null, line: string, note: string): Promise<Cut> => core<Cut>('history_cut', {repo, issue, line, note});

/**
 * Put a file back as it was at the last commit: its text again, a removed
 * one written back (its folders made), one added since removed.
 */
export const putBack = async (repo: string, path: string): Promise<void> =>
  restore(store, repo, path, await core<string | null>('history_at_head', {repo, path}));

// ---- the work on an issue, and what it hands to main ----

export interface Review { version: number; verdict: 'approve' | 'changes' | 'comment'; note: string; marks: string[]; by: string; time: number }
export interface Change {
  id: string; repo: string; line: string; issue: string; kind: string; title: string; version: number;
  base: string | null; head: string; state: 'open' | 'merged' | 'rejected' | 'reset'; note: string;
  submittedBy: string; updatedAt: number; reviews: Review[]; folders: string[]; files: number;
}
export interface Work { line: string; issue: string | null; started_by: string; started_at: number; commits: number; unpushed: number; change: Change | null }
export interface Line { line: string; issue: string; head: string | null; pushed: string | null; base: string | null; startedBy: string; startedAt: number }

/** Work on `issue` (its file name in issue/): the repo then shows that work's copy. */
export async function startWork(repo: string, issue: string): Promise<void> {
  // The work starts from the Remote's main: what was just written here (the issue itself, often) goes there first.
  await sync(repo);
  await core('work_start', {repo, issue: `issue/${issue}`});
  store.changedOutside(repo, 'work');
}

/** Show main (or another work) where the repo is seen. */
export const switchWork = (repo: string, line: string) => showLine(repo, line);
/** The work the repo shows, and where it stands. */
export const work = (repo: string): Promise<Work> => core<Work>('work_state', {repo});
/** Every issue's work on the Remote (main not among them). */
export const lines = (repo: string): Promise<Line[]> => core<Line[]>('work_lines', {repo});
/** The changes handed to the repo's main, newest first. */
export const changesOf = (repo: string): Promise<Change[]> => core<Change[]>('changes_list', {repo});

/** Where a repo stands: the work it shows, every issue's work, the changes. */
export interface Standing { work: Work; lines: Line[]; changes: Change[] }

/** Where each of `repos` stands, all asked of the Remote at once: each its own, or why not (the error asking it alone gives). */
export async function standings(repos: readonly string[]): Promise<(Standing | Error)[]> {
  const each = await core<Answer[]>('work_standings', {repos});
  return each.map((a) => ('ok' in a ? a.ok as Standing : failure(a)));
}

/** Push: the work's commits become its state on the Remote. */
export const push = async (repo: string): Promise<void> => { await core('history_push', {repo}); };
/** Change: what the work pushed is handed to main (again: its next version). */
export const submit = (repo: string, note = ''): Promise<Change> => core<Change>('history_submit', {repo, note});
/** Reset: take back the change this work handed in. */
export const reset = (repo: string): Promise<Change> => core<Change>('history_reset', {repo});

/** A review of the change's version: a verdict, or a comment alone; `marks` are lines marked in its diff ("path:index"). */
export const review = (repo: string, c: Change, verdict: Review['verdict'], note = '', marks: string[] = []): Promise<Change> =>
  core<Change>('change_review', {repo, id: c.id, verdict, note, marks});
export const merge = (repo: string, c: Change): Promise<Change> => core<Change>('change_merge', {repo, id: c.id});
export const reject = (repo: string, c: Change, note = ''): Promise<Change> => core<Change>('change_reject', {repo, id: c.id, note});

/** A change's diff against where it began. */
export const changeDiff = (repo: string, c: Change): Promise<FileDiff[]> => core<FileDiff[]>('change_diff', {repo, id: c.id});
