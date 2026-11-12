import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {ownCamera, WORK_AT, type WorkAt} from '../../ui/camera.ts';
import {fieldCarried} from '../../ui/caret.ts';
import {t} from '../../i18n/i18n.ts';
import {mark} from '../../ui/icons.ts';
import {arc, bornOn, EYE, FOOT, FOOT_ROOM, GRID, lineKept, next, PAD, slots, STANDARD, standardOn, tabbed, WIDTH, type Slot, type View} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge, the desk): what is open lies on a plane, each box as wide as 80
// columns of code, its name outside its top-left corner, on dots: files opened, each under the one opened before it.
// One box is in hand, and the camera (never the box) moves to it. One box may be put beside the rest, a second
// screen: the desk is then the left half, that box the right, each as wide as its half; put back, it lies where it
// lay. That is all the moving there is: a box is not carried about (before: Ctrl and an arrow carried the box in hand
// a slot at a time, anywhere, and Ctrl and an arrow in a text is the word's on every system).
// A box is gone to by pressing it. From the keyboard: Escape leaves a text, the keyboard on the desk; there an arrow
// (or Tab) takes the next box that way in hand, and Enter (or a letter typed) goes into it. Nothing is drawn for that
// but the box in hand's own shadow (before: a pointing hand beside its name, a game's cursor, with Tab taken from the
// text for it). The desk has one size, every box at its own: nothing steps back from it (before: Escape went round
// three cameras, the desk at three quarters and then half its size, so a key pressed to leave a line made the page
// smaller). Ctrl and -, + and 0, and a pinch, are the window's own. Ctrl, Alt and → put the box in hand beside (an
// editor's keys for it), Ctrl, Alt and ← put the one beside back. Where each box lies, and where the camera looks, are
// numbers kept apart (desk-layout.ts).

/** What lies on the desk: its element, and the name said over it (its folder quiet before it, and after it, quiet,
 * what more it is: the Prompt's folder). */
export interface Laid {
  element: HTMLElement; name: string; dir: string; after?: string; focus(): void;
  /** Its name pressed: written over in place (a file's). */
  rename?(name: HTMLElement): void;
  /** It stays on the desk: never put beside (the Agent's terminal, where its work is followed). */
  stays?: boolean;
}

type Way = 'up' | 'down' | 'left' | 'right';
const WAYS: Record<string, Way> = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'};

/** Whether `el` is on its way to its place now (its translate's transition running). */
const gliding = (el: HTMLElement) => el.getAnimations().some((a) => a instanceof CSSTransition && a.transitionProperty === 'translate' && a.playState === 'running');

/** Whether views `a` and `b` of a face `w` by `hgt` differ by no more than a box growing a few lines moves the camera. */
const near = (a: View, b: View, w: number, hgt: number) =>
  Math.abs(a.s - b.s) < .02 && Math.abs(a.x - b.x) < w / 6 && Math.abs(a.y - b.y) < hgt / 6;

/** Whether a key is a program's: one in a terminal reading each key as it comes (vi, less) has every key, as at a
 * terminal (its line says so, data-raw). */
const theirs = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.('[data-raw]');

/** A letter typed with no Ctrl, Alt or ⌘ (a space is a button's, / the search's): with the keyboard on the desk, it goes into the box in hand. */
const letter = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== ' ' && e.key !== '/';

/** Whether something between `from` and `desk` scrolls by itself the way (`dx`, `dy`) goes, with room left to go. */
function scrollsItself(from: Element, desk: Element, dx: number, dy: number): boolean {
  for (let el: Element | null = from; el && el !== desk; el = el.parentElement) {
    const o = getComputedStyle(el);
    if (dy && /auto|scroll/.test(o.overflowY) && el.scrollHeight > el.clientHeight + 1
      && (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    if (dx && /auto|scroll/.test(o.overflowX) && el.scrollWidth > el.clientWidth + 1
      && (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) return true;
  }
  return false;
}

/** The dots' pitch on the plane (styles: .desk), the first a half pitch in. */
const DOT = 24;

/** Minimum jerk: from rest to rest, nothing sudden at either end. */
const pan = (x: number) => x * x * x * (10 - 15 * x + 6 * x * x);
/** The ground between a half of the face and the box that fills it, two screens side by side: a step each side. */
const HALF_PAD = GRID;
/** The narrowest a box is read at beside another: narrower than two of them (and their ground), the face is one screen. */
const HALF_LEAST = 336;

/** A box on the desk; `placed` once it has stood somewhere (before, it has no place to move from). */
interface Box { key: string; laid: Laid; el: HTMLElement; label: HTMLElement; slot: Slot; placed?: boolean }


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
  #cols: string[][] = [[]];
  #held: string | null = null;
  /** A box's width now: 80 columns of code, or what the face has room for. */
  #bw = WIDTH;
  /** The second screen, beside the desk (the page puts it there, the desk the left half then): the one box put beside,
   * at its own size, scrolled in itself when it is taller than its room. */
  readonly side = h('div', {class: 'desk-side', hidden: ''});
  /** The box put beside, and where it lay on the desk (its column, its place in it): put back, it lies there. */
  #beside: {box: Box; col: number; at: number} | null = null;
  #view: View = {s: 1, x: 0, y: 0};
  /** The camera's glide under way (its next frame; none at rest), and where it is going: laid again on its way (a box
   * grown), it goes on to where it is now to go rather than starting again. */
  #moving = 0;
  #glide: {to: View} | null = null;
  /** The camera on its way (its scroll is its own then, not someone's going somewhere). */
  #gliding = false;
  /** When a box last began to come out from under the one above it: the camera lets it come out before it follows. */
  #comingAt = -Infinity;
  /** A box born beside another (desk.ts lay): the boxes after it make way for it at once, quick, as for one carried in. */
  #makingWay = false;
  /** The box come out from under another, and that one, while it is the one in hand: the camera keeps the other's foot in
   * sight over it (bornOn), until another is taken or the camera moves on. */
  #bornUnder: {key: string; above: string} | null = null;
  /** Where the pointer last was on the face. */
  #pointerAt: {x: number; y: number} | null = null;
  /** A key pressed while boxes slid: what it scrolled into view is not where the camera is to stay. */
  #strayed = false;
  /** The boxes the camera stands over at once (the Agent's at work), or none. */
  #framed: string[] | null = null;
  /** Where the box in hand's top stands on the face, as it was when it was taken in hand: it stays there as the box
   * grows or shrinks under the work (none: to be found again). */
  #topAt: number | null = null;
  /** Each box's size heard: grown or shrunk (a line written, a notice in its head), the desk is laid again, what is
   * under it pushed as it grows, in the frame it grew in (heard after that frame is laid out, before it is drawn: a
   * frame later, the grown box is drawn over the one under it). */
  readonly #sized = new ResizeObserver(() => this.#relay(false, true));
  /** When the camera last scrolled the desk itself. */
  #ownScroll = 0;
  /** The box a press under way is on (the camera waits for it to be let go: its click takes it in hand). */
  #pressing: string | null = null;
  readonly #shut: (key: string) => void;
  /** Where the Agent's hand or eye is in a box at work (its line, from the box's top, on the desk), told by the box. */
  #work: {key: string; top: number; bottom: number} | null = null;

  readonly #changed: () => void;

  /** `label`: what the desk is called, to be heard (the repo's files), `repo` whose it is; `shut`: a box's own close pressed (its key);
   * `changed`: what lies where, or which is in hand, changed (to be kept). */
  constructor(label: string, repo: string, shut: (key: string) => void, changed: () => void = () => {}) {
    this.#shut = shut;
    this.#changed = changed;
    this.#plane = h('div', {class: 'desk-plane'});
    this.element = h('section', {class: 'desk', tabindex: '-1', 'aria-label': label, 'data-repo': repo}, this.#plane);
    // The rail going by (main.ts select) asks a page's own camera to stand back: the desk has one size, and does not
    // (before: over the whole desk, at half its size, and back down as the page was come to).
    ownCamera(this.element, {away: () => Promise.resolve(), afar: () => {}, near: () => {}, far: 1, dots: null});
    this.element.addEventListener('keydown', (e) => this.#key(e));
    // Beside the desk, Ctrl, Alt and ← put the box back (the keyboard going with it).
    this.side.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey || e.isComposing || theirs(e)) return;
      e.preventDefault();
      this.putBack();
    });
    // The keyboard gone into a box (a press, a key that summons the Prompt): that box is in hand, the camera with it.
    // Gone there by a press, the box is taken once the press is let go (its click), never under the pointer.
    this.element.addEventListener('focusin', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key !== this.#held && key !== this.#pressing) this.take(key, false, true, 'near');
    });
    // Written in, the box in hand is come back to from over the Agent's work (their terminal written in).
    const writtenIn = (at: EventTarget | null) => {
      // (Its name written, it is not yet gone into: the camera stays where it is.)
      if ((at as Element | null)?.closest?.('.desk-label')) return;
      const key = (at as Element | null)?.closest?.<HTMLElement>('.desk-box')?.dataset.key;
      if (!key || key !== this.#held) return;
      if (this.#framed) { this.#framed = null; this.#topAt = null; this.#look(true); }
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
      // On its way the camera is the plane's move, the desk's scroll at rest: what the page scrolls meanwhile (the caret
      // brought into view as a box far off is written in) is undone before it is drawn.
      if (this.#moving && (this.element.scrollLeft || this.element.scrollTop)) { this.element.scrollTo(0, 0); return; }
      this.#scrolledStandard();
    });
    // A key pressed (or the keyboard come into a box) while boxes still slide to their places, a box just opened: what
    // it brought into view was brought there as it stood on its way. Once they stand, the camera goes back where it was.
    for (const ev of ['keydown', 'focusin'] as const) this.element.addEventListener(ev, () => { if (this.#sliding()) this.#strayed = true; }, true);
    this.#plane.addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'translate' || !this.#strayed || this.#sliding()) return;
      this.#strayed = false;
      const el = this.element, v = this.#view;
      if (v.s === 1 && Math.hypot(el.scrollLeft + v.x, el.scrollTop + v.y) > 1) this.#look(true);
    });
    this.element.addEventListener('wheel', (e) => this.#wheel(e), {passive: false});
    // The pointer moved (not something moved under it: the camera's glide moves the page under a pointer at rest), it is
    // in use again and back in sight.
    addEventListener('pointermove', (e) => {
      this.#pointerAt = {x: e.clientX, y: e.clientY};
      if (!e.isTrusted || (!e.movementX && !e.movementY)) return;
      this.element.classList.remove('resting');
      veil.show();
    }, {capture: true, passive: true});
    // Written in a box, the pointer is out of the way until it moves, as it is over any text typed in: a key, or what
    // comes in as written without one (a paste, a word the input method gives, text put in).
    const writing = () => veil.hide(this.#pointerAt);
    this.element.addEventListener('keydown', (e) => { if (e.target !== this.element && letter(e)) writing(); });
    this.element.addEventListener('beforeinput', (e) => { if (e.target !== this.element) writing(); });
  }

  /** `scroller`, a box round the desk, scrolled to bring something on it into view: undone, the desk's own camera
   * going there instead (the box most in view then in hand). */
  scrolled(scroller: HTMLElement) {
    if (scroller === this.element || (!scroller.scrollLeft && !scroller.scrollTop)) return;
    const best = this.#mostInView();
    scroller.scrollTo(0, 0);
    if (best && best.key !== this.#held) this.take(best.key, false, false);
  }

  /** The key of the box in hand. */
  get held(): string | null { return this.#held; }
  /** Whether `key` lies on the desk. */
  has(key: string): boolean { return this.#boxes.has(key) || this.#beside?.box.key === key; }
  /** The keys on the desk, column by column. */
  get columns(): string[][] {
    const cols = this.#cols.map((c) => [...c]), s = this.#beside;
    // (The one beside, where it lay: a desk kept is kept whole.)
    if (s) { const c = cols[Math.min(s.col, cols.length - 1)]; c.splice(Math.min(s.at, c.length), 0, s.box.key); }
    return cols;
  }
  /** The key of the box beside the desk (none: one screen). */
  get beside(): string | null { return this.#beside?.box.key ?? null; }

  /**
   * `key` (the box in hand) put beside the desk, a second screen: the desk the left half, this box the right, where it
   * stays while the desk is gone through; the one beside before it goes back where it lay first. The keyboard goes
   * with it if it had it; the box after it on the desk is the one in hand.
   */
  putBeside(key = this.#held) {
    const b = key ? this.#boxes.get(key) : undefined;
    // (A desk not yet on screen has no size to ask: put beside as it was kept, and put back once it is laid out if
    // there is no room.)
    if (!b || b.laid.stays || (this.element.clientWidth > 0 && !this.#roomForTwo())) return;
    const had = b.el.contains(document.activeElement);
    if (this.#beside) this.#back(false);
    const col = this.#cols.findIndex((c) => c.includes(b.key)), at = this.#cols[col].indexOf(b.key);
    const after = next(this.#cols, b.key, 'down') ?? next(this.#cols, b.key, 'up') ?? next(this.#cols, b.key, 'left') ?? next(this.#cols, b.key, 'right');
    this.#sized.unobserve(b.el);
    this.#boxes.delete(b.key);
    this.#cols = this.#cols.map((c) => c.filter((k) => k !== b.key)).filter((c, i) => c.length || i === 0);
    b.el.classList.remove('held', 'gives');
    b.el.style.translate = b.el.style.width = '';
    b.placed = false;
    this.side.append(b.el);
    this.side.hidden = false;
    this.side.scrollTop = 0;
    this.#beside = {box: b, col, at};
    this.#says(b, true);
    if (this.#held === b.key) { this.#held = null; this.#topAt = null; if (after) this.take(after, false); }
    if (had) b.laid.focus();
    this.#relay();
  }

  /** Whether the face (the whole of it: the desk's and, a box beside it, that box's half) has room for two boxes read
   * side by side. */
  #roomForTwo(): boolean {
    const w = this.element.clientWidth + (this.#beside ? this.side.clientWidth : 0);
    return w >= 2 * (HALF_LEAST + 2 * HALF_PAD);
  }

  /** The box beside the desk put back where it lay, in hand (the keyboard in it, if it had it). */
  putBack() { this.#back(true); }

  #back(take: boolean) {
    const s = this.#beside;
    if (!s) return;
    const b = s.box, had = b.el.contains(document.activeElement);
    this.#beside = null;
    this.side.hidden = true;
    const c = this.#cols[Math.min(s.col, this.#cols.length - 1)];
    c.splice(Math.min(s.at, c.length), 0, b.key);
    this.#plane.append(b.el);
    this.#boxes.set(b.key, b);
    this.#sized.observe(b.el);
    this.#says(b, false);
    this.#relay();
    if (take) this.take(b.key, had);
  }

  /** What `b`'s move says it does: put back (`beside`: it is beside the desk), or put beside. */
  #says(b: Box, beside: boolean) {
    b.el.querySelector('.desk-aside')?.setAttribute('aria-label', t(beside ? 'Put {name} back' : 'Put {name} beside', {name: b.laid.name}));
  }

  /**
   * `laid` put on the desk as `key`: beside the box `beside` (a column of its own after that one's), in column `col`,
   * or under the box in hand (the first box, the first column). `how.slide`: it comes out from under the box above it,
   * sliding down to its place (one opened now, not one laid again as it was left); `how.instead`: it takes the place
   * of that box, where it lies, as it is (a file renamed: no move at all), in hand if that one was.
   */
  lay(key: string, laid: Laid, col?: number, beside?: string, how: {slide?: boolean; instead?: string; top?: boolean} = {}) {
    if (this.has(key)) return;
    // In the place of the box beside the desk (a file renamed there): that one back first, this one beside after.
    if (how.instead !== undefined && this.#beside?.box.key === how.instead) {
      this.#back(false);
      this.lay(key, laid, col, beside, how);
      this.putBeside(key);
      return;
    }
    const name = h('span', {class: 'desk-name'}, laid.name);
    const label = h('div', {class: 'desk-label'}, h('span', {class: 'desk-dir'}, laid.dir), name,
      ...(laid.after ? [h('span', {class: 'desk-dir desk-after'}, laid.after)] : []));
    const rename = laid.rename;
    if (rename) name.addEventListener('click', () => { if (!getSelection()?.toString()) rename(name); });
    const close = h('button', {type: 'button', class: 'desk-close', 'aria-label': t('Close {name}', {name: laid.name})}, mark('close'));
    close.addEventListener('click', (e) => { e.stopPropagation(); this.#shut(key); });
    // Beside its close: put beside the desk (↗), and from there put back (↙). The one move a box has.
    const aside = laid.stays ? null : h('button', {type: 'button', class: 'desk-aside', 'aria-label': t('Put {name} beside', {name: laid.name})}, mark('beside'), mark('putBack'));
    aside?.addEventListener('click', (e) => { e.stopPropagation(); if (this.#beside?.box.key === key) this.putBack(); else this.putBeside(key); });
    const el = h('div', {class: 'desk-box', 'data-key': key}, label, laid.element, ...(aside ? [aside] : []), close);
    // Pressed (what was pressed in it done first: a line run, a link), it is in hand; the camera moves after the
    // press, never under it.
    el.addEventListener('click', () => {
      // Beside the desk it stands where it is: pressed, the keyboard is in it.
      if (this.#beside?.box.key === key) { if (!el.contains(document.activeElement)) laid.focus(); return; }
      if (this.#held !== key || !el.contains(document.activeElement)) this.take(key, !el.contains(document.activeElement), true, 'where');
    });
    const by = beside === undefined ? undefined : this.#boxes.get(beside);
    // Born beside another (the Agent's terminal beside the person's): a column of its own just right of that one's,
    // the columns after it making way; once they have, it is set down there as a box carried is set down
    // (forge-desk.css .landing), the camera turning to it meanwhile. Never under another box nor over its words: two
    // edges where one should be, one's words cut by the other's. (Before: it came out from under the person's, the two
    // sliding over each other.)
    if (by) {
      this.#makingWay = true;
      el.classList.add('landing');
      const landed = (e: AnimationEvent) => { if (e.target === el) { el.classList.remove('landing'); el.removeEventListener('animationend', landed); } };
      el.addEventListener('animationend', landed);
    }
    this.#plane.append(el);
    this.#sized.observe(el);
    const box: Box = {key, laid, el, label, slot: {x: 0, y: 0}, placed: false};
    this.#boxes.set(key, box);
    const byCol = by ? this.#cols.findIndex((k) => k.includes(by.key)) : -1;
    const was = how.instead === undefined ? undefined : this.#boxes.get(how.instead);
    if (was) {
      // In its place, as it is: where it lies, its size, in hand if it was; then the one it takes the place of goes.
      const c = this.#cols.findIndex((k) => k.includes(was.key));
      this.#cols[c].splice(this.#cols[c].indexOf(was.key), 0, key);
      this.#plane.insertBefore(el, was.el);
      box.slot = {...was.slot};
      box.placed = true;
      el.style.width = `${this.#bw}px`;
      standAt(el, was.slot.x, was.slot.y);
      if (this.#held === was.key) {
        this.#held = key;
        el.classList.add('held');
      }
      // (A file renamed as it comes out from under another: still come out from under the same box.)
      if (this.#bornUnder?.key === was.key) this.#bornUnder = {...this.#bornUnder, key};
      this.lift(was.key, true);
      return;
    }
    if (byCol >= 0) this.#cols.splice(byCol + 1, 0, [key]);
    else if (col !== undefined) {
      while (this.#cols.length <= col) this.#cols.push([]);
      if (how.top) this.#cols[col].unshift(key); else this.#cols[col].push(key);
    } else {
      const c = this.#held === null ? -1 : this.#cols.findIndex((k) => k.includes(this.#held!));
      if (c < 0) this.#cols[0].push(key);
      else this.#cols[c].splice(this.#cols[c].indexOf(this.#held!) + 1, 0, key);
    }
    // Out from under the box above it: where that one is, beneath it, then down to its own place (its name once out).
    const column = this.#cols.find((k) => k.includes(key))!, above = this.#boxes.get(column[column.indexOf(key) - 1] ?? '');
    if (how.slide && above && !by && !still()) {
      this.#plane.insertBefore(el, above.el);
      // Out quickly, as a drawer is pulled (forge-desk.css .coming), the camera a beat behind it (#go): never carried
      // out of sight still under the other.
      el.classList.add('born', 'coming');
      el.addEventListener('transitionend', () => el.classList.remove('born'), {once: true});
      const out = (e: TransitionEvent) => { if (e.target === el && e.propertyName === 'translate') { el.classList.remove('coming'); el.removeEventListener('transitionend', out); } };
      el.addEventListener('transitionend', out);
      this.#comingAt = performance.now();
      this.#bornUnder = {key, above: above.key};
      el.style.width = `${this.#bw}px`;
      // (Its height read first: reading it draws it, and it is to be drawn first where it starts.)
      const tall = el.offsetHeight;
      standAt(el, above.slot.x, above.slot.y + Math.max(0, above.el.offsetHeight - tall));
      box.placed = true;
    }
    this.#relay();
  }

  /** The name over `key` written over in its place (a new file's, as it comes). */
  name(key: string) {
    const b = this.#boxes.get(key) ?? (this.#beside?.box.key === key ? this.#beside.box : undefined);
    // Its name is shown at once, being written, even while the box is still on its way out.
    b?.el.classList.remove('born');
    const name = b?.label.querySelector<HTMLElement>('.desk-name');
    if (b?.laid.rename && name) b.laid.rename(name);
  }

  /** `key` taken off the desk; the box in hand, if it was, is the one beside it. */
  lift(key: string, atOnce = false) {
    // The one beside the desk: gone, and the desk is the whole face again.
    if (this.#beside?.box.key === key) {
      this.#beside.box.el.remove();
      this.#beside = null;
      this.side.hidden = true;
      this.#relay();
      return;
    }
    const b = this.#boxes.get(key);
    if (!b) return;
    const after = next(this.#cols, key, 'up') ?? next(this.#cols, key, 'down') ?? next(this.#cols, key, 'left') ?? next(this.#cols, key, 'right');
    this.#sized.unobserve(b.el);
    // Taken off (its dot, the file gone): it goes in a beat where it lies, the others closing up after it and the camera
    // gliding with them; never a cut. Taken off for one in its place (a file renamed), at once.
    if (atOnce || still()) b.el.remove();
    else {
      b.el.inert = true;
      b.el.style.pointerEvents = 'none';
      b.el.animate([{opacity: 1, scale: '1'}, {opacity: 0, scale: '.97'}], {duration: 140, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'})
        .finished.then(() => b.el.remove(), () => b.el.remove());
    }
    this.#boxes.delete(key);
    this.#cols = this.#cols.map((c) => c.filter((k) => k !== key)).filter((c, i) => c.length || i === 0);
    this.#relay(true);
    if (this.#held === key) { this.#held = null; if (after) this.take(after); }
  }

  /** The name said over `key` changed (a file renamed). */
  named(key: string, name: string, dir: string) {
    const b = this.#boxes.get(key) ?? (this.#beside?.box.key === key ? this.#beside.box : undefined);
    if (!b) return;
    b.label.querySelector('.desk-dir')!.textContent = dir;
    b.label.querySelector('.desk-name')!.textContent = name;
  }

  /** `key` in hand, the camera going to it (gliding there, unless `glide` is false), with the keyboard (`focus`).
   * `stay`: taken where it is seen, it stays there (staysAt): 'where', pressed; 'near', the keyboard gone to it. Gone
   * to from elsewhere (a file opened, a line found), it is put at its standard place: its top at the eye. */
  take(key: string, focus = true, glide = true, stay: 'where' | 'near' | null = null) {
    // Beside the desk it stands where it is: the keyboard goes into it, the desk's own box in hand stays.
    if (this.#beside?.box.key === key) { if (focus) this.#beside.box.laid.focus(); return; }
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    if (this.#bornUnder && this.#bornUnder.key !== key) this.#bornUnder = null;
    const at = stay ? this.#staysAt(b, stay) : null;
    this.#held = key;
    this.#framed = null;
    this.#topAt = at;
    this.#look(glide);
    if (focus) b.laid.focus();
    this.#changed();
  }

  /**
   * Where the top of `b`, taken in hand, stays on the face, or null for its standard place (its top at the eye).
   * Pressed ('where'), it stays exactly where it stands: what was pressed is under the pointer, and a line pressed
   * that then leaves the pointer is a line lost (before: any box pressed went to the top of the face, 456 px from
   * the hand; issue #174). The keyboard gone to it ('near'): where it stands while all of it is in sight; cut by the
   * face's foot, up by the least that brings it whole into sight; taller than the face, or its top out of sight, its
   * standard place. The camera on its way, there is no place to keep.
   */
  #staysAt(b: Box, stay: 'where' | 'near'): number | null {
    if (this.#glide) return null;
    const face = this.element.getBoundingClientRect(), r = b.el.getBoundingClientRect();
    if (!face.height || !r.height) return null;
    const top = r.top - face.top, foot = face.height - GRID - FOOT;
    if (stay === 'where') return top;
    if (top < EYE || r.height > foot - EYE) return null;
    return Math.min(top, foot - r.height);
  }

  /**
   * The camera over `keys` (each a box at work): on the one last at work; none, back on the box in hand.
   */
  frame(keys: string[]) {
    this.#framed = keys.length ? keys : null;
    this.#look(true);
  }

  /**
   * Where the camera stands over the framed boxes (`keys` in the order they started): on the one at work now, the
   * last, as a person looks at what they write in: in the middle across, its top at the eye (never left in the
   * middle of the face with the room over it empty); the
   * others at its sides as they lie, saying where they are. A box taller than the face goes on down from its top as
   * its line at work goes down it, a page turned as that line comes near the face's foot (lineKept), never under it.
   * Null when none lies here.
   */
  #frameView(keys: string[]): View | null {
    const boxes = keys.map((k) => this.#boxes.get(k)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    const w = this.element.clientWidth, hgt = this.element.clientHeight, v = this.#view;
    const last = boxes[boxes.length - 1], h = last.el.offsetHeight;
    const to = standardOn(last.slot, h, w, hgt);
    // The line the Agent's hand or eye is on in it, where one has it (what else at its sides tells, it does not follow).
    const work = this.#work?.key === last.key ? this.#work : null;
    // (Not while the camera is on its way: where it passes is not where it stays.)
    const there = !this.#glide && v.s === STANDARD && Math.abs(v.x - to.x) < .5;
    // A box that fits the face stands with its top at the eye; one taller stays turned down as far as it was.
    if (h <= hgt - to.y - FOOT_ROOM || !there && !work) return to;
    const turned = {...to, y: there ? Math.min(to.y, v.y) : to.y};
    const here = work ? lineKept(turned, last.slot.y + work.top, last.slot.y + work.bottom, hgt) : turned;
    return here.y > to.y ? to : here;
  }

  /** The Agent's hand or eye gone to a line of a box (`e.detail`, from the box's own top), or gone from it (null): the
   * camera over its work keeps that line in sight, turning on down as it nears the face's foot. */
  #workAt(e: CustomEvent<WorkAt | null>) {
    const box = (e.target as Element).closest<HTMLElement>('.desk-box'), key = box?.dataset.key;
    if (!box || !key) return;
    if (!e.detail) { if (this.#work?.key === key) this.#work = null; return; }
    // Where the line lies in the box, on the desk: what tells it is somewhere inside the box (a file under its name).
    const s = this.#view.s || 1, r = (e.target as Element).getBoundingClientRect(), b = box.getBoundingClientRect();
    const top = (r.top - b.top) / s + e.detail.top;
    this.#work = {key, top, bottom: top + e.detail.height};
    if (!this.#framed?.includes(key) || this.#glide || still()) return;
    const to = this.#target(), v = this.#view;
    if (to && (Math.abs(to.x - v.x) > .5 || Math.abs(to.y - v.y) > .5)) this.#go(to, true);
  }

  /** A wheel over the desk: the camera along the desk (a box's own scroll first: a Prompt's output scrolled within
   * it). With Ctrl (a pinch) it is the window's own: the desk has one size. */
  #wheel(e: WheelEvent) {
    if (e.ctrlKey || this.#moving || scrollsItself(e.target as Element, this.element, e.deltaX, e.deltaY)) return;
    e.preventDefault();
    this.#framed = null;
    this.element.scrollBy(e.deltaX, e.deltaY);
  }

  /** Places measured again (a box grew or shrank): the boxes go where they now belong, the camera with them. */
  relayout() { this.#relay(); }

  /** The boxes to their places, the camera with them: at once (or, on its way, going on to where it now goes), or gliding
   * there (`glide`: the desk changed under it, a box taken off). `grew`: laid again as a box grew or shrank: what is under it goes with it at once, as a page's lines
   * under one written do (never sliding after it, the grown box over it meanwhile), and the camera over the Agent's work
   * glides where it has to go. */
  #relay(glide = false, grew = false) {
    // Out of sight (another page shown), the desk has no size: laid out then, its boxes would be moved to where a desk of
    // none puts them, and slide back from there as it is shown again (under the camera bringing it in). They stay where
    // they are; shown again, it is laid out at its size, and nothing has moved.
    if (!this.element.clientWidth || !this.element.clientHeight) return;
    const heights = (key: string) => this.#boxes.get(key)?.el.offsetHeight ?? 0;
    // A box as wide as 80 columns of code, or as the face has room for (half the room, a box beside the desk).
    // (The face grown too narrow for two screens, a window made small: the one beside goes back; no box says it can
    // be put beside.)
    const two = this.#roomForTwo();
    this.element.classList.toggle('single', !two);
    if (this.#beside && !two) { queueMicrotask(() => this.putBack()); return; }
    const bw = this.#bw = Math.max(240, Math.min(WIDTH, this.element.clientWidth - 2 * HALF_PAD));
    for (const b of this.#boxes.values()) b.el.style.width = `${bw}px`;
    if (this.#beside) this.#beside.box.el.style.width = `${bw}px`;
    const at = slots(this.#cols, heights, bw);
    // Room round the boxes for the camera to stand any one of them in the middle, across and down (it scrolls over the
    // plane, and a scroll goes no further back than the plane's top left).
    const w = this.element.clientWidth, hgt = this.element.clientHeight, ox = Math.max(0, w / 2 - bw / 2 - PAD), oy = Math.round(hgt / 2);
    let right = 0, bottom = 0;
    for (const [key, p] of at) {
      const b = this.#boxes.get(key)!;
      p.x += ox;
      p.y += oy;
      b.slot = p;
      right = Math.max(right, p.x + bw);
      bottom = Math.max(bottom, p.y + heights(key));
      // A box born beside another, the ones after it get out of its way at once (styles: .desk-box.gives).
      b.el.classList.toggle('gives', this.#makingWay);
      // A box laid with no way in of its own stands in its place at once.
      if (!b.placed) { standAt(b.el, p.x, p.y); b.placed = true; continue; }
      const to = `${p.x}px ${p.y}px`;
      if (b.el.style.translate === to) continue;
      // (One on its way somewhere goes on there, to where it now belongs.)
      const pushed = grew && !gliding(b.el);
      b.el.style.translate = to;
      if (pushed) for (const a of b.el.getAnimations()) if (a instanceof CSSTransition && a.transitionProperty === 'translate') a.finish();
    }
    this.#makingWay = false;
    this.#plane.style.width = `${right + w}px`;
    this.#plane.style.height = `${bottom + hgt}px`;
    {
      const to = this.#target();
      // (On its way, it goes on to where it now stays: a little further, as a box grew, in the same glide; somewhere else
      // altogether, the work gone on to another box, a glide of its own from where it is, never a cut at the end.)
      if (to && this.#glide && near(this.#glide.to, to, w, hgt)) this.#glide.to = to;
      else if (to && this.#glide) this.#go(to, !still());
      // (Moved by what was done to the desk, a box taken off: the camera glides after the boxes as they close up. Over the
      // Agent's work as it grows, it glides too, where it has to go at all.)
      else if (to) {
        const v = this.#view, moves = Math.abs(to.x - v.x) > .5 || Math.abs(to.y - v.y) > .5 || to.s !== v.s;
        this.#go(to, (glide || (grew && moves && !!this.#framed)) && !still());
      }
    }
    this.#changed();
  }

  /** Where the camera should look now: over the boxes at work, or on the box in hand. None while the desk is not laid
   * out. */
  #target(): View | null {
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return null;
    const bw = this.#bw;
    const b = this.#held ? this.#boxes.get(this.#held) : this.#boxes.values().next().value;
    const under = b && this.#bornUnder?.key === b.key ? this.#boxes.get(this.#bornUnder.above) : undefined;
    // Framed over boxes at work (the Agent's, played), it stays so as they grow, until it is let go or one is taken.
    const framed = this.#framed ? this.#frameView(this.#framed) : null;
    if (framed) return framed;
    if (!b) return null;
    const to = under ? bornOn(b.slot, b.el.offsetHeight, w, hgt, under.el.offsetHeight, STANDARD, bw) : standardOn(b.slot, b.el.offsetHeight, w, hgt, STANDARD, bw);
    // Its top where it stood when it was taken in hand, whatever it has grown to since.
    if (this.#topAt === null) this.#topAt = to.y + b.slot.y * to.s;
    else to.y = this.#topAt - b.slot.y * to.s;
    return to;
  }

  /** The camera to where it should look now (`moving`: gliding there). */
  #look(moving: boolean) {
    const to = this.#target();
    if (to) this.#go(to, moving && !still());
  }

  /**
   * The camera to `to`, gliding there or at once. At rest the camera is the desk's own scroll, so what brings something
   * into view (the keyboard going into a box, a find) moves it as a scroll does; on its way the plane is moved (and, on
   * a long way, scaled: arc) instead.
   */
  #go(to: View, moving: boolean) {
    // On its way there already: it goes on as it goes, never set off again (asked again as what it frames is laid out).
    const g = this.#glide?.to;
    if (moving && g && Math.abs(g.x - to.x) < .5 && Math.abs(g.y - to.y) < .5 && Math.abs(g.s - to.s) < 1e-3) return;
    cancelAnimationFrame(this.#moving);
    this.#moving = 0;
    this.#glide = null;
    const {element: el} = this;
    // Where it is now, as a move of the plane: a scroll taken back into it.
    const from = el.scrollLeft || el.scrollTop ? {s: 1, x: -el.scrollLeft, y: -el.scrollTop} : {...this.#view};
    // Going along to what is out of sight (another column, a box far down), the camera steps back on the way and comes
    // down onto it, as a head turns across a room: never a whip across the desk at the boxes' own size.
    const long = moving ? arc(from, to, el.clientWidth, this.element.clientHeight, 560) : null;
    const ms = long ? long.ms : 560;
    const set = (v: View, done: boolean) => {
      this.#view = v;
      el.style.setProperty('--inv', String(1 / v.s));
      if (done && v.s === 1) {
        this.#plane.style.transform = '';
        // The dots are the desk's own again, going with its scroll (styles: .desk, local).
        el.style.backgroundSize = el.style.backgroundPosition = '';
        // The scroll this makes is the camera's own, not a person's going somewhere.
        this.#ownScroll = performance.now();
        el.scrollTo(-v.x, -v.y);
        this.#gliding = false;
        return;
      }
      this.#plane.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
      // The dots lie on the plane, as the boxes do: nearer or further, along or across, they go with the camera.
      el.style.backgroundSize = `${DOT * v.s}px ${DOT * v.s}px`;
      el.style.backgroundPosition = `${v.x + DOT / 2 * v.s}px ${v.y + DOT / 2 * v.s}px`;
      if (el.scrollLeft || el.scrollTop) { this.#ownScroll = performance.now(); el.scrollTo(0, 0); }
      // The caret in a box on it goes with its letter in this same frame.
      fieldCarried();
    };
    this.#gliding = true;
    if (!moving) { set(to, true); this.#gliding = false; return; }
    // What goes by under a pointer at rest was not pointed at: nothing under it lights up (forge-desk.css .resting)
    // until the pointer moves again.
    el.classList.add('resting');
    const glide = this.#glide = {to};
    // A box coming out from under another: it is out before the camera goes after it.
    const lag = performance.now() - this.#comingAt < 60 ? 90 : 0, t0 = performance.now() + lag;
    // The camera's way said as an animation of the page's, so what waits for the page to be still (a film, a look at
    // where the caret is) waits for it too.
    this.element.animate([{}, {}], {duration: lag + ms, id: 'desk-camera'});
    const step = (now: number) => {
      // A glide gone after another is let go: two at once would draw the camera back and forth a frame at a time.
      if (this.#glide !== glide) return;
      const k = Math.max(0, Math.min(1, (now - t0) / ms));
      // (Where it stays moved on the way, a box growing meanwhile, the arc ends there: what moved comes in with it.)
      if (long) {
        const e = glide.to, f = pan(k), v = long.at(f);
        set(k >= 1 ? e : {s: v.s * Math.pow(e.s / to.s, f), x: v.x + (e.x - to.x) * f, y: v.y + (e.y - to.y) * f}, k >= 1);
        veil.follow(this.#pointerAt);
        if (k < 1) this.#moving = requestAnimationFrame(step);
        else { this.#moving = 0; this.#glide = null; }
        return;
      }
      // A short way: along, from rest to rest (set off from a long way's step back, to its own size as it goes).
      const p = pan(k), end = glide.to;
      set(k >= 1 ? end : {s: from.s * Math.pow(end.s / from.s, p), x: from.x + (end.x - from.x) * p, y: from.y + (end.y - from.y) * p}, k >= 1);
      veil.follow(this.#pointerAt);
      if (k < 1) this.#moving = requestAnimationFrame(step);
      else { this.#moving = 0; this.#glide = null; }
    };
    this.#moving = requestAnimationFrame(step);
  }

  /** Scrolled (the camera moved as a scroll moves it): the box most in view is the one in hand, unless
   * one is written in: looking along the desk does not take the shadow off the box the keyboard is in. */
  #scrolledStandard() {
    if (this.#gliding || performance.now() - this.#ownScroll < 120) return;
    if (this.#strayed) return;
    const at = document.activeElement;
    if (at && at !== this.element && this.element.contains(at)) return;
    const best = this.#mostInView();
    if (!best || best.key === this.#held) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === best);
    this.#held = best.key;
    this.#changed();
  }

  /** A box still on its way to its place. */
  #sliding(): boolean {
    return this.#plane.getAnimations({subtree: true}).some((a) => a instanceof CSSTransition && a.transitionProperty === 'translate' && a.playState === 'running');
  }

  #mostInView(): Box | null {
    const view = this.element.getBoundingClientRect();
    let best: Box | null = null, most = 0;
    for (const b of this.#boxes.values()) {
      const r = b.el.getBoundingClientRect();
      const seen = Math.max(0, Math.min(r.right, view.right) - Math.max(r.left, view.left)) * Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top));
      if (seen > most) { most = seen; best = b; }
    }
    return best;
  }

  #key(e: KeyboardEvent) {
    if (e.isComposing || theirs(e)) return;
    const way = WAYS[e.key];
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    // The keyboard on the desk itself, a box in hand: not in any text.
    const onDesk = e.target === this.element && this.#held !== null;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // Escape from a box's text is the text's first (a search, a rename). One that reaches the desk takes the
      // keyboard out of the text onto the desk, and nothing moves. (Before: it also stepped the camera back, the whole
      // desk a quarter smaller for a key pressed to leave a line, and again to half; issue #173. Ctrl and -, + and 0
      // are the window's own now, as a pinch is.)
      e.preventDefault();
      this.element.focus({preventScroll: true});
    } else if ((way === 'left' || way === 'right') && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
      // Ctrl, Alt and →: the box in hand beside the desk, a second screen; Ctrl, Alt and ←: the one beside put back.
      e.preventDefault();
      if (way === 'right') this.putBeside(); else this.putBack();
    } else if (way && e.altKey && !e.defaultPrevented && (way === 'left' || way === 'right')) {
      // Alt and ← or → are a text's (moving what is written): never the browser's back and forward.
      e.preventDefault();
    } else if (onDesk && bare && e.key === 'Enter') {
      e.preventDefault();
      this.#enter();
    } else if (onDesk && bare && way) {
      e.preventDefault();
      const to = next(this.#cols, this.#held!, way);
      if (to && to !== this.#held) this.take(to, false, true, 'near');
    } else if (onDesk && e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // With no text to indent, Tab goes on to the next box (Shift+Tab back), as it goes on among things anywhere.
      e.preventDefault();
      const to = tabbed(this.#cols, this.#held!, e.shiftKey);
      if (to && to !== this.#held) this.take(to, false, true, 'near');
    } else if (onDesk && letter(e)) this.#enter();
  }

  /** Into the box in hand: the keyboard in it (a letter typed goes on in). */
  #enter() {
    if (!this.#held) return;
    this.#boxes.get(this.#held)?.laid.focus();
  }
}
