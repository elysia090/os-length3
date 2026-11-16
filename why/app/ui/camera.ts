import {SPRING} from './law.ts';
// The camera going along the rail (main.ts select), in three moves, each a camera's own:
//
//   out    the page left steps back with its own camera, the page still itself: a ground camera (below) to half its
//          size about where its words begin, at its top and its left, as it is read; Forge's desk has one size and
//          does not step back (its own camera says so: forge/desk.ts). What lay out of sight comes into it (Home's
//          lines past the window's foot): nothing is cut at an edge no one can see.
//   along  at that height the camera goes along the one ground to the page come to, lying beside the page left the way
//          the rail goes (above going up, below going down), already stood back by its own camera: the page left (a
//          picture of it) and the page come to (itself) go by together, and their dots with them.
//   in     the page come to's own camera comes down to where it stood.
//
// The rail, the band and the pane are the frame: they never move. What differs on them gives way in place as the camera
// goes along, the frame come to coming in under the one left before that one goes, so what the two share never dims.
// The dots lie on the ground as everything on it does: standing back they grow smaller with their pitch, going along
// they go by.

type Point = {x: number; y: number};
export type Rect = {left: number; top: number; right: number; bottom: number};

/** A page's own camera, as the rail moves it (out, in), whatever it is (the desk's, a ground camera). */
export interface PageCamera {
  /** Steps back, `ms` long; done once it is there. */
  away(ms: number): Promise<void>;
  /** Stands back at once, as the page is come to from afar. */
  afar(): void;
  /** Comes down to where it stood, `ms` long (0: at once). */
  near(ms: number): void;
  /** How far back what lies on the page's ground stands, as the rail moves it along (1: it stands back inside it, as the
   * desk's plane does). */
  readonly far: number;
  /** What holds the page's dots where they are not inside what moves (Home's, on the page), moved along with it. */
  readonly dots: HTMLElement | null;
}

/** The cameras pages have of their own (the desk's), by the element they are of (marked `data-camera`). */
const own = new WeakMap<Element, PageCamera>();
export function ownCamera(el: HTMLElement, camera: PageCamera) {
  el.dataset.camera = '';
  own.set(el, camera);
}
/** The camera of its own `page` shows (the desk's in Forge), if it has one. */
export function cameraIn(page: HTMLElement): PageCamera | null {
  for (const el of page.querySelectorAll('[data-camera]')) if (el.getClientRects().length && own.has(el)) return own.get(el)!;
  return null;
}

/** The event what is in a box on the desk sends up as the Agent's hand or eye goes to one of its lines (`detail`: that
 * line's top, from what sent it, and its height; null once it has gone from it): the desk's camera over the work keeps
 * it in sight (forge/desk.ts). */
export const WORK_AT = 'desk-work';
export interface WorkAt { top: number; height: number }
/** `el` telling the camera over it that the Agent's hand or eye is on its line `top` down, `height` high (none: gone). */
export function workAt(el: HTMLElement, at: WorkAt | null) {
  el.dispatchEvent(new CustomEvent(WORK_AT, {bubbles: true, detail: at}));
}

/** How far back the camera stands: half its size. */
export const FAR = .5;
/** Stepping back: quick off at the press, slowing as it gets there (the desk camera's land); coming down, the same. */
const LAND = SPRING;

const matrix = (k: number, x: number, y: number) => `matrix(${k}, 0, 0, ${k}, ${x}, ${y})`;

/** The dots' pitch on the ground (styles: --dots), the first a half pitch in. */
export const PITCH = 24;

/** Where a lattice point of the dots on `el` lies (its own background's, the first a half pitch in), seen now. */
function dotAt(el: HTMLElement): Point {
  const r = el.getBoundingClientRect(), [x = 0, y = 0] = getComputedStyle(el).backgroundPosition.split(' ').map(parseFloat);
  return {x: r.left + x, y: r.top + y};
}

/**
 * A page's camera where it has none of its own (Home, Git, the rest): what lies on its ground (`parts`) stands back to
 * FAR about where its words begin, at their left and their top (or the ground's top, read down past it): a page read
 * from its left stays at its left, as Forge's desk stays in the middle. The page's own dots (on `dotted`, if it has
 * them) go with it.
 */
export class GroundCamera implements PageCamera {
  readonly far = FAR;
  readonly dots: HTMLElement | null;
  readonly #parts: HTMLElement[];
  readonly #top: number;
  /** What holds it where it stands (stood back), or brings it there or back. */
  #held: Animation[] = [];

  constructor(parts: HTMLElement[], dotted: HTMLElement | null, ground: Rect) {
    this.#parts = parts;
    this.dots = dotted;
    this.#top = ground.top;
  }

  /** Each part's keyframes where it rests and stood back (read where they rest, what holds them let go first), and where
   * each is seen now (on its way, it steps back from there). */
  #frames(): {el: HTMLElement; now: Keyframe; rest: Keyframe; back: Keyframe}[] {
    const seen = [...this.#parts, ...this.dots ? [this.dots] : []].map((el) => {
      const c = getComputedStyle(el);
      return {transform: c.transform, backgroundSize: c.backgroundSize, backgroundPosition: c.backgroundPosition};
    });
    for (const a of this.#held) a.cancel();
    this.#held = [];
    const rects = this.#parts.map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (!rects.length) return [];
    const at = {x: Math.min(...rects.map((r) => r.left)), y: Math.max(this.#top, Math.min(...rects.map((r) => r.top)))};
    const k = FAR, out: {el: HTMLElement; now: Keyframe; rest: Keyframe; back: Keyframe}[] = [];
    this.#parts.forEach((el, i) => {
      const r = el.getBoundingClientRect(), rest = {transformOrigin: '0 0', transform: matrix(1, 0, 0)};
      out.push({el, rest, now: seen[i].transform === 'none' ? rest : {transformOrigin: '0 0', transform: seen[i].transform},
        back: {transformOrigin: '0 0', transform: matrix(k, (1 - k) * (at.x - r.left), (1 - k) * (at.y - r.top))}});
    });
    if (this.dots) {
      const page = this.dots.getBoundingClientRect(), o = dotAt(this.dots), d = {x: at.x + k * (o.x - at.x), y: at.y + k * (o.y - at.y)};
      const was = seen[this.#parts.length];
      out.push({el: this.dots, now: {backgroundSize: was.backgroundSize, backgroundPosition: was.backgroundPosition},
        rest: {backgroundSize: `${PITCH}px ${PITCH}px`, backgroundPosition: `${o.x - page.left}px ${o.y - page.top}px`},
        back: {backgroundSize: `${PITCH * k}px ${PITCH * k}px`, backgroundPosition: `${d.x - page.left}px ${d.y - page.top}px`}});
    }
    return out;
  }

  away(ms: number): Promise<void> {
    const f = this.#frames();
    this.#held = f.map(({el, now, back}) => el.animate([now, back], {duration: ms, easing: LAND, fill: 'forwards'}));
    return Promise.all(this.#held.map((a) => a.finished.catch(() => {}))).then(() => {});
  }

  afar() {
    const f = this.#frames();
    this.#held = f.map(({el, back}) => el.animate([back, back], {duration: 0, fill: 'forwards'}));
  }

  near(ms: number) {
    const f = this.#frames();
    if (ms > 0) this.#held = f.map(({el, rest, back}) => el.animate([back, rest], {duration: ms, easing: LAND}));
  }
}

/** A cubic Bézier easing (as CSS's), as a function of the time gone (0 to 1). */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (t) => {
    if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (at(x1, x2, mid) < t) lo = mid; else hi = mid; }
    return at(y1, y2, (lo + hi) / 2);
  };
}
/** The way along: off at once from where the camera stood back (never a stand between the two moves, which read as a
 * wait), slowing long into the page come to. */
const along = bezier(.3, .15, .2, 1);
const STEPS = 40;
const steps = (f: (q: number) => Keyframe) => Array.from({length: STEPS + 1}, (_, i) => f(along(i / STEPS)));

/** The camera going along: `by`, how far the page come to lies from the page left, down the window (going up the rail,
 * less than 0), seen stood back; `ms` long. */
export type Along = {by: number; ms: number};

/**
 * The page left (its picture, `pseudo` on the root, taken at `was`), going by as the camera goes along, seen only where
 * the ground is (`ground`: never over the band, the pane, or past the window's foot).
 */
export function goneBy(a: Along, root: HTMLElement, pseudo: string, was: Rect, ground: Rect): Animation {
  return root.animate(steps((q) => {
    const dy = -q * a.by;
    return {transform: `translateY(${dy}px)`,
      clipPath: `inset(${ground.top - was.top - dy}px ${was.right - ground.right}px ${was.bottom - ground.bottom + dy}px ${ground.left - was.left}px)`};
  }), {duration: a.ms, easing: 'linear', fill: 'forwards', pseudoElement: pseudo});
}

/**
 * What lies on the page come to's ground (`parts`, stood back already by its camera, `camera.far`), and its dots,
 * coming by as the camera goes along: each moved as much more, on top of where its camera holds it.
 */
export function comeBy(a: Along, camera: PageCamera, parts: HTMLElement[]): Animation[] {
  const o = {duration: a.ms, easing: 'linear', composite: 'add' as CompositeOperation};
  const moved = parts.map((el) => el.animate(steps((q) => ({transform: `translateY(${(1 - q) * a.by / camera.far}px)`})), o));
  const dots = camera.dots ? [camera.dots.animate(steps((q) => ({backgroundPosition: `0px ${(1 - q) * a.by}px`})), o)] : [];
  return [...moved, ...dots];
}

/** Where along the way the frame changes: as the camera passes between the two pages. The frame come to comes in under
 * the one left first, then that one goes, so what the two have the same (the band's tools, the pane's edge) never dims. */
export const CHANGE = {in: [.32, .46], out: [.46, .6]} as const;

/** The frame come to (`frame`, live), there under the frame left as the camera passes between the two; with no frame
 * left to come in under (`first`), as the camera sets off. */
export function frameIn(a: Along, frame: HTMLElement[], first = false): Animation[] {
  const [x, y] = first ? [0, .15] : CHANGE.in;
  return frame.map((el) => el.animate([{opacity: 0}, {opacity: 0, offset: x}, {opacity: 1, offset: y}, {opacity: 1}], {duration: a.ms, fill: 'both'}));
}

/** The frame left (its pictures, `pseudos` on the root), going once the frame come to is there under it. */
export function frameOff(a: Along, root: HTMLElement, pseudos: string[]): Animation[] {
  const [x, y] = CHANGE.out;
  return pseudos.map((p) => root.animate([{opacity: 1}, {opacity: 1, offset: x}, {opacity: 0, offset: y}, {opacity: 0}], {duration: a.ms, fill: 'both', pseudoElement: p}));
}
