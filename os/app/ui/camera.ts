// The camera over the one dotted ground the ground pages lie on (Forge's desk, Home, New repo: main.ts ON_GROUND),
// going from one to another as the rail is gone along. It is a map from where things lie to where they are seen:
// stood back by k (1 where it rests) about the middle of the window, and moved along by the way it has come. Each
// thing that moves is moved by that map: the page left (its picture) and the page come to (its parts, live); the
// frame (the band, the pane, its switch) is moved back as much, so it stands where it is, and the ground's dots are
// set where the map puts them, one lattice under both pages from the first frame to the last.

type Point = {x: number; y: number};
type Rect = {left: number; top: number; right: number; bottom: number};

/** One of the camera's steps: how far it has stood back (`k`, 1 where it rests), and how much of the way it has come (`q`). */
type Step = {k: number; q: number};

export type Flight = {
  /** The middle of the window, which the camera stands back about. */
  at: Point;
  /** The way from the page left to the page come to, as the page come to starts from it. */
  by: Point;
  /** Where the ground lies between the frame's parts (under the band, left of the pane, over the window's foot). */
  ground: Rect;
  steps: Step[];
  ms: number;
};

/** How many steps a flight is sampled at: each a keyframe, eased linearly between (the curves are the steps'). */
const STEPS = 24;

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

/**
 * The camera's way: the pan eased (`pan`, as CSS's cubic-bezier), and as it goes it stands back by `back` at most,
 * soon after it sets off, coming down into the page come to more slowly than it went up (the page grows into its
 * place as it lands).
 */
export function steps(pan: [number, number, number, number], back: number): Step[] {
  const q = bezier(...pan);
  return Array.from({length: STEPS + 1}, (_, i) => {
    const t = i / STEPS;
    return {k: 1 - back * Math.sin(Math.PI * t ** .75), q: q(t)};
  });
}

/** Where a lattice point of the ground's dots is seen on `page` (the page's own dots, or its desk's), null where it has none. */
export function lattice(page: HTMLElement): Point | null {
  const ground = page.querySelector<HTMLElement>('.desk') ?? (getComputedStyle(page).backgroundImage !== 'none' ? page : null);
  if (!ground) return null;
  const r = ground.getBoundingClientRect(), [x = 0, y = 0] = getComputedStyle(ground).backgroundPosition.split(' ').map(parseFloat);
  return {x: r.left + x, y: r.top + y};
}

/** The dots' pitch (styles: the ground's radial gradient every 24 px). */
const PITCH = 24;

/** `d` moved by less than half a pitch, so that `from` moved by it lies on the lattice of `to`. */
const onto = (d: number, from: number, to: number) => d + ((((from - to - d) % PITCH) + PITCH + PITCH / 2) % PITCH) - PITCH / 2;

/**
 * The way from the page left to the page come to: `by` as asked, each way moved by less than half a pitch so the dots
 * left (`left`, read before the page left was taken) come to lie on the dots of the page come to (`come`).
 */
export function way(by: Point, left: Point | null, come: Point | null): Point {
  return left && come ? {x: onto(by.x, left.x, come.x), y: onto(by.y, left.y, come.y)} : by;
}

/** The map at a step, as `k·x + b` (the page come to's, or the page left's: `left`). */
function offset(f: Flight, s: Step, left: boolean): Point {
  const along = left ? -s.q : 1 - s.q;
  return {x: (1 - s.k) * f.at.x + s.k * along * f.by.x, y: (1 - s.k) * f.at.y + s.k * along * f.by.y};
}

const matrix = (k: number, x: number, y: number) => `matrix(${k}, 0, 0, ${k}, ${x}, ${y})`;

/**
 * The page come to, flown in: each of its parts (`parts`, their boxes read before any of them moved) moved by the
 * map; the frame inside them (`frame`) moved back as much, standing where it is; the page's dots (its own, or put on
 * it for the flight where they are its desk's) set where the map puts the lattice they will rest on (`dots`).
 */
export function flyIn(f: Flight, page: HTMLElement, parts: [HTMLElement, DOMRect][], frame: [HTMLElement, DOMRect][], dots: Point | null): Animation[] {
  const o = {duration: f.ms, easing: 'linear'};
  const maps = f.steps.map((s) => ({k: s.k, b: offset(f, s, false)}));
  const moved = parts.map(([el, r]) => el.animate(maps.map(({k, b}) => ({transformOrigin: '0 0', transform: matrix(k, k * r.left + b.x - r.left, k * r.top + b.y - r.top)})), o));
  const held = frame.map(([el, r]) => el.animate(maps.map(({k, b}) => ({transformOrigin: '0 0',
    transform: matrix(1 / k, (r.left * (1 - k) - b.x) / k, (r.top * (1 - k) - b.y) / k)})), o));
  const box = page.getBoundingClientRect();
  const ground = dots ? [page.animate(maps.map(({k, b}) => ({backgroundSize: `${PITCH * k}px ${PITCH * k}px`,
    backgroundPosition: `${k * dots.x + b.x - box.left}px ${k * dots.y + b.y - box.top}px`})), o)] : [];
  return [...moved, ...held, ...ground];
}

/**
 * The page left (its picture, `pseudo` on the root, taken at `was`), flown off by the map, seen only where the ground
 * is between the frame's parts: never over the band or the pane, which stand where they are.
 */
export function flyOff(f: Flight, root: HTMLElement, pseudo: string, was: DOMRect): Animation[] {
  const frames = f.steps.map((s) => {
    const b = offset(f, s, true), k = s.k, g = f.ground;
    // The ground's edges where they are on the picture, as it is moved by the map at this step.
    const top = (g.top - b.y) / k - was.top, left = (g.left - b.x) / k - was.left;
    const bottom = was.height - ((g.bottom - b.y) / k - was.top), right = was.width - ((g.right - b.x) / k - was.left);
    return {transformOrigin: '0 0', transform: matrix(k, k * was.left + b.x - was.left, k * was.top + b.y - was.top),
      clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px)`};
  });
  return [root.animate(frames, {duration: f.ms, easing: 'linear', fill: 'forwards', pseudoElement: pseudo})];
}
