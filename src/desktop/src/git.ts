// Git in the issues' terms (core/src/git.rs): changes not yet cut, grouped by
// folder; cutting them into history under an issue (a commit named after it
// and tied to its file); and the cuts so far. Natively it is the repo's own
// git; a plain browser has no git, and says so.

import {isNative} from './host.ts';

export interface FileChange { path: string; status: 'added' | 'modified' | 'removed' | 'renamed'; added: number; removed: number; binary: boolean }
export interface Folder { folder: string; files: FileChange[]; added: number; removed: number }
export interface Changes { git: boolean; folders: Folder[]; files: number; added: number; removed: number }
export interface Commit { id: string; issue: string | null; kind: string | null; title: string; author: string; time: number; folders: string[]; files: number; added: number; removed: number }

export interface DiffLine { kind: 'hunk' | 'add' | 'del' | 'same'; text: string }
export interface FileDiff { path: string; status: FileChange['status']; binary: boolean; lines: DiffLine[]; more: number }

export const hasGit = isNative;

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export const changes = (repo: string) => call<Changes>('git_changes', {repo});
/** Cut under `issue` (its file name in issue/), or without one, named by `line`. */
export const cut = (repo: string, issue: string | null, line: string, note: string) => call<Commit>('git_cut', {repo, issue, line, note});
export const log = (repo: string) => call<Commit[]>('git_log', {repo});
/** The changes not yet cut, line by line. */
export const diff = (repo: string) => call<FileDiff[]>('git_diff', {repo});

/** How a status reads: a word, not a letter. */
export const STATUS_WORD: Record<FileChange['status'], string> = {added: '追加', modified: '変更', removed: '削除', renamed: '名前変更'};
