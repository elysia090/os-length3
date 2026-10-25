import {h} from '../dom.ts';
import {paced, still} from '../glide.ts';
import {lineOf, lineStarts, parseEdit, plan, type Mark} from '../edit.ts';
import {t} from '../i18n.ts';
import {store} from '../repos.ts';
import {numberOf, shownName} from '../issues.ts';
import type {Writing} from './reader.ts';

// The box at the center's foot as a line that edits the file in front (DESIGN.md § Forge, Edit): nothing to be in and
// no keys to learn. The plainest is to point: while the box has the keyboard, a line of a file pressed comes into the
// box as it is, the caret where it was pressed, to be written anew there; Enter writes it back, Escape leaves it as it
// was, ↑ and ↓ (nothing changed yet) take the line above or below. Pointed at, a line is ringed to say so.
// Besides, a few short lines that say what they do, each shown on the file as it is written and done with Enter,
// Ctrl+Z in the empty box taking it back (the file's own Undo has it too). The file in front is the one last written
// in (or pressed), else the one read; the pill says which, and the line the caret is on.
//
//   12               go to line 12 (:12 too)
//   word             find it, lit where it is; Enter goes to the next (Shift+Enter, the one before). Small letters
//                    find either; /word finds exactly what follows the / (a word that starts as a line below does)
//   old → new        write new for old, everywhere in the file (-> for →; nothing after it takes old away)
//   + words          a line of words under the caret's, as indented as it is; the box is ready for the next line
//   = words          the caret's line written anew, its indent kept
//   -   -3           take away the caret's line, or that many from it
//   >   <   >3       move the caret's line (or that many) in or out by one indent
//   @path            the file to edit (Tab completes it, as in Run)
//
// With the box empty, ↑ and ↓ move the caret's line, and Escape gives the keyboard back to the file, at the caret.
// What a line would do is shown on the file while it is written (what it takes or finds lit, a line to come as a
// rule) and said under the box; nothing is done before Enter. It is written into the file as typing is (Reader's
// editor: it saves, and its Undo takes it back), so nothing here keeps a file of its own.

/** A line's words up to a place in it as they are drawn: each tab to the next stop of `tab`. */
function drawn(line: string, tab: number): string {
  let out = '';
  for (const c of line) out += c === '\t' ? ' '.repeat(tab - (out.length % tab)) : c;
  return out;
}
const measures = new WeakMap<HTMLTextAreaElement, CanvasRenderingContext2D>();
/** How wide `words` are in the editor's face. */
function widthIn(area: HTMLTextAreaElement, words: string): number {
  let c = measures.get(area);
  if (!c) { c = document.createElement('canvas').getContext('2d')!; c.font = getComputedStyle(area).font; measures.set(area, c); }
  return c.measureText(words).width;
}

/**
 * `marks` drawn on the editor `area`, under its words (its ground is clear), in a layer of its own laid over it
 * (`layer` names it: what a line would do, or what was just done); none, the layer goes. Returns the lead mark's
 * element (the first now-mark, else the first).
 */
export function drawMarks(area: HTMLTextAreaElement, marks: Mark[], layer = 'edit-marks'): HTMLElement | null {
  const sheet = area.parentElement;
  if (!sheet) return null;
  let el = sheet.querySelector<HTMLElement>(`:scope > .${layer}`);
  if (!marks.length) { el?.remove(); return null; }
  if (!el) { el = h('div', {class: `edit-layer ${layer}`, 'aria-hidden': 'true'}); sheet.insertBefore(el, area); }
  const cs = getComputedStyle(area), text = area.value, starts = lineStarts(text);
  const lh = parseFloat(cs.lineHeight) || 1.6 * parseFloat(cs.fontSize), tab = Number(cs.tabSize) || 4;
  const top0 = parseFloat(cs.paddingTop) || 0, left0 = (parseFloat(cs.paddingLeft) || 0) - area.scrollLeft;
  Object.assign(el.style, {left: `${area.offsetLeft}px`, top: `${area.offsetTop}px`, width: `${area.offsetWidth}px`, height: `${area.offsetHeight}px`});
  const x = (line: number, offset: number) => left0 + widthIn(area, drawn(text.slice(starts[line], offset), tab));
  const els = marks.slice(0, 2000).map((m) => {
    const line = lineOf(starts, m.from);
    const span = h('span', {class: `edit-mark ${m.kind}${m.now ? ' now' : ''}${m.gone ? ' gone' : ''}`});
    if (m.kind === 'rule') span.style.top = `${top0 + (line + (m.under ? 1 : 0)) * lh}px`;
    else if (m.kind === 'lines') {
      const last = lineOf(starts, Math.max(m.from, m.to));
      Object.assign(span.style, {top: `${top0 + line * lh}px`, height: `${(last - line + 1) * lh}px`});
    } else {
      const a = x(line, m.from), b = x(line, m.to);
      Object.assign(span.style, {top: `${top0 + line * lh}px`, height: `${lh}px`, left: `${a - 2}px`, width: `${Math.max(4, b - a + 4)}px`});
    }
    return span;
  });
  el.replaceChildren(...els);
  return els[Math.max(0, marks.findIndex((m) => m.now))] ?? null;
}

/** `el` (a mark on the file) brought into view if it is out of it, a third down what is clear of the box (`clear`, its top). */
function bring(el: HTMLElement, area: HTMLTextAreaElement, clear: number) {
  const flow = area.closest<HTMLElement>('.flow');
  if (!flow) return;
  const r = el.getBoundingClientRect(), f = flow.getBoundingClientRect(), bottom = Math.min(f.bottom, clear) - 12;
  if (r.top < f.top + 12 || r.bottom > bottom)
    flow.scrollTo({top: flow.scrollTop + r.top - f.top - (bottom - f.top) / 3, behavior: still() ? 'auto' : 'smooth'});
  // A word far along a long line: the editor scrolls along to it (its marks with it). A line's mark (or a rule) is as
  // wide as the file, starting left of its words, so it asks for none; told only when it did scroll, so the marks
  // drawn again for it (show, on its scroll) do not ask again.
  const w = area.getBoundingClientRect();
  if (!el.matches('.lines, .rule') && (r.right > w.right - 8 || r.left < w.left)) {
    const was = area.scrollLeft;
    area.scrollLeft = Math.max(0, area.scrollLeft + r.left - w.left - w.width / 3);
    if (area.scrollLeft !== was) area.dispatchEvent(new Event('scroll'));
  }
}

/** What can be done from the empty box, each with what it does: said under it, as Tab's choices are. Pointing first. */
function legend(): Node[] {
  const each: [string, string][] = [[t('Click a line'), t('rewrite it here')], ['12', t('to the line')], ['word', t('find')], ['a → b', t('b for every a')],
    ['+', t('a line under')], ['-', t('take it away')], ['@', t('another file')]];
  return each.map(([k, w]) => h('span', {class: 'edit-key'}, h('code', {}, k), w));
}

/** The place in `area` the pointer is over, at (`x`, `y`): the nearest gap between two letters of its line (its end, beside the text). */
function offsetAt(area: HTMLTextAreaElement, x: number, y: number): {line: number; at: number} {
  const cs = getComputedStyle(area), r = area.getBoundingClientRect(), text = area.value, starts = lineStarts(text);
  const lh = parseFloat(cs.lineHeight) || 1.6 * parseFloat(cs.fontSize), tab = Number(cs.tabSize) || 4;
  const line = Math.min(starts.length - 1, Math.max(0, Math.floor((y - r.top - (parseFloat(cs.paddingTop) || 0)) / lh)));
  const from = starts[line], to = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  if (x < r.left) return {line, at: to};
  const want = x - r.left - (parseFloat(cs.paddingLeft) || 0) + area.scrollLeft;
  let was = 0;
  for (let i = from; i < to; i++) {
    const w = widthIn(area, drawn(text.slice(from, i + 1), tab));
    if (w >= want) return {line, at: want - was < w - want ? i : i + 1};
    was = w;
  }
  return {line, at: to};
}

/** A line taken into the box to be written anew: where it is in `area`, and its words as they were. */
interface Taken { area: HTMLTextAreaElement; from: number; to: number; text: string }

/** An edit the box did: `inserted` written at `from` over `removed`, the caret at `caret` before it. */
interface Step { area: HTMLTextAreaElement; from: number; removed: string; inserted: string; caret: number }
/** Steps kept to take back. */
const STEPS = 100;

/** The file Edit works on: its path, and the editor it is written in. */
export interface Front { path: string; area: HTMLTextAreaElement }

export interface EditParts {
  box: HTMLTextAreaElement;
  /** The page's content, where the repo's files are read (Forge's boxes, `.col[data-repo]`). */
  main: HTMLElement;
  /** The dock the box stands in, which what is shown on the file is kept clear of. */
  dock: HTMLElement;
  repo(): string | null;
  reveal(path: string, line?: number, write?: Writing): void;
  /** Said under the box: what Enter would do, or what it did, or (the box empty) what can be written there. */
  say(text: string | Node[]): void;
  /** The file in front, or the caret's line in it, changed: the pill says it again. */
  moved(): void;
  /** Whether the box edits and has the keyboard: a line pressed then is taken into it. */
  active(): boolean;
}

/** The box's Edit: the file it is set on, what a line would do shown on it as it is written, done with Enter. */
export class EditLine {
  readonly #p: EditParts;
  /** The editor last written in (or chosen with @): the file in front while it is there. */
  #last: HTMLTextAreaElement | null = null;
  /** Editors whose caret was put by a person (or here): the others start at the line read, not at the file's top. */
  readonly #placed = new WeakSet<HTMLTextAreaElement>();
  /** Editors written in by a person: their caret is theirs. */
  readonly #written = new WeakSet<HTMLTextAreaElement>();
  /** The editor whose marks are out now. */
  #shownOn: HTMLTextAreaElement | null = null;
  /** The keyboard going to the file and back for an edit: the box losing it then is not leaving it. */
  busy = false;
  #pending = 0;
  /**
   * What the box did, to take back one at a time (Ctrl+Z in the empty box) and put back (Ctrl+Shift+Z): its own,
   * not the browser's, which holds what was typed in the box too, in the same line.
   */
  readonly #done: Step[] = [];
  readonly #undone: Step[] = [];
  /** The line taken into the box, being written anew there. */
  #taken: Taken | null = null;
  /** The line pointed at, ringed: its editor and line. */
  #ringed: {area: HTMLTextAreaElement; line: number} | null = null;

  constructor(p: EditParts) {
    this.#p = p;
    // Pressed while the box has the keyboard, a line of the repo's files comes into it (not the keyboard into the
    // file); its numbers pressed, the same, the caret at its end.
    const areaOf = (el: EventTarget | null) => {
      const sheet = el instanceof Element ? el.closest('section.file .sheet') : null;
      const area = sheet?.querySelector<HTMLTextAreaElement>(':scope > textarea.code-edit');
      return area && area.closest<HTMLElement>('.col')?.dataset.repo === p.repo() ? area : null;
    };
    p.main.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !p.active()) return;
      const area = areaOf(event.target);
      if (!area) return;
      event.preventDefault();
      event.stopPropagation();
      const {line, at} = offsetAt(area, event.clientX, event.clientY);
      this.#take(area, line, at - lineStarts(area.value)[line]);
    }, true);
    let pointing = 0;
    p.main.addEventListener('pointermove', (event) => {
      cancelAnimationFrame(pointing);
      pointing = requestAnimationFrame(() => {
        const area = p.active() ? areaOf(document.elementFromPoint(event.clientX, event.clientY)) : null;
        this.#ring(area, area ? offsetAt(area, event.clientX, event.clientY).line : 0);
      });
    });
    p.main.addEventListener('pointerleave', () => { cancelAnimationFrame(pointing); this.#ring(null, 0); });
    // The file written in is the one in front; its caret moving moves the line the pill says.
    p.main.addEventListener('focusin', (event) => {
      const el = event.target;
      if (!(el instanceof HTMLTextAreaElement) || !el.classList.contains('code-edit')) return;
      this.#last = el;
      this.#placed.add(el);
      if (this.busy) return;
      this.#written.add(el);
      p.moved();
    });
    let moving = 0;
    const moved = () => { cancelAnimationFrame(moving); moving = requestAnimationFrame(() => p.moved()); };
    for (const e of ['keyup', 'pointerup', 'input']) {
      p.main.addEventListener(e, (event) => { if ((event.target as Element).classList?.contains('code-edit') && !this.busy) moved(); }, true);
    }
    // A long line scrolled along in the editor: its marks go with it.
    p.main.addEventListener('scroll', (event) => { if (event.target === this.#shownOn && !this.busy) this.show(); }, true);
  }

  /** The file in front: the one last written in while it is shown in the repo's box, else the one read there. */
  front(): Front | null {
    const repo = this.#p.repo();
    if (!repo) return null;
    const ok = (a: HTMLTextAreaElement | null) => !!a?.isConnected && !!a.offsetParent && a.closest<HTMLElement>('.col')?.dataset.repo === repo;
    let area = ok(this.#last) ? this.#last : null;
    if (!area) {
      const sel = `.col[data-repo="${CSS.escape(repo)}"]`;
      const flow = this.#p.main.querySelector<HTMLElement>(`${sel}.active .flow`) ?? this.#p.main.querySelector<HTMLElement>(`${sel}:not([hidden]) .flow`);
      const top = (flow?.getBoundingClientRect().top ?? 0) + 8;
      for (const a of flow?.querySelectorAll<HTMLTextAreaElement>('section.file textarea.code-edit') ?? []) {
        if (a.offsetParent && a.getBoundingClientRect().bottom > top) { area = a; break; }
      }
    }
    const path = area?.closest<HTMLElement>('section.file')?.dataset.path;
    if (!area || !path) return null;
    // Never written in: its caret starts at the line read (a third down the center), not at its top.
    if (!this.#placed.has(area)) {
      this.#placed.add(area);
      const flow = area.closest<HTMLElement>('.flow'), lh = parseFloat(getComputedStyle(area).lineHeight) || 20;
      const third = flow ? flow.getBoundingClientRect().top + flow.clientHeight / 3 : 0;
      const starts = lineStarts(area.value);
      const line = Math.min(starts.length - 1, Math.max(0, Math.floor((third - area.getBoundingClientRect().top) / lh)));
      area.setSelectionRange(starts[line], starts[line]);
    }
    return {path, area};
  }

  /** The pill's words: the file in front and the caret's line in it. */
  where(): {file: string; line: number} | null {
    const f = this.front();
    if (!f) return null;
    // Counted, not split: it is asked at every key in the file.
    const text = f.area.value, caret = f.area.selectionStart;
    let line = 1;
    for (let i = text.indexOf('\n'); i >= 0 && i < caret; i = text.indexOf('\n', i + 1)) line++;
    return {file: shownName(f.path), line};
  }

  /** What the box holds, shown on the file and said; with it empty, the caret's line lit. */
  show(back = false) {
    const f = this.front();
    this.#mark(f);
    this.#p.main.classList.add('edit-pointing');
    if (!f) { this.#off(); this.#p.say(this.#p.repo() ? t('Open a file to edit it here') : ''); return; }
    const typed = this.#p.box.value, e = parseEdit(typed), area = f.area;
    if (this.#shownOn && this.#shownOn !== area) this.#off();
    this.#shownOn = area;
    // A line taken into the box: it is lit where it is, whatever is written (its new words, not a line that asks).
    const k = this.#still();
    if (k) {
      const line = lineOf(lineStarts(k.area.value), k.from);
      drawMarks(k.area, [{from: k.from, to: k.to, kind: 'lines', now: true}]);
      this.#p.say(typed === k.text ? t('Line {n}: write it anew here, Escape leaves it as it is', {n: line + 1})
        : t('Line {n}: Enter writes it, Escape leaves it as it was', {n: line + 1}));
      return;
    }
    if (e.kind === 'none' || e.kind === 'file') {
      const starts = lineStarts(area.value), line = lineOf(starts, area.selectionStart);
      // The caret's line, softly: where + = - > would act.
      drawMarks(area, [{from: starts[line], to: starts[line], kind: 'lines'}]);
      this.#p.say(e.kind === 'file' ? t('Enter: edit {path}', {path: e.path}) : typed.startsWith('@') ? t('A file of {repo}: Tab completes it', {repo: this.#p.repo()!})
        : typed ? '' : legend());
      return;
    }
    const p = plan(e, area.value, area.selectionStart, back, typed, area.selectionEnd);
    const lead = drawMarks(area, p.marks);
    if (lead) bring(lead, area, this.#p.dock.getBoundingClientRect().top);
    this.#p.say(p.said);
  }

  /** The marks put away (the box left, or doing something else); a line taken stays taken, to be shown on coming back. */
  hide() {
    this.#off();
    this.#mark(null);
    this.#ring(null, 0);
    this.#p.main.classList.remove('edit-pointing');
  }

  /** Whether a line is taken into the box. */
  get taken(): boolean { return !!this.#still(); }

  /** The line taken, while it is as it was where it was (else it is let go). */
  #still(): Taken | null {
    const k = this.#taken;
    if (k && !(k.area.isConnected && k.area.value.slice(k.from, k.to) === k.text && (k.to === k.area.value.length || k.area.value[k.to] === '\n'))) {
      this.#taken = null;
      return null;
    }
    return k;
  }

  /** Line `line` of `area` taken into the box, the caret at `column` in it; one taken and written anew is written back first, as a sheet's cell is left. */
  #take(area: HTMLTextAreaElement, line: number, column: number) {
    if (this.#still() && this.#p.box.value !== this.#taken!.text) void this.#putBack();
    const starts = lineStarts(area.value), at = Math.min(Math.max(0, line), starts.length - 1);
    const from = starts[at], to = at + 1 < starts.length ? starts[at + 1] - 1 : area.value.length, text = area.value.slice(from, to);
    this.#taken = {area, from, to, text};
    this.#last = area;
    this.#placed.add(area);
    this.#written.add(area);
    // The caret's line is the one taken: the pill says it.
    area.setSelectionRange(from, from);
    const box = this.#p.box, c = Math.min(Math.max(0, column), text.length);
    box.value = text;
    box.setSelectionRange(c, c);
    box.dispatchEvent(new Event('input', {bubbles: true}));
    this.#p.moved();
  }

  /** The line taken written back as the box has it (nothing, if it is as it was): what is to be said of it. */
  #putBack(): string {
    const k = this.#still(), words = this.#p.box.value;
    this.#taken = null;
    if (!k) return t('Written over since: undo it in the file');
    const line = lineOf(lineStarts(k.area.value), k.from);
    if (words === k.text) return t('Line {n} as it was', {n: line + 1});
    this.#done.push({area: k.area, from: k.from, removed: k.text, inserted: words, caret: k.from});
    if (this.#done.length > STEPS) this.#done.shift();
    this.#undone.length = 0;
    this.#write(k.area, k.from, k.to, words, k.from + words.length);
    this.#flash(k.area, [{from: k.from, to: k.from + words.length, kind: 'lines'}]);
    return t('Line {n} written', {n: line + 1});
  }

  /** Escape with a line taken: it is let go as it was, the box emptied; false with none taken. */
  cancel(): boolean {
    if (!this.#taken) return false;
    this.#taken = null;
    this.#keep('');
    return true;
  }

  /** ↑ or ↓ with a line taken and nothing written in it yet: the one above or below taken instead; false otherwise. */
  stepTaken(by: 1 | -1): boolean {
    const k = this.#still();
    if (!k || this.#p.box.value !== k.text) return false;
    const line = lineOf(lineStarts(k.area.value), k.from) + by, box = this.#p.box;
    if (line < 0 || line >= lineStarts(k.area.value).length) return true;
    this.#take(k.area, line, box.selectionStart);
    const lead = k.area.parentElement?.querySelector<HTMLElement>(':scope > .edit-marks > .now');
    if (lead) bring(lead, k.area, this.#p.dock.getBoundingClientRect().top);
    return true;
  }

  /** The line pointed at ringed (none: the ring goes), to say it can be pressed. */
  #ring(area: HTMLTextAreaElement | null, line: number) {
    const was = this.#ringed;
    if (was && (was.area !== area || was.line !== line)) drawMarks(was.area, [], 'edit-ring');
    this.#ringed = area ? {area, line} : null;
    if (!area || (was?.area === area && was.line === line)) return;
    const starts = lineStarts(area.value);
    drawMarks(area, [{from: starts[line], to: starts[line], kind: 'lines'}], 'edit-ring');
  }
  #off() {
    if (this.#shownOn) drawMarks(this.#shownOn, []);
    this.#shownOn = null;
  }

  /** The file in front said so on the page while the box is on it: its edge as when it is written in. */
  #mark(f: Front | null) {
    const section = f?.area.closest('section.file') ?? null;
    for (const s of this.#p.main.querySelectorAll('section.file.edit-front')) if (s !== section) s.classList.remove('edit-front');
    section?.classList.add('edit-front');
  }

  /** Enter: what the box holds done on the file (a line taken, written back); false when there was nothing to do. */
  enter(back = false): boolean {
    if (this.#taken) {
      const said = this.#putBack();
      this.#keep('');
      this.show();
      this.#p.say(said);
      return true;
    }
    const typed = this.#p.box.value, e = parseEdit(typed);
    if (e.kind === 'file') { void this.#choose(e.path); return true; }
    const f = this.front();
    if (!f || e.kind === 'none') return false;
    const area = f.area, p = plan(e, area.value, area.selectionStart, back, typed, area.selectionEnd);
    if (p.go) {
      const go = p.go;
      this.#with(area, () => area.setSelectionRange(go.from, go.to));
      this.#keep(go.keep);
      if (e.kind === 'go') this.#flash(area, [{...p.marks[0], now: false}]);
      // Shown again from where it went: a word found is where one is now, said as such.
      this.show();
      return true;
    }
    if (!p.done) { this.#p.say(p.said); return false; }
    const d = p.done;
    this.#done.push({area, from: d.from, removed: area.value.slice(d.from, d.to), inserted: d.insert, caret: area.selectionStart});
    if (this.#done.length > STEPS) this.#done.shift();
    this.#undone.length = 0;
    this.#write(area, d.from, d.to, d.insert, d.caret);
    this.#keep(d.again ?? '');
    this.#flash(area, d.lit);
    this.show();
    this.#p.say(d.said);
    return true;
  }

  /** ↑ or ↓ in the empty box: the caret's line moved up or down by one. */
  step(by: 1 | -1) {
    const f = this.front();
    if (!f) return;
    const area = f.area, starts = lineStarts(area.value);
    const line = Math.min(starts.length - 1, Math.max(0, lineOf(starts, area.selectionStart) + by));
    this.#with(area, () => area.setSelectionRange(starts[line], starts[line]));
    this.show();
    const lead = area.parentElement?.querySelector<HTMLElement>(':scope > .edit-marks > .now');
    if (lead) bring(lead, area, this.#p.dock.getBoundingClientRect().top);
  }

  /**
   * Ctrl+Z in the empty box: what it last did taken back (Ctrl+Shift+Z, Ctrl+Y: put back), written into the file as
   * typing is, so the file's own Undo has it too. One whose words have been written over since is left as it is.
   */
  undo(redo = false) {
    const from = redo ? this.#undone : this.#done, to = redo ? this.#done : this.#undone;
    // One whose file has gone (its page read again) is passed over.
    let step = from.pop();
    while (step && !step.area.isConnected) step = from.pop();
    if (!step) { this.#p.say(redo ? t('Nothing to do again') : t('Nothing to undo')); return; }
    const {area, from: at} = step, now = redo ? step.removed : step.inserted, back = redo ? step.inserted : step.removed;
    if (area.value.slice(at, at + now.length) !== now) { from.length = 0; this.#p.say(t('Written over since: undo it in the file')); return; }
    to.push(step);
    this.#last = area;
    this.#write(area, at, at + now.length, back, redo ? at + back.length : step.caret);
    this.#flash(area, back ? [{from: at, to: at + back.length, kind: back.includes('\n') ? 'lines' : 'words'}] : []);
    this.show();
    this.#p.say(redo ? t('Done again') : t('Undone'));
  }

  /** `insert` written over `from`…`to` in `area` as typing is (so it saves), the caret at `caret`. */
  #write(area: HTMLTextAreaElement, from: number, to: number, insert: string, caret: number) {
    this.#with(area, () => {
      area.setSelectionRange(from, to);
      if (!document.execCommand('insertText', false, insert)) {
        area.setRangeText(insert, from, to, 'end');
        area.dispatchEvent(new Event('input', {bubbles: true}));
      }
      area.setSelectionRange(caret, caret);
    });
  }

  /** Escape in the empty box: the keyboard back in the file, at its caret; false with no file in front. */
  toFile(): boolean {
    const f = this.front();
    if (!f) return false;
    this.hide();
    f.area.focus({preventScroll: true});
    return true;
  }

  /** `path`, written after @ (or an issue, #3): shown in the center, the file in front from then on. */
  async #choose(path: string) {
    const repo = this.#p.repo();
    if (!repo) return;
    const asked = /^#(\d+)$/.exec(path);
    if (asked) {
      const file = (await store.tree(repo, 'issue').catch(() => [])).find((e) => e.kind === 'file' && numberOf(e.name) === Number(asked[1]));
      if (!file) { this.#p.say(t('No {path} in {repo}', {path, repo})); return; }
      return this.#open(repo, `issue/${file.name}`, path);
    }
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const there = await store.tree(repo, dir).then((es) => es.some((e) => e.kind === 'file' && (dir ? `${dir}/${e.name}` : e.name) === path), () => false);
    if (!there) { this.#p.say(t('No {path} in {repo}', {path, repo})); return; }
    this.#open(repo, path, path);
  }

  /** `path` of `repo` gone to in the center and, once its editor is there, the file in front; `shown` is what it is called. */
  #open(repo: string, path: string, shown: string) {
    this.#p.reveal(path);
    this.#keep('');
    this.#p.say(t('Editing {path}', {path: shown}));
    // Read in as it is gone to: in front once its editor is there.
    const mine = ++this.#pending;
    let frames = 0;
    const find = () => {
      if (mine !== this.#pending) return;
      const area = [...this.#p.main.querySelectorAll<HTMLTextAreaElement>(`.col[data-repo="${CSS.escape(repo)}"] section.file textarea.code-edit`)]
        .find((a) => a.closest<HTMLElement>('section.file')?.dataset.path === path && a.offsetParent);
      if (!area) { if (++frames < 120) requestAnimationFrame(find); return; }
      this.#last = area;
      // Chosen, never written in: its caret at its top (a value put in leaves it at the end).
      this.#placed.add(area);
      if (!this.#written.has(area)) area.setSelectionRange(0, 0);
      this.#p.moved();
      if (document.activeElement === this.#p.box) this.show();
    };
    requestAnimationFrame(find);
  }

  /** `f` done in `area` with the keyboard there a moment (as typing is, so its Undo has it), then back in the box. */
  #with(area: HTMLTextAreaElement, f: () => void) {
    this.busy = true;
    try {
      area.focus({preventScroll: true});
      f();
    } finally {
      this.#p.box.focus({preventScroll: true});
      this.busy = false;
    }
    this.#last = area;
    this.#written.add(area);
    this.#p.moved();
  }

  /** The box holding `text` after Enter (empty, or ready for the next of the same), the caret at its end. */
  #keep(text: string) {
    const box = this.#p.box;
    if (box.value === text) return;
    box.value = text;
    box.setSelectionRange(text.length, text.length);
    box.dispatchEvent(new Event('input', {bubbles: true}));
  }

  /** What was just done, lit a moment on the file, as a place landed on is. */
  #flash(area: HTMLTextAreaElement, lit: Mark[]) {
    if (!lit.length || still()) return;
    area.parentElement?.querySelector(':scope > .edit-flash')?.remove();
    drawMarks(area, lit, 'edit-flash');
    const layer = area.parentElement?.querySelector<HTMLElement>(':scope > .edit-flash');
    if (!layer) return;
    const gone = () => layer.remove();
    layer.animate([{opacity: 1}, {opacity: 1, offset: .35}, {opacity: 0}], {duration: paced(900), easing: 'ease-out'}).finished.then(gone, gone);
  }
}
