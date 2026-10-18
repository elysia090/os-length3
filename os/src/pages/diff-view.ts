import {h} from '../dom.ts';
import type {DiffLine, FileDiff} from '../history.ts';
import {t, tn} from '../i18n.ts';
import {askFoot, SETTLE} from './common.ts';
import {errorText} from '../errors.ts';

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
  /** Put a file back as it was at the last commit (the copy here only); asked in its head first. */
  putBack?: (f: FileDiff) => Promise<void>;
}

/** What putting a file back does, a short line each. */
const BACK = (f: FileDiff) => (f.status === 'added' ? [t('It was not in the last commit, so it goes')]
  : f.status === 'removed' ? [t('It comes back as it was at the last commit')]
  : [t('Back as it was at the last commit.'), t('What was changed here goes.')]);

/**
 * Put back, at the right end of a file's head. Pressed, the head gives way to
 * what will happen, Not now at the left and Put back at the right (under the
 * pointer), and comes back as it was if the answer is no. The lines stay under
 * it, so what goes is in view.
 */
function putBackButton(f: FileDiff, head: HTMLElement, act: (f: FileDiff) => Promise<void>): HTMLElement {
  const back = h('button', {type: 'button', class: 'button small-button put-back', 'aria-label': t('Put back {path}', {path: f.path})}, t('Put back')) as HTMLButtonElement;
  back.addEventListener('click', (e) => {
    e.preventDefault();
    const was = [...head.childNodes];
    const foot = askFoot(back, head);
    const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
    const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Put back')) as HTMLButtonElement;
    const error = h('span', {class: 'error small', role: 'alert'});
    no.addEventListener('click', (e) => { e.preventDefault(); head.classList.remove('asking'); head.replaceChildren(...was); back.focus(); });
    const shown = performance.now();
    yes.addEventListener('click', async (e) => {
      e.preventDefault();
      if (performance.now() - shown < SETTLE) return;
      yes.disabled = true;
      // Done, the diff is drawn again from what is there now.
      try { await act(f); } catch (x) { error.textContent = errorText(x); yes.disabled = false; }
    });
    head.classList.add('asking');
    head.replaceChildren(h('span', {class: 'diff-name'}, f.path), ...BACK(f).map((l) => h('span', {class: 'muted small'}, l)), error, foot(no, yes));
    yes.focus();
  });
  return back;
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
    // A binary file is put back only by going (one added since); its bytes are not written here.
    if (o.putBack && (!f.binary || f.status === 'added')) {
      head.append(h('span', {class: 'grow'}), putBackButton(f, head, o.putBack));
      // While it asks, the head is not the fold's switch.
      head.addEventListener('click', (e) => { if (head.classList.contains('asking')) e.preventDefault(); });
    }
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
      // The words in a span of their own, after the indent, so a mark is drawn over them as a highlighter is, line by line as they wrap.
      const indent = /^[ \t]*/.exec(l.text)![0];
      const words = l.text.slice(indent.length);
      const row = h('div', {class: `diff-line ${l.kind}`}, no, h('span', {class: 'diff-text'}, indent, h('span', {class: 'diff-words'}, words || ' ')));
      o.line?.(row, `${f.path}:${k}`, l);
      return row;
    }).filter(Boolean) as HTMLElement[];
    if (f.more) body.push(h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', f.more)));
    const fold = h('details', {class: 'diff-file'}, head, h('div', {class: 'diff'}, ...body)) as HTMLDetailsElement;
    fold.open = i < OPEN;
    return fold;
  });
}
