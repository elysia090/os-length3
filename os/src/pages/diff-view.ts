import {h} from '../dom.ts';
import type {DiffLine, FileDiff} from '../history.ts';
import {t, tn} from '../i18n.ts';

/** Files open at first; past them, a file shows its name and counts until opened. */
const OPEN = 3;

export interface DiffOptions {
  /** Pressing a file's name opens it (not for a removed file). */
  reveal?: (path: string) => void;
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
    const body = f.binary ? [] : f.lines.map((l, k) => {
      // Between two parts of a file, a quiet "…".
      if (l.kind === 'hunk') return k === 0 ? null : h('div', {class: 'diff-line hunk'}, h('span', {class: 'diff-no'}), h('span', {}, '…'));
      const row = h('div', {class: `diff-line ${l.kind}`}, h('span', {class: 'diff-no'}, l.at ? `${l.at}` : ''), h('span', {class: 'diff-text'}, l.text || ' '));
      o.line?.(row, `${f.path}:${k}`, l);
      return row;
    }).filter(Boolean) as HTMLElement[];
    if (f.more) body.push(h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', f.more)));
    const fold = h('details', {class: 'diff-file'}, head, h('div', {class: 'diff'}, ...body)) as HTMLDetailsElement;
    fold.open = i < OPEN;
    return fold;
  });
}
