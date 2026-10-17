// An issue is a number and its words: "#3 Fix：件名", then the detail. That
// is all a person meets; how it is kept is the OS's business. It is kept as
// one plain file in the repo's issue/ (so l3 and a Prompt see the same
// thing, and nothing is kept twice), written the way TODO items are: the
// first line names it, the lines after are the detail. The file is named by
// the issue's number, which the OS gives: the next one when an issue is
// written, and the next free one for a file there that has none (one written
// by hand, or two devices' issues that met under one number).

import type {RepoStore} from './repos.ts';
import {kindOf, named} from './text.ts';

export interface Issue {
  repo: string;
  /** Its number in the repo; null only until the OS has given it one. */
  n: number | null;
  /** How it is kept, inside issue/: never shown. */
  file: string;
  kind: string | null;
  title: string;
  detail: string;
}

/** The number a file in issue/ is named by ("007.md" is 7), or null. */
const numberOf = (file: string): number | null => {
  const m = /^0*(\d+)\.md$/.exec(file);
  return m ? Number(m[1]) : null;
};

/** How an issue is called: #7, or until it has a number, its words alone. */
export const issueName = (i: Pick<Issue, 'n'>): string => (i.n === null ? '' : `#${i.n}`);

/** The path an issue is kept at. */
export const issuePath = (i: Pick<Issue, 'file'>): string => `issue/${i.file}`;

export function parseIssue(repo: string, file: string, text: string): Issue {
  const [first = '', ...rest] = text.replace(/^﻿/, '').split('\n');
  const {kind, title} = kindOf(first.replace(/^#+\s*/, ''));
  return {repo, n: numberOf(file), file, kind, title: title || file.replace(/\.md$/, ''), detail: rest.join('\n').trim()};
}

/** The text of an issue's file. */
export function issueText(kind: string | null, title: string, detail: string): string {
  const head = named(kind, title);
  const body = detail.trim();
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

/** The file the next issue is kept in, after every number already there. */
export function nextIssueName(names: readonly string[]): string {
  const next = Math.max(0, ...names.map(numberOf).filter((n): n is number => n !== null)) + 1;
  return `${String(next).padStart(3, '0')}.md`;
}

/** The files in issue/, or null when there is no issue/ (the store refuses to list what is not there). */
const names = async (store: Pick<RepoStore, 'tree'>, repo: string): Promise<string[] | null> => {
  try { return (await store.tree(repo, 'issue')).filter((e) => e.kind === 'file').map((e) => e.name); } catch { return null; }
};

/** A repo's issues by number, the newest first (one still without a number is newer); [] when it has none. */
export async function readIssues(store: Pick<RepoStore, 'tree' | 'read'>, repo: string): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const name of await names(store, repo) ?? []) {
    // Gone between the listing and the reading (a Prompt, another device): it is no issue any more.
    const c = await store.read(repo, `issue/${name}`).catch(() => null);
    if (c?.text != null) out.push(parseIssue(repo, name, c.text));
  }
  return out.sort((a, b) => (b.n ?? Infinity) - (a.n ?? Infinity) || (a.file < b.file ? -1 : 1));
}

/** Write a new issue: it takes the next number (issue/ is made for the first). */
export async function writeIssue(store: Pick<RepoStore, 'tree' | 'mkdir' | 'add'>, repo: string, kind: string | null, title: string, detail: string): Promise<string> {
  const there = await names(store, repo);
  if (there === null) await store.mkdir(repo, 'issue');
  const file = nextIssueName(there ?? []);
  await store.add(repo, 'issue', file, issueText(kind, title, detail));
  return file;
}

/** Change an issue's words; its number stays. */
export const saveIssue = (store: Pick<RepoStore, 'write'>, i: Issue, kind: string | null, title: string, detail: string) =>
  store.write(i.repo, issuePath(i), issueText(kind, title, detail));

/**
 * Give every issue without a number the next free one, oldest name first,
 * except one a work refers to (its work keeps the name it began with).
 * Two devices doing this at once do the same thing, so they agree.
 * Returns whether anything was renumbered.
 */
export async function number(store: Pick<RepoStore, 'tree' | 'read' | 'add' | 'remove'>, repo: string, issues: readonly Issue[], inUse: ReadonlySet<string>): Promise<boolean> {
  const loose = issues.filter((i) => i.n === null && !inUse.has(issuePath(i))).sort((a, b) => (a.file < b.file ? -1 : 1));
  if (!loose.length) return false;
  const taken = issues.map((i) => i.file);
  for (const i of loose) {
    const file = nextIssueName(taken);
    const c = await store.read(repo, issuePath(i));
    if (c.text === null) continue;
    await store.add(repo, 'issue', file, c.text);
    await store.remove(repo, issuePath(i));
    taken.push(file);
  }
  return true;
}
