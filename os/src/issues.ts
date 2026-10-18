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
  /** Closed without being done: what its last line says after "Closed：" (the day, and who), or null while open. */
  closed: string | null;
}

/** The number a file in issue/ is named by ("007.md" is 7), or null. */
export const numberOf = (file: string): number | null => {
  const m = /^0*(\d+)\.md$/.exec(file);
  return m ? Number(m[1]) : null;
};

/** How an issue is called: #7, or until it has a number, its words alone. */
export const issueName = (i: Pick<Issue, 'n'>): string => (i.n === null ? '' : `#${i.n}`);

/** The path an issue is kept at. */
export const issuePath = (i: Pick<Issue, 'file'>): string => `issue/${i.file}`;

/**
 * A closed issue says so on its last line, after its detail: "Closed：2031-10-17 sora"
 * (the day it was closed, and who). Reopening takes the line away again.
 */
const CLOSED = /^Closed[：:]\s*(.*)$/;

/** The line that closes `lines`, if their last one with words is it (never the first, which names the issue). */
function closedAt(lines: readonly string[]): number {
  let j = lines.length - 1;
  while (j > 0 && !lines[j].trim()) j--;
  return j > 0 && CLOSED.test(lines[j].trim()) ? j : -1;
}

export function parseIssue(repo: string, file: string, text: string): Issue {
  const lines = text.replace(/^﻿/, '').split('\n');
  const at = closedAt(lines);
  const closed = at < 0 ? null : CLOSED.exec(lines[at].trim())![1].trim();
  const [first = '', ...rest] = at < 0 ? lines : lines.slice(0, at);
  const {kind, title} = kindOf(first.replace(/^#+\s*/, ''));
  return {repo, n: numberOf(file), file, kind, title: title || file.replace(/\.md$/, ''), detail: rest.join('\n').trim(), closed};
}

/** An issue's text open again: without the line that closed it. */
export function reopenText(text: string): string {
  const lines = text.split('\n');
  const at = closedAt(lines);
  return at < 0 ? text : `${lines.slice(0, at).join('\n').replace(/\s+$/, '')}\n`;
}

/** An issue's text closed: its words as they are, then "Closed：" and `mark` (the day, and who) on a line of its own. */
export const closeText = (text: string, mark: string): string => `${reopenText(text).replace(/\s+$/, '')}\n\nClosed：${mark.trim()}\n`;

/** What closed it, as its line says: the day (as a time, to be written as the language writes days) and who. */
export function closedBy(closed: string): {at: number | null; by: string} {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s*(.*)$/.exec(closed.trim());
  return m ? {at: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), by: m[4].trim()} : {at: null, by: closed.trim()};
}

/** The mark a close is written with: the day here (2031-10-17) and who, if known. */
export function closeMark(by: string, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}${by ? ` ${by}` : ''}`;
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

/** Change an issue's words; its number stays, and so does its being closed. */
export const saveIssue = (store: Pick<RepoStore, 'write'>, i: Issue, kind: string | null, title: string, detail: string) =>
  store.write(i.repo, issuePath(i), i.closed === null ? issueText(kind, title, detail) : closeText(issueText(kind, title, detail), i.closed));

/** Close an issue that will not be done (`mark`: closeMark), or open it again: only its last line changes. */
export async function setClosed(store: Pick<RepoStore, 'read' | 'write'>, i: Issue, mark: string | null): Promise<void> {
  const c = await store.read(i.repo, issuePath(i));
  if (c.text === null) throw new Error(issuePath(i));
  await store.write(i.repo, issuePath(i), mark === null ? reopenText(c.text) : closeText(c.text, mark));
}

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
