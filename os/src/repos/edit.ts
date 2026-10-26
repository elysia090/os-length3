// A file's lines as the box's Edit holds them (pages/bench/edit-box.ts): where each starts and ends, which one an
// offset is on, the indent a line starts with and the file's own, and what is lit on the file. Nothing here touches
// the page.

/** Where each line of `text` starts. */
export function lineStarts(text: string): number[] {
  const at = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) at.push(i + 1);
  return at;
}

/** The line `offset` is on (from 0). */
export function lineOf(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Where line `line` of `text` ends, before its break. */
export const lineEnd = (text: string, starts: number[], line: number): number => (line + 1 < starts.length ? starts[line + 1] - 1 : text.length);

/** The indent `line` starts with. */
export const leading = (line: string): string => /^[\t ]*/.exec(line)![0];

/** The file's own indent: a tab, or the spaces its lines are indented by, the fewest seen. */
export function indentOf(text: string): string {
  let tabs = 0, spaces = 0, least = 8;
  for (const m of text.matchAll(/^([\t ]+)\S/gm)) {
    if (m[1][0] === '\t') tabs++;
    else { spaces++; least = Math.min(least, m[1].length); }
  }
  return spaces > tabs ? ' '.repeat(Math.max(2, least)) : '\t';
}

/** A part of the file lit: words on one line, whole lines, or a rule over or under a line. */
export interface Mark { from: number; to: number; kind: 'words' | 'lines' | 'rule'; under?: boolean; now?: boolean; gone?: boolean }
