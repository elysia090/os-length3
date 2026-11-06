import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import {carried, next, overAll, PAD, slots, standardOn, WIDTH, wholeOf, type Slot, type View} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge, the desk): what is open lies on a plane, each box as wide as 80
// columns of code, its name outside its top-left corner, on dots. The Prompt's box is the first; files opened lie
// beside it, each under the one opened before it. One box is in hand, and the camera (never the box) moves to it. Its
// standard is every box at its own size, the box in hand in the middle: the balance the work is done at, never nearer.
// Escape (Ctrl and -, a pinch out) steps back to the whole desk, zooming first and then going; Enter (a double press,
// Ctrl and 0, a pinch in) comes back to the box in hand, going first and then zooming. Stepped back, an arrow hands
// over to the next box that way; at the standard Alt and an arrow do, and Alt, Shift and an arrow carry the box in hand
// a slot, lifted while Alt and Shift are held, the others stepping over (Ctrl and an arrow stay the text's own word
// moves). Where each box lies, and where the camera looks, are numbers kept apart (desk-layout.ts).

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
  /** Stepped back to the whole desk, rather than at the standard. */
  #whole = false;
  #view: View = {s: 1, x: 0, y: 0};
  #moving = 0;
  /** The camera on its way (its scroll is its own then, not someone's going somewhere). */
  #gliding = false;
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
    // The keyboard gone into a box (Tab, a key that summons the Prompt): that box is in hand, the camera with it. Gone
    // there by a press, the box is taken once the press is let go (its click), never under the pointer.
    this.element.addEventListener('focusin', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key !== this.#held && key !== this.#pressing) this.take(key, false);
    });
    // Framed over the Agent's work, the person writing in the box in hand (their terminal) takes the camera back to it.
    this.element.addEventListener('keydown', (e) => {
      if (!this.#framed || this.#whole || e.isComposing || (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace')) return;
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (key && key === this.#held) { this.#framed = null; this.#topAt = null; this.#look(true); }
    }, true);
    this.element.addEventListener('pointerdown', (e) => { this.#pressing = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key ?? null; }, true);
    for (const end of ['pointerup', 'pointercancel'] as const) addEventListener(end, () => { setTimeout(() => { this.#pressing = null; }); }, true);
    new ResizeObserver(() => this.#relay()).observe(this.element);
    this.element.addEventListener('scroll', () => this.#scrolledStandard());
    // A key pressed (or the keyboard come into a box) while boxes still slide to their places, a box just opened: what
    // it brought into view was brought there as it stood on its way. Once they stand, the camera goes back where it was.
    for (const ev of ['keydown', 'focusin'] as const) this.element.addEventListener(ev, () => { if (this.#sliding()) this.#strayed = true; }, true);
    this.#plane.addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'translate' || !this.#strayed || this.#sliding()) return;
      this.#strayed = false;
      const el = this.element, v = this.#view;
      if (!this.#whole && v.s === 1 && Math.hypot(el.scrollLeft + v.x, el.scrollTop + v.y) > 1) this.#look(true);
    });
    this.element.addEventListener('wheel', (e) => this.#wheel(e), {passive: false});
    // Stepped back, a box pressed twice is come back to.
    this.element.addEventListener('dblclick', (e) => {
      const key = (e.target as Element).closest<HTMLElement>('.desk-box')?.dataset.key;
      if (this.#whole && key) { this.take(key, false, false); this.setWhole(false); this.#boxes.get(key)?.laid.focus(); }
    });
    // Alt and Shift held: the box in hand lifted off the desk, to be carried; let go, it is put down.
    const lift = (e: KeyboardEvent) => this.#lifted(e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey);
    this.element.addEventListener('keydown', lift);
    this.element.addEventListener('keyup', lift);
    this.element.addEventListener('focusout', () => this.#lifted(false));
  }

  /** Whether the camera is stepped back to the whole desk. */
  get whole(): boolean { return this.#whole; }

  /** The camera stepped back to the whole desk (`on`), or come back to the box in hand. */
  setWhole(on: boolean) {
    if (on === this.#whole) return;
    this.#whole = on;
    this.#topAt = null;
    this.element.classList.toggle('whole', on);
    this.#look(true, on ? 'out' : 'in');
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
      if (this.#whole) { if (this.#held !== key) this.take(key, false); return; }
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

  /** `key` in hand: at the standard the camera goes to it (gliding there, unless `glide` is false) and it has the
   * keyboard (`focus`); stepped back, the camera stays over the whole desk, unless the keyboard goes into it. */
  take(key: string, focus = true, glide = true) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    this.#held = key;
    this.#framed = null;
    this.#topAt = null;
    if (this.#whole && focus) { this.#whole = false; this.element.classList.remove('whole'); this.#look(glide, 'in'); }
    else if (!this.#whole) this.#look(glide);
    if (focus) b.laid.focus();
    this.#changed();
  }

  /**
   * The camera over `keys` at once (each box at work), at the standard: over all of them when they fit, else on the one
   * last at work; none, back on the box in hand. Stepped back, the whole desk is in sight already: it stays.
   */
  frame(keys: string[]) {
    this.#framed = keys.length ? keys : null;
    if (!this.#whole) this.#look(true);
  }

  /** Where the camera stands over the framed boxes (stepped back as far as they need); null when none lies here. */
  #frameView(keys: string[]): View | null {
    const boxes = keys.map((k) => this.#boxes.get(k)).filter((b): b is Box => !!b);
    if (!boxes.length) return null;
    return overAll(boxes.map((b) => ({slot: b.slot, h: b.el.offsetHeight})), this.element.clientWidth, this.element.clientHeight);
  }

  /** A wheel over the desk: with Ctrl (a pinch), stepped back or come back to the standard; without it, the camera
   * along the desk at the standard (a box's own scroll first: a Prompt's output scrolled within it). */
  #wheel(e: WheelEvent) {
    if (e.ctrlKey) {
      e.preventDefault();
      if (Math.abs(e.deltaY) >= 4) this.setWhole(e.deltaY > 0);
      return;
    }
    if (this.#whole || this.#moving || scrollsItself(e.target as Element, this.element, e.deltaX, e.deltaY)) return;
    e.preventDefault();
    this.#framed = null;
    this.element.scrollBy(e.deltaX, e.deltaY);
  }

  /** Alt and Shift held (`on`): the box in hand lifted, its shadow longer; let go, it is put down with a small give. */
  #lifted(on: boolean) {
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    if (!b || b.el.classList.contains('lifted') === on) return;
    b.el.classList.toggle('lifted', on);
    if (!on && !still()) b.el.animate([{scale: '1'}, {scale: '.992'}, {scale: '1'}], {duration: 200, easing: 'ease-out'});
  }

  /** Places measured again (a box grew or shrank): the boxes go where they now belong, the camera with them. */
  relayout() { this.#relay(); }

  #relay() {
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
    this.#look(false);
    this.#changed();
  }

  /** Where the camera should look now: over the whole desk, over the boxes at work, or on the box in hand; moved there
   * (`moving`, the way it goes `how`). */
  #look(moving: boolean, how: Way2 = 'pan') {
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return;
    const glide = moving && !still();
    if (this.#whole) { this.#go(wholeOf([...this.#boxes.values()].map((b) => ({slot: b.slot, h: b.el.offsetHeight})), w, hgt), glide, how); return; }
    // Framed over boxes at work (the Agent's, played), it stays so as they grow, until it is let go or one is taken.
    const framed = this.#framed ? this.#frameView(this.#framed) : null;
    if (framed) { this.#go(framed, glide, how); return; }
    const b = this.#held ? this.#boxes.get(this.#held) : this.#boxes.values().next().value;
    if (!b) return;
    const to = standardOn(b.slot, b.el.offsetHeight, w, hgt);
    // Its top where it stood when it was taken in hand, whatever it has grown to since.
    if (this.#topAt === null) this.#topAt = to.y + b.slot.y * to.s;
    else to.y = this.#topAt - b.slot.y * to.s;
    this.#go(to, glide, how);
  }

  /**
   * The camera to `to`, gliding there (the way `how`) or at once. At the standard (at its own size) the camera is the
   * desk's own scroll, so what brings something into view (the keyboard going into a box, a find) moves it as a scroll
   * does; stepped back (or on its way) the plane is moved and scaled instead. Its way is told by where the box in hand
   * stands on the face and how near: going along, both at once; coming back, it goes before it zooms; stepping back, it
   * zooms before it goes.
   */
  #go(to: View, moving: boolean, how: Way2 = 'pan') {
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
    const pf = {x: m.x * from.s + from.x, y: m.y * from.s + from.y}, pt = {x: m.x * to.s + to.x, y: m.y * to.s + to.y};
    const ms = how === 'pan' ? 560 : 520;
    const t0 = performance.now();
    // The camera's way said as an animation of the page's, so what waits for the page to be still (a film, a look at
    // where the caret is) waits for it too.
    this.element.animate([{}, {}], {duration: ms, id: 'desk-camera'});
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const [p, q] = how === 'in' ? [land(k / .45), land((k - .45) / .55)] : how === 'out' ? [land((k - .55) / .45), land(k / .55)] : [pan(k), pan(k)];
      const s = from.s * Math.pow(to.s / from.s, q);
      const at = {x: pf.x + (pt.x - pf.x) * p, y: pf.y + (pt.y - pf.y) * p};
      set(k >= 1 ? to : {s, x: at.x - m.x * s, y: at.y - m.y * s}, k >= 1);
      if (k < 1) this.#moving = requestAnimationFrame(step);
    };
    this.#moving = requestAnimationFrame(step);
  }

  /** Scrolled at the standard (the camera moved as a scroll moves it): the box most in view is the one in hand. */
  #scrolledStandard() {
    if (this.#gliding || this.#whole || performance.now() - this.#ownScroll < 120) return;
    if (this.#strayed) return;
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
    if (e.isComposing) return;
    const way = WAYS[e.key];
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (ctrl && e.key === '-') {
      e.preventDefault();
      this.setWhole(true);
    } else if (ctrl && (e.key === '0' || e.key === '=' || e.key === '+')) {
      // Never nearer than the standard: Ctrl and + comes back to it at most.
      e.preventDefault();
      this.setWhole(false);
    } else if (e.key === 'Escape' && !e.defaultPrevented && !this.#whole) {
      // Escape from a box's text is the text's first (a search, a rename): one that reaches the desk steps back to the
      // whole desk, the keyboard on the desk.
      e.preventDefault();
      this.element.focus({preventScroll: true});
      this.setWhole(true);
    } else if (e.key === 'Enter' && this.#whole && this.#held && document.activeElement === this.element) {
      e.preventDefault();
      this.setWhole(false);
      this.#boxes.get(this.#held)?.laid.focus();
    } else if (way && this.#whole && this.#held && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Stepped back, an arrow hands over: the box that way in hand, the camera staying over the whole desk.
      e.preventDefault();
      const to = next(this.#cols, this.#held, way);
      if (to) this.take(to, false); else this.#bump(way);
    } else if (way && e.altKey && e.shiftKey && !e.ctrlKey && this.#held) {
      e.preventDefault();
      const was = this.#cols.map((c) => c.join('\n')).join('\t');
      this.#cols = carried(this.#cols, this.#held, way);
      if (this.#cols.map((c) => c.join('\n')).join('\t') === was) { this.#bump(way); return; }
      this.#relay();
      this.#look(true);
    } else if (way && e.altKey && !e.ctrlKey && this.#held) {
      e.preventDefault();
      const to = next(this.#cols, this.#held, way);
      if (to) this.take(to); else this.#bump(way);
    }
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
