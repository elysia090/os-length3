import {lineEnd, lineOf, lineStarts} from '../../repos/edit.ts';
import {t} from '../../i18n.ts';
import {shownName} from '../../repos/issues.ts';
import {Writes} from './edit-apply.ts';
import {drawMarks, offsetAt, Ring} from './edit-marks.ts';
import {Holding} from './edit-taken.ts';

// The box at the center's foot as a line of the file in front (DESIGN.md § Forge, Edit), written as any line is:
// nothing to learn, no words that ask for things. The box holds the line the file's caret is on; a line of the file
// pressed while the box has the keyboard comes into it instead, the caret where it was pressed, and words marked on a
// line (the pointer drawn across them) come in with it, chosen in the box, to be written over. Where the box's caret
// is, it is in the file too. What is typed is in the file as it is
// typed, saved as typing in the file is; the keys are a text's own (edit-taken.ts): Enter breaks the line, Backspace
// and Delete join lines, ↑ ↓ go along them, Ctrl+Z takes back what the box wrote. Escape gives the keyboard back to
// the file, at the same place. The file in front is the one last written in (or pressed), else the one read; the pill
// says which, and the line.

/** The editor of one of `repo`'s files that `el` is in (its sheet, its line numbers), if any. */
function areaOf(el: EventTarget | null, repo: string | null): HTMLTextAreaElement | null {
  const sheet = el instanceof Element ? el.closest('section.file .sheet') : null;
  const area = sheet?.querySelector<HTMLTextAreaElement>(':scope > textarea.code-edit');
  return area && area.closest<HTMLElement>('.col')?.dataset.repo === repo ? area : null;
}

/** The first of `repo`'s editors whose foot is in view in the center (`main`): the one read. */
function readIn(main: HTMLElement, repo: string): HTMLTextAreaElement | null {
  const sel = `.col[data-repo="${CSS.escape(repo)}"]`;
  const flow = main.querySelector<HTMLElement>(`${sel}.active .flow`) ?? main.querySelector<HTMLElement>(`${sel}:not([hidden]) .flow`);
  const top = (flow?.getBoundingClientRect().top ?? 0) + 8;
  for (const a of flow?.querySelectorAll<HTMLTextAreaElement>('section.file textarea.code-edit') ?? []) {
    if (a.offsetParent && a.getBoundingClientRect().bottom > top) return a;
  }
  return null;
}

/** The caret of `area` at the line read (a third down the center), not at its top. */
function caretAtRead(area: HTMLTextAreaElement) {
  const flow = area.closest<HTMLElement>('.flow'), lh = parseFloat(getComputedStyle(area).lineHeight) || 20;
  const third = flow ? flow.getBoundingClientRect().top + flow.clientHeight / 3 : 0;
  const starts = lineStarts(area.value);
  const line = Math.min(starts.length - 1, Math.max(0, Math.floor((third - area.getBoundingClientRect().top) / lh)));
  area.setSelectionRange(starts[line], starts[line]);
}

/** Whether `event` is the key itself, nothing held with it but Shift where it says. */
const bare = (event: KeyboardEvent, shift = false) => !event.ctrlKey && !event.metaKey && !event.altKey && (shift || !event.shiftKey);

/** The file Edit works on: its path, and the editor it is written in. */
interface Front { path: string; area: HTMLTextAreaElement }

/** What Edit is given by the box it is part of (box.ts). */
export interface EditParts {
  box: HTMLTextAreaElement;
  /** The page's content, where the repo's files are read (Forge's boxes, `.col[data-repo]`). */
  main: HTMLElement;
  /** The dock the box stands in, which what is lit on the file is kept clear of. */
  dock: HTMLElement;
  repo(): string | null;
  /** Said under the box. */
  say(text: string | Node[]): void;
  /** The file in front, or the line held in it, changed: the pill says it again. */
  moved(): void;
  /** Whether the box edits and has the keyboard: a line pressed then comes into it. */
  active(): boolean;
}

/** The box's Edit: a line of the file in front, held in the box and written there as in the file. */
export class EditLine {
  readonly #p: EditParts;
  /** The editor last written in (or pressed): the file in front while it is there. */
  #last: HTMLTextAreaElement | null = null;
  /** Editors whose caret was put by a person (or here): the others start at the line read, not at the file's top. */
  readonly #placed = new WeakSet<HTMLTextAreaElement>();
  /** The editor whose marks are out now. */
  #shownOn: HTMLTextAreaElement | null = null;
  /** What the box writes into the file, and what it wrote, to take back. */
  readonly #writes: Writes;
  /** The line the box holds. */
  readonly #holding: Holding;
  /** The line pointed at, ringed. */
  readonly #ring = new Ring();

  constructor(p: EditParts) {
    this.#p = p;
    this.#writes = new Writes((area) => { this.#last = area; p.moved(); });
    this.#holding = new Holding(p, this.#writes, (area) => {
      if (this.#shownOn && this.#shownOn !== area) this.#off();
      this.#shownOn = area;
      this.#last = area;
      this.#placed.add(area);
    });
    this.#pointing();
    this.#following();
    this.#minding();
  }

  /** The box's caret moved, or what it has chosen (a key, the pointer, the keyboard come or gone): so in the file. */
  #minding() {
    const box = this.#p.box;
    let minding = 0;
    const again = () => {
      cancelAnimationFrame(minding);
      minding = requestAnimationFrame(() => { if (this.#shownOn) this.#holding.show(); });
    };
    for (const e of ['keydown', 'pointerdown', 'pointerup', 'select', 'selectionchange', 'focus', 'blur']) box.addEventListener(e, again);
    box.addEventListener('pointermove', (event) => { if (event.buttons) again(); });
  }

  /**
   * Pressed while the box has the keyboard, a line of the repo's files comes into it (not the keyboard into the
   * file), the caret where it was pressed; drawn across, the line comes in with the words marked chosen. Pointed at
   * meanwhile, the line is ringed.
   */
  #pointing() {
    const p = this.#p;
    p.main.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !p.active()) return;
      const area = areaOf(event.target, p.repo());
      if (!area) return;
      event.preventDefault();
      event.stopPropagation();
      this.#press(area, event);
    }, true);
    let pointing = 0;
    p.main.addEventListener('pointermove', (event) => {
      cancelAnimationFrame(pointing);
      pointing = requestAnimationFrame(() => {
        const area = p.active() ? areaOf(document.elementFromPoint(event.clientX, event.clientY), p.repo()) : null;
        this.#ring.over(area, event.clientY);
      });
    });
    p.main.addEventListener('pointerleave', () => { cancelAnimationFrame(pointing); this.#ring.on(null, 0); });
  }

  /** A press on `area`: let go where it was pressed, its line held; drawn across first, the words marked chosen in it. */
  #press(area: HTMLTextAreaElement, down: PointerEvent) {
    const start = offsetAt(area, down.clientX, down.clientY), starts = lineStarts(area.value);
    const lineFrom = starts[start.line], lineTo = lineEnd(area.value, starts, start.line);
    let end = start.at, drawing = false;
    const move = (e: PointerEvent) => {
      if (!drawing && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
      drawing = true;
      // Marked along its own line only: what comes into the box is one line.
      end = Math.min(lineTo, Math.max(lineFrom, offsetAt(area, e.clientX, e.clientY).at));
      drawMarks(area, [{from: lineFrom, to: lineTo, kind: 'held', now: true}, {from: Math.min(start.at, end), to: Math.max(start.at, end), kind: 'words'}]);
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
      const at = drawing ? end : start.at;
      this.#holding.line(area, start.line, Math.min(start.at, at) - lineFrom, Math.max(start.at, at) - lineFrom);
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
  }

  /** The file written in is the one in front, and its caret's line the one the box holds when it comes back. */
  #following() {
    const p = this.#p;
    p.main.addEventListener('focusin', (event) => {
      const el = event.target;
      if (!(el instanceof HTMLTextAreaElement) || !el.classList.contains('code-edit')) return;
      this.#last = el;
      this.#placed.add(el);
      this.#holding.letGo();
      p.moved();
    });
    let moving = 0;
    const moved = () => { cancelAnimationFrame(moving); moving = requestAnimationFrame(() => p.moved()); };
    for (const e of ['keyup', 'pointerup', 'input']) {
      p.main.addEventListener(e, (event) => { if ((event.target as Element).classList?.contains('code-edit')) moved(); }, true);
    }
    // A long line scrolled along in the editor: its marks go with it.
    p.main.addEventListener('scroll', (event) => { if (event.target === this.#shownOn) this.#holding.show(); }, true);
  }

  /** The file in front: the one last written in while it is shown in the repo's box, else the one read there. */
  #front(): Front | null {
    const repo = this.#p.repo();
    if (!repo) return null;
    const ok = (a: HTMLTextAreaElement | null) => !!a?.isConnected && !!a.offsetParent && a.closest<HTMLElement>('.col')?.dataset.repo === repo;
    const area = ok(this.#last) ? this.#last : readIn(this.#p.main, repo);
    const path = area?.closest<HTMLElement>('section.file')?.dataset.path;
    if (!area || !path) return null;
    // Never written in: its caret starts at the line read (a third down the center), not at its top.
    if (!this.#placed.has(area)) {
      this.#placed.add(area);
      caretAtRead(area);
    }
    return {path, area};
  }

  /** The pill's words: the file in front and the caret's line in it. */
  where(): {file: string; line: number} | null {
    const f = this.#front();
    if (!f) return null;
    // Counted, not split: it is asked at every key in the file.
    const text = f.area.value, caret = f.area.selectionStart;
    let line = 1;
    for (let i = text.indexOf('\n'); i >= 0 && i < caret; i = text.indexOf('\n', i + 1)) line++;
    return {file: shownName(f.path), line};
  }

  /**
   * The box come to (or Edit chosen): it holds what it held, if the file still has it, else the line the file's caret
   * is on (words chosen in the file on it: those chosen in the box), lit where it is.
   */
  show() {
    const f = this.#front();
    this.#mark(f);
    this.#p.main.classList.add('edit-pointing');
    if (!f) { this.#off(); this.#holding.letGo(); this.#p.say(this.#p.repo() ? t('Open a file to edit it here') : ''); return; }
    this.#p.say('');
    const held = this.#holding.still();
    if (held?.area === f.area) { this.#holding.show(); return; }
    const area = f.area, a = area.selectionStart, b = area.selectionEnd, starts = lineStarts(area.value), line = lineOf(starts, a);
    this.#holding.line(area, line, a - starts[line], b <= lineEnd(area.value, starts, line) ? b - starts[line] : a - starts[line]);
  }

  /** Typed in the box: written into the file as it is typed (nothing held any more: held anew, from the file). */
  typed() {
    if (!this.#holding.typed()) this.show();
  }

  /** A key in the box: true when it was the box's to do (and done), as a text's own keys are. */
  key(event: KeyboardEvent): boolean {
    const h = this.#holding;
    const done = (() => {
      const k = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (k === 'z' || k === 'y')) {
        const why = h.undo(k === 'y' || event.shiftKey);
        if (why) this.#p.say(why);
        return true;
      }
      if (event.key === 'Enter' && bare(event)) return h.split();
      if (event.key === 'Backspace' && bare(event)) return h.joinUp();
      if (event.key === 'Delete' && bare(event)) return h.joinDown();
      if (event.key === 'ArrowUp' && bare(event)) return h.step(-1);
      if (event.key === 'ArrowDown' && bare(event)) return h.step(1);
      if (event.key === 'ArrowLeft' && bare(event)) return h.round(-1);
      if (event.key === 'ArrowRight' && bare(event)) return h.round(1);
      if (event.key === 'Tab' && bare(event, true)) return h.indent(event.shiftKey ? -1 : 1);
      return false;
    })();
    if (done) event.preventDefault();
    return done;
  }

  /** The marks put away (the box left, or doing something else); what is held is held again on coming back. */
  hide() {
    this.#off();
    this.#mark(null);
    this.#ring.on(null, 0);
    this.#p.main.classList.remove('edit-pointing');
  }

  /** Nothing held: the box doing something else now (what it held is in the file already). */
  letGo() { this.#holding.letGo(); }

  /** Escape: the keyboard back in the file, where the box was in it; false with no file in front. */
  toFile(): boolean {
    const held = this.#holding.still(), f = this.#front();
    const area = held?.area ?? f?.area;
    if (!area) return false;
    const caret = held ? held.from + this.#p.box.selectionStart : area.selectionStart;
    this.hide();
    this.#holding.letGo();
    area.focus({preventScroll: true});
    area.setSelectionRange(caret, caret);
    return true;
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
}
