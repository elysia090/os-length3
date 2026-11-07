// Where each box of the desk lies (desk.ts), and where the camera looks: kept apart from the page so it is measured
// and tested as numbers. The desk is a plane on a 24 px grid; its boxes stand in columns, each box as wide as 80
// columns of code, one under another in its column with three grid steps between them, the columns two steps apart.
// The camera has three places, as a game's cameras do: its standard, every box at its own size, the box in hand in the
// middle (a balance found good: never nearer than that); a step back, the boxes beside it in sight; and the whole desk.

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
/** The standard: every box at its own size. A step back, the box in hand still read and those beside it in sight; the
 * whole desk, at most half of it. */
export const STANDARD = 1;
export const PULLED = 0.7;
export const WHOLE_MOST = 0.5;

function up(v: number): number { return GRID * Math.ceil(v / GRID); }

export interface Slot { x: number; y: number }

/** Each box's place: `cols` (each column's keys, top first), `heights` each box's height. */
export function slots(cols: readonly (readonly string[])[], heights: (key: string) => number): Map<string, Slot> {
  const out = new Map<string, Slot>();
  cols.forEach((col, c) => {
    let y = TOP;
    for (const key of col) {
      out.set(key, {x: PAD + c * (WIDTH + GAP), y});
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
export function bornOn(slot: Slot, h: number, w: number, hgt: number, above: number, s = STANDARD): View {
  const v = standardOn(slot, h, w, hgt, s);
  return {...v, y: v.y + Math.min(above * s, ABOVE_SEEN) + VGAP * s - EYE};
}

/**
 * At the standard, on the box at `slot` (`h` high) in a face `w` by `hgt`: the box's middle in the face's middle across,
 * its top at EYE (a tall one goes on down from there; a short one stands where the eye starts, not in a hole in the
 * middle).
 */
export function standardOn(slot: Slot, _h: number, w: number, _hgt: number, s = STANDARD): View {
  const x = w / 2 - (slot.x + WIDTH / 2) * s;
  return {s, x, y: EYE - slot.y * s};
}

/** A step back, on the box at `slot` (`h` high): smaller, in the middle across and down (a tall one from the eye), the
 * boxes beside it, above it and under it in sight round it, as a step back is taken to see. */
export function pulledOn(slot: Slot, h: number, w: number, hgt: number): View {
  const v = standardOn(slot, h, w, hgt, PULLED);
  return {...v, y: Math.max(EYE, (hgt - h * PULLED) / 2) - slot.y * PULLED};
}

/** Stepped back: the whole desk (each box's slot and height, its name over it, its shadow) in the face, at most
 * WHOLE_MOST, centred. */
export function wholeOf(boxes: {slot: Slot; h: number}[], w: number, hgt: number): View {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const {slot, h} of boxes) { l = Math.min(l, slot.x); t = Math.min(t, slot.y - 24); r = Math.max(r, slot.x + WIDTH + 8); b = Math.max(b, slot.y + h + 8); }
  if (!isFinite(l)) return {s: WHOLE_MOST, x: 0, y: 0};
  const s = Math.min(WHOLE_MOST, (w - 96) / (r - l), (hgt - 96) / (b - t));
  return {s, x: (w - (r - l) * s) / 2 - l * s, y: Math.max(TOP, (hgt - (b - t) * s) / 2) - t * s};
}

/** Held up to be carried, the least the camera goes back to have the desk in sight whole round the box; a desk too
 * wide for it is seen round the box at it. */
export const LIFTED_LEAST = 0.25;
/** How far in from the face's edges a box carried is kept. */
export const KEPT = 2 * GRID;

/**
 * Held up to be carried (Ctrl), the camera over the desk as it may stand while `held` goes across it, still: every box,
 * room for one more column (the box's own, out of the column it shares: `shares`) and for the box under the longest
 * column, laid as wholeOf lays them; the box goes across a desk that stands, never with a camera after it. A desk too
 * wide for that at LIFTED_LEAST is seen at it round the box instead (the camera goes with the box only as far as keeps
 * it in sight: kept).
 */
export function liftedOf(boxes: {slot: Slot; h: number}[], held: {slot: Slot; h: number}, shares: boolean, w: number, hgt: number): View {
  let right = -Infinity, low = -Infinity, top = Infinity;
  for (const {slot, h} of boxes) { right = Math.max(right, slot.x); low = Math.max(low, slot.y + h); top = Math.min(top, slot.y); }
  const room = [...boxes, {slot: {x: held.slot.x, y: low + VGAP}, h: held.h}];
  if (shares) room.push({slot: {x: right + WIDTH + GAP, y: top}, h: held.h});
  const whole = wholeOf(room, w, hgt);
  if (whole.s >= LIFTED_LEAST) return whole;
  const s = LIFTED_LEAST, t = top - 24, b = low + VGAP + held.h + 8;
  return {s, x: w / 2 - (held.slot.x + WIDTH / 2) * s, y: Math.max(TOP, (hgt - (b - t) * s) / 2) - t * s};
}

/** `v` moved the least that keeps the box at `slot` (`h` high) KEPT in from the edges of a face `w` by `hgt` (its top
 * only, down to a third of the face, when it is taller than the face): `v` itself while it is in sight. */
export function kept(v: View, slot: Slot, h: number, w: number, hgt: number): View {
  const l = v.x + slot.x * v.s, r = l + WIDTH * v.s, t = v.y + slot.y * v.s, tall = h * v.s;
  const dx = l < KEPT ? KEPT - l : r > w - KEPT ? w - KEPT - r : 0;
  const low = tall <= hgt - 2 * KEPT ? hgt - KEPT - tall : hgt / 3;
  const dy = t < KEPT ? KEPT - t : t > low ? low - t : 0;
  return dx || dy ? {s: v.s, x: v.x + dx, y: v.y + dy} : v;
}

/**
 * At the standard, over the boxes at `boxes` (each its slot and height) at once, as they lie: their middle in the
 * face's middle when they all fit in it; null when they do not (the camera goes along to the one at work instead,
 * never stepping back for them).
 */
export function overAll(boxes: {slot: Slot; h: number}[], w: number, hgt: number): View | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const {slot, h} of boxes) { l = Math.min(l, slot.x); t = Math.min(t, slot.y); r = Math.max(r, slot.x + WIDTH); b = Math.max(b, slot.y + h); }
  if (r - l > w - 2 * PAD || b - t > hgt - 2 * PAD) return null;
  return {s: STANDARD, x: (w - (r - l)) / 2 - l, y: Math.max(PAD, (hgt - (b - t)) / 2) - t};
}

/** The box after `from` (before it, `back`) as Tab goes: down each column, then the next column's top, round again. */
export function tabbed(cols: readonly (readonly string[])[], from: string, back = false): string | null {
  const all = cols.flat();
  const i = all.indexOf(from);
  if (i < 0) return all[0] ?? null;
  return all[(i + (back ? all.length - 1 : 1)) % all.length];
}

/** The box `from` hands over to going `way` (an arrow, the finger on it): along its column, or the next column's nearest. */
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

/**
 * `cols` with `key` carried a slot `way` (Ctrl and an arrow): along its column, the others stepping over. Sideways the
 * slots alternate, as a hand putting a sheet between two others would: out of a column with others it goes first into
 * the gap beside it, a column of its own between that one and the next (or past the last); a column of its own, it goes
 * on into the next column, at the same place in it; none there, it stays (the desk says so: a nudge).
 */
export function carried(cols: readonly (readonly string[])[], key: string, way: 'up' | 'down' | 'left' | 'right'): string[][] {
  const out = cols.map((col) => [...col]);
  const c = out.findIndex((col) => col.includes(key));
  if (c < 0) return out;
  const i = out[c].indexOf(key);
  if (way === 'up' || way === 'down') {
    const j = i + (way === 'up' ? -1 : 1);
    if (j < 0 || j >= out[c].length) return out;
    [out[c][i], out[c][j]] = [out[c][j], out[c][i]];
    return out;
  }
  const right = way === 'right';
  if (out[c].length > 1) {
    out[c].splice(i, 1);
    out.splice(right ? c + 1 : c, 0, [key]);
    return out;
  }
  const d = c + (right ? 1 : -1);
  if (d < 0 || d >= out.length) return out;
  out[d].splice(Math.min(i, out[d].length), 0, key);
  out.splice(c, 1);
  return out.filter((col, k) => col.length || k === 0);
}
