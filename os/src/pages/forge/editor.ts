import {differs, Held} from '../../repos/conflict.ts';
import {bytes, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {lineCount} from '../../repos/reading.ts';
import {EDIT_LIMIT, store} from '../../repos/repos.ts';
import {answers} from '../common.ts';
import {keepOut, putAway} from '../../ui/glide.ts';
import {diffFiles} from './diff-view.ts';
import {shownPath} from '../../repos/issues.ts';
import {errorText} from '../../app/errors.ts';

// A file in Forge's center is a plain text editor in its own box (reader.ts reads the page they make). Typing saves
// on its own, on leaving the file, or with Ctrl+S. A text saved elsewhere while this one has unsaved edits is asked
// in the file's box: take the other, or save yours over it, with what differs to be seen. A text grown past what
// Forge edits (EDIT_LIMIT) is not saved on its own: the box says so and offers to save it whole, which makes it a
// file Forge reads only in part; made smaller again, it saves as before.

/** Where a text and its selection were, before and after the last indent in an editor. */
interface Spot { text: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' }
const indents = new WeakMap<HTMLTextAreaElement, {before: Spot; after: Spot}>();

/**
 * Write `text` over `from`…`to` as typing does, so Undo takes it back: the
 * browser's own command, or (where it has none) the range replaced by hand.
 */
function typeOver(area: HTMLTextAreaElement, from: number, to: number, text: string) {
  area.setSelectionRange(from, to);
  if (document.execCommand('insertText', false, text)) return;
  area.setRangeText(text, from, to, 'end');
  area.dispatchEvent(new Event('input'));
}

/**
 * Tab in a file. With nothing selected it types a tab. With a selection, each
 * line it touches is moved in by one tab (an empty line stays empty; a
 * selection ending at a line's start leaves that line), the same text stays
 * selected, and one Undo takes it all back, the selection too.
 */
function indent(area: HTMLTextAreaElement) {
  const {value, selectionStart: a, selectionEnd: b} = area;
  const direction = area.selectionDirection;
  if (a === b) { typeOver(area, a, b, '\t'); return; }
  const from = value.lastIndexOf('\n', a - 1) + 1;
  const last = value[b - 1] === '\n' ? b - 1 : b;
  const end = value.indexOf('\n', last);
  const to = end < 0 ? value.length : end;
  const lines = value.slice(from, to).split('\n');
  if (lines.every((l) => !l)) return;
  // Where each tab goes, to move the selection with the text.
  const at: number[] = [];
  let k = from;
  for (const l of lines) { if (l) at.push(k); k += l.length + 1; }
  const start = a + at.filter((p) => p < a).length;
  const stop = b + at.filter((p) => p < b).length;
  const before = {text: value, start: a, end: b, direction};
  typeOver(area, from, to, lines.map((l) => (l ? `\t${l}` : l)).join('\n'));
  area.setSelectionRange(start, stop, direction);
  indents.set(area, {before, after: {text: area.value, start, end: stop, direction}});
}

/** How tall a line of `area` is. */
export const lineHeight = (area: HTMLElement) => parseFloat(getComputedStyle(area).lineHeight) || 20;
/** Where line `n` (the first is 0) starts in a text split into `lines`. */
export const lineStart = (lines: string[], n: number) => lines.slice(0, n).reduce((k, l) => k + l.length + 1, 0);

/** What a file's head says of it beside its name: nothing while it is simply saved. */
export interface FileState {
  el: HTMLElement;
  /** Written and not saved yet. */
  unsaved(): void;
  /** Saved. */
  saved(): void;
}

/** What a file says beside its name in its head, made for one file. */
export function fileState(): FileState {
  // Says something only when the file is not simply saved.
  const el = h('span', {class: 'file-state', role: 'status'});
  /** Written and not saved yet: a quiet dot where the word would be (said, not shown); saved, it goes. */
  const unsaved = () => {
    const dot = el.querySelector<HTMLElement>('.unsaved-dot');
    // Written on again while it was going: it stays.
    if (dot) { keepOut(dot); return; }
    el.replaceChildren(h('span', {class: 'unsaved-dot', 'aria-hidden': 'true'}), h('span', {class: 'sr-only'}, t('Unsaved')));
  };
  /** Saved: the dot goes as it came, not at once. */
  const saved = () => {
    const dot = el.querySelector<HTMLElement>('.unsaved-dot');
    if (dot) putAway(dot, () => { if (dot.isConnected) el.textContent = ''; }); else el.textContent = '';
  };
  return {el, unsaved, saved};
}

/** The line numbers in `gutter` for a text: written again only when the count of lines changed, not at every keystroke. */
export function numbering(gutter: HTMLElement): (text: string) => void {
  let numbered = 0;
  return (text) => {
    const n = Math.max(lineCount(text), 1);
    if (n === numbered) return;
    numbered = n;
    gutter.textContent = Array.from({length: n}, (_, i) => String(i + 1)).join('\n');
  };
}

/** A file's box, as the page draws it, that an editor is made in. */
interface FileBox {
  repo: string;
  path: string;
  /** The file's head: what is asked when it was saved elsewhere comes under it. */
  head: HTMLElement;
  /** Where its text is, its line numbers (`gutter`) beside it, written by `number`. */
  sheet: HTMLElement;
  gutter: HTMLElement;
  number(text: string): void;
  state: FileState;
  /** The page it is in: Escape leaves the text for it. */
  flow: HTMLElement;
  /** Fitted to its text (true), or out of sight and not measured (false): fitted again when it shows. */
  seen(measured: boolean): void;
}

/** One file's text, to be written in and saved. */
export class Editor {
  readonly area: HTMLTextAreaElement;
  private box: FileBox;
  /** Its text as saved, as written here, and as saved elsewhere (conflict.ts). */
  private held: Held;
  private timer = 0;
  /** The text's length and lines as it was last fitted to (-1: not fitted). */
  private fitted = {length: -1, lines: -1};
  // Saved elsewhere while this one has unsaved edits: asked in the box, over the text, which
  // stays to be read and written on. Nothing is saved on its own until it is answered. What
  // differs opens under the answers, so nothing moves under the pointer that asked for it.
  private ask = h('div', {class: 'file-ask', role: 'group', 'aria-label': t('Modified externally')});
  private see = h('button', {type: 'button', class: 'button small-button', 'aria-expanded': 'false'}, t('View diff')) as HTMLButtonElement;
  private other = h('button', {type: 'button', class: 'button small-button'}, t('Keep external')) as HTMLButtonElement;
  private mine = h('button', {type: 'button', class: 'button small-button primary'}, t('Overwrite with local')) as HTMLButtonElement;
  private difference = h('div', {class: 'file-ask-diff', hidden: ''});
  // Grown past what Forge edits: said in the box, over the text, with the way to keep it whole.
  private large = h('div', {class: 'file-ask', role: 'group', 'aria-label': t('File too large to save here')});
  private whole = h('button', {type: 'button', class: 'button small-button primary'}, t('Save full file')) as HTMLButtonElement;

  /** `text` in an editor, put on the `box`'s sheet. */
  constructor(text: string, box: FileBox) {
    this.box = box;
    const area = this.area = h('textarea', {class: 'code code-edit', rows: '1', wrap: 'off', spellcheck: 'false', autocapitalize: 'off',
      'aria-label': t('Edit {path}', {path: shownPath(box.path)})}) as HTMLTextAreaElement;
    area.value = text;
    box.sheet.replaceChildren(box.gutter, area);
    box.sheet.addEventListener('pointerdown', (event) => this.pressed(event));
    requestAnimationFrame(() => this.fit());
    this.held = new Held(text);
    this.see.addEventListener('click', () => {
      this.difference.hidden = !this.difference.hidden;
      this.see.setAttribute('aria-expanded', String(!this.difference.hidden));
      this.paintDiff();
    });
    this.other.addEventListener('click', () => {
      this.show(this.held.useTheirs());
      this.settle();
      box.state.el.textContent = '';
      area.focus();
    });
    this.mine.addEventListener('click', async () => {
      const text = this.held.keepMine(area.value);
      this.settle();
      await this.write(text);
      area.focus();
    });
    this.whole.addEventListener('click', () => void this.saveWhole());
    area.addEventListener('input', () => this.typed());
    area.addEventListener('blur', () => void this.save());
    // The tab closing (or put away) saves what is written, before the store keeps what it has (repos.ts).
    addEventListener('beforeunload', this.leaving);
    document.addEventListener('visibilitychange', this.leaving);
    area.addEventListener('keydown', (event) => this.key(event));
    // Undo and Redo of an indent take back the selection it had, not only the text.
    area.addEventListener('input', (event) => this.undone(event as InputEvent));
  }

  /**
   * Fitted to its text; out of sight (folded, or its page hidden) it cannot be measured: fitted again when it shows.
   * `typing`, with its text only added to since, it grows if it must and is not measured from nothing: that laid the
   * page out twice at every keystroke, and most change no height at all.
   */
  fit(typing = false) {
    const {area} = this;
    // Seen at all, asked of its style (offsetParent laid the page out first).
    if (!(area.checkVisibility?.() ?? !!area.offsetParent)) { this.box.seen(false); this.fitted = {length: -1, lines: -1}; return; }
    this.box.seen(true);
    const text = area.value, lines = lineCount(text), was = this.fitted;
    this.fitted = {length: text.length, lines};
    if (typing && was.length >= 0 && text.length >= was.length && lines >= was.lines) {
      if (area.scrollHeight > area.clientHeight) area.style.height = `${area.scrollHeight}px`;
      return;
    }
    area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`;
  }

  /** `text` in the editor, fitted and numbered. */
  private show(text: string) { this.area.value = text; this.fit(); this.box.number(text); }

  /**
   * The whole box is the place to write. A press beside the text (its numbers, or the room around
   * them) is that line, selected as a line found is; a press below the text puts the caret at its end.
   */
  private pressed(event: PointerEvent) {
    const {area} = this;
    if (event.target === area) return;
    event.preventDefault();
    area.focus({preventScroll: true});
    const at = area.getBoundingClientRect();
    if (event.clientX < at.left && event.clientY < at.bottom) {
      const lines = area.value.split('\n');
      const n = Math.min(Math.max(Math.floor((event.clientY - at.top) / lineHeight(area)), 0), lines.length - 1);
      const from = lineStart(lines, n);
      area.setSelectionRange(from, from + lines[n].length);
      return;
    }
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** What differs between the other text and this one, drawn under the answers while it is open. */
  private paintDiff() {
    const {difference, held} = this;
    if (difference.hidden || held.theirs === null) return;
    const d = differs(held.theirs, this.area.value);
    difference.replaceChildren(...diffFiles([{path: t('Compare local vs. external'), status: 'modified', binary: false, lines: d.lines, more: d.more}]));
  }

  /** Answered, the ask folds away over the text, not at once. */
  private settle() {
    putAway(this.ask, () => this.ask.remove(), {fold: true});
    this.difference.hidden = true;
    this.see.setAttribute('aria-expanded', 'false');
  }

  /** Saved elsewhere while this one has unsaved edits: asked under the head, nothing saved until it is answered. */
  private asking() {
    const {ask} = this;
    clearTimeout(this.timer);
    this.box.state.el.textContent = t('Modified externally');
    keepOut(ask);
    if (!ask.isConnected) {
      ask.replaceChildren(
        h('p', {class: 'muted small'}, t('File was saved externally while editing here.')),
        h('p', {class: 'muted small'}, t('Your local changes are kept until you choose.')),
        answers(this.other, this.see, this.mine), this.difference);
      this.box.head.after(ask);
    }
    this.paintDiff();
  }

  /**
   * A text saved elsewhere (another device, the shell, l3, Git) comes in unless this one has unsaved edits: then it
   * is asked, and false.
   */
  take(text: string): boolean {
    const {state} = this.box;
    const came = this.held.came(text, this.area.value);
    if (came === 'ask') { this.asking(); return false; }
    if (came === 'take') this.show(text);
    this.settle();
    if (came === 'same' || state.el.textContent === t('Modified externally')) state.el.textContent = '';
    return true;
  }

  private async write(text: string) {
    const {state} = this.box;
    try {
      await store.write(this.box.repo, this.box.path, text);
      this.held.wrote(text);
      if (this.area.value === this.held.saved) state.saved(); else state.unsaved();
    } catch (e) {
      state.el.textContent = t('Failed to save: {message}', {message: errorText(e)});
    }
  }

  private async save() {
    clearTimeout(this.timer);
    if (!this.held.canSave) return;
    if (this.area.value === this.held.saved) { this.box.state.saved(); return; }
    // Past what Forge edits, it is not written as it is (it would come back read in part): said, with the way on.
    if (this.over()) { this.tooLarge(); return; }
    this.fits();
    await this.write(this.area.value);
  }

  /** Whether what is written is more than Forge edits and saves. */
  private over(): boolean {
    return this.area.value.length > EDIT_LIMIT / 4 && new TextEncoder().encode(this.area.value).length > EDIT_LIMIT;
  }

  /**
   * Grown past what Forge edits: the head says it is not saved, and the box how big it is and what can be done (made
   * once; written on, only its size follows, so Save it whole never moves under the pointer).
   */
  private tooLarge() {
    const {large} = this;
    const size = t('Size is {size}. Forge can only save files up to {limit}. Unsaved changes remain in editor.',
      {size: bytes(new TextEncoder().encode(this.area.value).length), limit: bytes(EDIT_LIMIT)});
    this.box.state.el.textContent = t('Unsaved · Exceeds {limit}', {limit: bytes(EDIT_LIMIT)});
    keepOut(large);
    if (large.isConnected) { large.firstElementChild!.textContent = size; return; }
    large.replaceChildren(h('p', {class: 'muted small'}, size),
      h('p', {class: 'muted small'}, t('Reduce size to save normally, or save full file: Forge will show preview only, and Prompt edits the full file.')),
      answers(null, this.whole));
    this.box.head.after(large);
  }

  /** Small enough again: what said it was too large goes, as an ask answered goes. */
  private fits() {
    if (!this.large.isConnected) return;
    const {large} = this;
    putAway(large, () => large.remove(), {fold: true});
  }

  /** Kept whole as written, past what Forge edits: the page reads it again, its start to read (reader.ts). */
  private async saveWhole() {
    const {state} = this.box;
    this.whole.disabled = true;
    try {
      const text = this.area.value;
      await store.put(this.box.repo, this.box.path, new TextEncoder().encode(text));
      this.held.wrote(text);
      this.fits();
      state.saved();
    } catch (e) {
      state.el.textContent = t('Failed to save: {message}', {message: errorText(e)});
    } finally { this.whole.disabled = false; }
  }

  /** Written in: saved a moment after the typing stops, unless what to keep is still being asked. */
  private typed() {
    const {area, held} = this;
    this.fit(true);
    this.box.number(area.value);
    if (held.asking) {
      // Written on until it is theirs: nothing is left to ask.
      if (held.typed(area.value)) { this.settle(); this.box.state.el.textContent = ''; } else this.paintDiff();
      return;
    }
    // Too large to save, it keeps saying so (not the dot) until it is small enough or saved whole.
    if (!this.large.isConnected) this.box.state.unsaved();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), 700);
  }

  /**
   * The tab closing or put away: what is written is saved (once the editor is gone, it no longer listens). What cannot
   * be saved as it is (too large) is not lost without a word: the browser asks before the tab closes.
   */
  private leaving = (event: Event) => {
    if (!this.area.isConnected) { removeEventListener('beforeunload', this.leaving); document.removeEventListener('visibilitychange', this.leaving); return; }
    if (this.area.value === this.held.saved) return;
    if (event.type === 'beforeunload' && this.over()) { event.preventDefault(); return; }
    void this.save();
  };

  /** Ctrl+S saves; Tab indents; Escape leaves the text. */
  private key(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void this.save(); return; }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
      event.preventDefault();
      indent(this.area);
      return;
    }
    // Escape leaves the text, so the keyboard is never caught in it: it is on the page, and
    // Shift+Tab goes back up to the search from there.
    if (event.key === 'Escape') this.box.flow.focus({preventScroll: true});
  }

  /** Undo or Redo of an indent: the selection it had comes back with the text. */
  private undone(event: InputEvent) {
    const how = event.inputType;
    const was = indents.get(this.area);
    if (!was || (how !== 'historyUndo' && how !== 'historyRedo')) return;
    const to = how === 'historyUndo' ? was.before : was.after;
    if (this.area.value === to.text) this.area.setSelectionRange(to.start, to.end, to.direction);
  }
}
