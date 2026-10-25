import {t, tn} from './i18n.ts';

// The grammar of the box's Edit (pages/edit-box.ts shows it on the file and does it): a line written in the box,
// read as what it asks, and what that would do to a file's text with its caret where it is. Nothing here touches
// the page.

export type Edit =
  | {kind: 'go'; line: number}
  | {kind: 'find'; text: string; exact: boolean}
  | {kind: 'replace'; from: string; to: string}
  | {kind: 'add'; text: string}
  | {kind: 'drop'; n: number}
  | {kind: 'set'; text: string}
  | {kind: 'indent'; by: 1 | -1; n: number}
  | {kind: 'file'; path: string}
  | {kind: 'none'};

/** What a line in the box asks. An added or written line keeps its words as they are (several, pasted). */
export function parseEdit(line: string): Edit {
  const first = line.split('\n')[0];
  let m: RegExpExecArray | null;
  if ((m = /^\s*:?\s*(\d{1,7})\s*$/.exec(first))) return {kind: 'go', line: Number(m[1])};
  if ((m = /^@(\S*)\s*$/.exec(first))) return m[1] ? {kind: 'file', path: m[1].replace(/^\/+/, '')} : {kind: 'none'};
  if ((m = /^\+ ?([^]*)$/.exec(line))) return {kind: 'add', text: m[1]};
  if ((m = /^= ?([^]*)$/.exec(line))) return {kind: 'set', text: m[1]};
  if ((m = /^\s*-\s*(\d{0,5})\s*$/.exec(first))) return {kind: 'drop', n: Math.max(1, Number(m[1] || 1))};
  if ((m = /^\s*([<>])\s*(\d{0,5})\s*$/.exec(first))) return {kind: 'indent', by: m[1] === '>' ? 1 : -1, n: Math.max(1, Number(m[2] || 1))};
  if ((m = /^\/(.+)$/.exec(first))) return {kind: 'find', text: m[1], exact: true};
  if ((m = /^(.+?)\s*(?:→|->) ?(.*)$/.exec(first)) && m[1].trim()) return {kind: 'replace', from: m[1], to: m[2].trimEnd()};
  return first.trim() ? {kind: 'find', text: first.trim(), exact: false} : {kind: 'none'};
}

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

/** Where `what` is in `text`, at most `most`; written in small letters and not `exact`, either case is found. */
export function finds(text: string, what: string, exact = true, most = 2000): number[] {
  if (!what) return [];
  const loose = !exact && what === what.toLowerCase() && text.toLowerCase().length === text.length;
  const hay = loose ? text.toLowerCase() : text;
  const at: number[] = [];
  for (let i = hay.indexOf(what); i >= 0 && at.length < most; i = hay.indexOf(what, i + what.length)) at.push(i);
  return at;
}

/** The file's own indent: a tab, or the spaces its lines are indented by, the fewest seen. */
export function indentOf(text: string): string {
  let tabs = 0, spaces = 0, least = 8;
  for (const m of text.matchAll(/^([\t ]+)\S/gm)) {
    if (m[1][0] === '\t') tabs++;
    else { spaces++; least = Math.min(least, m[1].length); }
  }
  return spaces > tabs ? ' '.repeat(Math.max(2, least)) : '\t';
}

/** A part of the file an edit shows: words on one line, whole lines, or a rule over or under a line. */
export interface Mark { from: number; to: number; kind: 'words' | 'lines' | 'rule'; under?: boolean; now?: boolean; gone?: boolean }

/** What Enter writes: `insert` over `from`…`to`, the caret at `caret` after; `lit` (in the new text) shown a moment. */
export interface Done { from: number; to: number; insert: string; caret: number; said: string; lit: Mark[]; again?: string }

export interface Plan {
  marks: Mark[];
  /** What Enter would do, said under the box. */
  said: string;
  done: Done | null;
  /** Where Enter puts the caret, when that is all it does (a line, a word found); the box holds `keep` after. */
  go?: {from: number; to: number; keep: string};
}

/**
 * `edit` on `text`, its caret at `caret` (a selection from it to `selected`): what it shows, what it says, and what
 * Enter does. `back`: Shift+Enter, a word found the one before; `typed`: what the box holds, kept there after a find.
 */
export function plan(edit: Edit, text: string, caret: number, back = false, typed = '', selected = caret): Plan {
  const starts = lineStarts(text), at = lineOf(starts, caret), count = starts.length;
  const end = (line: number) => (line + 1 < count ? starts[line + 1] - 1 : text.length);
  const lines = (from: number, n: number): Mark => ({from: starts[from], to: end(Math.min(count - 1, from + n - 1)), kind: 'lines'});
  const lead = (line: number) => /^[\t ]*/.exec(text.slice(starts[line], end(line)))![0];
  const span = (a: number, n: number) => (n === 1 ? t('Line {a}', {a: a + 1}) : t('Lines {a}–{b}', {a: a + 1, b: a + n}));
  switch (edit.kind) {
    case 'go': {
      const line = Math.min(Math.max(1, edit.line), count) - 1;
      return {marks: [{...lines(line, 1), now: true}], said: t('Line {n} of {all}', {n: line + 1, all: count}), done: null,
        go: {from: starts[line], to: starts[line], keep: ''}};
    }
    case 'find': {
      const found = finds(text, edit.text, edit.exact), all = found.length, n = edit.text.length;
      if (!all) return {marks: [], said: t('Not in this file'), done: null};
      // On one (gone to before): that is where one is, and Enter goes on to the next (Shift: the one before), round.
      // Elsewhere: the first at or after the caret (Shift: the last before it) is lit, and Enter goes to it.
      const on = found.findIndex((i) => i === caret && i + n === selected);
      const k = on >= 0 ? (on + (back ? -1 : 1) + all) % all
        : back ? (found.filter((i) => i < caret).length - 1 + all) % all : Math.max(0, found.findIndex((i) => i >= caret));
      const lit = on >= 0 ? on : k;
      return {marks: found.map((i, j) => ({from: i, to: i + n, kind: 'words', now: j === lit})), said: t('{n} of {all}', {n: lit + 1, all}),
        done: null, go: {from: found[k], to: found[k] + n, keep: typed}};
    }
    case 'replace': {
      const found = finds(text, edit.from);
      if (!found.length) return {marks: [], said: t('Not in this file'), done: null};
      const n = edit.from.length, from = found[0], to = found.at(-1)! + n, by = edit.to.length - n;
      const shift = found.filter((i) => i < caret).length * by;
      return {marks: found.map((i) => ({from: i, to: i + n, kind: 'words', gone: true})),
        said: edit.to ? tn('{n} to write as “{to}”', '{n} to write as “{to}”', found.length, {to: edit.to}) : tn('{n} to take away', '{n} to take away', found.length),
        done: {from, to, insert: text.slice(from, to).split(edit.from).join(edit.to), caret: Math.max(0, caret + shift),
          said: edit.to ? tn('{n} written', '{n} written', found.length) : tn('{n} taken away', '{n} taken away', found.length),
          lit: edit.to ? found.map((i, j) => ({from: i + j * by, to: i + j * by + edit.to.length, kind: 'words'})) : []}};
    }
    case 'add': {
      // As indented as the caret's line, unless it says its own.
      const words = /^[\t ]/.test(edit.text) ? edit.text : edit.text.split('\n').map((l) => (l ? lead(at) + l : l)).join('\n');
      const e = end(at), insert = `\n${words}`;
      return {marks: [{from: e, to: e, kind: 'rule', under: true, now: true}], said: t('A line under line {n}', {n: at + 1}),
        done: {from: e, to: e, insert, caret: e + insert.length, said: t('Line {n} added', {n: at + 2}),
          lit: [{from: e + 1, to: e + insert.length, kind: 'lines'}], again: '+ '}};
    }
    case 'set': {
      const words = /^[\t ]/.test(edit.text) ? edit.text : edit.text.split('\n').map((l, i) => (l || !i ? lead(at) + l : l)).join('\n');
      return {marks: [{...lines(at, 1), gone: true}], said: t('Line {n} written anew', {n: at + 1}),
        done: {from: starts[at], to: end(at), insert: words, caret: starts[at] + words.length, said: t('Line {n} written', {n: at + 1}),
          lit: [{from: starts[at], to: starts[at] + words.length, kind: 'lines'}]}};
    }
    case 'drop': {
      const n = Math.min(edit.n, count - at), last = at + n - 1;
      // The line break goes with them: the one after the last, or (at the file's end) the one before the first.
      const cut = last + 1 < count ? {from: starts[at], to: starts[last + 1]} : {from: Math.max(0, starts[at] - 1), to: text.length};
      const after = last + 1 < count || !at ? cut.from : starts[at - 1];
      return {marks: [{...lines(at, n), gone: true}], said: t('{what} to take away', {what: span(at, n)}),
        done: {from: cut.from, to: cut.to, insert: '', caret: after, said: tn('{n} line taken away', '{n} lines taken away', n),
          lit: [{from: cut.from, to: cut.from, kind: 'rule', under: last + 1 >= count && at > 0, gone: true}]}};
    }
    case 'indent': {
      const n = Math.min(edit.n, count - at), from = starts[at], to = end(at + n - 1), unit = indentOf(text);
      const out = new RegExp(`^ {1,${unit === '\t' ? 4 : unit.length}}`);
      const block = text.slice(from, to).split('\n')
        .map((l) => (edit.by > 0 ? (l ? unit + l : l) : l.startsWith('\t') ? l.slice(1) : l.replace(out, ''))).join('\n');
      if (block === text.slice(from, to)) return {marks: [{...lines(at, n), now: true}], said: t('Nothing to move out'), done: null};
      const moved = (block.split('\n')[0].length - (end(at) - from));
      return {marks: [{...lines(at, n), now: true}],
        said: edit.by > 0 ? t('{what} in by one', {what: span(at, n)}) : t('{what} out by one', {what: span(at, n)}),
        done: {from, to, insert: block, caret: Math.max(from, from + lead(at).length + moved),
          said: edit.by > 0 ? t('In by one') : t('Out by one'), lit: [{from, to: from + block.length, kind: 'lines'}]}};
    }
    default:
      return {marks: [], said: '', done: null};
  }
}
