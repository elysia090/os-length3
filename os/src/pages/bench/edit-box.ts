import {h} from '../../ui/dom.ts';
import {lineOf, lineStarts, parseEdit, plan, type Edit} from '../../repos/edit.ts';
import {t} from '../../i18n.ts';
import {store} from '../../repos/repos.ts';
import {numberOf, shownName} from '../../repos/issues.ts';
import type {Writing} from '../forge/reader.ts';
import {keep, Writes} from './edit-apply.ts';
import {bring, bringLead, drawMarks, flash, lineMark, offsetAt, Ring} from './edit-marks.ts';
import {TakenLine} from './edit-taken.ts';

// The box at the center's foot as a line that edits the file in front (DESIGN.md § Forge, Edit): nothing to be in and
// no keys to learn. The plainest is to point: while the box has the keyboard, a line of a file pressed comes into the
// box as it is, the caret where it was pressed, to be written anew there; Enter writes it back, Escape leaves it as it
// was, ↑ and ↓ (nothing changed yet) take the line above or below (edit-taken.ts). Pointed at, a line is ringed to say so.
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
// rule: edit-marks.ts) and said under the box; nothing is done before Enter. It is written into the file as typing is
// (Reader's editor: it saves, and its Undo takes it back: edit-apply.ts), so nothing here keeps a file of its own.

/** What can be done from the empty box, each with what it does: said under it, as Tab's choices are. Pointing first. */
function legend(): Node[] {
  const each: [string, string][] = [[t('Click a line'), t('rewrite it here')], ['12', t('to the line')], ['word', t('find')], ['a → b', t('b for every a')],
    ['+', t('a line under')], ['-', t('take it away')], ['@', t('another file')]];
  return each.map(([k, w]) => h('span', {class: 'edit-key'}, h('code', {}, k), w));
}

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

/** The file Edit works on: its path, and the editor it is written in. */
interface Front { path: string; area: HTMLTextAreaElement }

/** What Edit is given by the box it is part of (box.ts). */
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
  #pending = 0;
  /** What the box writes into the file, and what it did, to take back. */
  readonly #writes: Writes;
  /** The line taken into the box, being written anew there. */
  readonly #taken: TakenLine;
  /** The line pointed at, ringed. */
  readonly #ring = new Ring();

  constructor(p: EditParts) {
    this.#p = p;
    this.#writes = new Writes(p.box, (area) => { this.#last = area; this.#written.add(area); p.moved(); });
    this.#taken = new TakenLine(p, this.#writes, (area) => { this.#last = area; this.#placed.add(area); this.#written.add(area); });
    this.#pointing();
    this.#following();
  }

  /** The keyboard going to the file and back for an edit: the box losing it then is not leaving it. */
  get busy(): boolean { return this.#writes.busy; }

  /**
   * Pressed while the box has the keyboard, a line of the repo's files comes into it (not the keyboard into the
   * file); its numbers pressed, the same, the caret at its end. Pointed at meanwhile, the line is ringed.
   */
  #pointing() {
    const p = this.#p;
    p.main.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !p.active()) return;
      const area = areaOf(event.target, p.repo());
      if (!area) return;
      event.preventDefault();
      event.stopPropagation();
      const {line, at} = offsetAt(area, event.clientX, event.clientY);
      this.#taken.take(area, line, at - lineStarts(area.value)[line]);
    }, true);
    let pointing = 0;
    p.main.addEventListener('pointermove', (event) => {
      cancelAnimationFrame(pointing);
      pointing = requestAnimationFrame(() => {
        const area = p.active() ? areaOf(document.elementFromPoint(event.clientX, event.clientY), p.repo()) : null;
        this.#ring.on(area, area ? offsetAt(area, event.clientX, event.clientY).line : 0);
      });
    });
    p.main.addEventListener('pointerleave', () => { cancelAnimationFrame(pointing); this.#ring.on(null, 0); });
  }

  /** The file written in is the one in front; its caret moving moves the line the pill says. */
  #following() {
    const p = this.#p;
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
    if (this.#taken.show()) return;
    if (e.kind === 'none' || e.kind === 'file') { this.#showCaret(area, e, typed); return; }
    const p = plan(e, area.value, area.selectionStart, back, typed, area.selectionEnd);
    const lead = drawMarks(area, p.marks);
    if (lead) bring(lead, area, this.#p.dock.getBoundingClientRect().top);
    this.#p.say(p.said);
  }

  /** Nothing asked of the file (an empty box, @path): the caret's line, softly, where + = - > would act. */
  #showCaret(area: HTMLTextAreaElement, e: Edit, typed: string) {
    const starts = lineStarts(area.value);
    drawMarks(area, lineMark(starts, lineOf(starts, area.selectionStart)));
    this.#p.say(e.kind === 'file' ? t('Enter: edit {path}', {path: e.path}) : typed.startsWith('@') ? t('A file of {repo}: Tab completes it', {repo: this.#p.repo()!})
      : typed ? '' : legend());
  }

  /** The marks put away (the box left, or doing something else); a line taken stays taken, to be shown on coming back. */
  hide() {
    this.#off();
    this.#mark(null);
    this.#ring.on(null, 0);
    this.#p.main.classList.remove('edit-pointing');
  }

  /** Whether a line is taken into the box. */
  get taken(): boolean { return !!this.#taken.still(); }

  /** Escape with a line taken: it is let go as it was, the box emptied; false with none taken. */
  cancel(): boolean { return this.#taken.cancel(); }

  /** ↑ or ↓ with a line taken and nothing written in it yet: the one above or below taken instead; false otherwise. */
  stepTaken(by: 1 | -1): boolean { return this.#taken.step(by); }

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
    if (this.#taken.any) {
      const said = this.#taken.putBack();
      keep(this.#p.box, '');
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
      this.#writes.with(area, () => area.setSelectionRange(go.from, go.to));
      keep(this.#p.box, go.keep);
      if (e.kind === 'go') flash(area, [{...p.marks[0], now: false}]);
      // Shown again from where it went: a word found is where one is now, said as such.
      this.show();
      return true;
    }
    if (!p.done) { this.#p.say(p.said); return false; }
    const d = p.done;
    this.#writes.apply(area, d.from, d.to, d.insert, d.caret, area.selectionStart);
    keep(this.#p.box, d.again ?? '');
    flash(area, d.lit);
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
    this.#writes.with(area, () => area.setSelectionRange(starts[line], starts[line]));
    this.show();
    bringLead(area, this.#p.dock.getBoundingClientRect().top);
  }

  /**
   * Ctrl+Z in the empty box: what it last did taken back (Ctrl+Shift+Z, Ctrl+Y: put back), written into the file as
   * typing is, so the file's own Undo has it too. One whose words have been written over since is left as it is.
   */
  undo(redo = false) {
    const done = this.#writes.undo(redo);
    if (typeof done === 'string') { this.#p.say(done); return; }
    flash(done.area, done.lit);
    this.show();
    this.#p.say(redo ? t('Done again') : t('Undone'));
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
    keep(this.#p.box, '');
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
}
