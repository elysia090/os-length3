import {t} from '../../i18n.ts';
import type {Mark} from '../../repos/edit.ts';

// What the box's Edit does to the file in front (edit-box.ts) is written into it as typing is (Reader's editor: it
// saves, and its Undo takes it back), the keyboard there a moment and then back in the box; and what the box did is
// kept, to take back one at a time (Ctrl+Z in the empty box) and to put back.

/** An edit the box did: `inserted` written at `from` over `removed`, the caret at `caret` before it. */
interface Step { area: HTMLTextAreaElement; from: number; removed: string; inserted: string; caret: number }
/** Steps kept to take back. */
const STEPS = 100;

/** The box holding `text` after Enter (empty, or ready for the next of the same), the caret at its end. */
export function keep(box: HTMLTextAreaElement, text: string) {
  if (box.value === text) return;
  box.value = text;
  box.setSelectionRange(text.length, text.length);
  box.dispatchEvent(new Event('input', {bubbles: true}));
}

/** What the box writes into the file, and what it did, to take back and put back. */
export class Writes {
  /** The keyboard going to the file and back for an edit: the box losing it then is not leaving it. */
  busy = false;
  /**
   * What the box did, to take back one at a time (Ctrl+Z in the empty box) and put back (Ctrl+Shift+Z): its own,
   * not the browser's, which holds what was typed in the box too, in the same line.
   */
  readonly #done: Step[] = [];
  readonly #undone: Step[] = [];
  readonly #box: HTMLTextAreaElement;
  readonly #wrote: (area: HTMLTextAreaElement) => void;

  /** Writes from `box`; `wrote` hears each editor written in, which is the one in front from then on. */
  constructor(box: HTMLTextAreaElement, wrote: (area: HTMLTextAreaElement) => void) {
    this.#box = box;
    this.#wrote = wrote;
  }

  /** `f` done in `area` with the keyboard there a moment (as typing is, so its Undo has it), then back in the box. */
  with(area: HTMLTextAreaElement, f: () => void) {
    this.busy = true;
    try {
      area.focus({preventScroll: true});
      f();
    } finally {
      this.#box.focus({preventScroll: true});
      this.busy = false;
    }
    this.#wrote(area);
  }

  /** `insert` written over `from`…`to` in `area` as typing is (so it saves), the caret at `caret`. */
  #write(area: HTMLTextAreaElement, from: number, to: number, insert: string, caret: number) {
    this.with(area, () => {
      area.setSelectionRange(from, to);
      if (!document.execCommand('insertText', false, insert)) {
        area.setRangeText(insert, from, to, 'end');
        area.dispatchEvent(new Event('input', {bubbles: true}));
      }
      area.setSelectionRange(caret, caret);
    });
  }

  /** As `write`, done by the box and kept to take back: its caret was at `was` before. */
  apply(area: HTMLTextAreaElement, from: number, to: number, insert: string, caret: number, was: number) {
    this.#done.push({area, from, removed: area.value.slice(from, to), inserted: insert, caret: was});
    if (this.#done.length > STEPS) this.#done.shift();
    this.#undone.length = 0;
    this.#write(area, from, to, insert, caret);
  }

  /**
   * What the box last did taken back (`redo`: put back), written into the file as typing is, so the file's own Undo
   * has it too. One whose words have been written over since is left as it is. Returns what to light on the file, or
   * why nothing was done.
   */
  undo(redo: boolean): {area: HTMLTextAreaElement; lit: Mark[]} | string {
    const from = redo ? this.#undone : this.#done, to = redo ? this.#done : this.#undone;
    // One whose file has gone (its page read again) is passed over.
    let step = from.pop();
    while (step && !step.area.isConnected) step = from.pop();
    if (!step) return redo ? t('Nothing to do again') : t('Nothing to undo');
    const {area, from: at} = step, now = redo ? step.removed : step.inserted, back = redo ? step.inserted : step.removed;
    if (area.value.slice(at, at + now.length) !== now) { from.length = 0; return t('Written over since: undo it in the file'); }
    to.push(step);
    this.#write(area, at, at + now.length, back, redo ? at + back.length : step.caret);
    return {area, lit: back ? [{from: at, to: at + back.length, kind: back.includes('\n') ? 'lines' : 'words'}] : []};
  }
}
