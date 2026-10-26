import {indentOf, leading, lineEnd, lineOf, lineStarts} from '../../repos/edit.ts';
import {keep, type Writes} from './edit-apply.ts';
import {bringLead, drawMarks} from './edit-marks.ts';
import type {EditParts} from './edit-box.ts';

// What the box holds of the file in front (edit-box.ts): a line of it (the caret's, or one pressed) or words marked on
// a line, the box and the file one text: what is typed in the box is in the file as it is typed. Lit where it is.
// Enter breaks the line where the caret is, and the box goes on to the new one, which keeps the indent; Backspace at
// the start joins the line to the one above, Delete at the end the one below to it; ↑ and ↓ go to the line above or
// below, ← at the start and → at the end round onto them; Shift+Tab takes the line out by the file's own indent.

/** What the box holds: where it is in `area`, and its words as the file and the box last had them alike. */
interface Held { area: HTMLTextAreaElement; from: number; to: number; text: string; whole: boolean }

/** The part of the file the box holds, written in as the box is. */
export class Holding {
  #held: Held | null = null;
  readonly #p: EditParts;
  readonly #writes: Writes;
  readonly #took: (area: HTMLTextAreaElement) => void;

  /** `took` hears the editor a part is held from, which is the one in front from then on. */
  constructor(p: EditParts, writes: Writes, took: (area: HTMLTextAreaElement) => void) {
    this.#p = p;
    this.#writes = writes;
    this.#took = took;
  }

  /** What is held, while the file still has it as it was last written (else it is let go). */
  still(): Held | null {
    const k = this.#held;
    if (k && !(k.area.isConnected && k.area.value.slice(k.from, k.to) === k.text)) this.#held = null;
    return this.#held;
  }

  /** Let go: nothing held (the box is doing something else, or another file is in front). */
  letGo() { this.#held = null; }

  /** Line `line` of `area` held, the caret at `column` (as near as the line has it). */
  line(area: HTMLTextAreaElement, line: number, column: number) {
    const text = area.value, starts = lineStarts(text), at = Math.min(Math.max(0, line), starts.length - 1);
    const from = starts[at], to = lineEnd(text, starts, at), c = Math.min(Math.max(0, column), to - from);
    this.#hold({area, from, to, text: text.slice(from, to), whole: true}, c, c);
  }

  /** Words `from`…`to` of `area` (on one line) held, all chosen in the box, so what is typed writes over them. */
  words(area: HTMLTextAreaElement, from: number, to: number) {
    this.#hold({area, from, to, text: area.value.slice(from, to), whole: false}, 0, to - from);
  }

  #hold(k: Held, from: number, to: number) {
    this.#held = k;
    this.#took(k.area);
    // The file's caret goes with the box's: the pill says its line.
    k.area.setSelectionRange(k.from + from, k.from + from);
    keep(this.#p.box, k.text, from, to);
    this.show();
    this.#p.moved();
  }

  /** What the box has now written into the file over what it held, as it is typed; false with nothing held. */
  typed(): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k) return false;
    if (box.value === k.text) return true;
    const caret = k.from + box.selectionStart;
    this.#writes.apply(k.area, k.from, k.to, box.value, caret);
    k.to = k.from + box.value.length;
    k.text = box.value;
    // Lines pasted in: the box goes on to the line the caret is on now.
    if (box.value.includes('\n')) { this.#at(k.area, caret); return true; }
    this.show();
    this.#p.moved();
    return true;
  }

  /** The line `offset` of `area` is on held, the caret there. */
  #at(area: HTMLTextAreaElement, offset: number) {
    const starts = lineStarts(area.value), line = lineOf(starts, offset);
    this.line(area, line, offset - starts[line]);
  }

  /**
   * Enter: the line broken where the caret is (what is chosen in the box goes), the box going on to the new line,
   * which starts with the indent the broken one had before the caret. Words held: the box goes on to their whole line.
   */
  split(): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k) return false;
    const a = box.selectionStart, b = box.selectionEnd;
    if (!k.whole) { this.#at(k.area, k.from + a); return true; }
    const indent = leading(box.value).slice(0, a);
    const insert = `${box.value.slice(0, a)}\n${indent}${box.value.slice(b)}`, next = k.from + a + 1;
    this.#writes.apply(k.area, k.from, k.to, insert, next + indent.length);
    this.#at(k.area, next + indent.length);
    this.#bring();
    return true;
  }

  /** Backspace at the start of a line: it joins the one above, the caret where they meet; false elsewhere. */
  joinUp(): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k?.whole || box.selectionEnd !== 0 || k.from === 0) return false;
    this.#writes.apply(k.area, k.from - 1, k.from, '', k.from - 1);
    this.#at(k.area, k.from - 1);
    this.#bring();
    return true;
  }

  /** Delete at the end of a line: the one below joins it, the caret where they meet; false elsewhere. */
  joinDown(): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k?.whole || box.selectionStart !== box.value.length || k.to >= k.area.value.length) return false;
    this.#writes.apply(k.area, k.to, k.to + 1, '', k.to);
    this.#at(k.area, k.to);
    return true;
  }

  /** ↑ or ↓: the line above or below held, at the same column as near as it has; false with nothing held. */
  step(by: 1 | -1): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k) return false;
    const starts = lineStarts(k.area.value), line = lineOf(starts, k.from) + by;
    if (line < 0 || line >= starts.length) return true;
    this.line(k.area, line, k.from - starts[line - by] + box.selectionStart);
    this.#bring();
    return true;
  }

  /** ← at the start of a line or → at its end: on round to the end of the line above, or the start of the one below. */
  round(by: 1 | -1): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k?.whole || box.selectionStart !== box.selectionEnd || box.selectionStart !== (by < 0 ? 0 : box.value.length)) return false;
    const starts = lineStarts(k.area.value), line = lineOf(starts, k.from) + by;
    if (line < 0 || line >= starts.length) return false;
    this.line(k.area, line, by < 0 ? Infinity : 0);
    this.#bring();
    return true;
  }

  /** Tab: the file's own indent typed at the caret; Shift+Tab: the line out by one. False with nothing held. */
  indent(by: 1 | -1): boolean {
    const k = this.still(), box = this.#p.box;
    if (!k) return false;
    const unit = indentOf(k.area.value);
    if (by > 0) { document.execCommand('insertText', false, unit); return true; }
    if (!k.whole) return true;
    const lead = leading(box.value), cut = lead.startsWith(unit) ? unit.length : Math.min(lead.length, lead.startsWith('\t') ? 1 : unit.length);
    if (!cut) return true;
    const a = Math.max(0, box.selectionStart - cut), b = Math.max(0, box.selectionEnd - cut);
    keep(box, box.value.slice(cut), a, b);
    return true;
  }

  /** What the box last wrote taken back (`redo`: put back), the box on the line it was on; a string says why not. */
  undo(redo: boolean): string | null {
    const done = this.#writes.undo(redo);
    if (typeof done === 'string') return done;
    this.#at(done.area, done.caret);
    this.#bring();
    return null;
  }

  /** What is held lit where it is; false with nothing held. */
  show(): boolean {
    const k = this.still();
    if (!k) return false;
    drawMarks(k.area, [{from: k.from, to: k.to, kind: k.whole ? 'lines' : 'words', now: true}]);
    return true;
  }

  /** What is held brought into view, clear of the box. */
  #bring() {
    const k = this.#held;
    if (k) bringLead(k.area, this.#p.dock.getBoundingClientRect().top);
  }
}
