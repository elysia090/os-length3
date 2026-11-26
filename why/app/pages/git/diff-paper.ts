/// <reference types="vite/client" />

import {h} from '../../ui/dom.ts';
import type {DiffLine, FileDiff} from '../../../repo/history.ts';
import {lineKey, type ReviewLine} from '../../../api/review-lines.ts';
import {t, tn} from '../../../text/i18n.ts';
import '../../styles/git-diff-paper.css';

interface PaperOptions {
  /** Full identity of the displayed comparison (repo, change, and immutable base/head), never just a version or path. */
  key: string;
  /** Private draft marks on this comparison. They are never sent by this view. */
  marks?: readonly ReviewLine[];
  onMarks?: (lines: ReviewLine[]) => void;
  /** Read-only references to show on the same comparison, kept apart from the draft. */
  linked?: readonly ReviewLine[];
}

interface Position { top: number; left: number }
interface PaperRest {
  position: Position;
  folds: Map<string, boolean>;
  resume: Map<string, Position>;
}

// A redraw or a return to a comparison keeps the view, not a cache of the diff or of a person's draft.
const rests = new Map<string, PaperRest>();
const MAX_RESTS = 64;

function restFor(key: string): PaperRest {
  const rest = rests.get(key) ?? {position: {top: 0, left: 0}, folds: new Map(), resume: new Map()};
  rests.delete(key);
  rests.set(key, rest);
  if (rests.size > MAX_RESTS) rests.delete(rests.keys().next().value!);
  return rest;
}

type Side = ReviewLine['side'];

function numberOn(line: DiffLine, side: Side): number | undefined {
  if (line.kind === 'hunk' || (side === 'old' && line.kind === 'add') || (side === 'new' && line.kind === 'del')) return;
  // A legacy context row only supplied its *new* number. Never guess its old number.
  const n = (side === 'old' ? line.old : line.new) ?? ((line.kind === 'del' ? 'old' : 'new') === side ? line.at : undefined);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

interface FileView {
  path: string;
  section: HTMLElement;
  head: HTMLElement;
  fold: HTMLElement;
  body: HTMLElement;
  sides: Record<Side, Cell[]>;
  tab?: HTMLElement;
}
interface Row { node: HTMLElement; file: FileView; cells: Partial<Record<Side, Cell>> }
interface Cell { ref: ReviewLine; key: string; button: HTMLElement; row: Row; offset: number }
interface Stroke { first: Cell; last: Cell; add: boolean; cells: Set<Cell> }

const sides: Side[] = ['old', 'new'];
const horizontal = new Set(['ArrowLeft', 'ArrowRight']);
const scrollKeys = new Set([...horizontal, 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

function cellName({path, side, line}: ReviewLine): string {
  return side === 'old' ? t('Before: line {n} in {path}', {n: line, path}) : t('After: line {n} in {path}', {n: line, path});
}

function range(first: Cell, last: Cell): Cell[] {
  return first.row.file.sides[first.ref.side].slice(Math.min(first.offset, last.offset), Math.max(first.offset, last.offset) + 1);
}
const sameSide = (a: Cell, b: Cell) => a.row.file === b.row.file && a.ref.side === b.ref.side;

/** The right column of the issue's paper. Its only scroller is this region. Its only fold is the file's name. */
export function diffPaper(files: readonly FileDiff[], options: PaperOptions): {
  element: HTMLElement;
  reveal(line: ReviewLine): boolean;
} {
  const rest = restFor(options.key);
  const element = h('div', {class: 'git-diff-paper'});
  const viewport = h('div', {class: 'git-diff-scroll', role: 'region', 'aria-label': t('Diff'), tabindex: '0'});
  const fileList = h('div', {class: 'git-diff-files'});
  const marked = new Map(options.marks?.map((line) => [lineKey(line), line]));
  const linked = new Set(options.linked?.map(lineKey));
  const addresses = new Map<string, Cell>();
  const rows = new WeakMap<Element, Row>();
  let pointer: (Stroke & {id: number}) | undefined;
  let keyboard: {first: Cell; base: Map<string, ReviewLine>} | undefined;
  let anchor: Cell | undefined;
  element.append(viewport);
  viewport.append(files.length ? fileList : h('p', {class: 'git-diff-unread'}, t('No changes')));

  const position = (): Position => ({top: viewport.scrollTop, left: viewport.scrollLeft});
  const remember = () => { if (element.isConnected) rest.position = position(); };
  const scroll = ({top, left}: Position) => { viewport.scrollTop = top; viewport.scrollLeft = left; remember(); };
  viewport.addEventListener('scroll', remember, {passive: true});

  function draw(row: Row) {
    let lit = false;
    for (const side of sides) {
      const cell = row.cells[side];
      if (!cell) continue;
      const set = pointer?.cells.has(cell) ? pointer.add : marked.has(cell.key);
      if (options.onMarks) cell.button.setAttribute('aria-pressed', String(set));
      lit ||= set || linked.has(cell.key);
    }
    row.node.classList.toggle('is-marked', lit);
  }

  function change(cells: readonly Cell[], add: boolean) {
    let different = false;
    for (const cell of cells) {
      if (add === marked.has(cell.key)) continue;
      if (add) marked.set(cell.key, cell.ref); else marked.delete(cell.key);
      different = true;
    }
    for (const cell of cells) draw(cell.row);
    if (different) options.onMarks?.([...marked.values()]);
  }

  function focus(cell: Cell) {
    if (options.onMarks) cell.button.focus({preventScroll: true});
    else { cell.row.node.tabIndex = -1; cell.row.node.focus({preventScroll: true}); }
  }

  // Only the requested line is brought into the viewport, not the page that contains the issue.
  function intoView(row: Row, showStart = false) {
    const bounds = viewport.getBoundingClientRect(), box = row.node.getBoundingClientRect();
    const top = Math.min(bounds.bottom, bounds.top + row.file.head.offsetHeight);
    const bottom = bounds.top + viewport.clientHeight;
    if (box.top < top) viewport.scrollTop += box.top - top;
    else if (box.bottom > bottom) viewport.scrollTop += box.bottom - bottom;
    if (showStart) viewport.scrollLeft = 0;
    remember();
  }

  function folding(file: FileView, open: boolean, byHand: boolean) {
    if (open === !file.body.hidden) return;
    if (byHand && !open) rest.resume.set(file.path, {...position(), top: Math.max(0, viewport.scrollTop - file.section.offsetTop)});
    rest.folds.set(file.path, open);
    file.fold.setAttribute('aria-expanded', String(open));
    file.body.hidden = !open;
    if (!byHand) return;
    const where = rest.resume.get(file.path);
    if (open && where) scroll({top: file.section.offsetTop + where.top, left: where.left});
    else if (!open) scroll({top: file.section.offsetTop, left: 0});
    else remember();
  }

  function keyOn(e: KeyboardEvent, cell: Cell) {
    if (e.key === 'Escape' && pointer) {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const {side} = cell.ref, other = side === 'old' ? 'new' : 'old';
    const family = cell.row.file.sides[side];
    const vertical = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const next = vertical ? family[cell.offset + vertical]
      : e.key === 'Home' ? family[0] : e.key === 'End' ? family.at(-1)
      : (e.key === 'ArrowLeft' && side === 'new') || (e.key === 'ArrowRight' && side === 'old') ? cell.row.cells[other]
      : undefined;
    if (!next) return;
    e.preventDefault();
    if (e.shiftKey && sameSide(cell, next)) {
      if (!keyboard || !sameSide(keyboard.first, cell)) keyboard = {first: cell, base: new Map(marked)};
      const chosen = range(keyboard.first, next);
      const showing = new Set([...marked.keys(), ...keyboard.base.keys(), ...chosen.map((part) => part.key)]);
      const previous = new Set(marked.keys());
      marked.clear();
      for (const [key, ref] of keyboard.base) marked.set(key, ref);
      for (const part of chosen) marked.set(part.key, part.ref);
      for (const key of showing) { const part = addresses.get(key); if (part) draw(part.row); }
      if (showing.size && [...showing].some((key) => previous.has(key) !== marked.has(key))) options.onMarks?.([...marked.values()]);
      anchor = keyboard.first;
    } else {
      keyboard = undefined;
    }
    focus(next);
    intoView(next.row);
  }

  function finish(seal: boolean) {
    if (!pointer) return;
    const {first, cells, add} = pointer;
    pointer = undefined;
    if (seal) { anchor = first; change([...cells], add); }
    else for (const cell of cells) draw(cell.row);
  }

  function markButton(cell: Cell) {
    const {button, row} = cell;
    button.addEventListener('focus', () => {
      if (row.file.tab) row.file.tab.tabIndex = -1;
      row.file.tab = button;
      button.tabIndex = 0;
    });
    button.addEventListener('keydown', (e) => keyOn(e, cell));
    button.addEventListener('click', (e) => {
      // Pointer events handle both clicks and drags; keyboard/assistive activation uses a synthetic click.
      if (e.detail !== 0) return;
      keyboard = undefined;
      if (e.shiftKey && anchor && sameSide(anchor, cell)) change(range(anchor, cell), true);
      else { change([cell], !marked.has(cell.key)); anchor = cell; }
    });
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || pointer) return;
      e.preventDefault(); // Keep the code's native text selection separate from the gutter.
      keyboard = undefined;
      focus(cell);
      const first = e.shiftKey && anchor && sameSide(anchor, cell) ? anchor : cell;
      pointer = {id: e.pointerId, first, last: cell, add: e.shiftKey || !marked.has(cell.key), cells: new Set(range(first, cell))};
      button.setPointerCapture(e.pointerId);
      for (const part of pointer.cells) draw(part.row);
    });
  }

  // Touch that starts in the diff belongs to its scroller or gutter, not the issue row's swipe.
  viewport.addEventListener('pointerdown', (e) => e.stopPropagation());
  viewport.addEventListener('pointermove', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    // Capture keeps handling the drag after the pointer leaves the original button. It can pass over the code.
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.git-diff-line');
    const cell = target ? rows.get(target)?.cells[pointer.first.ref.side] : undefined;
    if (!cell || !sameSide(pointer.first, cell) || cell === pointer.last) return;
    const previous = pointer.cells;
    pointer.last = cell;
    pointer.cells = new Set(range(pointer.first, cell));
    for (const before of previous) if (!pointer.cells.has(before)) draw(before.row);
    for (const added of pointer.cells) if (!previous.has(added)) draw(added.row);
  });
  viewport.addEventListener('pointerup', (e) => { if (e.pointerId === pointer?.id) finish(true); });
  for (const event of ['pointercancel', 'lostpointercapture'] as const) {
    viewport.addEventListener(event, (e) => { if (e.pointerId === pointer?.id) finish(false); });
  }
  viewport.addEventListener('keydown', (e) => { if (scrollKeys.has(e.key)) e.stopPropagation(); });
  viewport.addEventListener('keyup', (e) => { if (e.key === 'Shift') keyboard = undefined; });
  viewport.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof Node) || !viewport.contains(e.relatedTarget)) keyboard = undefined;
  });
  viewport.addEventListener('copy', (e) => {
    const text = copiedDiff(viewport, document.getSelection());
    if (text === null || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });

  files.forEach((f, index) => {
    const readable = !f.binary && (f.lines.length > 0 || f.more > 0);
    const fold = h(readable ? 'button' : 'span', {class: 'git-diff-name', ...(readable ? {type: 'button'} : {})}, f.path);
    // A legacy capped response cannot tell the full count. Do not report partial figures as totals.
    const count = f.binary ? t('Binary') : [
      f.added ?? (!f.more ? f.lines.filter((line) => line.kind === 'add').length : 0),
      f.removed ?? (!f.more ? f.lines.filter((line) => line.kind === 'del').length : 0),
    ].map((n, i) => n ? `${i ? '−' : '+'}${n}` : '').filter(Boolean).join('  ');
    const position = files.length > 1 ? h('span', {class: 'git-diff-position'}, `${index + 1} / ${files.length}`) : null;
    const meta = h('span', {class: 'git-diff-meta'}, position, h('span', {class: 'git-diff-count'}, count));
    const head = h('div', {class: 'git-diff-head'}, fold, meta);
    const body = h('div', {class: 'git-diff-lines'});
    const section = h('section', {class: 'git-diff-file'}, head, body);
    const file: FileView = {path: f.path, section, head, fold, body, sides: {old: [], new: []}};
    const open = rest.folds.get(f.path) ?? index < 3;
    fileList.append(section);
    body.hidden = !readable || !open;
    if (!readable) return;
    fold.setAttribute('aria-expanded', String(open));
    fold.addEventListener('click', () => folding(file, !!body.hidden, true));

    for (const line of f.lines) {
      if (line.kind === 'hunk') { body.append(h('div', {class: 'git-diff-hunk'}, line.text)); continue; }
      const gutter = h('div', {class: 'git-diff-gutter'});
      const indent = /^[ \t]*/.exec(line.text)![0];
      const code = h('span', {class: 'git-diff-code'}, indent, h('span', {class: 'git-diff-words'}, line.text.slice(indent.length) || ''));
      const node = h('div', {class: `git-diff-line is-${line.kind}`}, gutter, code);
      const row: Row = {node, file, cells: {}};
      for (const side of sides) {
        const n = numberOn(line, side);
        if (n === undefined) { gutter.append(h('span', {class: 'git-diff-number', 'aria-hidden': 'true'})); continue; }
        const ref: ReviewLine = {path: f.path, side, line: n};
        const button = h(options.onMarks ? 'button' : 'span', {
          class: 'git-diff-number',
          ...(options.onMarks ? {type: 'button', 'aria-label': cellName(ref), tabindex: file.tab ? '-1' : '0'} : {}),
        }, String(n));
        const family = file.sides[side];
        const cell: Cell = {ref, key: lineKey(ref), button, row, offset: family.length};
        family.push(cell);
        addresses.set(cell.key, cell);
        row.cells[side] = cell;
        if (options.onMarks) { file.tab ??= button; markButton(cell); }
        gutter.append(button);
      }
      gutter.append(h('span', {class: 'git-diff-sign', 'aria-hidden': 'true'}, line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''));
      rows.set(node, row);
      draw(row);
      body.append(node);
    }
    if (f.more) body.append(h('p', {class: 'git-diff-unread'}, tn('{n} more line', '{n} more lines', f.more)));
  });
  const initial = rest.position;
  // The caller inserts our element immediately; restore after all scroll dimensions exist. An explicit link wins.
  let willReveal = false;
  requestAnimationFrame(() => { if (!willReveal && element.isConnected) scroll(initial); });

  return {
    element,
    reveal(line) {
      const cell = addresses.get(lineKey(line));
      if (!cell) return false; // Missing, capped, or unavailable old coordinates do not name a different line.
      willReveal = true;
      folding(cell.row.file, true, false);
      const show = () => { if (element.isConnected) { intoView(cell.row, true); focus(cell); } };
      if (element.isConnected) show(); else requestAnimationFrame(show);
      return true;
    },
  };
}

/** Preserve plain multiline code when a native text selection spans gutters or hunk separators. */
function copiedDiff(viewport: HTMLElement, selection: Selection | null): string | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const {startContainer, startOffset, endContainer, endOffset} = selection.getRangeAt(0);
  const codeAt = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('.git-diff-code');
  const start = codeAt(startContainer), end = codeAt(endContainer);
  const file = start?.closest('.git-diff-lines');
  if (!start || !end || start === end || !file || !viewport.contains(file) || end.closest('.git-diff-lines') !== file) return null;
  const before = (code: Element, node: Node, offset: number) => {
    const r = document.createRange();
    r.selectNodeContents(code);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  const lines = [...file.querySelectorAll('.git-diff-code')];
  return lines.slice(lines.indexOf(start), lines.indexOf(end) + 1).map((code) => (code.textContent ?? '').slice(
    code === start ? before(start, startContainer, startOffset) : 0,
    code === end ? before(end, endContainer, endOffset) : undefined,
  )).join('\n');
}
