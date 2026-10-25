import {h} from '../../ui/dom.ts';
import type {DiffLine, FileDiff} from '../../repos/history.ts';
import {t, tn} from '../../i18n.ts';
import {askFoot, SETTLE} from '../common.ts';
import {errorText} from '../../app/errors.ts';
import {shownPath} from '../../repos/issues.ts';

/**
 * A file of a diff as it is called: an issue's file is the issue (issue/001.md is #1), every other file its path.
 * Only what is shown; what is done is done to the file itself.
 */
export const fileName = shownPath;

/** Files open at first; past them, a file shows its name and counts until opened. */
const OPEN = 3;

interface DiffOptions {
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
  /**
   * The lines beside the file's name and its +n −n, from that row, not under it: for a box as wide as Git's,
   * where a file is read whole (issue #20). Unfolded, always open. (A search's diff, narrow, keeps them under.)
   */
  beside?: boolean;
  /**
   * A file's lines past this many wait under a quiet "n more lines", pressed to show them: a large change reads
   * file by file, none of them a wall. Which files are open is kept under `kept` (a repo's name, say) while the
   * page is drawn again.
   */
  cut?: number;
  kept?: string;
}

/** The files opened or shut by hand, by `kept` and path, so a page drawn again keeps them so. */
const folded = new Map<string, boolean>();

/** What putting a file back does, a short line each. */
const BACK = (f: FileDiff) => (f.status === 'added' ? [t('It was not in the last commit, so it goes')]
  : f.status === 'removed' ? [t('It comes back as it was at the last commit')]
  : [t('Back as it was at the last commit.'), t('What was changed here goes.')]);

/**
 * Put back, at the foot of a file's lines, its right end: out of the head, where
 * the file's name and counts have the line to themselves (issue #20: in the head
 * it squeezed and wrapped them). Pressed, the foot gives way to what will happen,
 * Not now at the left and Put back at the right (under the pointer), and comes
 * back as it was if the answer is no. The lines stay over it, so what goes is in view.
 */
function putBackButton(f: FileDiff, head: HTMLElement, act: (f: FileDiff) => Promise<void>): HTMLElement {
  const back = h('button', {type: 'button', class: 'button small-button put-back', 'aria-label': t('Put back {path}', {path: fileName(f.path)})}, t('Put back')) as HTMLButtonElement;
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
      try { await act(f); head.classList.remove('asking'); } catch (x) { error.textContent = errorText(x); yes.disabled = false; }
    });
    head.classList.add('asking');
    head.replaceChildren(...BACK(f).map((l) => h('span', {class: 'muted small'}, l)), error, foot(no, yes));
    yes.focus();
  });
  return back;
}

/**
 * What a file's change comes to: +n in the added lines' green, −n in the removed lines' red, and after them five
 * small squares shared out between the two as the lines are, each side at least one when it has any (any diff
 * reads so at a glance).
 */
export function counted(add: number, del: number): HTMLElement {
  const all = add + del;
  let green = all ? Math.round((5 * add) / all) : 0;
  if (add && !green) green = 1;
  if (del && green === 5) green = 4;
  const squares = [...Array(all ? 5 : 0)].map((_, i) => h('i', {class: i < green ? 'add' : 'del'}));
  return h('span', {class: 'diff-count'}, add ? h('span', {class: 'diff-add'}, `+${add}`) : null, del ? h('span', {class: 'diff-del'}, `−${del}`) : null,
    h('span', {class: 'diff-bar', 'aria-hidden': 'true'}, ...squares));
}

/** Where line `k` of `f` is in the file as it is now: its own number, or for a removed line the next line kept (else the last). */
function nowAt(f: FileDiff, k: number): number | undefined {
  const l = f.lines[k];
  if (l.kind !== 'del') return l.at;
  const after = f.lines.slice(k + 1).find((x) => x.kind === 'add' || x.kind === 'same');
  if (after) return after.at;
  const before = f.lines.slice(0, k).reverse().find((x) => x.kind === 'add' || x.kind === 'same');
  return before?.at ? before.at + 1 : 1;
}

/** `f`'s line `l` (the `k`th) as a row: which line it is in the file, + or −, its words; none for the first part's head. */
function diffRow(f: FileDiff, l: DiffLine, k: number, o: DiffOptions): HTMLElement | null {
  // Between two parts of a file, a quiet "…".
  if (l.kind === 'hunk') return k === 0 ? null : h('div', {class: 'diff-line hunk'}, h('span', {class: 'diff-no'}), h('span'), h('span', {}, '…'));
  const at = o.reveal && f.status !== 'removed' ? nowAt(f, k) : undefined;
  const no = at ? h('button', {type: 'button', class: 'diff-no go', tabindex: '-1', 'aria-label': t('Line {n} of {path}', {n: at, path: fileName(f.path)})}, l.at ? `${l.at}` : '')
    : h('span', {class: 'diff-no'}, l.at ? `${l.at}` : '');
  if (at) { const go = o.reveal!; no.addEventListener('click', () => go(f.path, at)); }
  // The words in a span of their own, after the indent, so a mark is drawn over them as a highlighter is, line by line as they wrap.
  const indent = /^[ \t]*/.exec(l.text)![0];
  const words = l.text.slice(indent.length);
  // + or − before the words (nothing for a line that stays), as any diff writes it.
  const sign = h('span', {class: 'diff-sign', 'aria-hidden': 'true'}, l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '');
  const row = h('div', {class: `diff-line ${l.kind}`}, no, sign, h('span', {class: 'diff-text'}, indent, h('span', {class: 'diff-words'}, words || ' ')));
  o.line?.(row, `${f.path}:${k}`, l);
  return row;
}

/** The head of `f`'s fold: its name (pressed, the file opens, unless it was removed) and what its change comes to. */
function diffHead(f: FileDiff, o: DiffOptions): HTMLElement {
  const add = f.lines.filter((l) => l.kind === 'add').length, del = f.lines.filter((l) => l.kind === 'del').length;
  const name = h('span', {class: 'diff-name', title: f.path}, fileName(f.path));
  if (o.reveal && f.status !== 'removed') {
    const go = o.reveal;
    name.classList.add('link');
    name.addEventListener('click', (e) => { e.preventDefault(); go(f.path); });
  }
  return h('summary', {class: 'diff-head'}, name, f.binary ? h('span', {class: 'muted small'}, t('Binary')) : counted(add, del));
}

/**
 * Under `f`'s lines, how many more there are: those `waiting` past the cut shown in `lines` when pressed, and what
 * could not be read said.
 */
function moreLines(f: FileDiff, lines: HTMLElement, waiting: HTMLElement[]): HTMLElement | null {
  const unread = () => h('p', {class: 'diff-more muted small'}, tn('{n} more line', '{n} more lines', f.more));
  if (!waiting.length) return f.more ? unread() : null;
  const more = h('button', {type: 'button', class: 'diff-more'}, tn('{n} more line', '{n} more lines', waiting.length + f.more)) as HTMLButtonElement;
  more.addEventListener('click', () => {
    lines.append(...waiting);
    // What could not be read past 400 lines is still said; the rest are there now.
    if (f.more) more.replaceWith(unread()); else more.remove();
  });
  return more;
}

/** `f`, the `i`th file of a diff: a fold, open if it is among the first few (or as it was left), or open beside its head. */
function diffFile(f: FileDiff, i: number, o: DiffOptions): HTMLElement {
  const head = diffHead(f, o);
  // A binary file is put back only by going (one added since); its bytes are not written here.
  const foot = o.putBack && (!f.binary || f.status === 'added') ? h('div', {class: 'diff-foot'}) : null;
  if (foot) foot.append(putBackButton(f, foot, o.putBack!));
  const body = f.binary ? [] : f.lines.map((l, k) => diffRow(f, l, k, o)).filter((row) => row !== null);
  // Past `cut` lines, the rest wait under a quiet line that shows them when pressed.
  const waiting = o.cut && body.length > o.cut + 4 ? body.splice(o.cut) : [];
  const lines = h('div', {class: 'diff'}, ...body);
  const more = moreLines(f, lines, waiting);
  const after = [...(more ? [more] : []), ...(foot ? [foot] : [])];
  if (o.beside) return h('div', {class: 'diff-file beside'}, h('div', {class: 'diff-head'}, ...head.childNodes), lines, ...after);
  const fold = h('details', {class: 'diff-file'}, head, lines, ...after) as HTMLDetailsElement;
  const key = o.kept ? `${o.kept}:${f.path}` : '';
  fold.open = key && folded.has(key) ? folded.get(key)! : i < OPEN;
  if (key) fold.addEventListener('toggle', () => folded.set(key, fold.open));
  return fold;
}

/**
 * Files of a diff. Each is a fold: its name with what was added and
 * removed (+3 −1), and under it its lines, each with which line it is in
 * the file. The first few are open; with many files or long ones, the rest
 * wait closed, so a large change reads file by file.
 */
export function diffFiles(files: FileDiff[], o: DiffOptions = {}): HTMLElement[] {
  return files.map((f, i) => diffFile(f, i, o));
}
