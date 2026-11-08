// The camera going along the rail (main.ts select), as the desk's own camera goes (pages/forge/desk.ts) and as a game
// switches from one person to another: what lies on the ground pulls back to half its size about the middle of the
// ground (as the desk's Escape does: back first, then along), goes along to the page come to, lying beside the page
// left the way the rail goes, and comes down into it (along first, then near). Only what lies on the ground moves:
// the rail, the band and the pane are the frame and stand where they are, what differs on them giving way in place
// as the camera passes between the two; the ground itself, its colour and its dots, stands still under the camera, as
// the desk's does, its dots never growing or shrinking.
//
// It is one map from where things lie to where they are seen, `k·x + b`: stood back by k (1 where it rests) about the
// middle of the ground, and moved along by the way it has come. It moves the page left (its picture, its frame taken
// apart from it) and the page come to (its parts, live, so a press lands on them as they come), each seen only where
// the ground is (under the band, left of the pane, over the window's foot).

type Point = {x: number; y: number};
export type Rect = {left: number; top: number; right: number; bottom: number};

/** One of the camera's steps: how far it has stood back (`k`, 1 where it rests), and how much of the way it has come (`q`). */
export type Step = {k: number; q: number};

/** A switch: `ms` long, standing back to `1 - back`; its moves as parts of the whole: it has stood back by `out`, and
 * comes down from `down`. */
export type Moves = {ms: number; back: number; out: number; down: number};

export type Flight = {
  /** Where the camera stands back about: the middle of the ground left. */
  at: Point;
  /** How far the page come to lies from the page left, down the window (going up the rail, less than 0). */
  by: number;
  /** Where the ground is seen, left and come to (the window's part of each page between its frame's parts). */
  from: Rect;
  to: Rect;
  moves: Moves;
  steps: Step[];
  ms: number;
};

/** How many steps a switch is sampled at: each a keyframe, eased linearly between (the curves are the steps'). */
const STEPS = 60;

/** The desk camera's own curves (desk.ts): nearer or further, quick away and slowing into its place; along, from rest
 * to rest with nothing sudden at either end (minimum jerk). */
const land = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
const along = (x: number) => { const s = Math.min(1, Math.max(0, x)); return s * s * s * (10 - 15 * s + 6 * s * s); };
/** How much the way along runs into the moves either side of it (part of the whole): the camera never stands still
 * between them, which read as a wait. */
const OVER = .06;

const part = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));

/** Where the camera is `t` of the way through a switch (0 to 1). */
export function camera(t: number, m: Moves): Step {
  const k = 1 - m.back * (t <= m.out ? land(t / m.out) : t < m.down ? 1 : 1 - land(part(t, m.down, 1)));
  return {k, q: along(part(t, m.out - OVER, m.down + OVER))};
}

/** The camera's way, a step for each keyframe. */
export function stages(m: Moves): Step[] {
  return Array.from({length: STEPS + 1}, (_, i) => camera(i / STEPS, m));
}

/** Where along the way across the frame changes, and the ground's dots come or go: as the camera passes between the
 * two pages, both small and far from it. The frame come to comes in under the one left first, then that one goes, so
 * what the two have the same (the band's tools, the pane's edge) never dims. */
export const CHANGE = {in: [.36, .46], out: [.46, .56]} as const;

const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const meet = (a: Rect, b: Rect): Rect => ({left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)});
const toward = (a: Rect, b: Rect, s: number): Rect => ({left: lerp(a.left, b.left, s), top: lerp(a.top, b.top, s), right: lerp(a.right, b.right, s), bottom: lerp(a.bottom, b.bottom, s)});

/** Where the ground is seen at `t`: the page left's as it pulls back, where both pages' ground is while it goes along,
 * the page come to's as it comes down (the edges going as the frame changes, never over what is on the ground). */
function seen(f: Flight, t: number): Rect {
  const both = meet(f.from, f.to);
  if (t <= f.moves.out) return toward(f.from, both, land(t / f.moves.out));
  if (t < f.moves.down) return both;
  return toward(both, f.to, land(part(t, f.moves.down, 1)));
}

/** The map at a step, as `k·x + b` (the page come to's, or the page left's: `left`). */
function offset(f: Flight, s: Step, left: boolean): Point {
  return {x: (1 - s.k) * f.at.x, y: (1 - s.k) * f.at.y + s.k * (left ? -s.q : 1 - s.q) * f.by};
}

const matrix = (k: number, x: number, y: number) => `matrix(${k}, 0, 0, ${k}, ${x}, ${y})`;

/** A thing at `r` (as it stood before it moved) at each step: moved by the map, cut to where the ground is seen (the cut
 * its own, in its own place, so it goes with it on the compositor). */
function moved(f: Flight, r: Rect, left: boolean): Keyframe[] {
  return f.steps.map((s, i) => {
    const b = offset(f, s, left), k = s.k, g = seen(f, i / (f.steps.length - 1));
    const top = (g.top - b.y) / k - r.top, lft = (g.left - b.x) / k - r.left;
    const bottom = r.bottom - ((g.bottom - b.y) / k), right = r.right - ((g.right - b.x) / k);
    return {transformOrigin: '0 0', transform: matrix(k, k * r.left + b.x - r.left, k * r.top + b.y - r.top),
      clipPath: `inset(${top}px ${right}px ${bottom}px ${lft}px)`};
  });
}

/** What lies on the ground of the page come to (`parts`, each with where it stood), flown in from beside the page left. */
export function flyIn(f: Flight, parts: [HTMLElement, DOMRect][]): Animation[] {
  return parts.map(([el, r]) => el.animate(moved(f, r, false), {duration: f.ms, easing: 'linear'}));
}

/** The page left (its picture, `pseudo` on the root, taken at `was`), flown off. */
export function flyOff(f: Flight, root: HTMLElement, pseudo: string, was: Rect): Animation {
  return root.animate(moved(f, was, true), {duration: f.ms, easing: 'linear', fill: 'forwards', pseudoElement: pseudo});
}

/** The frame come to (`frame`, live), there under the frame left as the camera passes between the two. */
export function frameIn(f: Flight, frame: HTMLElement[]): Animation[] {
  const [a, b] = CHANGE.in;
  return frame.map((el) => el.animate([{opacity: 0}, {opacity: 0, offset: a}, {opacity: 1, offset: b}, {opacity: 1}], {duration: f.ms, fill: 'both'}));
}

/** The frame left (its pictures, `pseudos` on the root), going once the frame come to is there under it. */
export function frameOff(f: Flight, root: HTMLElement, pseudos: string[]): Animation[] {
  const [a, b] = CHANGE.out;
  return pseudos.map((p) => root.animate([{opacity: 1}, {opacity: 1, offset: a}, {opacity: 0, offset: b}, {opacity: 0}], {duration: f.ms, fill: 'both', pseudoElement: p}));
}

/** The dots' pitch (styles: the ground's radial gradient every 24 px). */
export const PITCH = 24;

/** Where a lattice point of the dots `page` shows is seen (its desk's, or its own), null where it shows none. */
export function lattice(page: HTMLElement): Point | null {
  const desk = [...page.querySelectorAll<HTMLElement>('.desk')].find((d) => d.getClientRects().length);
  const ground = desk ?? (getComputedStyle(page).backgroundImage.includes('radial-gradient') ? page : null);
  if (!ground) return null;
  const r = ground.getBoundingClientRect(), [x = 0, y = 0] = getComputedStyle(ground).backgroundPosition.split(' ').map(parseFloat);
  return {x: r.left + x, y: r.top + y};
}

/**
 * The ground's dots under the camera (`pseudo` on the root, standing over `box`): still, as the desk's are, on the
 * lattice of the page left (`from`, a point of it; null: it has none) and of the page come to (`to`). Where the two
 * lattices differ (a page read down part of a dot), they go over by the least they can as the camera goes along; where
 * one page has none, they come or go as the frame changes.
 */
export function ground(f: Flight, root: HTMLElement, pseudo: string, box: Rect, from: Point | null, to: Point | null): Animation {
  const a = from ?? to!, b = to ?? from!;
  const near = (d: number) => ((d % PITCH) + PITCH * 1.5) % PITCH - PITCH / 2;
  const d = {x: near(b.x - a.x), y: near(b.y - a.y)};
  const [c0, c1] = [CHANGE.in[0], CHANGE.out[1]];
  return root.animate(f.steps.map((s, i) => {
    const t = i / (f.steps.length - 1), shown = from && to ? 1 : from ? 1 - part(t, c0, c1) : part(t, c0, c1);
    return {opacity: shown, backgroundPosition: `${a.x + d.x * s.q - box.left}px ${a.y + d.y * s.q - box.top}px`};
  }), {duration: f.ms, easing: 'linear', fill: 'both', pseudoElement: pseudo});
}
