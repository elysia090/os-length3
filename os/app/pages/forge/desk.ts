import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import {bornOn, carried, kept, liftedOn, next, overAll, PAD, pulledOn, slots, standardOn, tabbed, WIDTH, wholeOf, type Slot, type View} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge, the desk): what is open lies on a plane, each box as wide as 80
// columns of code, its name outside its top-left corner, on dots. The Prompt's box is the first; files opened lie
// beside it, each under the one opened before it. One box is in hand, and the camera (never the box) moves to it.
// The keys are a game's. Tab (Shift+Tab back) puts the finger on the next box wherever the keyboard was, the keyboard
// on the desk, the camera going to it as near as it stands; an arrow, the finger on, puts it on the box that way; Enter
// (or a letter typed) goes into the box under the finger, at the standard. Escape goes round the camera's three places:
// the standard (every box at its own size, the box in hand in the middle: the balance the work is done at, never
// nearer), a step back (the boxes beside it in sight), the whole desk; stepping back it zooms first and then goes,
// coming nearer it goes first. Ctrl and - step back, Ctrl and 0 come to the standard, a pinch either way. Ctrl and an
// arrow carry the box in hand a slot wherever the keyboard is: lifted while Ctrl is held, the others stepping over, the
// camera following a little behind; Ctrl let go, it is put down. Where each box lies, and where the camera looks, are
// numbers kept apart (desk-layout.ts).

/** What lies on the desk: its element, and the name said over it (its folder quiet before it, and after it, quiet,
 * what more it is: the Prompt's folder). */
export interface Laid {
  element: HTMLElement; name: string; dir: string; after?: string; focus(): void;
  /** Its name pressed: written over in place (a file's). */
  rename?(name: HTMLElement): void;
}

type Way = 'up' | 'down' | 'left' | 'right';
const WAYS: Record<string, Way> = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'};
/** Each way's other way: a step carried that way is taken back. */
const BACK: Record<Way, Way> = {up: 'down', down: 'up', left: 'right', right: 'left'};

/** Where the camera stands: at its standard, a step back, over the whole desk (Escape goes round them in this order). */
type Camera = 'standard' | 'pulled' | 'whole';
const CAMERAS: readonly Camera[] = ['standard', 'pulled', 'whole'];

/** Whether a key is a program's: one in a terminal reading each key as it comes (vi, less) has every key, as at a
 * terminal (its line says so, data-raw). */
const theirs = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.('[data-raw]');

/** A letter typed with no Ctrl, Alt or ⌘ (a space is a button's, / the search's): with the finger on a box, it goes into it. */
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

/** Minimum jerk: from rest to rest, nothing sudden at either end. */
const pan = (x: number) => x * x * x * (10 - 15 * x + 6 * x * x);
/** Landing: quick away, slowing into its place. */
const land = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
/** A cubic Bézier from rest to rest, as CSS's cubic-bezier(x1, y1, x2, y2): how far along at `x` of the time. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  return (x: number) => {
    if (x <= 0 || x >= 1) return Math.min(1, Math.max(0, x));
    let lo = 0, hi = 1;
    for (let k = 0; k < 20; k++) { const t = (lo + hi) / 2; if (at(x1, x2, t) < x) lo = t; else hi = t; }
    return at(y1, y2, (lo + hi) / 2);
  };
}
/** A box's way to its place, and its time (styles: .desk-box, its translate): the camera made to go with a box goes so. */
const slide = bezier(.45, 0, .2, 1);
const SLIDE_MS = 640;
/** Back over the desk as a box is held up: quick, done before the arrow that carries it is pressed; and how long Ctrl
 * is held on it first (a shortcut's Ctrl, Ctrl and S, Ctrl and -, is let go or joined by its key before then). */
const LIFT_MS = 300;
const LIFT_WAIT = 140;
/** How the camera goes: along (pan); coming back to the box (in: going first, then zooming); stepping back (out:
 * zooming first, then going); with a box carried (slide: as it slides, the same way in the same time); back over the
 * desk as a box is held up (lift: going and zooming at once, as a slide, quick). */
type Way2 = 'pan' | 'in' | 'out' | 'slide' | 'lift';
interface Point { x: number; y: number }
/** A box carried a slot: its middle on the desk where it stood, and the camera over the desk to stand still at, if it
 * is the first slot it is carried (none: the camera stands still already). */
interface Carried { from: Point; over: View | null }

/** A box on the desk; `placed` once it has stood somewhere (before, it has no place to move from). */
interface Box { key: string; laid: Laid; el: HTMLElement; label: HTMLElement; slot: Slot; placed?: boolean }


/**
 * The pointer out of sight where it rests (the finger shown, or the keyboard writing in a box): `cursor: none` on what
 * is under it alone, moved to what comes under it as the desk glides beneath it, put back as it was once it moves. (A
 * class on the page's root with a rule for everything under it had the style of every element worked out again, 4–5 ms,
 * at each key that brought the finger.)
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
  #cam: Camera = 'standard';
  #view: View = {s: 1, x: 0, y: 0};
  /** The camera's glide under way (its next frame; none at rest), and where it is going: laid again on its way (a box
   * grown), it goes on to where it is now to go rather than starting again. */
  #moving = 0;
  #glide: {to: View} | null = null;
  /** When a pinch last moved the camera a place: one place for one pinch. */
  #pinched = 0;
  /** The camera on its way (its scroll is its own then, not someone's going somewhere). */
  #gliding = false;
  /** When a box last began to come out from under the one above it: the camera lets it come out before it follows. */
  #comingAt = -Infinity;
  /** The box come out from under another, and that one, while it is the one in hand: the camera keeps the other's foot in
   * sight over it (bornOn), until another is taken or the camera moves on. */
  #bornUnder: {key: string; above: string} | null = null;
  /** The box whose name is being written over (a file just made): the keyboard going on into it after (Enter, Escape)
   * is the way in, and brings the camera to the standard, as Enter does with the finger on a box. */
  #naming: string | null = null;
  /** The way the box in hand was carried, a step at a time, and how the desk stood before each: an arrow the other way
   * takes the last step back exactly (where it stood in its column too), as a sheet slid out is slid back where it
   * was. Forgotten once another box is taken, or the desk changes otherwise. */
  #trail: {key: string; steps: {way: Way; cols: string[][]}[]} | null = null;
  /**
   * The finger, the pointer's own pointing hand: its fingertip on the top edge of the box in hand, a little in from its
   * right corner, while the keyboard moves between boxes (Tab, an arrow, Escape, Ctrl), closed on the box while it is
   * held up; the pointer hidden all the while. It glides from box to box, and comes out of the pointer where that was;
   * the pointer moved, it is gone and the pointer back. Written in, both are gone until the pointer moves.
   */
  readonly #hand = h('div', {class: 'desk-hand', 'aria-hidden': 'true'});
  /** Where the fingertip is on the desk; its glide under way (from where, since when, how long); its frame. */
  #handAt: {x: number; y: number} | null = null;
  #handGlide: {from: {x: number; y: number}; t0: number; ms: number} | null = null;
  #handFrame = 0;
  /** Where the pointer last was on the face, and whether it is the one in use (moved since the keyboard last was). */
  #pointerAt: {x: number; y: number} | null = null;
  /** A key pressed while boxes slid: what it scrolled into view is not where the camera is to stay. */
  #strayed = false;
  /** The boxes the camera stands over at once (the Agent's at work), or none. */
  #framed: string[] | null = null;
  /** Where the box in hand's top stands on the face, as it was when it was taken in hand: it stays there as the box
   * grows or shrinks under the work (none: to be found again). */
  #topAt: number | null = null;
  /** Where the camera stands still while a box is carried, a step back about it, two boxes side by side in sight
   * (liftedOn): the box goes across the desk, the camera never after it (one after it, a little behind, left the box
   * neither still nor moving). Moved only as far as keeps the box in sight, with it. Let go once the box is put down
   * (the camera back where it stood, on the box) or the camera is moved otherwise. */
  #still: View | null = null;
  /** The camera the box in hand was held up at, while it is held up. */
  #liftedFrom: Camera | null = null;
  /** The camera's going back over the desk, waiting on Ctrl held a moment; and whether the box held up has been carried
   * yet (a key other than an arrow before then was a shortcut's: the camera stays the person's). */
  #lifting = 0;
  #carrying = false;
  /** Each box's size heard: grown or shrunk (a line written, a notice in its head), the desk is laid again. */
  readonly #sized = new ResizeObserver(() => { cancelAnimationFrame(this.#sizing); this.#sizing = requestAnimationFrame(() => this.#relay()); });
  #sizing = 0;
  /** When the camera last scrolled the desk itself. */
  #ownScroll = 0;
  /** The box a press under way is on (the camera waits for it to be let go: its click takes it in hand). */
  #pressing: string | null = null;
  readonly #shut: (key: string) => void;

  readonly #changed: () => void;

  /** `label`: what the desk is called, to be heard (the repo's files), `repo` whose it is; `shut`: a box's own close pressed (its key);
   * `changed`: what lies where, or which is in hand, changed (to be kept). */
  constructor(label: string, repo: string, shut: (key: string) => void, changed: () => void = () => {}) {
    this.#shut = shut;
    this.#changed = changed;
    this.#plane = h('div', {class: 'desk-plane'});
    this.element = h('section', {class: 'desk', tabindex: '-1', 'aria-label': label, 'data-repo': repo}, this.#plane);
    this.element.addEventListener('keydown', (e) => this.#key(e));
    // Tab is the desk's wherever the keyboard is on it, before what it is in (a file, the Prompt's line): the finger to
    // the next box, Shift+Tab to the one before.
    this.element.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || !this.#held || theirs(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.#point(tabbed(this.#cols, this.#held, e.shiftKey));
    }, true);
    // The keyboard gone into a box (a press, a key that summons the Prompt): that box is in hand, the camera with it.
    // Gone there by a press, the box is taken once the press is let go (its click), never under the pointer.
    this.element.addEventListener('focusin', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key !== this.#held && key !== this.#pressing) this.take(key, false);
      // Named, the keyboard gone on into the box (not into its name): in, at the standard.
      if (this.#naming && !(e.target as Element).closest('.desk-label')) {
        const named = this.#naming;
        this.#naming = null;
        if (key === named && this.#cam !== 'standard') this.#setCam('standard');
      }
    });
    // Written in, the box in hand is come back to: at the standard when the camera stood back from it, and from over the
    // Agent's work (their terminal written in).
    const writtenIn = (at: EventTarget | null) => {
      // (Its name written, it is not yet gone into: the camera stays where it stands.)
      if ((at as Element | null)?.closest?.('.desk-label')) return;
      const key = (at as Element | null)?.closest?.<HTMLElement>('.desk-box')?.dataset.key;
      if (!key || key !== this.#held) return;
      if (this.#cam !== 'standard') { this.#framed = null; this.#setCam('standard'); }
      else if (this.#framed) { this.#framed = null; this.#topAt = null; this.#look(true); }
    };
    this.element.addEventListener('keydown', (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace')) return;
      writtenIn(e.target);
    }, true);
    // (Written in with no key: a paste, a word chosen from the input method's, a dictation.)
    this.element.addEventListener('beforeinput', (e) => writtenIn(e.target), true);
    this.element.addEventListener('pointerdown', (e) => { this.#pressing = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key ?? null; }, true);
    for (const end of ['pointerup', 'pointercancel'] as const) addEventListener(end, () => { setTimeout(() => { this.#pressing = null; }); }, true);
    new ResizeObserver(() => { this.#still = null; this.#relay(); }).observe(this.element);
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
      if (e.propertyName !== 'translate' || e.target === this.#hand || !this.#strayed || this.#sliding()) return;
      this.#strayed = false;
      const el = this.element, v = this.#view;
      if (this.#cam === 'standard' && v.s === 1 && Math.hypot(el.scrollLeft + v.x, el.scrollTop + v.y) > 1) this.#look(true);
    });
    this.element.addEventListener('wheel', (e) => this.#wheel(e), {passive: false});
    // Stepped back, a box pressed twice is come back to.
    this.element.addEventListener('dblclick', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (this.#cam !== 'standard' && key) { this.take(key, false, false); this.#setCam('standard'); this.#boxes.get(key)?.laid.focus(); }
    });
    // Held up by Ctrl (the finger on a box) or Ctrl and an arrow (anywhere), the box is put down once Ctrl is let go,
    // or the keyboard leaves the desk.
    this.element.addEventListener('keyup', (e) => { if (e.key === 'Control') this.#lifted(false); });
    this.element.addEventListener('focusout', () => this.#lifted(false));
    // The finger is the pointer's own pointing hand (tokens.css), drawn larger, over the boxes.
    this.#plane.append(this.#hand);
    const open = /url\("([^"]+)"\)/.exec(getComputedStyle(document.documentElement).getPropertyValue('--cursor-hand'))?.[1];
    if (open) this.#hand.style.setProperty('--hand-open', `url("${open}")`);
    // The pointer moved (not something moved under it: the camera's glide moves the page under a pointer at rest), it is
    // the one in use again: the finger gone, the pointer back.
    addEventListener('pointermove', (e) => {
      this.#pointerAt = {x: e.clientX, y: e.clientY};
      if (!e.isTrusted || (!e.movementX && !e.movementY)) return;
      veil.show();
      this.#showHand(false);
    }, {capture: true, passive: true});
    // Written in a box, the finger and the pointer are out of the way until the pointer moves: a key, or what comes in
    // as written without one (a paste, a word the input method gives, text put in).
    const writing = () => { this.#showHand(false); veil.hide(this.#pointerAt); };
    this.element.addEventListener('keydown', (e) => { if (e.target !== this.element && letter(e)) writing(); });
    this.element.addEventListener('beforeinput', (e) => { if (e.target !== this.element) writing(); });
  }

  /** The camera to `c` (gliding there, unless `glide` is false): stepping back it zooms and then goes, coming nearer it
   * goes and then zooms. */
  #setCam(c: Camera, glide = true) {
    this.#still = null;
    if (c === this.#cam) return;
    const back = CAMERAS.indexOf(c) > CAMERAS.indexOf(this.#cam);
    this.#cam = c;
    this.#topAt = null;
    // (Come to the standard, a box just made stands at the eye as any other.)
    if (c === 'standard') this.#bornUnder = null;
    this.element.classList.toggle('pulled', c === 'pulled');
    this.element.classList.toggle('whole', c === 'whole');
    this.#look(glide, back ? 'out' : 'in');
  }

  /** The camera a place back (`by` 1) or nearer (-1), no further than the whole desk nor nearer than the standard. */
  #step(by: 1 | -1) {
    this.#setCam(CAMERAS[Math.max(0, Math.min(CAMERAS.length - 1, CAMERAS.indexOf(this.#cam) + by))]);
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
  has(key: string): boolean { return this.#boxes.has(key); }
  /** The keys on the desk, column by column. */
  get columns(): string[][] { return this.#cols.map((c) => [...c]); }

  /**
   * `laid` put on the desk as `key`: beside the box `beside` (a column of its own after that one's), in column `col`,
   * or under the box in hand (the first box, the first column). `how.slide`: it comes out from under the box above it,
   * sliding down to its place (one opened now, not one laid again as it was left); `how.instead`: it takes the place
   * of that box, where it lies, as it is (a file renamed: no move at all), in hand if that one was.
   */
  lay(key: string, laid: Laid, col?: number, beside?: string, how: {slide?: boolean; instead?: string; top?: boolean} = {}) {
    if (this.#boxes.has(key)) return;
    const name = h('span', {class: 'desk-name'}, laid.name);
    const label = h('div', {class: 'desk-label'}, h('span', {class: 'desk-dir'}, laid.dir), name,
      ...(laid.after ? [h('span', {class: 'desk-dir desk-after'}, laid.after)] : []));
    const rename = laid.rename;
    if (rename) name.addEventListener('click', () => { if (!getSelection()?.toString()) rename(name); });
    const close = h('button', {type: 'button', class: 'desk-close', 'aria-label': t('Close {name}', {name: laid.name})});
    close.addEventListener('click', (e) => { e.stopPropagation(); this.#shut(key); });
    const el = h('div', {class: 'desk-box', 'data-key': key}, label, laid.element, close);
    // Pressed (what was pressed in it done first: a line run, a link), it is in hand; the camera moves after the
    // press, never under it.
    el.addEventListener('click', () => {
      // Stepped back, a press only takes it in hand (twice, it is come back to).
      if (this.#cam !== 'standard') { if (this.#held !== key) this.take(key, false); return; }
      if (this.#held !== key || !el.contains(document.activeElement)) this.take(key, !el.contains(document.activeElement));
    });
    const by = beside === undefined ? undefined : this.#boxes.get(beside);
    // Born beside another (the Agent's terminal beside the person's): a column of its own just right of that one's,
    // the columns after it making way; it comes out from under that box, sliding across to its place.
    if (by) {
      this.#plane.insertBefore(el, by.el);
      // Its name comes once it is out from under the other's.
      el.classList.add('born');
      el.addEventListener('transitionend', () => el.classList.remove('born'), {once: true});
      el.style.width = `${WIDTH}px`;
      standAt(el, by.slot.x, by.slot.y);
    } else this.#plane.append(el);
    this.#sized.observe(el);
    const box: Box = {key, laid, el, label, slot: {x: 0, y: 0}, placed: !!by};
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
      el.style.width = `${WIDTH}px`;
      standAt(el, was.slot.x, was.slot.y);
      if (this.#held === was.key) {
        this.#held = key;
        el.classList.add('held');
      }
      // (A file renamed as it is named: still the one being named, and come out from under the same box.)
      if (this.#naming === was.key) this.#naming = key;
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
      el.style.width = `${WIDTH}px`;
      // (Its height read first: reading it draws it, and it is to be drawn first where it starts.)
      const tall = el.offsetHeight;
      standAt(el, above.slot.x, above.slot.y + Math.max(0, above.el.offsetHeight - tall));
      box.placed = true;
    }
    this.#still = null;
    this.#relay();
  }

  /** The name over `key` written over in its place (a new file's, as it comes). */
  name(key: string) {
    const b = this.#boxes.get(key);
    if (b) this.#naming = key;
    // Its name is shown at once, being written, even while the box is still on its way out.
    b?.el.classList.remove('born');
    const name = b?.label.querySelector<HTMLElement>('.desk-name');
    if (b?.laid.rename && name) b.laid.rename(name);
  }

  /** `key` taken off the desk; the box in hand, if it was, is the one beside it. */
  lift(key: string, atOnce = false) {
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
    this.#trail = null;
    this.#still = null;
    this.#relay(null, true);
    if (this.#held === key) { this.#held = null; if (after) this.take(after); }
  }

  /** The name said over `key` changed (a file renamed). */
  named(key: string, name: string, dir: string) {
    const b = this.#boxes.get(key);
    if (!b) return;
    b.label.querySelector('.desk-dir')!.textContent = dir;
    b.label.querySelector('.desk-name')!.textContent = name;
  }

  /** The camera a step back from the standard (where it stands back already, it stays): a file just made is laid
   * where it is seen with what is round it, and Enter (the finger on it, or its name written) goes in to it. */
  stepBack() {
    if (this.#cam === 'standard') this.#setCam('pulled');
  }

  /** `key` in hand, the camera going to it as near as it stands (gliding there, unless `glide` is false; over the whole
   * desk, staying); with the keyboard (`focus`), at the standard. */
  take(key: string, focus = true, glide = true) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    if (this.#bornUnder && this.#bornUnder.key !== key) this.#bornUnder = null;
    if (this.#trail && this.#trail.key !== key) this.#trail = null;
    // The finger goes with it, from where it is.
    if (this.#held !== key && this.#handAt) this.#handGlide = {from: this.#handAt, t0: performance.now(), ms: 320};
    this.#held = key;
    this.#placeHand();
    this.#framed = null;
    this.#topAt = null;
    this.#still = null;
    if (focus && this.#cam !== 'standard') this.#setCam('standard', glide);
    else this.#look(glide);
    // The keyboard into it: the finger, the keyboard's on the desk, goes (as Enter into it takes it away).
    if (focus) { this.#showHand(false); b.laid.focus(); }
    this.#changed();
  }

  /**
   * The camera over `keys` at once (each box at work), at the standard: over all of them when they fit, else on the one
   * last at work; none, back on the box in hand. Stood back, the camera stays where the person put it.
   */
  frame(keys: string[]) {
    this.#framed = keys.length ? keys : null;
    if (this.#cam === 'standard') this.#look(true);
  }

  /**
   * Where the camera stands over the framed boxes, at the standard: over all of them when they fit; else sideways to
   * the one last to start (`keys` in the order they started: the work going on now), whole in the middle, the others
   * at its sides a sliver each, saying where they are and that they are at work too. Already whole in sight, it stays.
   * Null when none lies here.
   */
  #frameView(keys: string[]): View | null {
    const boxes = keys.map((k) => this.#boxes.get(k)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    const all = overAll(boxes.map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt);
    if (all) return all;
    const v = this.#view, last = boxes[boxes.length - 1];
    // (Not while the camera is on its way: where it passes is not where it stays, and a glide told to end where it is
    // now goes back on itself.)
    if (!this.#glide && v.s === 1 && this.#seen(last, v, w, hgt) >= .98) return {...v};
    return standardOn(last.slot, last.el.offsetHeight, w, hgt);
  }

  /** How much of `b` the camera at `v` shows in a face `w` by `hgt` (0 to 1). */
  #seen(b: Box, v: View, w: number, hgt: number): number {
    const h = b.el.offsetHeight || 1;
    const l = v.x + b.slot.x * v.s, t = v.y + b.slot.y * v.s, r = l + WIDTH * v.s, bt = t + h * v.s;
    const seen = Math.max(0, Math.min(r, w) - Math.max(l, 0)) * Math.max(0, Math.min(bt, hgt) - Math.max(t, 0));
    return seen / (WIDTH * v.s * h * v.s);
  }

  /** A wheel over the desk: with Ctrl (a pinch), the camera a place back or nearer; without it, the camera along the
   * desk at the standard (a box's own scroll first: a Prompt's output scrolled within it). */
  #wheel(e: WheelEvent) {
    if (e.ctrlKey) {
      e.preventDefault();
      if (Math.abs(e.deltaY) < 4 || performance.now() - this.#pinched < 400) return;
      this.#pinched = performance.now();
      this.#step(e.deltaY > 0 ? 1 : -1);
      return;
    }
    if (this.#cam !== 'standard' || this.#moving || scrollsItself(e.target as Element, this.element, e.deltaX, e.deltaY)) return;
    e.preventDefault();
    this.#framed = null;
    this.element.scrollBy(e.deltaX, e.deltaY);
  }

  /** Held up (`on`): the box in hand lifted, its shadow longer, the hand closed on it, and (`look`: Ctrl held a moment,
   * the finger on it) the camera stepping back over the desk it is to go across, before it goes. Put down, with a small
   * give, the camera back to where it stood, on the box where it now lies. */
  #lifted(on: boolean, look = false) {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    if (!b || b.el.classList.contains('lifted') === on) return;
    b.el.classList.toggle('lifted', on);
    // (Held up, the boxes' closes are gone: the desk is being laid out, not cleared; they come back once it is down.)
    this.element.classList.toggle('carrying', on);
    if (on) this.#showHand(true);
    this.#hand.classList.toggle('shut', on);
    this.#placeHand();
    clearTimeout(this.#lifting);
    this.#lifting = 0;
    if (on) {
      this.#liftedFrom = this.#cam;
      this.#carrying = false;
      if (look) this.#lifting = window.setTimeout(() => this.#liftCamera(), LIFT_WAIT);
      return;
    }
    if (!still()) b.el.animate([{scale: '1'}, {scale: '.992'}, {scale: '1'}], {duration: 200, easing: 'ease-out'});
    const was = this.#liftedFrom;
    this.#liftedFrom = null;
    if (was && this.#still) { this.#still = null; this.#look(true, 'in'); }
  }

  /** Ctrl held on the box in hand a moment, nothing carried yet: the camera a step back about it. */
  #liftCamera() {
    this.#lifting = 0;
    const over = this.#liftedFrom && !this.#carrying ? this.#overDesk() : null;
    if (over) { this.#still = over; this.#look(true, 'lift'); }
  }

  /** A key other than an arrow while a box is held up: a shortcut's, not a carry. The camera back where it stood, if
   * nothing was carried (the key then moves it as it moves it), and not taken back once Ctrl is let go. */
  #liftDropped() {
    clearTimeout(this.#lifting);
    this.#lifting = 0;
    this.#liftedFrom = null;
    if (!this.#carrying && this.#still) { this.#still = null; this.#look(true); }
  }

  /** Places measured again (a box grew or shrank): the boxes go where they now belong, the camera with them. */
  relayout() { this.#relay(); }

  /** The boxes to their places, the camera with them: at once (or, on its way, going on to where it now goes), gliding
   * there (`glide`: the desk changed under it, a box taken off), or standing still as a box is carried across it
   * (`follow`). */
  #relay(follow: Carried | null = null, glide = false) {
    const heights = (key: string) => this.#boxes.get(key)?.el.offsetHeight ?? 0;
    const at = slots(this.#cols, heights);
    // Room round the boxes for the camera to stand any one of them in the middle, across and down (it scrolls over the
    // plane, and a scroll goes no further back than the plane's top left).
    const w = this.element.clientWidth, hgt = this.element.clientHeight, ox = Math.max(0, w / 2 - WIDTH / 2 - PAD), oy = Math.round(hgt / 2);
    let right = 0, bottom = 0;
    // The box carried: where it stood (its top left, its height).
    const lifted = follow && this.#held ? this.#boxes.get(this.#held) : undefined;
    const carried = follow && lifted ? {l: follow.from.x - WIDTH / 2, t: follow.from.y - lifted.el.offsetHeight / 2, h: lifted.el.offsetHeight} : null;
    for (const [key, p] of at) {
      const b = this.#boxes.get(key)!;
      p.x += ox;
      p.y += oy;
      b.slot = p;
      right = Math.max(right, p.x + WIDTH);
      bottom = Math.max(bottom, p.y + heights(key));
      b.el.style.width = `${WIDTH}px`;
      // Carried past, the others answer it: one coming into where it was waits for it to be gone (fills); the rest get out
      // of its way, all at once, quick and a little jostled (gives), so the box is seen to cut in, not the desk to be laid
      // again (styles: .desk-box.gives, .fills).
      b.el.classList.remove('gives', 'fills');
      if (carried && key !== this.#held) {
        const fills = p.x < carried.l + WIDTH && p.x + WIDTH > carried.l && p.y < carried.t + carried.h && p.y + heights(key) > carried.t;
        b.el.classList.add(fills ? 'fills' : 'gives');
      }
      // A box laid with no way in of its own stands in its place at once.
      if (b.placed) b.el.style.translate = `${p.x}px ${p.y}px`;
      else { standAt(b.el, p.x, p.y); b.placed = true; }
    }
    this.#plane.style.width = `${right + w}px`;
    this.#plane.style.height = `${bottom + hgt}px`;
    this.#placeHand();
    if (follow) this.#follow(follow);
    else {
      const to = this.#target();
      if (to && this.#glide) this.#glide.to = to;
      // (Moved by what was done to the desk, a box taken off: the camera glides after the boxes as they close up.)
      else if (to) this.#go(to, glide && !still());
    }
    this.#changed();
  }

  /** Where the camera should look now: over the whole desk; a step back, on the box in hand; at the standard, over the
   * boxes at work or on the box in hand. None while the desk is not laid out. */
  #target(): View | null {
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return null;
    if (this.#still) return this.#still;
    if (this.#cam === 'whole') return wholeOf([...this.#boxes.values()].map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt);
    const b = this.#held ? this.#boxes.get(this.#held) : this.#boxes.values().next().value;
    const under = b && this.#bornUnder?.key === b.key ? this.#boxes.get(this.#bornUnder.above) : undefined;
    // (Stood back, a box just made is in the middle with what it came from above it in sight: no more is needed.)
    if (this.#cam === 'pulled') {
      if (!b) return null;
      const first = this.#cols.find((c) => c.includes(b.key))?.[0], top = (first ? this.#boxes.get(first)?.slot.y : undefined) ?? b.slot.y;
      return pulledOn(b.slot, b.el.offsetHeight, w, hgt, top);
    }
    // Framed over boxes at work (the Agent's, played), it stays so as they grow, until it is let go or one is taken.
    const framed = this.#framed ? this.#frameView(this.#framed) : null;
    if (framed) return framed;
    if (!b) return null;
    const to = under ? bornOn(b.slot, b.el.offsetHeight, w, hgt, under.el.offsetHeight) : standardOn(b.slot, b.el.offsetHeight, w, hgt);
    // Its top where it stood when it was taken in hand, whatever it has grown to since.
    if (this.#topAt === null) this.#topAt = to.y + b.slot.y * to.s;
    else to.y = this.#topAt - b.slot.y * to.s;
    return to;
  }

  /** The camera to where it should look now (`moving`: gliding there, the way `how`). */
  #look(moving: boolean, how: Way2 = 'pan') {
    const to = this.#target();
    if (to) this.#go(to, moving && !still(), how);
  }

  /** Where the camera stands while the box in hand is carried: a step back about it where it is on the face, two boxes
   * side by side in sight (liftedOn). */
  #overDesk(): View | null {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const el = this.element, w = el.clientWidth, hgt = el.clientHeight;
    if (!b || !w || !hgt) return null;
    const cur = this.#glide?.to ?? (el.scrollLeft || el.scrollTop ? {s: 1, x: -el.scrollLeft, y: -el.scrollTop} : this.#view);
    return liftedOn(cur, b.slot, b.el.offsetHeight, w, hgt);
  }

  /** A box carried a slot (`c`): the camera still (held up with Ctrl, it stands back already), unless it is the first
   * slot carried at once (back about the box then, as it slides: one move, not two) or the box would go out of sight
   * (as far as keeps it in, with it). Moving, it goes as the box goes, the same way in the same time, the box's own way
   * across the face one straight move. */
  #follow(c: Carried) {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const base = c.over ?? this.#still;
    if (!b || !base) { this.#look(true); return; }
    const to = kept(base, b.slot, b.el.offsetHeight, this.element.clientWidth, this.element.clientHeight);
    const path = {from: c.from, to: {x: b.slot.x + WIDTH / 2, y: b.slot.y + b.el.offsetHeight / 2}};
    // (Still on its way back, or after the slot before, it goes on there as the box goes.)
    if (c.over || to !== this.#still || this.#glide) { this.#still = to; this.#go(to, !still(), 'slide', SLIDE_MS, path); }
  }

  /**
   * The camera to `to`, gliding there (the way `how`) or at once. At the standard (at its own size) the camera is the
   * desk's own scroll, so what brings something into view (the keyboard going into a box, a find) moves it as a scroll
   * does; stepped back (or on its way) the plane is moved and scaled instead. Its way is told by where the box in hand
   * stands on the face and how near: going along, both at once; coming back, it goes before it zooms; stepping back, it
   * zooms before it goes.
   */
  #go(to: View, moving: boolean, how: Way2 = 'pan', ms = how === 'pan' ? 560 : how === 'slide' ? SLIDE_MS : how === 'lift' ? LIFT_MS : 520, path?: {from: Point; to: Point}) {
    cancelAnimationFrame(this.#moving);
    this.#moving = 0;
    this.#glide = null;
    const {element: el} = this;
    // Where it is now, as a move of the plane: a scroll taken back into it.
    const from = el.scrollLeft || el.scrollTop ? {s: 1, x: -el.scrollLeft, y: -el.scrollTop} : {...this.#view};
    const set = (v: View, done: boolean) => {
      this.#view = v;
      el.style.setProperty('--inv', String(1 / v.s));
      if (done && v.s === 1) {
        this.#plane.style.transform = '';
        // The scroll this makes is the camera's own, not a person's going somewhere.
        this.#ownScroll = performance.now();
        el.scrollTo(-v.x, -v.y);
        this.#gliding = false;
        return;
      }
      this.#plane.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
      if (el.scrollLeft || el.scrollTop) { this.#ownScroll = performance.now(); el.scrollTo(0, 0); }
    };
    this.#gliding = true;
    if (!moving) { set(to, true); this.#gliding = false; return; }
    // The box in hand's middle, on the desk: where it is on the face, and how near, are what move. Carried (`path`), it
    // is where the box is on its way, so the box goes across the face in one straight move however the camera moves.
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const m0 = b ? {x: b.slot.x + WIDTH / 2, y: b.slot.y + b.el.offsetHeight / 2} : {x: (el.clientWidth / 2 - from.x) / from.s, y: (el.clientHeight / 2 - from.y) / from.s};
    const mid = (p: number) => (path ? {x: path.from.x + (path.to.x - path.from.x) * p, y: path.from.y + (path.to.y - path.from.y) * p} : m0);
    const pf = {x: mid(0).x * from.s + from.x, y: mid(0).y * from.s + from.y};
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
      const [p, q] = how === 'slide' || how === 'lift' ? [slide(k), slide(k)] : how === 'in' ? [land(k / .45), land((k - .45) / .55)] : how === 'out' ? [land((k - .55) / .45), land(k / .55)] : [pan(k), pan(k)];
      const end = glide.to, m1 = mid(1), pt = {x: m1.x * end.s + end.x, y: m1.y * end.s + end.y};
      const s = from.s * Math.pow(end.s / from.s, q), m = mid(p);
      const at = {x: pf.x + (pt.x - pf.x) * p, y: pf.y + (pt.y - pf.y) * p};
      set(k >= 1 ? end : {s, x: at.x - m.x * s, y: at.y - m.y * s}, k >= 1);
      veil.follow(this.#pointerAt);
      if (k < 1) this.#moving = requestAnimationFrame(step);
      else { this.#moving = 0; this.#glide = null; }
    };
    this.#moving = requestAnimationFrame(step);
  }

  /** Scrolled at the standard (the camera moved as a scroll moves it): the box most in view is the one in hand. */
  #scrolledStandard() {
    if (this.#gliding || this.#cam !== 'standard' || performance.now() - this.#ownScroll < 120) return;
    if (this.#strayed) return;
    const best = this.#mostInView();
    if (!best || best.key === this.#held) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === best);
    this.#held = best.key;
    this.#changed();
  }

  /** A box still on its way to its place (the hand going to one is not: nothing it passes is brought into view). */
  #sliding(): boolean {
    return this.#plane.getAnimations({subtree: true}).some((a) => a instanceof CSSTransition && a.transitionProperty === 'translate'
      && a.playState === 'running' && a.effect instanceof KeyframeEffect && a.effect.target !== this.#hand);
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
    const zoom = (e.ctrlKey || e.metaKey) && !e.altKey;
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    // The finger on a box: the keyboard on the desk itself.
    const finger = e.target === this.element && this.#held !== null;
    if (this.#liftedFrom && e.key !== 'Control' && !(way && e.ctrlKey)) this.#liftDropped();
    if (zoom && e.key === '-') { e.preventDefault(); this.#step(1); }
    // Never nearer than the standard: Ctrl and + comes a place nearer, Ctrl and 0 to the standard.
    else if (zoom && (e.key === '=' || e.key === '+')) { e.preventDefault(); this.#step(-1); }
    else if (zoom && e.key === '0') { e.preventDefault(); this.#setCam('standard'); }
    else if (e.key === 'Escape' && !e.defaultPrevented) {
      // Escape from a box's text is the text's first (a search, a rename): one that reaches the desk takes the camera
      // round its places, the keyboard on the desk and the finger on the box in hand.
      e.preventDefault();
      this.element.focus({preventScroll: true});
      this.#showHand(true);
      this.#setCam(CAMERAS[(CAMERAS.indexOf(this.#cam) + 1) % CAMERAS.length]);
    } else if (e.key === 'Control' && !e.repeat && finger) {
      // Ctrl, the finger on a box: the hand closes on it, held up to be carried, the camera back over the desk.
      this.#lifted(true, true);
    } else if (way && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && this.#held) {
      e.preventDefault();
      this.#carry(way);
    } else if (way && e.altKey && !e.defaultPrevented && (way === 'left' || way === 'right')) {
      // Alt and ← or → are a text's (moving what is written): never the browser's back and forward.
      e.preventDefault();
    } else if (finger && bare && e.key === 'Enter') {
      e.preventDefault();
      this.#enter();
    } else if (finger && bare && way) {
      e.preventDefault();
      this.#point(next(this.#cols, this.#held!, way), way);
    } else if (finger && letter(e)) this.#enter();
  }

  /** The finger on `to`, the keyboard on the desk (none there: the box in hand nudged toward `way`). */
  #point(to: string | null, way?: Way) {
    if (document.activeElement !== this.element) this.element.focus({preventScroll: true});
    this.#showHand(true);
    if (to && to !== this.#held) this.take(to, false);
    else if (!to && way) this.#bump(way);
  }

  /** Into the box under the finger, at the standard: the keyboard in it, the finger gone (a letter typed goes on in). */
  #enter() {
    if (!this.#held) return;
    this.#showHand(false);
    // At the standard the camera is on it already: it stays where it stands, only the keyboard goes in.
    if (this.#cam === 'standard') this.#boxes.get(this.#held)?.laid.focus();
    else this.take(this.#held);
  }

  /** The box in hand carried a slot `way`, lifted (put down once Ctrl is let go), across a desk that stands still. */
  #carry(way: Way) {
    const key = this.#held!;
    this.#lifted(true);
    const was = this.#cols, laid = (cols: string[][]) => cols.map((c) => c.join('\n')).join('\t');
    if (this.#trail?.key !== key) this.#trail = {key, steps: []};
    const last = this.#trail.steps.at(-1), back = last && last.way === BACK[way];
    const to = back ? last.cols : carried(was, key, way);
    if (laid(to) === laid(was)) { this.#bump(way); return; }
    // Where it stands, and (first carried) the camera over the desk as it stands, read before it goes.
    clearTimeout(this.#lifting);
    this.#lifting = 0;
    this.#carrying = true;
    const b = this.#boxes.get(key)!, from = {x: b.slot.x + WIDTH / 2, y: b.slot.y + b.el.offsetHeight / 2};
    const over = this.#still ? null : this.#overDesk();
    if (back) this.#trail.steps.pop();
    else this.#trail.steps.push({way, cols: was.map((c) => [...c])});
    this.#cols = to;
    this.#topAt = null;
    this.#relay({from, over});
  }

  /** The finger shown (`on`), the pointer hidden while it is (out of the pointer, where that was over the desk), or gone. */
  #showHand(on: boolean) {
    if (on) veil.hide(this.#pointerAt);
    if (this.#hand.classList.contains('on') === on) return;
    this.#hand.classList.toggle('on', on);
    if (!on) { this.#handGlide = null; return; }
    const r = this.#plane.getBoundingClientRect(), s = r.width / (this.#plane.offsetWidth || 1);
    const p = this.#pointerAt, e = this.element.getBoundingClientRect();
    const over = p && p.x >= e.left && p.x <= e.right && p.y >= e.top && p.y <= e.bottom;
    this.#handAt = null;
    this.#handGlide = over && s ? {from: {x: (p.x - r.left) / s, y: (p.y - r.top) / s}, t0: performance.now(), ms: 240} : null;
    this.#placeHand();
  }

  /** The finger kept on the box in hand as it is now (sliding to its place, held up), gliding there: a frame at a time
   * while it is shown and anything moves. */
  #placeHand() {
    if (this.#handFrame || !this.#hand.classList.contains('on')) return;
    const frame = () => {
      this.#handFrame = 0;
      const b = this.#held ? this.#boxes.get(this.#held) : undefined;
      if (!b || !this.#hand.classList.contains('on')) return;
      // The box where it is drawn now: on its way to its place, or held up off it.
      const cs = getComputedStyle(b.el), [tx = 0, ty = 0] = cs.translate.split(' ').map(parseFloat);
      const to = {x: tx + (parseFloat(cs.marginLeft) || 0) + WIDTH, y: ty + (parseFloat(cs.marginTop) || 0)};
      let at = to;
      const g = this.#handGlide;
      if (g && !still()) {
        const k = Math.min(1, (performance.now() - g.t0) / g.ms), e = pan(k);
        at = {x: g.from.x + (to.x - g.from.x) * e, y: g.from.y + (to.y - g.from.y) * e};
        if (k >= 1) this.#handGlide = null;
      } else this.#handGlide = null;
      const was = this.#handAt;
      this.#handAt = at;
      this.#hand.style.translate = `${at.x}px ${at.y}px`;
      veil.follow(this.#pointerAt);
      // Still once it stands where it should and nothing it follows moves.
      if (this.#handGlide || !was || Math.abs(was.x - at.x) + Math.abs(was.y - at.y) > .01 || b.el.getAnimations().length) this.#handFrame = requestAnimationFrame(frame);
    };
    this.#handFrame = requestAnimationFrame(frame);
  }

  /** Nothing that way: the box in hand nudged toward it and back. */
  #bump(way: Way) {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    if (!b || still()) return;
    const [dx, dy] = way === 'left' ? [-1, 0] : way === 'right' ? [1, 0] : way === 'up' ? [0, -1] : [0, 1];
    b.el.animate([{transform: 'none'}, {transform: `translate(${10 * dx}px, ${10 * dy}px)`}, {transform: `translate(${-6 * dx}px, ${-6 * dy}px)`}, {transform: 'none'}],
      {duration: 220, easing: 'ease-out'});
  }
}
