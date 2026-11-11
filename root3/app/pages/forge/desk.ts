import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {ownCamera, WORK_AT, type WorkAt} from '../../ui/camera.ts';
import {fieldCarried} from '../../ui/caret.ts';
import {t} from '../../i18n/i18n.ts';
import {mark} from '../../ui/icons.ts';
import {arc, bornOn, FOOT_ROOM, GRID, lineKept, next, PAD, pulledOn, slots, STANDARD, standardOn, tabbed, WIDTH, wholeOf, type Slot, type View} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge, the desk): what is open lies on a plane, each box as wide as 80
// columns of code, its name outside its top-left corner, on dots: files opened, each under the one opened before it.
// One box is in hand, and the camera (never the box) moves to it. One box may be put beside the rest, a second
// screen: the desk is then the left half, that box the right, each as wide as its half; put back, it lies where it
// lay. That is all the moving there is: a box is not carried about (before: Ctrl and an arrow carried the box in hand
// a slot at a time, anywhere, and Ctrl and an arrow in a text is the word's on every system).
// The keys are a game's. Tab (Shift+Tab back) puts the finger on the next box wherever the keyboard was, the keyboard
// on the desk, the camera going to it as near as it stands; an arrow, the finger on, puts it on the box that way; Enter
// (or a letter typed) goes into the box under the finger, at the standard. Escape goes round the camera's three places:
// the standard (every box at its own size, the box in hand in the middle: the balance the work is done at, never
// nearer), a step back (the boxes beside it in sight), the whole desk; stepping back it zooms first and then goes,
// coming nearer it goes first. Ctrl and - step back, Ctrl and 0 come to the standard, a pinch either way. Ctrl, Alt
// and → put the box in hand beside (an editor's keys for it), Ctrl, Alt and ← put the one beside back. Where each box
// lies, and where the camera looks, are numbers kept apart (desk-layout.ts).

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

/** The dots' pitch on the plane (styles: .desk), the first a half pitch in. */
const DOT = 24;

/** Minimum jerk: from rest to rest, nothing sudden at either end. */
const pan = (x: number) => x * x * x * (10 - 15 * x + 6 * x * x);
/** Landing: quick away, slowing into its place. */
const land = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
/** How the camera goes: along (pan); coming back to the box (in: going first, then zooming); stepping back (out:
 * zooming first, then going). */
type Way2 = 'pan' | 'in' | 'out';
interface Point { x: number; y: number }
/** The ground between a half of the face and the box that fills it, two screens side by side: a step each side. */
const HALF_PAD = GRID;

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
  /** A box's width now: 80 columns of code, or what the face has room for. */
  #bw = WIDTH;
  /** The second screen, beside the desk (the page puts it there, the desk the left half then): the one box put beside,
   * at its own size, scrolled in itself when it is taller than its room. */
  readonly side = h('div', {class: 'desk-side', hidden: ''});
  /** The box put beside, and where it lay on the desk (its column, its place in it): put back, it lies there. */
  #beside: {box: Box; col: number; at: number} | null = null;
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
  /** A box born beside another (desk.ts lay): the boxes after it make way for it at once, quick, as for one carried in. */
  #makingWay = false;
  /** The box come out from under another, and that one, while it is the one in hand: the camera keeps the other's foot in
   * sight over it (bornOn), until another is taken or the camera moves on. */
  #bornUnder: {key: string; above: string} | null = null;
  /** The box whose name is being written over (a file just made): the keyboard going on into it after (Enter, Escape)
   * is the way in, and brings the camera to the standard, as Enter does with the finger on a box. */
  #naming: string | null = null;
  /**
   * The finger, the pointer's own pointing hand: its fingertip on the top edge of the box in hand, a little in from its
   * right corner, while the keyboard moves between boxes (Tab, an arrow, Escape); the pointer hidden all the while. It glides from box to box, and comes out of the pointer where that was;
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
    // Its camera is the rail's too, as Forge is left and come to (main.ts select): it stands back inside the desk.
    ownCamera(this.element, {away: (ms) => this.away(ms), afar: () => this.afar(), near: (ms) => this.near(ms), far: 1, dots: null});
    this.element.addEventListener('keydown', (e) => this.#key(e));
    // Beside the desk, Ctrl, Alt and ← put the box back (the keyboard going with it).
    this.side.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey || e.isComposing || theirs(e)) return;
      e.preventDefault();
      this.putBack();
    });
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
      if (e.propertyName !== 'translate' || e.target === this.#hand || !this.#strayed || this.#sliding()) return;
      this.#strayed = false;
      const el = this.element, v = this.#view;
      if (this.#cam === 'standard' && v.s === 1 && Math.hypot(el.scrollLeft + v.x, el.scrollTop + v.y) > 1) this.#look(true);
    });
    this.element.addEventListener('wheel', (e) => this.#wheel(e), {passive: false});
    // The finger is the pointer's own pointing hand (tokens.css), drawn larger, over the boxes.
    this.#plane.append(this.#hand);
    const open = /url\("([^"]+)"\)/.exec(getComputedStyle(document.documentElement).getPropertyValue('--cursor-hand'))?.[1];
    if (open) this.#hand.style.setProperty('--hand-open', `url("${open}")`);
    // The pointer moved (not something moved under it: the camera's glide moves the page under a pointer at rest), it is
    // the one in use again: the finger gone, the pointer back.
    addEventListener('pointermove', (e) => {
      this.#pointerAt = {x: e.clientX, y: e.clientY};
      if (!e.isTrusted || (!e.movementX && !e.movementY)) return;
      this.element.classList.remove('resting');
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
  #setCam(c: Camera, glide = true, ms?: number) {
    if (c === this.#cam) { this.#arrived(); return; }
    const back = CAMERAS.indexOf(c) > CAMERAS.indexOf(this.#cam);
    this.#cam = c;
    this.#topAt = null;
    // (Come to the standard, a box just made stands at the eye as any other.)
    if (c === 'standard') this.#bornUnder = null;
    this.element.classList.toggle('pulled', c === 'pulled');
    this.element.classList.toggle('whole', c === 'whole');
    this.#look(glide, back ? 'out' : 'in', ms);
  }

  /** What waits for the camera to be where it was sent (away): told once it is, or once it is sent elsewhere. */
  #landed: (() => void) | null = null;
  #arrived() { const l = this.#landed; this.#landed = null; l?.(); }

  /** The camera the rail left the desk at, to come down to again as it comes back (null: not left). */
  #left: Camera | null = null;

  /**
   * The rail going elsewhere (main.ts select): the camera steps back over the whole desk as Escape takes it (back first,
   * then along), `ms` long, unless it stands as far back already; done once it is there. Where it stood is kept (near).
   */
  away(ms: number): Promise<void> {
    this.#left ??= this.#cam;
    // Stood back by the rail, not by the person looking over the desk: no box is pointed out in it (styles: .railed).
    this.element.classList.add('railed');
    this.#arrived();
    if (this.#cam === 'whole' || still()) return Promise.resolve();
    return new Promise((done) => { this.#landed = done; this.#setCam('whole', true, ms); });
  }

  /** Come to along the rail: over the whole desk at once, as it is seen from afar (where it stood is kept: near). */
  afar() {
    this.#left ??= this.#cam;
    this.element.classList.add('railed');
    this.#setCam('whole', false);
  }

  /** Come down from afar to where the camera stood as the rail left it, `ms` long (along first, then near). */
  near(ms: number) {
    const c = this.#left;
    this.element.classList.remove('railed');
    if (c === null) return;
    this.#left = null;
    this.#setCam(c, !still(), ms);
  }

  /** Come to anew (its page left and come back to): at the standard, on the box in hand, where its words are read.
   * (Before: left a step back, it was come back to a step back, its words some 10 px tall, with nothing to say why.) */
  home() { if (this.#cam !== 'standard') this.#setCam('standard', false); }

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

  /** How much of the desk's foot something stands over (the Prompt, bench.ts): the face the camera works in ends
   * above it, so what is worked on is never under it. */
  #foot = 0;
  set foot(covered: number) {
    const foot = Math.max(0, Math.round(covered));
    if (foot === this.#foot) return;
    this.#foot = foot;
    this.#relay();
  }
  /** The face's height: the desk's, less what stands over its foot. */
  get #hgt(): number { return Math.max(0, this.element.clientHeight - this.#foot); }

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
    if (!b || b.laid.stays) return;
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
    el.addEventListener('click', (e) => {
      // Beside the desk it stands where it is: pressed, the keyboard is in it.
      if (this.#beside?.box.key === key) { if (!el.contains(document.activeElement)) laid.focus(); return; }
      // One press and it is come to, however far back the camera stood and however little of it showed at the desk's
      // edge: in hand, at the standard, the keyboard in it. (Before: stepped back, a press only took it in hand, and
      // it took a second to come to it.) Its name pressed is its name written, the keyboard there: the box is in
      // hand, and the camera stays.
      if (this.#cam !== 'standard') {
        if ((e.target as Element).closest('.desk-label')) { if (this.#held !== key) this.take(key, false); return; }
        this.take(key, false, false);
        this.#setCam('standard');
        this.#boxes.get(key)?.laid.focus();
        return;
      }
      if (this.#held !== key || !el.contains(document.activeElement)) this.take(key, !el.contains(document.activeElement));
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
    if (b) this.#naming = key;
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

  /** `key` in hand, the camera going to it as near as it stands (gliding there, unless `glide` is false; over the whole
   * desk, staying); with the keyboard (`focus`), at the standard. */
  take(key: string, focus = true, glide = true) {
    // Beside the desk it stands where it is: the keyboard goes into it, the desk's own box in hand stays.
    if (this.#beside?.box.key === key) { if (focus) this.#beside.box.laid.focus(); return; }
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    if (this.#bornUnder && this.#bornUnder.key !== key) this.#bornUnder = null;
    // The finger goes with it, from where it is.
    if (this.#held !== key && this.#handAt) this.#handGlide = {from: this.#handAt, t0: performance.now(), ms: 320};
    this.#held = key;
    this.#placeHand();
    this.#framed = null;
    this.#topAt = null;
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
    // Work begun is watched as a person goes to work: in to the standard, where its words are read, however far the
    // camera stood back (a box carried, a file just made, the whole desk looked over); it does not start out there.
    if (keys.length && this.#cam !== 'standard') this.#setCam('standard');
    else if (this.#cam === 'standard') this.#look(true);
  }

  /**
   * Where the camera stands over the framed boxes (`keys` in the order they started), at the standard: on the one at
   * work now, the last, as a person looks at what they write in: at its own size, in the middle across, its top at
   * the eye (never left in the middle of the face with the room over it empty, nor stood back over all of them); the
   * others at its sides as they lie, saying where they are. A box taller than the face goes on down from its top as
   * its line at work goes down it, a page turned as that line comes near the face's foot (lineKept), never under it.
   * Null when none lies here.
   */
  #frameView(keys: string[]): View | null {
    const boxes = keys.map((k) => this.#boxes.get(k)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    const w = this.element.clientWidth, hgt = this.#hgt, v = this.#view;
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
    if (!this.#framed?.includes(key) || this.#cam !== 'standard' || this.#glide || still()) return;
    const to = this.#target(), v = this.#view;
    if (to && (Math.abs(to.x - v.x) > .5 || Math.abs(to.y - v.y) > .5)) this.#go(to, true);
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
    const bw = this.#bw = Math.max(240, Math.min(WIDTH, this.element.clientWidth - 2 * HALF_PAD));
    for (const b of this.#boxes.values()) b.el.style.width = `${bw}px`;
    if (this.#beside) this.#beside.box.el.style.width = `${bw}px`;
    const at = slots(this.#cols, heights, bw);
    // Room round the boxes for the camera to stand any one of them in the middle, across and down (it scrolls over the
    // plane, and a scroll goes no further back than the plane's top left).
    const w = this.element.clientWidth, hgt = this.#hgt, ox = Math.max(0, w / 2 - bw / 2 - PAD), oy = Math.round(hgt / 2);
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
    this.#placeHand();
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

  /** Where the camera should look now: over the whole desk; a step back, on the box in hand; at the standard, over the
   * boxes at work or on the box in hand. None while the desk is not laid out. */
  #target(): View | null {
    const w = this.element.clientWidth, hgt = this.#hgt;
    if (!w || !hgt) return null;
    const bw = this.#bw;
    if (this.#cam === 'whole') return wholeOf([...this.#boxes.values()].map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt, bw);
    const b = this.#held ? this.#boxes.get(this.#held) : this.#boxes.values().next().value;
    const under = b && this.#bornUnder?.key === b.key ? this.#boxes.get(this.#bornUnder.above) : undefined;
    // (Stood back, a box just made is in the middle with what it came from above it in sight: no more is needed.)
    if (this.#cam === 'pulled') {
      if (!b) return null;
      const first = this.#cols.find((c) => c.includes(b.key))?.[0], top = (first ? this.#boxes.get(first)?.slot.y : undefined) ?? b.slot.y;
      return pulledOn(b.slot, b.el.offsetHeight, w, hgt, top, bw);
    }
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

  /** The camera to where it should look now (`moving`: gliding there, the way `how`). */
  #look(moving: boolean, how: Way2 = 'pan', ms?: number) {
    const to = this.#target();
    if (to) this.#go(to, moving && !still(), how, ms);
    else this.#arrived();
  }

  /**
   * The camera to `to`, gliding there (the way `how`) or at once. At the standard (at its own size) the camera is the
   * desk's own scroll, so what brings something into view (the keyboard going into a box, a find) moves it as a scroll
   * does; stepped back (or on its way) the plane is moved and scaled instead. Its way is told by where the box in hand
   * stands on the face and how near: going along, both at once; coming back, it goes before it zooms; stepping back, it
   * zooms before it goes.
   */
  #go(to: View, moving: boolean, how: Way2 = 'pan', ms: number | undefined = undefined) {
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
    const long = how === 'pan' && moving ? arc(from, to, el.clientWidth, this.#hgt, ms ?? 560) : null;
    ms ??= long ? long.ms : how === 'pan' ? 560 : 520;
    const set = (v: View, done: boolean) => {
      this.#view = v;
      el.style.setProperty('--inv', String(1 / v.s));
      if (done) this.#arrived();
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
    // The box in hand's middle, on the desk: where it is on the face, and how near, are what move.
    // (The box in hand out of sight, the camera over other work, the Agent's: what is in the face's middle, so stepping
    // back is about what is seen, never a slide off to where the box in hand lies.)
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const middle = {x: (el.clientWidth / 2 - from.x) / from.s, y: (el.clientHeight / 2 - from.y) / from.s};
    const inHand = b ? {x: b.slot.x + this.#bw / 2, y: b.slot.y + b.el.offsetHeight / 2} : null;
    const seen = (p: Point) => { const x = from.x + p.x * from.s, y = from.y + p.y * from.s; return x >= 0 && x <= el.clientWidth && y >= 0 && y <= el.clientHeight; };
    const m0 = inHand && seen(inHand) ? inHand : middle;
    const mid = (_p: number) => m0;
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
      // (Where it stays moved on the way, a box growing meanwhile, the arc ends there: what moved comes in with it.)
      if (long) {
        const e = glide.to, f = pan(k), v = long.at(f);
        set(k >= 1 ? e : {s: v.s * Math.pow(e.s / to.s, f), x: v.x + (e.x - to.x) * f, y: v.y + (e.y - to.y) * f}, k >= 1);
        veil.follow(this.#pointerAt);
        if (k < 1) this.#moving = requestAnimationFrame(step);
        else { this.#moving = 0; this.#glide = null; }
        return;
      }
      const [p, q] = how === 'in' ? [land(k / .45), land((k - .45) / .55)] : how === 'out' ? [land((k - .55) / .45), land(k / .55)] : [pan(k), pan(k)];
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
    } else if ((way === 'left' || way === 'right') && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
      // Ctrl, Alt and →: the box in hand beside the desk, a second screen; Ctrl, Alt and ←: the one beside put back.
      e.preventDefault();
      if (way === 'right') this.putBeside(); else this.putBack();
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
      const to = {x: tx + (parseFloat(cs.marginLeft) || 0) + this.#bw, y: ty + (parseFloat(cs.marginTop) || 0)};
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
