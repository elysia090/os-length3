import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import {carried, next, overAll, PAD, pulledOn, slots, standardOn, tabbed, WIDTH, wholeOf, type Slot, type View} from './desk-layout.ts';

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

/** Where the camera stands: at its standard, a step back, over the whole desk (Escape goes round them in this order). */
type Camera = 'standard' | 'pulled' | 'whole';
const CAMERAS: readonly Camera[] = ['standard', 'pulled', 'whole'];

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
/** How the camera goes: along (pan); coming back to the box (in: going first, then zooming); stepping back (out:
 * zooming first, then going). */
type Way2 = 'pan' | 'in' | 'out';

interface Box { key: string; laid: Laid; el: HTMLElement; label: HTMLElement; slot: Slot }

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
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || !this.#held) return;
      e.preventDefault();
      e.stopPropagation();
      this.#point(tabbed(this.#cols, this.#held, e.shiftKey));
    }, true);
    // The keyboard gone into a box (a press, a key that summons the Prompt): that box is in hand, the camera with it.
    // Gone there by a press, the box is taken once the press is let go (its click), never under the pointer.
    this.element.addEventListener('focusin', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key !== this.#held && key !== this.#pressing) this.take(key, false);
    });
    // Written in, the box in hand is come back to: at the standard when the camera stood back from it, and from over the
    // Agent's work (their terminal written in).
    this.element.addEventListener('keydown', (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace')) return;
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (!key || key !== this.#held) return;
      if (this.#cam !== 'standard') { this.#framed = null; this.#setCam('standard'); }
      else if (this.#framed) { this.#framed = null; this.#topAt = null; this.#look(true); }
    }, true);
    this.element.addEventListener('pointerdown', (e) => { this.#pressing = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key ?? null; }, true);
    for (const end of ['pointerup', 'pointercancel'] as const) addEventListener(end, () => { setTimeout(() => { this.#pressing = null; }); }, true);
    new ResizeObserver(() => this.#relay()).observe(this.element);
    this.element.addEventListener('scroll', () => this.#scrolledStandard());
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
      document.documentElement.classList.remove('desk-nocursor');
      this.#showHand(false);
    }, {capture: true, passive: true});
    // Written in a box, the finger and the pointer are out of the way until the pointer moves.
    this.element.addEventListener('keydown', (e) => {
      if (e.target === this.element || !letter(e)) return;
      this.#showHand(false);
      document.documentElement.classList.add('desk-nocursor');
    });
  }

  /** The camera to `c` (gliding there, unless `glide` is false): stepping back it zooms and then goes, coming nearer it
   * goes and then zooms. */
  #setCam(c: Camera, glide = true) {
    if (c === this.#cam) return;
    const back = CAMERAS.indexOf(c) > CAMERAS.indexOf(this.#cam);
    this.#cam = c;
    this.#topAt = null;
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

  /** `laid` put on the desk as `key`: beside the box `beside` (a column of its own after that one's), in column `col`,
   * or under the box in hand (the first box, the first column). */
  lay(key: string, laid: Laid, col?: number, beside?: string) {
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
      el.style.translate = `${by.slot.x}px ${by.slot.y}px`;
      // (Where it starts taken as its style before it is moved, so it goes from there.)
      void el.offsetWidth;
    } else this.#plane.append(el);
    this.#sized.observe(el);
    const box: Box = {key, laid, el, label, slot: {x: 0, y: 0}};
    this.#boxes.set(key, box);
    const byCol = by ? this.#cols.findIndex((k) => k.includes(by.key)) : -1;
    if (byCol >= 0) this.#cols.splice(byCol + 1, 0, [key]);
    else if (col !== undefined) {
      while (this.#cols.length <= col) this.#cols.push([]);
      this.#cols[col].push(key);
    } else {
      const c = this.#held === null ? -1 : this.#cols.findIndex((k) => k.includes(this.#held!));
      if (c < 0) this.#cols[0].push(key);
      else this.#cols[c].splice(this.#cols[c].indexOf(this.#held!) + 1, 0, key);
    }
    this.#relay();
  }

  /** `key` taken off the desk; the box in hand, if it was, is the one beside it. */
  lift(key: string) {
    const b = this.#boxes.get(key);
    if (!b) return;
    const after = next(this.#cols, key, 'up') ?? next(this.#cols, key, 'down') ?? next(this.#cols, key, 'left') ?? next(this.#cols, key, 'right');
    this.#sized.unobserve(b.el);
    b.el.remove();
    this.#boxes.delete(key);
    this.#cols = this.#cols.map((c) => c.filter((k) => k !== key)).filter((c, i) => c.length || i === 0);
    this.#relay();
    if (this.#held === key) { this.#held = null; if (after) this.take(after); }
  }

  /** The name said over `key` changed (a file renamed). */
  named(key: string, name: string, dir: string) {
    const b = this.#boxes.get(key);
    if (!b) return;
    b.label.querySelector('.desk-dir')!.textContent = dir;
    b.label.querySelector('.desk-name')!.textContent = name;
  }

  /** `key` in hand, the camera going to it as near as it stands (gliding there, unless `glide` is false; over the whole
   * desk, staying); with the keyboard (`focus`), at the standard. */
  take(key: string, focus = true, glide = true) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    // The finger goes with it, from where it is.
    if (this.#held !== key && this.#handAt) this.#handGlide = {from: this.#handAt, t0: performance.now(), ms: 320};
    this.#held = key;
    this.#placeHand();
    this.#framed = null;
    this.#topAt = null;
    if (focus && this.#cam !== 'standard') this.#setCam('standard', glide);
    else this.#look(glide);
    if (focus) b.laid.focus();
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
   * Where the camera stands over the framed boxes, at the standard: over all of them when they fit; else where it
   * stands while one of them is well in sight there (no going to and fro between lanes at work side by side), else on
   * the one last at work. Null when none lies here.
   */
  #frameView(keys: string[]): View | null {
    const boxes = keys.map((k) => this.#boxes.get(k)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    const all = overAll(boxes.map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt);
    if (all) return all;
    const v = this.#view;
    if (v.s === 1 && boxes.some((b) => this.#seen(b, v, w, hgt) >= .4)) return {...v};
    const last = boxes[boxes.length - 1];
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

  /** Held up (`on`): the box in hand lifted, its shadow longer, the hand closed on it; put down, with a small give. */
  #lifted(on: boolean) {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    if (!b || b.el.classList.contains('lifted') === on) return;
    b.el.classList.toggle('lifted', on);
    if (on) this.#showHand(true);
    this.#hand.classList.toggle('shut', on);
    this.#placeHand();
    if (!on && !still()) b.el.animate([{scale: '1'}, {scale: '.992'}, {scale: '1'}], {duration: 200, easing: 'ease-out'});
  }

  /** Places measured again (a box grew or shrank): the boxes go where they now belong, the camera with them. */
  relayout() { this.#relay(); }

  /** The boxes to their places, the camera with them: at once (or, on its way, going on to where it now goes), or
   * following them a little behind (`follow`: a box carried). */
  #relay(follow = false) {
    const heights = (key: string) => this.#boxes.get(key)?.el.offsetHeight ?? 0;
    const at = slots(this.#cols, heights);
    // Room round the boxes for the camera to stand any one of them in the middle, across and down (it scrolls over the
    // plane, and a scroll goes no further back than the plane's top left).
    const w = this.element.clientWidth, hgt = this.element.clientHeight, ox = Math.max(0, w / 2 - WIDTH / 2 - PAD), oy = Math.round(hgt / 2);
    let right = 0, bottom = 0;
    for (const [key, p] of at) {
      const b = this.#boxes.get(key)!;
      p.x += ox;
      p.y += oy;
      b.slot = p;
      right = Math.max(right, p.x + WIDTH);
      bottom = Math.max(bottom, p.y + heights(key));
      b.el.style.width = `${WIDTH}px`;
      b.el.style.translate = `${p.x}px ${p.y}px`;
    }
    this.#plane.style.width = `${right + w}px`;
    this.#plane.style.height = `${bottom + hgt}px`;
    this.#placeHand();
    if (follow) this.#look(true, 'pan', 900);
    else {
      const to = this.#target();
      if (to && this.#glide) this.#glide.to = to;
      else if (to) this.#go(to, false);
    }
    this.#changed();
  }

  /** Where the camera should look now: over the whole desk; a step back, on the box in hand; at the standard, over the
   * boxes at work or on the box in hand. None while the desk is not laid out. */
  #target(): View | null {
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return null;
    if (this.#cam === 'whole') return wholeOf([...this.#boxes.values()].map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt);
    const b = this.#held ? this.#boxes.get(this.#held) : this.#boxes.values().next().value;
    if (this.#cam === 'pulled') return b ? pulledOn(b.slot, b.el.offsetHeight, w, hgt) : null;
    // Framed over boxes at work (the Agent's, played), it stays so as they grow, until it is let go or one is taken.
    const framed = this.#framed ? this.#frameView(this.#framed) : null;
    if (framed) return framed;
    if (!b) return null;
    const to = standardOn(b.slot, b.el.offsetHeight, w, hgt);
    // Its top where it stood when it was taken in hand, whatever it has grown to since.
    if (this.#topAt === null) this.#topAt = to.y + b.slot.y * to.s;
    else to.y = this.#topAt - b.slot.y * to.s;
    return to;
  }

  /** The camera to where it should look now (`moving`: gliding there, the way `how`, in `ms`). */
  #look(moving: boolean, how: Way2 = 'pan', ms?: number) {
    const to = this.#target();
    if (to) this.#go(to, moving && !still(), how, ms);
  }

  /**
   * The camera to `to`, gliding there (the way `how`) or at once. At the standard (at its own size) the camera is the
   * desk's own scroll, so what brings something into view (the keyboard going into a box, a find) moves it as a scroll
   * does; stepped back (or on its way) the plane is moved and scaled instead. Its way is told by where the box in hand
   * stands on the face and how near: going along, both at once; coming back, it goes before it zooms; stepping back, it
   * zooms before it goes.
   */
  #go(to: View, moving: boolean, how: Way2 = 'pan', ms = how === 'pan' ? 560 : 520) {
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
    // The box in hand's middle, on the desk: where it is on the face, and how near, are what move.
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const m = b ? {x: b.slot.x + WIDTH / 2, y: b.slot.y + b.el.offsetHeight / 2} : {x: (el.clientWidth / 2 - from.x) / from.s, y: (el.clientHeight / 2 - from.y) / from.s};
    const pf = {x: m.x * from.s + from.x, y: m.y * from.s + from.y};
    const glide = this.#glide = {to};
    const t0 = performance.now();
    // The camera's way said as an animation of the page's, so what waits for the page to be still (a film, a look at
    // where the caret is) waits for it too.
    this.element.animate([{}, {}], {duration: ms, id: 'desk-camera'});
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const [p, q] = how === 'in' ? [land(k / .45), land((k - .45) / .55)] : how === 'out' ? [land((k - .55) / .45), land(k / .55)] : [pan(k), pan(k)];
      const end = glide.to, pt = {x: m.x * end.s + end.x, y: m.y * end.s + end.y};
      const s = from.s * Math.pow(end.s / from.s, q);
      const at = {x: pf.x + (pt.x - pf.x) * p, y: pf.y + (pt.y - pf.y) * p};
      set(k >= 1 ? end : {s, x: at.x - m.x * s, y: at.y - m.y * s}, k >= 1);
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
    if (e.isComposing) return;
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
    } else if (e.key === 'Control' && !e.repeat && finger) {
      // Ctrl, the finger on a box: the hand closes on it, held up to be carried.
      this.#lifted(true);
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

  /** The box in hand carried a slot `way`, lifted (put down once Ctrl is let go), the camera following it. */
  #carry(way: Way) {
    const key = this.#held!;
    this.#lifted(true);
    const was = this.#cols.map((c) => c.join('\n')).join('\t');
    this.#cols = carried(this.#cols, key, way);
    if (this.#cols.map((c) => c.join('\n')).join('\t') === was) { this.#bump(way); return; }
    this.#topAt = null;
    this.#relay(true);
  }

  /** The finger shown (`on`), the pointer hidden while it is (out of the pointer, where that was over the desk), or gone. */
  #showHand(on: boolean) {
    if (on) document.documentElement.classList.add('desk-nocursor');
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
