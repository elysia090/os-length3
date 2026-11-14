import {nativeOptionArrow} from '../../ui/text-keys.ts';
import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {ownCamera, WORK_AT, type WorkAt} from '../../ui/camera.ts';
import {fieldCarried} from '../../ui/caret.ts';
import {scrollMarks} from '../../ui/scroll-marks.ts';
import {t} from '../../i18n/i18n.ts';
import {mark} from '../../ui/icons.ts';
import {ground} from '../../ui/row.ts';
import {rowMap} from '../../ui/row-desk.ts';
import {atRest, eased, GRID, next, PAD, planeWidth, row, SHADOW, tabbed, tallest, termHeight, TOP, turnedTo, turnTime, WIDTH} from './desk-layout.ts';

// A repo's desk, Forge's center: what is open lies in a row on dots, in the order it was opened, the terminal first;
// every piece is one width (fifty letters), its name over its top-left corner, its top on one line. What is under a
// piece's foot, or past its right edge, is scrolled to inside it.
// The rules, and there are no others:
//   hand   One piece is in hand. It alone is filled, casts a shadow, has its colours and shows what can be done with
//          it (its close); the rest are drawn in line on the ground. So the eye is where the hand is.
//   go     A piece is gone to by pressing it (or ← → and Tab with the keyboard on the desk, Enter or a letter to go
//          into it; Escape leaves a text for the desk). Whole in sight, it is in hand where it lies: what is
//          pressed never goes from under the hand that pressed it. Cut by the window's edge or past it, it is
//          brought in by the nearest rest that shows it whole.
//   look   The desk is looked along by scrolling it, as anything is; let go of, it comes to rest with the nearest
//          piece at its edge. So the desk rests in as many places as it has pieces and no others: what is out of
//          sight is known from which piece is at the edge.
// The desk is the world and the window looks at it: turned, its ground goes with its pieces (the dots move as the
// pieces do, and stand where they stood at every rest). Nothing changes size, and nothing moves but the desk. Where each piece lies, and how far
// the desk is turned, are numbers kept apart (desk-layout.ts).
// (Before: the terminal askew until in hand and wider while it was; a piece twice as large pressed twice; pieces
// making way for one set down; a wheel over the ground turned into a turn of the desk.)

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

/** How long after the desk was last scrolled by hand it is taken to be let go of. */
const REST_MS = 140;

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
  /** The desk turning (its next frame; none at rest), and how far it is going: laid again on its way, it goes on to
   * where it is now to go rather than starting again. */
  #moving = 0;
  #glide: {to: number} | null = null;
  /** The desk let go of (scrolled by hand, then left): it comes to rest on the grid. */
  #letGo = 0;
  /** Where the pointer last was on the face. */
  #pointerAt: {x: number; y: number} | null = null;
  /** The pieces the desk is turned to at once (the Agent's at work), or none. */
  #framed: string[] | null = null;
  /** Each piece's size heard: grown or shrunk (a line written), the desk is laid again. */
  readonly #sized = new ResizeObserver(() => this.#relay());
  /** The piece a press under way is on (the desk waits for it to be let go: its click takes it in hand). */
  #pressing: string | null = null;
  /** The row's map at the window's foot (ui/row-desk.ts): what is out of sight, which way and how far, and the way to it by a press. */
  readonly #map: {element: HTMLElement; paint(): void};
  #turnedTo = 0;
  readonly #shut: (key: string) => void;
  readonly #changed: () => void;

  /** `label`: what the desk is called, to be heard (the repo's files), `repo` whose it is; `shut`: a piece's own close pressed (its key);
   * `changed`: what lies where, or which is in hand, changed (to be kept). */
  constructor(label: string, repo: string, shut: (key: string) => void, changed: () => void = () => {}) {
    this.#shut = shut;
    this.#changed = changed;
    this.#plane = h('div', {class: 'desk-plane'});
    this.element = h('section', {class: 'desk', tabindex: '-1', 'aria-label': label, 'data-repo': repo}, this.#plane);
    this.#map = rowMap(this.element, () => this.#row.map((key) => {
      const b = this.#boxes.get(key)!;
      return {x: b.x, w: b.w, held: key === this.#held, name: b.el.querySelector('.desk-label')?.textContent?.trim() || key, go: () => this.take(key)};
    }));
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
    for (const end of ['pointerup', 'pointercancel'] as const) addEventListener(end, () => { setTimeout(() => { this.#pressing = null; }); }, true);
    new ResizeObserver(() => this.#relay()).observe(this.element);
    this.#plane.addEventListener(WORK_AT, (e) => this.#workAt(e as CustomEvent<WorkAt | null>));
    this.element.addEventListener('scroll', () => {
      // The desk is a row: it is never turned down (what is under a sheet's foot is scrolled to inside it).
      if (this.element.scrollTop) this.element.scrollTop = 0;
      if (this.element.scrollLeft === this.#turnedTo) return;
      this.#turnedTo = this.element.scrollLeft;
      this.#said();
      // The ground goes with the pieces: the dots are the desk's, not the window's (whole cells at every rest).
      ground(this.#turnedTo, GRID);
      // Scrolled by hand (not turned to a piece) and then left, where the browser has not brought it to rest at a
      // piece itself (styles: scroll-snap): it goes on to the nearest.
      clearTimeout(this.#letGo);
      if (!this.#glide) this.#letGo = window.setTimeout(() => { if (!this.#glide && this.#pressing === null) this.#go(atRest(this.element.scrollLeft, this.#starts()), true); }, REST_MS);
    });
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
  lay(key: string, laid: Laid, how: {after?: string; at?: number; instead?: string} = {}) {
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
      if (this.#held !== key || !el.contains(document.activeElement)) this.take(key, !el.contains(document.activeElement));
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
      if (this.#held === was.key) {
        this.#held = key;
        el.classList.add('held');
      }
      this.lift(was.key);
      return;
    }
    const first = this.#row[0] !== undefined && this.#boxes.get(this.#row[0])?.laid.kind === 'term' ? 1 : 0;
    const by = how.after !== undefined && this.#row.includes(how.after) ? how.after : this.#held !== null && this.#row.includes(this.#held) ? this.#held : null;
    const at = term ? 0 : Math.max(first, how.at ?? (by === null ? this.#row.length : this.#row.indexOf(by) + 1));
    this.#row.splice(Math.min(at, this.#row.length), 0, key);
    // In the page as along the row: what is read out, and where Tab goes, follow the desk from its start.
    const follows = this.#row[this.#row.indexOf(key) + 1];
    this.#plane.insertBefore(el, follows === undefined ? null : this.#boxes.get(follows)!.el);
    this.#relay();
  }

  /** The name over `key` written over in its place (a new file's, as it comes). */
  name(key: string) {
    const b = this.#boxes.get(key);
    const name = b?.label.querySelector<HTMLElement>('.desk-name');
    if (b?.laid.rename && name) b.laid.rename(name);
  }

  /** `key` taken off the desk, at once; the piece in hand, if it was, is the one beside it. */
  lift(key: string) {
    const b = this.#boxes.get(key);
    if (!b) return;
    const after = next(this.#row, key, 'left') ?? next(this.#row, key, 'right');
    this.#sized.unobserve(b.el);
    b.el.remove();
    this.#boxes.delete(key);
    this.#row = this.#row.filter((k) => k !== key);
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

  /** `key` in hand, the desk turned to it (gliding there, unless `glide` is false), with the keyboard (`focus`). */
  take(key: string, focus = true, glide = true) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    this.#held = key;
    this.#framed = null;
    this.#look(glide);
    this.#said();
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

  /** Places measured again (a piece grew or shrank): the pieces go where they now belong, the desk with them. */
  relayout() { this.#relay(); }

  /** The pieces to their places, the desk turned to the one in hand: at once (or, on its way, going on to where it now
   * goes), or gliding there (`glide`: the desk changed under it, a piece taken off). */
  #relay(glide = false) {
    // Out of sight (another page shown), the desk has no size: laid out then, its pieces would be moved to where a desk
    // of none puts them. They stay where they are; shown again, it is laid out at its size, and nothing has moved.
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return;
    // Every piece fifty letters wide, or as wide as the face has room for with its shadow (a phone's: the one rule).
    const bw = Math.min(WIDTH, Math.max(10 * GRID, GRID * Math.floor((w - PAD - SHADOW) / GRID)));
    const {at, end} = row(this.#row, bw);
    for (const key of this.#row) {
      const b = this.#boxes.get(key)!, x = at.get(key)!;
      b.x = x;
      b.w = bw;
      b.el.style.width = `${bw}px`;
      b.el.style.setProperty('--tallest', `${b.laid.kind === 'term' ? termHeight(hgt) : tallest(hgt)}px`);
      // A piece laid with no place yet stands in its place at once.
      if (!b.placed) { standAt(b.el, x, TOP); b.placed = true; continue; }
      const to = `${x}px ${TOP}px`;
      if (b.el.style.translate !== to) b.el.style.translate = to;
    }
    // (Wide enough for the last piece to stand at the edge.)
    const last = this.#row.at(-1);
    this.#plane.style.width = `${Math.max(end, last === undefined ? w : planeWidth(at.get(last)!, w))}px`;
    this.#plane.style.height = `${hgt}px`;
    this.#said();
    this.#look(glide);
    this.#changed();
  }

  /** Where each piece starts, along the row. */
  #starts(): number[] { return this.#row.map((k) => this.#boxes.get(k)!.x); }

  /** The desk turned to where it should be now: to the piece last at work, or the one in hand (`moving`: gliding). */
  #look(moving: boolean) {
    const w = this.element.clientWidth;
    if (!w) return;
    const key = this.#framed?.findLast((k) => this.#boxes.has(k)) ?? this.#held ?? this.#row[0];
    const b = key === undefined ? undefined : this.#boxes.get(key);
    if (!b) return;
    this.#go(turnedTo(atRest(this.#glide?.to ?? this.element.scrollLeft, this.#starts()), b.x, b.w, w, this.#starts()), moving && !still());
  }

  /** The desk turned `to` along its row, gliding there or at once. */
  #go(to: number, moving: boolean) {
    const el = this.element;
    // On its way already: it goes on to where it now goes, never set off again.
    if (moving && this.#glide) { this.#glide.to = to; return; }
    cancelAnimationFrame(this.#moving);
    this.#moving = 0;
    this.#glide = null;
    el.style.scrollSnapType = '';
    const from = el.scrollLeft;
    if (!moving || Math.abs(to - from) < .5) { if (Math.abs(to - from) >= .5) el.scrollLeft = to; return; }
    // What goes by under a pointer at rest was not pointed at: nothing under it lights up (forge-desk.css .resting)
    // until the pointer moves again.
    el.classList.add('resting');
    // (On its way the desk is taken where it is told: it comes to rest at a piece by going to one.)
    el.style.scrollSnapType = 'none';
    const glide = this.#glide = {to}, t0 = performance.now(), ms = turnTime(to - from, el.clientWidth);
    // The desk's way said as an animation of the page's, so what waits for the page to be still (a film, a look at
    // where the caret is) waits for it too.
    el.animate([{}, {}], {duration: ms, id: 'desk-camera'});
    const step = (now: number) => {
      // A glide gone after another is let go: two at once would draw the desk back and forth a frame at a time.
      if (this.#glide !== glide) return;
      const k = Math.max(0, Math.min(1, (now - t0) / ms));
      el.scrollLeft = k >= 1 ? glide.to : from + (glide.to - from) * eased(k);
      // The caret in a piece on it goes with its letter in this same frame.
      fieldCarried();
      veil.follow(this.#pointerAt);
      if (k < 1) this.#moving = requestAnimationFrame(step);
      else { this.#moving = 0; this.#glide = null; el.style.scrollSnapType = ''; }
    };
    this.#moving = requestAnimationFrame(step);
  }

  /** The row's map drawn again: beside the desk (not on what it turns), at the window's foot. */
  #said() {
    if (!this.#map.element.isConnected) this.element.parentElement?.append(this.#map.element);
    this.#map.paint();
  }

  #key(e: KeyboardEvent) {
    if (e.isComposing || theirs(e) || nativeOptionArrow(e)) return;
    const way = WAYS[e.key];
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    // The keyboard on the desk itself, a piece in hand: not in any text.
    const onDesk = e.target === this.element && this.#held !== null;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // Escape from a piece's text is the text's first (a search, a rename). One that reaches the desk takes the
      // keyboard out of the text onto the desk.
      e.preventDefault();
      this.element.focus({preventScroll: true});
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
