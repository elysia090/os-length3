import {t} from '../../i18n.ts';
import {lineOf, lineStarts} from '../../repos/edit.ts';
import {keep, type Writes} from './edit-apply.ts';
import {bringLead, drawMarks, flash} from './edit-marks.ts';
import type {EditParts} from './edit-box.ts';

// A line of the file in front taken into the box to be written anew there (pressed while the box edits and has the
// keyboard, edit-box.ts): lit where it is, Enter writes it back, Escape leaves it as it was, and ↑ and ↓ (nothing
// changed yet) take the line above or below. Another pressed, one written anew is written back first, as a sheet's
// cell is left.

/** A line taken into the box to be written anew: where it is in `area`, and its words as they were. */
interface Taken { area: HTMLTextAreaElement; from: number; to: number; text: string }

/** The line taken into the box, being written anew there. */
export class TakenLine {
  #taken: Taken | null = null;
  readonly #p: EditParts;
  readonly #writes: Writes;
  readonly #took: (area: HTMLTextAreaElement) => void;

  /** `took` hears the editor a line is taken from, which is the one in front from then on. */
  constructor(p: EditParts, writes: Writes, took: (area: HTMLTextAreaElement) => void) {
    this.#p = p;
    this.#writes = writes;
    this.#took = took;
  }

  /** Whether a line was taken (whether or not it is still as it was). */
  get any(): boolean { return !!this.#taken; }

  /** The line taken, while it is as it was where it was (else it is let go). */
  still(): Taken | null {
    const k = this.#taken;
    if (k && !(k.area.isConnected && k.area.value.slice(k.from, k.to) === k.text && (k.to === k.area.value.length || k.area.value[k.to] === '\n'))) {
      this.#taken = null;
      return null;
    }
    return k;
  }

  /** Line `line` of `area` taken into the box, the caret at `column`; one taken and written anew is written back first. */
  take(area: HTMLTextAreaElement, line: number, column: number) {
    const box = this.#p.box;
    if (this.still() && box.value !== this.#taken!.text) void this.putBack();
    const starts = lineStarts(area.value), at = Math.min(Math.max(0, line), starts.length - 1);
    const from = starts[at], to = at + 1 < starts.length ? starts[at + 1] - 1 : area.value.length, text = area.value.slice(from, to);
    this.#taken = {area, from, to, text};
    this.#took(area);
    // The caret's line is the one taken: the pill says it.
    area.setSelectionRange(from, from);
    const c = Math.min(Math.max(0, column), text.length);
    box.value = text;
    box.setSelectionRange(c, c);
    box.dispatchEvent(new Event('input', {bubbles: true}));
    this.#p.moved();
  }

  /**
   * The line taken lit where it is, whatever is written (its new words, not a line that asks), and said; false with
   * none taken.
   */
  show(): boolean {
    const k = this.still();
    if (!k) return false;
    const line = lineOf(lineStarts(k.area.value), k.from);
    drawMarks(k.area, [{from: k.from, to: k.to, kind: 'lines', now: true}]);
    this.#p.say(this.#p.box.value === k.text ? t('Line {n}: write it anew here, Escape leaves it as it is', {n: line + 1})
      : t('Line {n}: Enter writes it, Escape leaves it as it was', {n: line + 1}));
    return true;
  }

  /** The line taken written back as the box has it (nothing, if it is as it was): what is to be said of it. */
  putBack(): string {
    const k = this.still(), words = this.#p.box.value;
    this.#taken = null;
    if (!k) return t('Written over since: undo it in the file');
    const line = lineOf(lineStarts(k.area.value), k.from);
    if (words === k.text) return t('Line {n} as it was', {n: line + 1});
    this.#writes.apply(k.area, k.from, k.to, words, k.from + words.length, k.from);
    flash(k.area, [{from: k.from, to: k.from + words.length, kind: 'lines'}]);
    return t('Line {n} written', {n: line + 1});
  }

  /** Escape with a line taken: it is let go as it was, the box emptied; false with none taken. */
  cancel(): boolean {
    if (!this.#taken) return false;
    this.#taken = null;
    keep(this.#p.box, '');
    return true;
  }

  /** ↑ or ↓ with a line taken and nothing written in it yet: the one above or below taken instead; false otherwise. */
  step(by: 1 | -1): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k || box.value !== k.text) return false;
    const line = lineOf(lineStarts(k.area.value), k.from) + by;
    if (line < 0 || line >= lineStarts(k.area.value).length) return true;
    this.take(k.area, line, box.selectionStart);
    bringLead(k.area, this.#p.dock.getBoundingClientRect().top);
    return true;
  }
}
