// Where each box of the desk lies (desk.ts), and where the camera looks: kept apart from the page so it is measured
// and tested as numbers. The desk is a plane on a 24 px grid; its boxes stand in columns, each box as wide as 80
// columns of code, one under another in its column with three grid steps between them, the columns two steps apart.
// The desk has one size, every box at its own, the box in hand in the middle across with its top at the eye (before:
// three cameras, a step back and the whole desk beside this one).

/** The grid the desk is laid on. */
export const GRID = 24;
/** A box's width: 80 columns of the desk's code (14 px, 8.42 px a column), its numbers and its padding, up to the grid. */
export const WIDTH = up(80 * 8.42 + 72);
/** Between two columns, and between two boxes of one column. */
export const GAP = 2 * GRID;
export const VGAP = 3 * GRID;
/** The desk's margin round its boxes. */
export const PAD = 36;
/** Room above a column's first box for its name. */
export const TOP = 48;
/** The standard: every box at its own size. */
export const STANDARD = 1;
/** How far under the face's top the line at work is kept (lineKept). */
export const KEPT = 2 * GRID;

function up(v: number): number { return GRID * Math.ceil(v / GRID); }

export interface Slot { x: number; y: number }

/** Each box's place: `cols` (each column's keys, top first), `heights` each box's height. */
export function slots(cols: readonly (readonly string[])[], heights: (key: string) => number, bw = WIDTH): Map<string, Slot> {
  const out = new Map<string, Slot>();
  cols.forEach((col, c) => {
    let y = TOP;
    for (const key of col) {
      out.set(key, {x: PAD + c * (bw + GAP), y});
      y += up(heights(key)) + VGAP;
    }
  });
  return out;
}

/** The camera: the plane's scale, and where its origin is on the face. */
export interface View { s: number; x: number; y: number }

/** How far under a box's foot what hangs from it reaches: its close, a dot 16 px under its bottom corner, 9 px across
 * (styles: .desk-close); its shadow, 8 px, falls inside that. */
export const FOOT = 16 + 9;

/** Where a box's top stands on the face, in px from the desk's top: level with the rail between Home and File (its
 * items stand at fixed places from the top, so this is a distance, not a share of the height). High enough that the box
 * above it in its column (a whole gap above, with its name), its shadow and the dot of its close are wholly out of the
 * face: never a strip, nor a dot, cut by its edge. */
export const EYE = VGAP - FOOT - 1;

/** A box just come out from under the one above it: so much of that one's foot (on the face) stays in sight over it
 * (or all of it, if it is less), the new box lower than the eye by as much, so what it was made under is seen with it. */
export const ABOVE_SEEN = 5 * GRID;

/** On the box at `slot` just come out from under one `above` high, at scale `s` (the standard, or a step back): as
 * standardOn, lower by what keeps ABOVE_SEEN of that one in sight (its foot, its close, the gap and the new box's name
 * under them). */
export function bornOn(slot: Slot, h: number, w: number, hgt: number, above: number, s = STANDARD, bw = WIDTH): View {
  const v = standardOn(slot, h, w, hgt, s, bw);
  return {...v, y: v.y + Math.min(above * s, ABOVE_SEEN) + VGAP * s - EYE};
}

/**
 * At the standard, on the box at `slot` (`h` high) in a face `w` by `hgt`: the box's middle in the face's middle across,
 * its top at EYE (a tall one goes on down from there; a short one stands where the eye starts, not in a hole in the
 * middle).
 */
export function standardOn(slot: Slot, _h: number, w: number, _hgt: number, s = STANDARD, bw = WIDTH): View {
  const x = w / 2 - (slot.x + bw / 2) * s;
  return {s, x, y: EYE - slot.y * s};
}

/**
 * The camera's way from `a` to `b` over a face `w` by `hgt` when it is long: as a head turns to something across the
 * room, it steps back on the way as far as the way is long and comes down onto what it goes to (van Wijk and Nuij's
 * smooth zoom and pan: back about to where what it left and what it goes to are both nearly in sight at the middle of
 * the way, the boxes passing read, never a whip across the desk at their own size, half boxes going by). `at(t)` is the
 * view at `t` (0 to 1 along the way); `ms` how long it takes, a plain pan's `ms` for the shortest arc, longer as the way
 * is. Null for a way short enough that what it goes to is in sight from where it sets off (a plain pan, no step back).
 */
export function arc(a: View, b: View, w: number, hgt: number, ms: number): {at(t: number): View; ms: number} | null {
  const c0 = {x: (w / 2 - a.x) / a.s, y: (hgt / 2 - a.y) / a.s}, c1 = {x: (w / 2 - b.x) / b.s, y: (hgt / 2 - b.y) / b.s};
  const w0 = w / a.s, w1 = w / b.s, dx = c1.x - c0.x, dy = c1.y - c0.y, d = Math.hypot(dx, dy);
  if (d < ARC_FROM * Math.min(w, hgt) / Math.max(a.s, b.s)) return null;
  const r2 = ARC_RHO ** 2, r4 = r2 * r2;
  const b0 = (w1 * w1 - w0 * w0 + r4 * d * d) / (2 * w0 * r2 * d), b1 = (w1 * w1 - w0 * w0 - r4 * d * d) / (2 * w1 * r2 * d);
  const q0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), q1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1), S = (q1 - q0) / ARC_RHO;
  const at = (t: number): View => {
    if (t >= 1) return b;
    const p = t * S, u = (w0 / (r2 * d)) * (Math.cosh(q0) * Math.tanh(ARC_RHO * p + q0) - Math.sinh(q0));
    const s = w / ((w0 * Math.cosh(q0)) / Math.cosh(ARC_RHO * p + q0)), cx = c0.x + u * dx, cy = c0.y + u * dy;
    return {s, x: w / 2 - cx * s, y: hgt / 2 - cy * s};
  };
  return {at, ms: Math.round(Math.min(ARC_MOST, ms * Math.max(1, Math.sqrt(S / ARC_S))))};
}
/** How far apart (a part of the face's shorter side) where the camera is and where it goes are before it arcs. */
const ARC_FROM = .5;
/** How far back an arc goes for its length (van Wijk and Nuij's ρ, as d3's zoom): to about three quarters going to
 * the next column, where both are in sight. */
const ARC_RHO = Math.SQRT2;
/** An arc's length (in its own measure) that takes a plain pan's time; longer ones take longer, at most ARC_MOST. */
const ARC_S = .8;
const ARC_MOST = 900;

/** The line at work in a box (`top` to `bottom`, on the desk), as the camera at `v` over a face `hgt` high should show
 * it: `v` while it is in sight and above the face's foot by FOOT_ROOM; else `v` moved down (or up) as a page is turned,
 * the line then at TURNED of the face, room under it for what comes next. */
export function lineKept(v: View, top: number, bottom: number, hgt: number): View {
  const t = v.y + top * v.s, b = v.y + bottom * v.s;
  if (t >= KEPT && b <= hgt - FOOT_ROOM) return v;
  return {...v, y: v.y + (TURNED * hgt - t)};
}
/** How near the face's foot the line at work comes before the camera goes on down (three grid steps). */
export const FOOT_ROOM = 3 * GRID;
/** Where on the face (from its top, a part of its height) the line at work is put when the camera goes on down to it. */
export const TURNED = .4;

/** The box after `from` (before it, `back`) as Tab goes: down each column, then the next column's top, round again. */
export function tabbed(cols: readonly (readonly string[])[], from: string, back = false): string | null {
  const all = cols.flat();
  const i = all.indexOf(from);
  if (i < 0) return all[0] ?? null;
  return all[(i + (back ? all.length - 1 : 1)) % all.length];
}

/** The box `from` hands over to going `way` (an arrow, the keyboard on the desk): along its column, or the next column's nearest. */
export function next(cols: readonly (readonly string[])[], from: string, way: 'up' | 'down' | 'left' | 'right'): string | null {
  const c = cols.findIndex((col) => col.includes(from));
  if (c < 0) return null;
  const i = cols[c].indexOf(from);
  if (way === 'up') return cols[c][i - 1] ?? null;
  if (way === 'down') return cols[c][i + 1] ?? null;
  const to = cols[c + (way === 'left' ? -1 : 1)];
  if (!to?.length) return null;
  return to[Math.min(i, to.length - 1)];
}

