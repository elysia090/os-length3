import {h} from '../../ui/dom.ts';
import {still} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import {carried, closeOn, next, PAD, slots, WIDTH, wholeOf, type Slot, type View} from './desk-layout.ts';

// A repo's desk, Forge's center (DESIGN.md § Forge, the desk): what is open lies on a plane, each box as wide as 80
// columns of code, its name outside its top-left corner, on dots. The Prompt's box is the first; files opened lie
// beside it, each under the one opened before it. One box is in hand: work is done close to it (the camera, never the
// box, moves: the box in hand in the middle across, under the top); Escape steps back to the whole desk, Enter (or a
// press on a box) comes close again. Alt and an arrow hand over to the next box that way; Alt, Shift and an arrow
// carry the box in hand a slot, the others stepping over (Ctrl and an arrow stay the text's own word moves). Where each box lies, and where the camera looks, are numbers kept
// apart (desk-layout.ts).

/** What lies on the desk: its element, and the name said over it (its folder quiet before it, and after it, quiet,
 * what more it is: the Prompt's folder). */
export interface Laid {
  element: HTMLElement; name: string; dir: string; after?: string; focus(): void;
  /** Its name pressed: written over in place (a file's). */
  rename?(name: HTMLElement): void;
}

type Way = 'up' | 'down' | 'left' | 'right';
const WAYS: Record<string, Way> = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'};

/** Minimum jerk: from rest to rest, nothing sudden at either end. */
const pan = (x: number) => x * x * x * (10 - 15 * x + 6 * x * x);

interface Box { key: string; laid: Laid; el: HTMLElement; label: HTMLElement; slot: Slot }

export class Desk {
  readonly element: HTMLElement;
  readonly #plane: HTMLElement;
  readonly #boxes = new Map<string, Box>();
  #cols: string[][] = [[]];
  #held: string | null = null;
  #whole = false;
  #view: View = {s: 1, x: 0, y: 0};
  #moving = 0;
  /** The camera on its way (its scroll is its own then, not someone's going somewhere). */
  #gliding = false;
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
    this.element.addEventListener('scroll', () => this.#scrolledClose());
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
    el.addEventListener('click', () => { if (this.#held !== key || this.#whole) this.take(key, !el.contains(document.activeElement)); });
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

  /** `key` in hand: the camera comes close to it (gliding there, unless `glide` is false), and it has the keyboard. */
  take(key: string, focus = true, glide = true) {
    const b = this.#boxes.get(key);
    if (!b) return;
    for (const o of this.#boxes.values()) o.el.classList.toggle('held', o === b);
    this.#held = key;
    this.#whole = false;
    this.element.classList.remove('whole');
    this.#look(glide);
    if (focus) b.laid.focus();
    this.#changed();
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
    this.#look(false);
    this.#changed();
  }

  /** Where the camera should look now: close on the box in hand, or back over the whole desk; moved there. */
  #look(moving: boolean) {
    const w = this.element.clientWidth, hgt = this.element.clientHeight;
    if (!w || !hgt) return;
    const heights = (key: string) => this.#boxes.get(key)?.el.offsetHeight ?? 0;
    const b = this.#held ? this.#boxes.get(this.#held) : undefined;
    const to = this.#whole || !b ? wholeOf(new Map([...this.#boxes].map(([k, x]) => [k, x.slot])), heights, w, hgt)
      : closeOn(b.slot, b.el.offsetHeight, w, hgt);
    this.#go(to, moving && !still());
  }

  /**
   * The camera to `to`, gliding there or at once. Close (at its full size) the camera is the desk's own scroll, so what
   * brings something into view (the keyboard going into a box, a find) moves it as a scroll does; stepped back (or
   * on its way) the plane is moved and scaled instead.
   */
  #go(to: View, moving: boolean) {
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
    const t0 = performance.now(), ms = 480;
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

  /** Scrolled close (the camera moved as a scroll moves it): the box most in view is the one in hand. */
  #scrolledClose() {
    if (this.#gliding || this.#whole) return;
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
    if (e.key === 'Escape' && !this.#whole && !e.defaultPrevented) {
      // Escape from a box's text is the text's first (a search, a rename): only one that reaches the desk steps back.
      e.preventDefault();
      this.#whole = true;
      this.element.classList.add('whole');
      this.element.focus({preventScroll: true});
      this.#look(true);
    } else if (e.key === 'Enter' && this.#whole && this.#held) {
      e.preventDefault();
      this.take(this.#held);
    } else if (way && e.altKey && e.shiftKey && !e.ctrlKey && this.#held) {
      e.preventDefault();
      this.#cols = carried(this.#cols, this.#held, way);
      this.#relay();
      this.#look(true);
    } else if (way && e.altKey && !e.ctrlKey && this.#held) {
      e.preventDefault();
      const to = next(this.#cols, this.#held, way);
      if (to) this.take(to);
    } else if (way && this.#whole && this.#held) {
      e.preventDefault();
      const to = next(this.#cols, this.#held, way);
      if (to) { this.#held = to; for (const o of this.#boxes.values()) o.el.classList.toggle('held', o.key === to); }
    }
  }
}
