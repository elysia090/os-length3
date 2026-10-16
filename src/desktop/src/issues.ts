// Issues live as plain files in a repo's issue/ directory, one file each, and
// the Git page lists those very files: nothing is kept twice. A file is
// written the way TODO items are: its first line names it ("Fix：件名"), the
// lines after are the detail. Files are numbered in the order they are
// written (001.md, 002.md, …); dates go in the text, not in the name.

import {kindOf} from './todo.ts';

export interface Issue {
  repo: string;
  /** File name inside issue/. */
  file: string;
  kind: string | null;
  title: string;
  detail: string;
}

export function parseIssue(repo: string, file: string, text: string): Issue {
  const [first = '', ...rest] = text.replace(/^﻿/, '').split('\n');
  const {kind, title} = kindOf(first.replace(/^#+\s*/, ''));
  return {repo, file, kind, title: title || file, detail: rest.join('\n').trim()};
}

/** The text of a new issue file. */
export function issueText(kind: string | null, title: string, detail: string): string {
  const head = kind ? `${kind}：${title.trim()}` : title.trim();
  const body = detail.trim();
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

/** The next free number among the names already in issue/. */
export function nextIssueName(names: readonly string[]): string {
  const used = names.map((n) => /^(\d+)\.md$/.exec(n)?.[1]).filter((n): n is string => !!n).map(Number);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${String(next).padStart(3, '0')}.md`;
}
