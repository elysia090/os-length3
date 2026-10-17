import {h} from '../dom.ts';
import type {DiffLine, FileDiff} from '../history.ts';
import {t, tn} from '../i18n.ts';

/** Files open at first; past them, a file shows its name and counts until opened. */
const OPEN = 3;

export interface DiffOptions {
  /**
   * Pressing a file's name opens it (not for a removed file); pressing a
   * line's number opens it at that line, selected, to write in. A removed
   * line is no line of the file now: its number opens the line that took its
   * place. Only for the copy here, whose lines are the center's.
   */
  reveal?: (path: string, line?: number) => void;
  /** Called for each line drawn, with its key (`path:index`), to mark it or make it markable. */
  line?: (row: HTMLElement, key: string, l: DiffLine) => void;
}

/**
 * Files of a diff. Each is a fold: its name with what was added and
 * removed (+3 −1), and under it its lines, each with which line it is in
 * the file. The first few are open; with many files or long ones, the rest
 * wait closed, so a large change reads file by file.
 */
export function diffFiles(files: FileDiff[], o: DiffOptions = {}): HTMLElement[] {
  return files.map((f, i) => {
    const add = f.lines.filter((l) => l.kind === 'add').length, del = f.lines.filter((l) => l.kind === 'del').length;
    const name = h('span', {class: 'diff-name'}, f.path);
    if (o.reveal && f.status !== 'removed') {
      const go = o.reveal;
      name.classList.add('link');
      name.addEventListener('click', (e) => { e.preventDefault(); go(f.path); });
    }
    const head = h('summary', {class: 'diff-head'}, name,
      f.binary ? h('span', {class: 'muted small'}, t('Binary')) : h('span', {class: 'diff-count'}, add ? `+${add}` : '', del ? ` −${del}` : ''));
    // Where each line is in the file as it is now: its own number, or for a removed line the next line kept (else the last).
    const now = (k: number): number | undefined => {
      const l = f.lines[k];
      if (l.kind !== 'del') return l.at;
      const after = f.lines.slice(k + 1).find((x) => x.kind === 'add' || x.kind === 'same');
      if (after) return after.at;
      const before = f.lines.slice(0, k).reverse().find((x) => x.kind === 'add' || x.kind === 'same');
      return before?.at ? before.at + 1 : 1;
    };
    const body = f.binary ? [] : f.lines.map((l, k) => {
      // Between two parts of a file, a quiet "…".
      if (l.kind === 'hunk') return k === 0 ? null : h('div', {class: 'diff-line hunk'}, h('span', {class: 'diff-no'}), h('span', {}, '…'));
      const at = o.reveal && f.status !== 'removed' ? now(k) : undefined;
      const no = at ? h('button', {type: 'button', class: 'diff-no go', tabindex: '-1', 'aria-label': t('Line {n} of {path}', {n: at, path: f.path})}, l.at ? `${l.at}` : '')
        : h('span', {class: 'diff-no'}, l.at ? `${l.at}` : '');
      if (at) { const go = o.reveal!; no.addEventListener('click', () => go(f.path, at)); }
      const row = h('div', {class: `diff-line ${l.kind}`}, no, h('span', {class: 'diff-text'}, l.text || ' '));
      o.line?.(row, `${f.path}:${k}`, l);
      return row;
    }).filter(Boolean) as HTMLElement[];
    if (f.more) body.push(h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', f.more)));
    const fold = h('details', {class: 'diff-file'}, head, h('div', {class: 'diff'}, ...body)) as HTMLDetailsElement;
    fold.open = i < OPEN;
    return fold;
  });
}
