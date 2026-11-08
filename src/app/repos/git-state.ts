// How Git lays a repo's issues out, from where each repo stands: the open
// ones (oldest first, as the row of boxes reads), what main has not
// committed, and what is done with: merged (newest first, from the Remote's
// changes) and closed without being done (from the issue's own file).

import type {Change, Work} from './history.ts';
import {issuePath, type Issue} from './issues.ts';

/** Where a repo stands, as Git reads it once for all its issues. */
export interface Standing { work: Work | null; changes: Change[]; uncommitted: number; error?: string }

/** The issue's change (the latest record of it). */
export const changeFor = (s: Standing | undefined, i: Issue) => s?.changes.find((c) => c.issue === issuePath(i)) ?? null;
/** Merged into main: done. */
const isMerged = (s: Standing | undefined, i: Issue) => changeFor(s, i)?.state === 'merged';
/** Still to do: neither merged nor closed. */
export const isOpen = (s: Standing | undefined, i: Issue) => !isMerged(s, i) && i.closed === null;

const oldestFirst = (a: Issue, b: Issue) => (a.repo === b.repo ? (a.file < b.file ? -1 : 1) : a.repo < b.repo ? -1 : 1);
const newestFirst = (a: Issue, b: Issue) => (a.repo === b.repo ? (a.file < b.file ? 1 : -1) : a.repo < b.repo ? -1 : 1);

export interface Laid {
  open: Issue[];
  /** Repos whose main has something not committed, while they show main. */
  dirty: string[];
  merged: {repo: string; change: Change}[];
  /** `reopen`: where the Remote is known (an issue is main's, whatever work its repo shows). */
  closed: {issue: Issue; reopen: boolean}[];
}

/** Git's layout of `issues` in `repos` (the ones looked at), from `states`. */
export function laidOut(repos: readonly string[], issues: readonly Issue[], states: ReadonlyMap<string, Standing>): Laid {
  const st = (r: string) => states.get(r);
  return {
    open: issues.filter((i) => isOpen(st(i.repo), i)).sort(oldestFirst),
    dirty: repos.filter((r) => { const s = st(r); return !!s && !s.error && s.work?.line === 'main' && s.uncommitted > 0; }),
    merged: repos.flatMap((r) => (st(r)?.changes ?? []).filter((c) => c.state === 'merged').map((change) => ({repo: r, change})))
      .sort((a, b) => b.change.updatedAt - a.change.updatedAt),
    closed: issues.filter((i) => i.closed !== null && !isMerged(st(i.repo), i)).sort(newestFirst)
      .map((issue) => ({issue, reopen: !!st(issue.repo)?.work})),
  };
}
