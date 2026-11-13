import {nativeOptionArrow} from '../../ui/text-keys.ts';
import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {ownCamera, WORK_AT, type WorkAt} from '../../ui/camera.ts';
import {fieldCarried} from '../../ui/caret.ts';
import {scrollMarks} from '../../ui/scroll-marks.ts';
import {t} from '../../i18n/i18n.ts';
import {mark} from '../../ui/icons.ts';
import {BIG, GRID, inSight, LINE, next, PAD, row, SHADOW, tabbed, tallest, TERM, TERM_HELD, termHeight, TOP, WIDTH} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge): what is open lies in a row on dots. The terminal first, a sheet of
// ink near the places, lying askew until it is in hand; then the files, each a sheet of paper fifty letters wide, its
// name over its top-left corner. Every sheet's top is on one line, and none reaches lower than two cells over the
// window's foot: what is under that, or past its right edge, is scrolled to inside the sheet. One piece is in hand
// (its shadow a cell right and down), and the desk is turned along the row only as far as shows that piece whole;
// nothing is brought to the middle. A piece pressed twice is twice as large, and again its own size.
// (Before: boxes 80 columns wide in columns, one under another and as tall as their text, the one in hand brought to
// the middle of the face by a camera that stepped back on long ways; a box put beside the rest as a second screen.)
// A piece is gone to by pressing it. From the keyboard: Escape leaves a text, the keyboard on the desk; there ← and →
// (or Tab) take the next piece in hand, and Enter (or a letter typed) goes into it. Where each piece lies, and how
// far the desk is turned, are numbers kept apart (desk-layout.ts).

/** What lies on the desk: its element, and the name said over it (its folder quiet before it, and after it, quiet,
 * what more it is). */
export interface Laid {
  element: HTMLElement; name: string; dir: string; after?: string; focus(): void;
  /** Its name pressed: written over in place (a file's). */
  rename?(name: HTMLElement): void;
  /** A terminal rather than a file's sheet: the person's ('term': first in the row, never taken off, no name over
   * it) or the Agent's ('agent'). */
  kind?: 'term' | 'agent';
}

type Way = 'left' | 'right';
const WAYS: Record<string, Way> = {ArrowLeft: 'left', ArrowRight: 'right'};

/** Whether a key is a program's: one in a terminal reading each key as it comes (vi, less) has every key, as at a
 * terminal (its line says so, data-raw). */
const theirs = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.('[data-raw]');

/** A letter typed with no Ctrl, Alt or ⌘ (a space is a button's, / the search's): with the keyboard on the desk, it goes into the piece in hand. */
const letter = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== ' ' && e.key !== '/';

/** What scrolls of itself round `from` (inside `box`) the way (`dx`, `dy`) goes, with room left to go. */
function scrollsItself(from: Element, box: Element, dx: number, dy: number): boolean {
  for (let el: Element | null = from; el && el !== box; el = el.parentElement) {
    const o = getComputedStyle(el);
    if (dy && /auto|scroll/.test(o.overflowY) && el.scrollHeight > el.clientHeight + 1
      && (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    if (dx && /auto|scroll/.test(o.overflowX) && el.scrollWidth > el.clientWidth + 1
      && (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
  }
  return false;
}

/** Minimum jerk: from rest to rest, nothing sudden at either end. */
const pan = (x: number) => x * x * x * (10 - 15 * x + 6 * x * x);
/** How long the desk takes to turn to a piece. */
const TURN_MS = 420;
/** As long as a second press of a double press may come after the first. */
const TWICE_MS = 320;
/** How long the desk's own mark stays after it was last turned. */
const MARK_MS = 700;

/** A piece on the desk: where its left edge is and how wide it is; `placed` once it has stood somewhere (before, it
 * has no place to move from). */
interface Box { key: string; laid: Laid; el: HTMLElement; label: HTMLElement; x: number; w: number; placed?: boolean }

/**
 * The pointer out of sight where it rests while the keyboard writes in a box: `cursor: none` on what
 * is under it alone, moved to what comes under it as the desk glides beneath it, put back as it was once it moves. (A
 * class on the page's root with a rule for everything under it had the style of every element worked out again, 4–5 ms,
 * at each key.)
 */
const veil = new (class {
  #on: {el: HTMLElement; was: string; prio: string} | null = null;
  #wanted = false;
  /** Out of sight, at `at` (where the pointer was last; none, it is not over the page). */
  hide(at: {x: number; y: number} | null) { this.#wanted = true; this.follow(at); }
  /** Still out of sight over what is now under it. */
  follow(at: {x: number; y: number} | null) {
    if (!this.#wanted || !at) return;
    const el = document.elementFromPoint(at.x, at.y);
    if (!(el instanceof HTMLElement) || el === this.#on?.el) return;
    this.#back();
    this.#on = {el, was: el.style.getPropertyValue('cursor'), prio: el.style.getPropertyPriority('cursor')};
    el.style.setProperty('cursor', 'none', 'important');
  }
  /** In sight again. */
  show() { this.#wanted = false; this.#back(); }
  #back() {
    const o = this.#on;
    this.#on = null;
    if (!o) return;
    if (o.was) o.el.style.setProperty('cursor', o.was, o.prio); else o.el.style.removeProperty('cursor');
  }
})();

/** `el` put at (x, y) at once, not moved there: where a box first stands (never come from the desk's corner). */
function standAt(el: HTMLElement, x: number, y: number) {
  el.style.transition = 'none';
  el.style.translate = `${x}px ${y}px`;
  void el.offsetWidth;
  el.style.transition = '';
}

export class Desk {
  readonly element: HTMLElement;
  readonly #plane: HTMLElement;
  readonly #boxes = new Map<string, Box>();
  #row: string[] = [];
  #held: string | null = null;
  /** The terminal's closing, waited for after a press took a file (take). */
  #closing = 0;
  /** The piece pressed twice: twice as large until it is pressed twice again. */
  #big: string | null = null;
  /** Where the row ends (its last piece's shadow, a cell after). */
  #end = 0;
  /** The desk turning (its next frame; none at rest), and how far it is going: laid again on its way, it goes on to
   * where it is now to go rather than starting again. */
  #moving = 0;
  #glide: {to: number} | null = null;
  /** A piece laid beside another: the ones after it make way for it at once, quick, as for one carried in. */
  #makingWay = false;
  /** Where the pointer last was on the face. */
  #pointerAt: {x: number; y: number} | null = null;
  /** The pieces the desk is turned to at once (the Agent's at work), or none. */
  #framed: string[] | null = null;
  /** Each piece's size heard: grown or shrunk (a line written), the desk is laid again. */
  readonly #sized = new ResizeObserver(() => this.#relay());
  /** The piece a press under way is on (the desk waits for it to be let go: its click takes it in hand), and the one
   * that was in hand as a press (the first of two) began. */
  #pressing: string | null = null;
  #heldAtPress: string | null = null;
  /** How far the desk is turned, said at the window's foot while it turns (styles: .desk-turned). */
  readonly #turned = h('div', {class: 'desk-turned', 'aria-hidden': 'true'});
  #turnedRest = 0;
  #turnedTo = 0;
  readonly #shut: (key: string) => void;
  readonly #changed: () => void;

  /** `label`: what the desk is called, to be heard (the repo's files), `repo` whose it is; `shut`: a piece's own close pressed (its key);
   * `changed`: what lies where, or which is in hand, changed (to be kept). */
  constructor(label: string, repo: string, shut: (key: string) => void, changed: () => void = () => {}) {
    this.#shut = shut;
    this.#changed = changed;
    this.#plane = h('div', {class: 'desk-plane'});
    this.element = h('section', {class: 'desk', tabindex: '-1', 'aria-label': label, 'data-repo': repo}, this.#plane, this.#turned);
    // The rail going by (main.ts select) asks a page's own camera to stand back: the desk has one size, and does not.
    ownCamera(this.element, {away: () => Promise.resolve(), afar: () => {}, near: () => {}, far: 1, dots: null});
    this.element.addEventListener('keydown', (e) => this.#key(e));
    // The keyboard gone into a piece (a press, a key that summons the Prompt): that piece is in hand, the desk turned
    // to it. Gone there by a press, it is taken once the press is let go (its click), never under the pointer.
    this.element.addEventListener('focusin', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key !== this.#held && key !== this.#pressing) this.take(key, false);
    });
    // Written in, the piece in hand is come back to from over the Agent's work (their terminal written in).
    const writtenIn = (at: EventTarget | null) => {
      // (Its name written, it is not yet gone into: the desk stays where it is.)
      if ((at as Element | null)?.closest?.('.desk-label')) return;
      const key = (at as Element | null)?.closest?.<HTMLElement>('.desk-box')?.dataset.key;
      if (!key || key !== this.#held) return;
      if (this.#framed) { this.#framed = null; this.#look(true); }
    };
    this.element.addEventListener('keydown', (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace')) return;
      writtenIn(e.target);
    }, true);
    // (Written in with no key: a paste, a word chosen from the input method's, a dictation.)
    this.element.addEventListener('beforeinput', (e) => writtenIn(e.target), true);
    this.element.addEventListener('pointerdown', (e) => { this.#pressing = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key ?? null; }, true);
    this.element.addEventListener('mousedown', (e) => { if (e.detail <= 1) this.#heldAtPress = this.#held; }, true);
    for (const end of ['pointerup', 'pointercancel'] as const) addEventListener(end, () => { setTimeout(() => { this.#pressing = null; }); }, true);
    this.element.addEventListener('dblclick', (e) => this.#twice(e));
    new ResizeObserver(() => this.#relay()).observe(this.element);
    this.#plane.addEventListener(WORK_AT, (e) => this.#workAt(e as CustomEvent<WorkAt | null>));
    this.element.addEventListener('scroll', () => {
      // The desk is a row: it is never turned down (what is under a sheet's foot is scrolled to inside it).
      if (this.element.scrollTop) this.element.scrollTop = 0;
      if (this.element.scrollLeft === this.#turnedTo) return;
      this.#turnedTo = this.element.scrollLeft;
      this.#said();
    });
    this.element.addEventListener('wheel', (e) => this.#wheel(e), {passive: false});
    // The pointer moved (not something moved under it: the desk turning moves the page under a pointer at rest), it is
    // in use again and back in sight.
    addEventListener('pointermove', (e) => {
      this.#pointerAt = {x: e.clientX, y: e.clientY};
      if (!e.isTrusted || (!e.movementX && !e.movementY)) return;
      this.element.classList.remove('resting');
      veil.show();
    }, {capture: true, passive: true});
    // Written in a piece, the pointer is out of the way until it moves, as it is over any text typed in: a key, or what
    // comes in as written without one (a paste, a word the input method gives, text put in).
    const writing = () => veil.hide(this.#pointerAt);
    this.element.addEventListener('keydown', (e) => { if (e.target !== this.element && letter(e)) writing(); });
    this.element.addEventListener('beforeinput', (e) => { if (e.target !== this.element) writing(); });
  }

  /** `scroller`, a box round the desk, scrolled to bring something on it into view: undone (the desk turns itself). */
  scrolled(scroller: HTMLElement) {
    if (scroller === this.element || (!scroller.scrollLeft && !scroller.scrollTop)) return;
    scroller.scrollTo(0, 0);
  }

  /** The desk's repo renamed: what it is called (`label`, to be heard) and whose it is, under the new name. */
  renamed(label: string, repo: string) {
    this.element.setAttribute('aria-label', label);
    this.element.dataset.repo = repo;
  }

  /** The key of the piece in hand. */
  get held(): string | null { return this.#held; }
  /** Whether `key` lies on the desk. */
  has(key: string): boolean { return this.#boxes.has(key); }
  /** The keys on the desk, along the row. */
  get row(): string[] { return [...this.#row]; }
  /** What is said over the piece `key` (its name), and what kind it is. */
  said(key: string): {name: string; kind: Laid['kind']} | null {
    const b = this.#boxes.get(key);
    return b ? {name: b.label.querySelector('.desk-name')?.textContent ?? b.laid.name, kind: b.laid.kind} : null;
  }

  /**
   * `laid` put on the desk as `key`: after the piece `how.after`, at `how.at` along the row, or after the piece in
   * hand (the row's end, with none). The terminal is the row's first, and nothing is laid before it. `how.lands`: it
   * is set down in the room the pieces after it make (one opened now, not one laid again as it was left);
   * `how.instead`: it takes the place of that piece, where it lies, as it is (a file renamed: no move at all), in
   * hand if that one was.
   */
  lay(key: string, laid: Laid, how: {after?: string; at?: number; instead?: string; lands?: boolean} = {}) {
    if (this.has(key)) return;
    const term = laid.kind === 'term';
    const name = h('span', {class: 'desk-name'}, laid.name);
    const label = h('div', {class: 'desk-label'}, h('span', {class: 'desk-dir'}, laid.dir), name,
      ...(laid.after ? [h('span', {class: 'desk-dir desk-after'}, laid.after)] : []));
    const rename = laid.rename;
    if (rename) name.addEventListener('click', () => { if (!getSelection()?.toString()) rename(name); });
    const close = term ? null : h('button', {type: 'button', class: 'desk-close', 'aria-label': t('Close {name}', {name: laid.name})}, mark('close'));
    close?.addEventListener('click', (e) => { e.stopPropagation(); this.#shut(key); });
    const el = h('div', {class: 'desk-box', 'data-key': key, ...(laid.kind ? {'data-kind': laid.kind} : {})}, ...(term ? [] : [label]), laid.element, ...(close ? [close] : []));
    // Where it is scrolled to inside it is said in it while it is scrolled, by a mark cut square at its edge.
    scrollMarks(el);
    // Pressed (what was pressed in it done first: a line run, a link), it is in hand; the desk turns after the
    // press, never under it.
    el.addEventListener('click', () => {
      if (this.#held !== key || !el.contains(document.activeElement)) this.take(key, !el.contains(document.activeElement), true, true);
    });
    this.#plane.append(el);
    this.#sized.observe(el);
    const box: Box = {key, laid, el, label, x: 0, w: 0, placed: false};
    this.#boxes.set(key, box);
    const was = how.instead === undefined ? undefined : this.#boxes.get(how.instead);
    if (was) {
      // In its place, as it is: where it lies, its size, in hand if it was; then the one it takes the place of goes.
      this.#row.splice(this.#row.indexOf(was.key), 0, key);
      this.#plane.insertBefore(el, was.el);
      box.x = was.x;
      box.w = was.w;
      box.placed = true;
      el.style.width = `${was.w}px`;
      standAt(el, was.x, TOP);
      if (this.#big === was.key) this.#big = key;
      if (this.#held === was.key) {
        this.#held = key;
        el.classList.add('held');
      }
      this.lift(was.key, true);
      return;
    }
    const first = this.#row[0] !== undefined && this.#boxes.get(this.#row[0])?.laid.kind === 'term' ? 1 : 0;
    const by = how.after !== undefined && this.#row.includes(how.after) ? how.after : this.#held !== null && this.#row.includes(this.#held) ? this.#held : null;
    const at = term ? 0 : Math.max(first, how.at ?? (by === null ? this.#row.length : this.#row.indexOf(by) + 1));
    this.#row.splice(Math.min(at, this.#row.length), 0, key);
    // In the page as along the row: what is read out, and where Tab goes, follow the desk from its start.
    const follows = this.#row[this.#row.indexOf(key) + 1];
    this.#plane.insertBefore(el, follows === undefined ? null : this.#boxes.get(follows)!.el);
    // Set down in the room the pieces after it make (forge-desk.css .landing), the desk turning to it meanwhile:
    // never under another piece nor over its words.
    if (how.lands && !still() && this.#row.length > 1) {
      this.#makingWay = true;
      el.classList.add('landing');
      const landed = (e: AnimationEvent) => { if (e.target === el) { el.classList.remove('landing'); el.removeEventListener('animationend', landed); } };
      el.addEventListener('animationend', landed);
    }
    this.#relay();
  }

  /** The name over `key` written over in its place (a new file's, as it comes). */
  name(key: string) {
    const b = this.#boxes.get(key);
    const name = b?.label.querySelector<HTMLElement>('.desk-name');
    if (b?.laid.rename && name) b.laid.rename(name);
  }

  /** `key` taken off the desk; the piece in hand, if it was, is the one beside it. */
  lift(key: string, atOnce = false) {
    const b = this.#boxes.get(key);
    if (!b) return;
    const after = next(this.#row, key, 'left') ?? next(this.#row, key, 'right');
    this.#sized.unobserve(b.el);
    // Taken off (its close, the file gone): it goes in a beat where it lies, the others closing up after it and the
    // desk turning with them; never a cut. Taken off for one in its place (a file renamed), at once.
    if (atOnce || still()) b.el.remove();
    else {
      b.el.inert = true;
      b.el.style.pointerEvents = 'none';
      b.el.animate([{opacity: 1, scale: '1'}, {opacity: 0, scale: '.97'}], {duration: 140, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'})
        .finished.then(() => b.el.remove(), () => b.el.remove());
    }
    this.#boxes.delete(key);
    this.#row = this.#row.filter((k) => k !== key);
    if (this.#big === key) this.#big = null;
    this.#relay(true);
    if (this.#held === key) { this.#held = null; if (after) this.take(after); else this.#changed(); }
  }

  /** The name said over `key` changed (a file renamed). */
  named(key: string, name: string, dir: string) {
    const b = this.#boxes.get(key);
    if (!b) return;
    b.label.querySelector('.desk-dir')!.textContent = dir;
    b.label.querySelector('.desk-name')!.textContent = name;
  }

  /** `key` in hand, the desk turned to it (gliding there, unless `glide` is false), with the keyboard (`focus`);
   * `pressed`: taken by a press of the pointer on it. */
  take(key: string, focus = true, glide = true, pressed = false) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    // The terminal taken in hand opens out to work in, and closes to its size at rest when something else is: the
    // pieces after it go along the row at once to make it room, or come back.
    const was = this.#held === null ? undefined : this.#boxes.get(this.#held);
    const opens = was !== b && (b.laid.kind === 'term' || was?.laid.kind === 'term');
    this.#held = key;
    this.#framed = null;
    clearTimeout(this.#closing);
    // (A file pressed while the terminal was open stays under the pointer for as long as a second press may come:
    // the terminal closes, and the files come back along the row, after that. Taken by the keyboard, at once.)
    const lay = () => { this.#makingWay = true; this.#relay(glide); };
    if (opens && pressed && b.laid.kind !== 'term') { this.#closing = window.setTimeout(lay, TWICE_MS); this.#look(glide); }
    else if (opens) lay();
    else this.#look(glide);
    if (focus) b.laid.focus();
    this.#changed();
  }

  /** The desk turned to `keys` (each a piece at work): to the one last at work; none, back to the piece in hand. */
  frame(keys: string[]) {
    this.#framed = keys.length ? keys : null;
    this.#look(true);
  }

  /** The Agent's hand or eye gone to a line of a piece (`e.detail`, from what sent it), or gone from it (null): the
   * piece scrolls itself to keep that line in sight, a page turned as the line nears its foot, and the desk over the
   * Agent's work is turned to that piece. */
  #workAt(e: CustomEvent<WorkAt | null>) {
    const from = e.target as HTMLElement, box = from.closest<HTMLElement>('.desk-box'), key = box?.dataset.key;
    if (!box || !key || !e.detail) return;
    let s: HTMLElement | null = from;
    while (s && s !== box && !(/auto|scroll/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight + 1)) s = s.parentElement;
    if (s && s !== box) {
      const top = from.getBoundingClientRect().top - s.getBoundingClientRect().top + e.detail.top, line = e.detail.height;
      if (top < line || top + line > s.clientHeight - 3 * line) s.scrollTo({top: s.scrollTop + top - .4 * s.clientHeight, behavior: still() ? 'auto' : 'smooth'});
    }
    if (this.#framed?.includes(key) && !still()) this.#look(true);
  }

  /** A wheel over the desk: what is under it scrolls itself first (a sheet, a terminal's output). Over the bare
   * ground, or sideways where nothing under it goes sideways, the desk is turned along its row. With Ctrl (a pinch)
   * it is the window's own: the desk has one size. */
  #wheel(e: WheelEvent) {
    if (e.ctrlKey) return;
    const on = e.target as Element, box = on.closest('.desk-box');
    if (box && scrollsItself(on, box, e.deltaX, e.deltaY)) return;
    // (Down a sheet at its foot, nothing more: the desk is not turned sideways by a wheel that went down a file.)
    const dx = e.deltaX || (box || e.shiftKey ? 0 : e.deltaY);
    e.preventDefault();
    if (!dx) return;
    cancelAnimationFrame(this.#moving);
    this.#moving = 0;
    this.#glide = null;
    this.#framed = null;
    this.element.scrollLeft += dx;
  }

  /** Pressed twice: the piece is twice as large, and its own size again. On the words of the piece one writes in,
   * twice chooses a word, as in any text: there its size is its margins' (its numbers, its edges). */
  #twice(e: MouseEvent) {
    const on = e.target as Element, key = on.closest<HTMLElement>('.desk-box')?.dataset.key;
    if (!key || on.closest('button, a, .desk-label')) return;
    const words = on.closest('textarea, input, [contenteditable], .term-out, .agent-out');
    if (words && this.#heldAtPress === key) return;
    // (The word the two presses chose in a piece just taken up is let go: it was pressed for its size.)
    const at = document.activeElement;
    if (at instanceof HTMLTextAreaElement && this.#boxes.get(key)?.el.contains(at)) at.setSelectionRange(at.selectionStart, at.selectionStart);
    else getSelection()?.removeAllRanges();
    this.enlarge(this.#big === key ? null : key);
  }

  /** `key` twice as large (none: every piece its own size). */
  enlarge(key: string | null) {
    this.#big = key && this.#boxes.has(key) ? key : null;
    for (const b of this.#boxes.values()) b.el.classList.toggle('big', b.key === this.#big);
    this.#relay(true);
  }
  /** The piece that is large now. */
  get big(): string | null { return this.#big; }

  /** Places measured again (a piece grew or shrank): the pieces go where they now belong, the desk with them. */
  relayout() { this.#relay(); }

  /** The pieces to their places, the desk turned to the one in hand: at once (or, on its way, going on to where it now
   * goes), or gliding there (`glide`: the desk changed under it, a piece taken off). */
  #relay(glide = false) {
    // Out of sight (another page shown), the desk has no size: laid out then, its pieces would be moved to where a desk
    // of none puts them. They stay where they are; shown again, it is laid out at its size, and nothing has moved.
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return;
    // A sheet fifty letters wide, or as wide as the face has room for with its shadow.
    const room = Math.max(10 * GRID, GRID * Math.floor((w - PAD - SHADOW - GRID) / GRID)), bw = Math.min(WIDTH, room);
    const pieces = this.#row.map((key) => {
      const term = this.#boxes.get(key)!.laid.kind === 'term', k = key === this.#big ? BIG : 1;
      return {key, width: (term ? Math.min(key === this.#held ? TERM_HELD : TERM, room) : bw) * k, term, k};
    });
    const {at, end} = row(pieces);
    for (const p of pieces) {
      const b = this.#boxes.get(p.key)!, x = at.get(p.key)!;
      b.x = x;
      b.w = p.width;
      b.el.style.width = `${p.width}px`;
      b.el.style.setProperty('--k', String(p.k));
      b.el.style.setProperty('--tallest', `${p.term ? termHeight(hgt, LINE * p.k, p.key === this.#held) : tallest(hgt, LINE * p.k)}px`);
      // A piece laid beside another, the ones after it get out of its way at once (styles: .desk-box.gives).
      b.el.classList.toggle('gives', this.#makingWay);
      // A piece laid with no way in of its own stands in its place at once.
      if (!b.placed) { standAt(b.el, x, TOP); b.placed = true; continue; }
      const to = `${x}px ${TOP}px`;
      if (b.el.style.translate !== to) b.el.style.translate = to;
    }
    this.#makingWay = false;
    this.#end = end;
    this.#plane.style.width = `${Math.max(end, w)}px`;
    this.#plane.style.height = `${hgt}px`;
    this.#look(glide);
    this.#changed();
  }

  /** The desk turned to where it should be now: to the piece last at work, or the one in hand (`moving`: gliding). */
  #look(moving: boolean) {
    const w = this.element.clientWidth;
    if (!w) return;
    const key = this.#framed?.findLast((k) => this.#boxes.has(k)) ?? this.#held ?? this.#row[0];
    const b = key === undefined ? undefined : this.#boxes.get(key);
    if (!b) return;
    this.#go(inSight(this.element.scrollLeft, b.x, b.w, w, this.#end, key === this.#big), moving && !still());
  }

  /** The desk turned `to` along its row, gliding there or at once. */
  #go(to: number, moving: boolean) {
    const el = this.element;
    // On its way already: it goes on to where it now goes, never set off again.
    if (moving && this.#glide) { this.#glide.to = to; return; }
    cancelAnimationFrame(this.#moving);
    this.#moving = 0;
    this.#glide = null;
    const from = el.scrollLeft;
    if (!moving || Math.abs(to - from) < .5) { if (Math.abs(to - from) >= .5) el.scrollLeft = to; return; }
    // What goes by under a pointer at rest was not pointed at: nothing under it lights up (forge-desk.css .resting)
    // until the pointer moves again.
    el.classList.add('resting');
    const glide = this.#glide = {to}, t0 = performance.now();
    // The desk's way said as an animation of the page's, so what waits for the page to be still (a film, a look at
    // where the caret is) waits for it too.
    el.animate([{}, {}], {duration: TURN_MS, id: 'desk-camera'});
    const step = (now: number) => {
      // A glide gone after another is let go: two at once would draw the desk back and forth a frame at a time.
      if (this.#glide !== glide) return;
      const k = Math.max(0, Math.min(1, (now - t0) / TURN_MS));
      el.scrollLeft = k >= 1 ? glide.to : from + (glide.to - from) * pan(k);
      // The caret in a piece on it goes with its letter in this same frame.
      fieldCarried();
      veil.follow(this.#pointerAt);
      if (k < 1) this.#moving = requestAnimationFrame(step);
      else { this.#moving = 0; this.#glide = null; }
    };
    this.#moving = requestAnimationFrame(step);
  }

  /** How far the desk is turned, said at the window's foot while it turns and a moment after: an ink bar cut square,
   * as long as the part of the row in sight is of the whole, where that part is. Nothing at rest. */
  #said() {
    const el = this.element, w = el.clientWidth, far = this.#end - w;
    if (far <= 1) { this.#turned.classList.remove('shown'); return; }
    // (From where the page's own things start to a cell short of the window's edge.)
    const from = 3 * GRID, room = w - from - GRID, len = Math.max(GRID, room * w / this.#end);
    this.#turned.style.width = `${len}px`;
    this.#turned.style.translate = `${el.scrollLeft + from + (room - len) * Math.min(1, el.scrollLeft / far)}px 0`;
    this.#turned.classList.add('shown');
    clearTimeout(this.#turnedRest);
    this.#turnedRest = window.setTimeout(() => this.#turned.classList.remove('shown'), MARK_MS);
  }

  #key(e: KeyboardEvent) {
    if (e.isComposing || theirs(e) || nativeOptionArrow(e)) return;
    const way = WAYS[e.key];
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    // The keyboard on the desk itself, a piece in hand: not in any text.
    const onDesk = e.target === this.element && this.#held !== null;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // Escape from a piece's text is the text's first (a search, a rename). One that reaches the desk takes the
      // keyboard out of the text onto the desk; there, it puts a piece made large back to its own size.
      e.preventDefault();
      if (e.target === this.element && this.#big) this.enlarge(null);
      else this.element.focus({preventScroll: true});
    } else if (way && e.altKey && !e.defaultPrevented) {
      // Alt and ← or → are a text's (moving what is written): never the browser's back and forward.
      e.preventDefault();
    } else if (onDesk && bare && e.key === 'Enter') {
      e.preventDefault();
      this.#enter();
    } else if (onDesk && bare && way) {
      e.preventDefault();
      const to = next(this.#row, this.#held!, way);
      if (to && to !== this.#held) this.take(to, false);
    } else if (onDesk && e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // With no text to indent, Tab goes on to the next piece (Shift+Tab back), as it goes on among things anywhere.
      e.preventDefault();
      const to = tabbed(this.#row, this.#held!, e.shiftKey);
      if (to && to !== this.#held) this.take(to, false);
    } else if (onDesk && letter(e)) this.#enter();
  }

  /** Into the piece in hand: the keyboard in it (a letter typed goes on in). */
  #enter() {
    if (!this.#held) return;
    this.#boxes.get(this.#held)?.laid.focus();
  }
}
