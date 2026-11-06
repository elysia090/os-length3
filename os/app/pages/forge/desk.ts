import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import {baseOn, carried, closeOn, next, overAll, PAD, slots, WIDTH, type Slot, type View} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge, the desk): what is open lies on a plane, each box as wide as 80
// columns of code, its name outside its top-left corner, on dots. The Prompt's box is the first; files opened lie
// beside it, each under the one opened before it. One box is in hand, and the camera (never the box) moves to it: at
// the base, every box at its own size, the box in hand in the middle across, under the top; close, as near as it fits across,
// where the work in it is kept in sight as it goes (Ctrl and + or a pinch come close, Ctrl and -, Ctrl and 0, Escape
// or a pinch out go back to the base; never further back than the base). Alt and an arrow hand over to the next box
// that way; Alt, Shift and an arrow carry the box in hand a slot, the others stepping over (Ctrl and an arrow stay the
// text's own word moves). Where each box lies, and where the camera looks, are numbers kept apart (desk-layout.ts).

/** What lies on the desk: its element, and the name said over it (its folder quiet before it, and after it, quiet,
 * what more it is: the Prompt's folder). */
export interface Laid {
  element: HTMLElement; name: string; dir: string; after?: string; focus(): void;
  /** Its name pressed: written over in place (a file's). */
  rename?(name: HTMLElement): void;
}

type Way = 'up' | 'down' | 'left' | 'right';
const WAYS: Record<string, Way> = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'};

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

interface Box { key: string; laid: Laid; el: HTMLElement; label: HTMLElement; slot: Slot }

export class Desk {
  readonly element: HTMLElement;
  readonly #plane: HTMLElement;
  readonly #boxes = new Map<string, Box>();
  #cols: string[][] = [[]];
  #held: string | null = null;
  /** Close (nearer the box in hand, as near as it fits across) rather than at the base. */
  #near = false;
  #view: View = {s: 1, x: 0, y: 0};
  #moving = 0;
  /** The camera on its way (its scroll is its own then, not someone's going somewhere). */
  #gliding = false;
  /** The boxes the camera stands over at once (the Agent's at work), or none. */
  #framed: string[] | null = null;
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
    // The keyboard gone into a box (Tab, a key that summons the Prompt): that box is in hand, the camera with it.
    this.element.addEventListener('focusin', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key !== this.#held) this.take(key, false);
    });
    new ResizeObserver(() => this.#relay()).observe(this.element);
    this.element.addEventListener('scroll', () => this.#scrolledBase());
    this.element.addEventListener('wheel', (e) => this.#wheel(e), {passive: false});
    // Close, the camera keeps where the work is in sight as it goes (a line written past the face's edge, the caret
    // taken down the box).
    const follow = () => { if (this.#near && !this.#moving && this.element.contains(document.activeElement)) this.#follow(true); };
    this.element.addEventListener('input', follow);
    this.element.addEventListener('keyup', follow);
  }

  /** Whether the camera is close (nearer the box in hand), not at the base. */
  get near(): boolean { return this.#near; }

  /** The camera close to the box in hand (`on`), or back at the base. */
  setNear(on: boolean) {
    if (on === this.#near || (on && !this.#held)) return;
    this.#near = on;
    this.#framed = null;
    this.element.classList.toggle('near', on);
    this.#look(true);
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

  /** `laid` put on the desk as `key`: in column `col`, or under the box in hand (the first box, the first column). */
  lay(key: string, laid: Laid, col?: number) {
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
    el.addEventListener('click', () => { if (this.#held !== key || !el.contains(document.activeElement)) this.take(key, !el.contains(document.activeElement)); });
    this.#plane.append(el);
    const box: Box = {key, laid, el, label, slot: {x: 0, y: 0}};
    this.#boxes.set(key, box);
    if (col !== undefined) {
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

  /** `key` in hand: the camera goes to it, as near as it was (gliding there, unless `glide` is false), and it has the
   * keyboard. */
  take(key: string, focus = true, glide = true) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    this.#held = key;
    this.#framed = null;
    this.#look(glide);
    if (focus) b.laid.focus();
    this.#changed();
  }

  /**
   * The camera over `keys` at once (each box at work), at the base: over all of them when they fit, else on the one
   * last at work; none, back on the box in hand.
   */
  frame(keys: string[]) {
    this.#framed = keys.length ? keys : null;
    if (this.#framed && this.#near) { this.#near = false; this.element.classList.remove('near'); }
    this.#look(true);
  }

  /** Where the camera stands over the framed boxes; null when none of them lies here. */
  #frameView(keys: string[]): View | null {
    const boxes = keys.map((k) => this.#boxes.get(k)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    const all = overAll(boxes.map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt);
    if (all) return all;
    // Not all in sight at once: where it stands, while one at work is well in sight there (no going to and fro between
    // lanes at work side by side); else on the one last at work.
    const v = this.#view;
    if (v.s === 1 && boxes.some((b) => this.#seen(b, v, w, hgt) >= .4)) return {...v};
    const last = boxes[boxes.length - 1];
    return baseOn(last.slot, last.el.offsetHeight, w, hgt);
  }

  /** How much of `b` the camera at `v` shows in a face `w` by `hgt` (0 to 1). */
  #seen(b: Box, v: View, w: number, hgt: number): number {
    const h = b.el.offsetHeight || 1;
    const l = v.x + b.slot.x * v.s, t = v.y + b.slot.y * v.s, r = l + WIDTH * v.s, bt = t + h * v.s;
    const seen = Math.max(0, Math.min(r, w) - Math.max(l, 0)) * Math.max(0, Math.min(bt, hgt) - Math.max(t, 0));
    return seen / (WIDTH * v.s * h * v.s);
  }

  /** Where the work is in `b` (the caret in its text, from the box's top left, at its own size); none, its top. */
  #caret(b: Box): {x: number; y: number} | null {
    const a = document.activeElement;
    if (!(a instanceof HTMLTextAreaElement) || !b.el.contains(a)) return null;
    const before = a.value.slice(0, a.selectionEnd);
    const line = before.split('\n').length - 1, col = before.length - before.lastIndexOf('\n') - 1;
    const cs = getComputedStyle(a), lh = parseFloat(cs.lineHeight) || 20, cw = (parseFloat(cs.fontSize) || 14) * .6015;
    let x = 0, y = 0;
    for (let e: HTMLElement | null = a; e && e !== b.el; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
    return {x: x + col * cw - a.scrollLeft, y: y + (line + .5) * lh - a.scrollTop};
  }

  /** Close, the work gone out of the middle of the face (a line written past its edge, the caret taken down, the box
   * grown under it): the camera goes with it (`gliding`, or at once). */
  #follow(gliding: boolean) {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const at = b && this.#caret(b);
    if (!b || !at) return;
    const w = this.element.clientWidth, hgt = this.element.clientHeight, v = this.#view;
    const sx = v.x + (b.slot.x + at.x) * v.s, sy = v.y + (b.slot.y + at.y) * v.s;
    if (sx > 48 && sx < w - 48 && sy > hgt * .18 && sy < hgt * .82) return;
    this.#go(closeOn(b.slot, b.el.offsetHeight, w, hgt, at), gliding && !still(), 260);
  }

  /** A wheel over the desk: with Ctrl (a pinch), close or back to the base; without it, the camera along the desk (a
   * box's own scroll first: a Prompt's output scrolled within it). */
  #wheel(e: WheelEvent) {
    if (e.ctrlKey) {
      e.preventDefault();
      if (Math.abs(e.deltaY) >= 4) this.setNear(e.deltaY < 0);
      return;
    }
    if (this.#moving || scrollsItself(e.target as Element, this.element, e.deltaX, e.deltaY)) return;
    e.preventDefault();
    this.#framed = null;
    if (!this.#near) { this.element.scrollBy(e.deltaX, e.deltaY); return; }
    const v = this.#view;
    this.#go({s: v.s, x: v.x - e.deltaX, y: v.y - e.deltaY}, false);
  }

  /** Places measured again (a box grew or shrank): the boxes go where they now belong, the camera with them. */
  relayout() { this.#relay(); }

  #relay() {
    const heights = (key: string) => this.#boxes.get(key)?.el.offsetHeight ?? 0;
    const at = slots(this.#cols, heights);
    // Room round the boxes for the camera to stand any one of them in the middle (it scrolls over the plane).
    const w = this.element.clientWidth, hgt = this.element.clientHeight, ox = Math.max(0, w / 2 - WIDTH / 2 - PAD);
    let right = 0, bottom = 0;
    for (const [key, p] of at) {
      const b = this.#boxes.get(key)!;
      p.x += ox;
      b.slot = p;
      right = Math.max(right, p.x + WIDTH);
      bottom = Math.max(bottom, p.y + heights(key));
      b.el.style.width = `${WIDTH}px`;
      b.el.style.translate = `${p.x}px ${p.y}px`;
    }
    this.#plane.style.width = `${right + w}px`;
    this.#plane.style.height = `${bottom + hgt}px`;
    // Close, a box grown or moved under the work keeps the camera where it is unless the work went out of sight.
    if (this.#near && !this.#framed && this.#held && this.#caret(this.#boxes.get(this.#held)!)) this.#follow(false);
    else this.#look(false);
    this.#changed();
  }

  /** Where the camera should look now: on the box in hand, at the base or close; moved there. */
  #look(moving: boolean) {
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return;
    // Framed over boxes at work (the Agent's, played), it stays so as they grow, until it is let go or one is taken.
    const framed = this.#framed ? this.#frameView(this.#framed) : null;
    if (framed) { this.#go(framed, moving && !still()); return; }
    const b = this.#held ? this.#boxes.get(this.#held) : this.#boxes.values().next().value;
    if (!b) return;
    const to = this.#near ? closeOn(b.slot, b.el.offsetHeight, w, hgt, this.#caret(b)) : baseOn(b.slot, b.el.offsetHeight, w, hgt);
    this.#go(to, moving && !still());
  }

  /**
   * The camera to `to`, gliding there or at once. Close (at its full size) the camera is the desk's own scroll, so what
   * brings something into view (the keyboard going into a box, a find) moves it as a scroll does; stepped back (or
   * on its way) the plane is moved and scaled instead.
   */
  #go(to: View, moving: boolean, ms = 480) {
    cancelAnimationFrame(this.#moving);
    this.#moving = 0;
    const {element: el} = this;
    // Where it is now, as a move of the plane: a scroll taken back into it.
    const from = el.scrollLeft || el.scrollTop ? {s: 1, x: -el.scrollLeft, y: -el.scrollTop} : {...this.#view};
    const set = (v: View, done: boolean) => {
      this.#view = v;
      el.style.setProperty('--inv', String(1 / v.s));
      if (done && v.s === 1) {
        this.#plane.style.transform = '';
        el.scrollTo(-v.x, -v.y);
        this.#gliding = false;
        return;
      }
      this.#plane.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
      if (el.scrollLeft || el.scrollTop) el.scrollTo(0, 0);
    };
    this.#gliding = true;
    if (!moving) { set(to, true); this.#gliding = false; return; }
    const t0 = performance.now();
    // The camera's way said as an animation of the page's, so what waits for the page to be still (a film, a look at
    // where the caret is) waits for it too.
    this.element.animate([{}, {}], {duration: ms, id: 'desk-camera'});
    const step = (now: number) => {
      const k = pan(Math.min(1, (now - t0) / ms));
      set({s: from.s + (to.s - from.s) * k, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k}, k >= 1);
      if (k < 1) this.#moving = requestAnimationFrame(step);
    };
    this.#moving = requestAnimationFrame(step);
  }

  /** Scrolled at the base (the camera moved as a scroll moves it): the box most in view is the one in hand. */
  #scrolledBase() {
    if (this.#gliding || this.#near) return;
    const best = this.#mostInView();
    if (!best || best.key === this.#held) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === best);
    this.#held = best.key;
    this.#changed();
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
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (ctrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.setNear(true);
    } else if (ctrl && (e.key === '-' || e.key === '0')) {
      e.preventDefault();
      this.setNear(false);
    } else if (e.key === 'Escape' && !e.defaultPrevented && this.#near) {
      // Escape from a box's text is the text's first (a search, a rename): only one that reaches the desk steps back,
      // to the base and no further.
      e.preventDefault();
      this.setNear(false);
    } else if (e.key === 'Escape' && !e.defaultPrevented && document.activeElement !== this.element) {
      // At the base, it lets go of the box's text: the keyboard on the desk, the box still in hand (Tab, the page).
      e.preventDefault();
      this.element.focus({preventScroll: true});
    } else if (way && e.altKey && e.shiftKey && !e.ctrlKey && this.#held) {
      e.preventDefault();
      this.#cols = carried(this.#cols, this.#held, way);
      this.#relay();
      this.#look(true);
    } else if (way && e.altKey && !e.ctrlKey && this.#held) {
      e.preventDefault();
      const to = next(this.#cols, this.#held, way);
      if (to) this.take(to);
    }
  }
}
