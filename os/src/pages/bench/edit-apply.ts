import {t} from '../../i18n.ts';

// What the box's Edit writes into the file in front (edit-box.ts) is written into it as typing in it would be: the
// editor hears it as typed and saves it a moment after the typing stops. The keyboard stays in the box: were it taken
// into the file and back at every key, the file would be left at every key, and a file left is saved at once (one
// save on another's heels, each taken for the other's). What the box wrote is kept, to take back one at a time (Ctrl+Z
// in the box) and to put back; all that is typed on one line while the box holds it is one thing to take back, as a
// line written anew is.

/** A write the box did: `inserted` written at `from` over `removed`, the caret at `caret` before it. */
interface Step { area: HTMLTextAreaElement; from: number; removed: string; inserted: string; caret: number }
/** Steps kept to take back. */
const STEPS = 100;

/** The box holding `text`, `from`…`to` of it chosen (the caret at its end, by default); its height follows. */
export function keep(box: HTMLTextAreaElement, text: string, from = text.length, to = from) {
  if (box.value !== text) box.value = text;
  box.setSelectionRange(from, to);
  box.dispatchEvent(new Event('input', {bubbles: true}));
}

/** What the box writes into the file, and what it wrote, to take back and put back. */
export class Writes {
  /**
   * What the box wrote, to take back one at a time and put back: its own, not the browser's, which holds what was
   * typed in the box too, line after line.
   */
  readonly #done: Step[] = [];
  readonly #undone: Step[] = [];
  readonly #wrote: (area: HTMLTextAreaElement) => void;

  /** `wrote` hears each editor written in, which is the one in front from then on. */
  constructor(wrote: (area: HTMLTextAreaElement) => void) {
    this.#wrote = wrote;
  }

  /** `insert` written over `from`…`to` in `area` as typing it would be (heard as typed: it saves), the caret at `caret`. */
  #write(area: HTMLTextAreaElement, from: number, to: number, insert: string, caret: number) {
    area.setRangeText(insert, from, to, 'end');
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: insert}));
    this.#wrote(area);
  }

  /**
   * As `#write`, kept to take back. Written over what the last one wrote (the same line, typed on), it is the same
   * step, which takes the line back to what it was before any of it.
   */
  apply(area: HTMLTextAreaElement, from: number, to: number, insert: string, caret: number) {
    const last = this.#done.at(-1);
    if (last && last.area === area && last.from === from && from + last.inserted.length === to && !insert.includes('\n') && !last.inserted.includes('\n')) {
      last.inserted = insert;
    } else {
      this.#done.push({area, from, removed: area.value.slice(from, to), inserted: insert, caret: area.selectionStart});
      if (this.#done.length > STEPS) this.#done.shift();
    }
    this.#undone.length = 0;
    this.#write(area, from, to, insert, caret);
  }

  /**
   * What the box last wrote taken back (`redo`: put back), written into the file as typing is, so the file's own Undo
   * has it too. One whose words have been written over since is left as it is. Returns where the caret is now, or why
   * nothing was done.
   */
  undo(redo: boolean): {area: HTMLTextAreaElement; caret: number} | string {
    const from = redo ? this.#undone : this.#done, to = redo ? this.#done : this.#undone;
    // One whose file has gone (its page read again) is passed over.
    let step = from.pop();
    while (step && !step.area.isConnected) step = from.pop();
    if (!step) return redo ? t('Nothing to do again') : t('Nothing to undo');
    const {area, from: at} = step, now = redo ? step.removed : step.inserted, back = redo ? step.inserted : step.removed;
    if (area.value.slice(at, at + now.length) !== now) { from.length = 0; return t('Written over since: undo it in the file'); }
    to.push(step);
    const caret = redo ? at + back.length : step.caret;
    this.#write(area, at, at + now.length, back, caret);
    return {area, caret};
  }
}
