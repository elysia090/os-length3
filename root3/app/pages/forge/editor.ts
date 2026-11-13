import {nativeOptionArrow} from '../../ui/text-keys.ts';
import {differs, Held} from '../../repos/conflict.ts';
import {bytes, h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {lineCount} from '../../repos/reading.ts';
import {EDIT_LIMIT, store} from '../../repos/repos.ts';
import {answers} from '../kit/common.ts';
import {keepOut, putAway} from '../../ui/glide.ts';
import {diffFiles} from '../kit/diff-view.ts';
import {shownPath} from '../../repos/issues.ts';
import {errorText} from '../../host/errors.ts';

// A file in Forge's center is a plain text editor in its own box (reader.ts reads the page they make). Typing saves
// on its own, on leaving the file, or with Ctrl+S. A text saved elsewhere while this one has unsaved edits is asked
// in the file's box: take the other, or save yours over it, with what differs to be seen. A text grown past what
// Forge edits (EDIT_LIMIT) is not saved on its own: the box says so and offers to save it whole, which makes it a
// file Forge reads only in part; made smaller again, it saves as before.

/** Where a text and its selection were, before and after the last reshaping (an indent, lines moved) in an editor. */
interface Spot { text: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' }
const shaped = new WeakMap<HTMLTextAreaElement, {before: Spot; after: Spot}>();

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

/** Where the line that `i` is on starts in `value`. */
const startOf = (value: string, i: number) => (i > 0 ? value.lastIndexOf('\n', i - 1) + 1 : 0);

/** `from`…`to` of `area` written over with `text`, then `start`…`end` selected as it was going: one Undo takes both
 * back, the selection too. */
function reshape(area: HTMLTextAreaElement, from: number, to: number, text: string, start: number, end: number) {
  const direction = area.selectionDirection;
  const before = {text: area.value, start: area.selectionStart, end: area.selectionEnd, direction};
  typeOver(area, from, to, text);
  area.setSelectionRange(start, end, direction);
  shaped.set(area, {before, after: {text: area.value, start, end, direction}});
}

/** The lines the selection of `area` touches: where the first starts and the last ends (a selection ending at a line's
 * start leaves that line). */
function touched(area: HTMLTextAreaElement): {from: number; to: number} {
  const {value, selectionStart: a, selectionEnd: b} = area;
  const from = startOf(value, a);
  const last = b > a && value[b - 1] === '\n' ? b - 1 : b;
  const end = value.indexOf('\n', last);
  return {from, to: end < 0 ? value.length : end};
}

/** The file's own indent: a tab, unless its lines are indented with spaces (then as many as its shallowest indent). */
function indentOf(text: string): string {
  let tabs = 0, spaces = 0, least = Infinity;
  for (const m of text.matchAll(/^([ \t]+)\S/gm)) {
    if (m[1][0] === '\t') tabs++;
    else { spaces++; least = Math.min(least, m[1].length); }
  }
  return spaces > tabs ? ' '.repeat(Math.min(least, 8)) : '\t';
}

/**
 * Ctrl+] in a file (Ctrl+[, `out`): each line the caret or the selection touches moved in by the file's own indent (an
 * empty line in a selection stays empty), or out by one; the same text stays selected, and one Undo takes it back.
 */
function indent(area: HTMLTextAreaElement, out = false) {
  const {value, selectionStart: a, selectionEnd: b} = area;
  const {from, to} = touched(area);
  const unit = indentOf(value);
  const lines = value.slice(from, to).split('\n');
  // Each line's start, and what it gains (a positive length) or loses there.
  const edits: {at: number; by: number}[] = [];
  let k = from;
  const done = lines.map((l) => {
    const at = k;
    k += l.length + 1;
    if (!out) {
      if (!l && a !== b) return l;
      edits.push({at, by: unit.length});
      return unit + l;
    }
    const gone = l[0] === '\t' ? 1 : Math.min(/^ */.exec(l)![0].length, unit === '\t' ? 8 : unit.length);
    if (gone) edits.push({at, by: -gone});
    return l.slice(gone);
  });
  if (!edits.length) return;
  // A place moved with the text: past an indent added before it (at a line's start, too, with a caret), or back as
  // much as was taken out before it.
  const moved = (p: number) => p + edits.reduce((d, e) => d + (e.by > 0 ? (e.at < p || (a === b && e.at === p) ? e.by : 0) : (e.at < p ? -Math.min(-e.by, p - e.at) : 0)), 0);
  reshape(area, from, to, done.join('\n'), moved(a), moved(b));
}

/**
 * Tab in a file, as in any editor: with a selection its lines move in (Shift+Tab: out), as Ctrl+] moves them; with the
 * caret alone, the file's own indent is written where the caret is (Shift+Tab: the caret's line moved out).
 */
function tab(area: HTMLTextAreaElement, out: boolean) {
  const at = area.selectionStart;
  if (out || at !== area.selectionEnd) indent(area, out);
  else typeOver(area, at, at, indentOf(area.value));
}

/** Alt+↑ or Alt+↓ in a file: the lines the caret or the selection touches moved over the line above or below. */
function moveLines(area: HTMLTextAreaElement, up: boolean) {
  const {value, selectionStart: a, selectionEnd: b} = area;
  const {from, to} = touched(area);
  const block = value.slice(from, to);
  if (up) {
    if (from === 0) return;
    const above = startOf(value, from - 1), line = value.slice(above, from - 1), by = line.length + 1;
    reshape(area, above, to, `${block}\n${line}`, a - by, b - by);
  } else {
    if (to >= value.length) return;
    const stop = value.indexOf('\n', to + 1), below = stop < 0 ? value.length : stop, line = value.slice(to + 1, below), by = line.length + 1;
    reshape(area, from, below, `${line}\n${block}`, a + by, b + by);
  }
}

/** Alt+← or Alt+→ in a file: what is selected (with nothing selected, the letter after the caret) moved a letter that
 * way, still selected (the caret still before it). */
function moveLetters(area: HTMLTextAreaElement, left: boolean) {
  const {value, selectionStart: a, selectionEnd: b} = area;
  // A letter is a code point: never half of one.
  const after = (i: number) => i + (value.codePointAt(i)! > 0xffff ? 2 : 1);
  const before = (i: number) => i - (i >= 2 && value.codePointAt(i - 2)! > 0xffff ? 2 : 1);
  const caret = a === b;
  const end = caret ? (a < value.length ? after(a) : a) : b;
  if (end === a) return;
  const moving = value.slice(a, end);
  if (left) {
    if (a === 0) return;
    const p = before(a), over = value.slice(p, a);
    reshape(area, p, end, moving + over, p, caret ? p : p + moving.length);
  } else {
    if (end >= value.length) return;
    const q = after(end), over = value.slice(end, q);
    reshape(area, a, q, over + moving, a + over.length, caret ? a + over.length : q);
  }
}

/** Enter in a file: the new line keeps the indent of the one it breaks. */
function newLine(area: HTMLTextAreaElement) {
  const {value, selectionStart: a, selectionEnd: b} = area;
  const start = startOf(value, a);
  const lead = /^[ \t]*/.exec(value.slice(start, a))![0];
  typeOver(area, a, b, `\n${lead}`);
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

/** The rows a text is written on: its lines and, after a last newline, the empty row the caret goes on to (numbered as
 * any row is, so the line one has just begun has its number at once). */
function rows(text: string): number {
  let n = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) n++;
  return n;
}

/** The line numbers in `gutter` for a text, a number a row: written again only when the count of rows changed, not at
 * every keystroke. */
export function numbering(gutter: HTMLElement): (text: string) => void {
  let numbered = 0;
  return (text) => {
    const n = rows(text);
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
    // Undo and Redo of an indent or a move take back the selection it had, not only the text.
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
      // The box may be seen nearer than its own size (the desk's close camera): its lines as tall as they are seen.
      const scale = at.height / (area.offsetHeight || at.height || 1);
      const n = Math.min(Math.max(Math.floor((event.clientY - at.top) / (lineHeight(area) * scale)), 0), lines.length - 1);
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
   * A text saved elsewhere (another device, the shell, root3, Git) comes in unless this one has unsaved edits: then it
   * is asked, and false.
   */
  take(text: string): boolean {
    const {state} = this.box;
    const came = this.held.came(text, this.area.value);
    // (Its own save heard back after it was written on again: nothing came from elsewhere.)
    if (came === 'known') return true;
    if (came === 'ask') { this.asking(); return false; }
    if (came === 'take') this.show(text);
    this.settle();
    if (came === 'same' || state.el.textContent === t('Modified externally')) state.el.textContent = '';
    return true;
  }

  private async write(text: string) {
    const {state} = this.box;
    try {
      this.held.writes(text);
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
      this.held.writes(text);
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

  /**
   * Ctrl+S saves; Tab and Shift+Tab, or Ctrl+] and Ctrl+[, move the lines in and out (Tab with the caret alone writes
   * the indent there); Alt and an arrow move what is written (the lines up and down, the letters sideways); Enter keeps
   * the indent; Escape leaves the text, so Tab never holds the keyboard in it.
   */
  private key(event: KeyboardEvent) {
    if (event.isComposing || nativeOptionArrow(event)) return;
    const ctrl = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    const alt = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (ctrl && event.key === 's') { event.preventDefault(); void this.save(); return; }
    if (ctrl && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
      event.preventDefault();
      indent(this.area, event.code === 'BracketLeft');
      return;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); tab(this.area, event.shiftKey); return; }
    if (alt && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); moveLines(this.area, event.key === 'ArrowUp'); return; }
    if (alt && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); moveLetters(this.area, event.key === 'ArrowLeft'); return; }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); newLine(this.area); return; }
    // Escape leaves the text, so the keyboard is never caught in it: it is on the page (on a desk, the desk's).
    if (event.key === 'Escape') this.box.flow.focus({preventScroll: true});
  }

  /** Undo or Redo of a reshaping: the selection it had comes back with the text. */
  private undone(event: InputEvent) {
    const how = event.inputType;
    const was = shaped.get(this.area);
    if (!was || (how !== 'historyUndo' && how !== 'historyRedo')) return;
    const to = how === 'historyUndo' ? was.before : was.after;
    if (this.area.value === to.text) this.area.setSelectionRange(to.start, to.end, to.direction);
  }
}
