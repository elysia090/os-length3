// What the prompt box does besides taking what is typed: ↑ and ↓ walk the
// repo's earlier lines (from the line being written back to the oldest the
// Prompt keeps, and down to it again), and Tab completes a path in the repo
// as the store has it. Kept apart from the page so it can be tried alone.

/** Whether the caret at `at` is on the text's first line, and on its last. */
export function caretLine(text: string, at: number): {first: boolean; last: boolean} {
  return {first: !text.slice(0, at).includes('\n'), last: !text.slice(at).includes('\n')};
}

/**
 * A walk through earlier lines, newest first. What was being written when
 * the walk began is kept and comes back at its end; writing in the box ends
 * the walk (reset), so what is changed is the line now being written.
 */
export class Recall {
  /** Where the walk is in the lines; null: on the line being written. */
  private at: number | null = null;
  private draft = '';

  /** The lines to walk: the same line twice in a row once, and no empty ones. */
  private static plain(lines: readonly string[]): string[] {
    return lines.filter((l, i) => l.trim() !== '' && l !== lines[i - 1]);
  }

  /** The line before the one shown, or null when there is none (the box keeps its own ↑). */
  older(lines: readonly string[], current: string): string | null {
    const list = Recall.plain(lines);
    if (this.at === null) {
      if (!list.length) return null;
      this.draft = current;
      this.at = list.length;
    }
    if (this.at === 0) return null;
    this.at = Math.min(this.at, list.length) - 1;
    return list[this.at];
  }

  /** The line after the one shown, the one being written at the end; null when not walking. */
  newer(lines: readonly string[]): string | null {
    if (this.at === null) return null;
    const list = Recall.plain(lines);
    this.at++;
    if (this.at < list.length) return list[this.at];
    this.at = null;
    return this.draft;
  }

  reset() { this.at = null; this.draft = ''; }

  /**
   * ↑ or ↓ pressed with the caret at `at` (nothing selected): the line to
   * show, when the caret is on the first line (↑) or the last (↓) and there
   * is one; null leaves the key to the box, which moves the caret.
   */
  arrow(key: 'ArrowUp' | 'ArrowDown', text: string, at: number, lines: readonly string[]): string | null {
    const on = caretLine(text, at);
    if (key === 'ArrowUp') return on.first ? this.older(lines, text) : null;
    return on.last ? this.newer(lines) : null;
  }
}

/** A path being written before the caret: where it starts, its directory in the repo, and the start of its name. */
export interface PathWord { start: number; dir: string; name: string }

/** What ends a word in sh, as far as completing a path goes. */
const BREAK = /[\s;|&<>()'"`=]/;

/**
 * The path written just before the caret, read against the repo's root (the
 * Prompt starts there): `src/ma`, `./src/ma` or `/root/<repo>/src/ma`. Null
 * where nothing is written there, or the path leaves the repo.
 */
export function pathWord(text: string, at: number, repo: string): PathWord | null {
  let start = at;
  while (start > 0 && !BREAK.test(text[start - 1])) start--;
  let word = text.slice(start, at);
  if (!word) return null;
  const root = `/root/${repo}/`;
  if (word.startsWith(root)) word = word.slice(root.length);
  else if (word.startsWith('/') || word.startsWith('~') || word.startsWith('$')) return null;
  const parts = word.split('/');
  const name = parts.pop()!;
  const dir: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') return null;
    dir.push(p);
  }
  return {start, dir: dir.join('/'), name};
}

/** sh's special characters in a name, each with a backslash before it. */
const quote = (s: string) => s.replace(/[\s'"\\$`!*?&;|<>()[\]{}#~=]/g, '\\$&');

/**
 * Completing `name` among a directory's entries: what to type after it (the
 * rest of the one match, with / after a directory and a space after a file;
 * or what every match shares), and the matches when more than one is left.
 * Null when nothing matches. A name starting with a dot is shown only when
 * the dot is written.
 */
export function complete(name: string, entries: readonly {name: string; kind: string}[]): {insert: string; choices: string[]} | null {
  const matches = entries.filter((e) => e.name.startsWith(name) && (name.startsWith('.') || !e.name.startsWith('.')));
  if (!matches.length) return null;
  const shown = (e: {name: string; kind: string}) => (e.kind === 'dir' ? `${e.name}/` : e.name);
  if (matches.length === 1) {
    const e = matches[0];
    return {insert: quote(e.name.slice(name.length)) + (e.kind === 'dir' ? '/' : ' '), choices: []};
  }
  let shared = matches[0].name;
  for (const e of matches) while (!e.name.startsWith(shared)) shared = shared.slice(0, -1);
  return {insert: quote(shared.slice(name.length)), choices: matches.map(shown)};
}
