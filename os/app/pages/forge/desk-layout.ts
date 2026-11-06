// Where each box of the desk lies (desk.ts), and where the camera looks: kept apart from the page so it is measured
// and tested as numbers. The desk is a plane on a 24 px grid; its boxes stand in columns, each box as wide as 80
// columns of code, one under another in its column with three grid steps between them, the columns two steps apart.

/** The grid the desk is laid on. */
export const GRID = 24;
/** A box's width: 80 columns of code (7.82 px each), its numbers and its padding, up to the grid. */
export const WIDTH = up(80 * 7.82 + 72);
/** Between two columns, and between two boxes of one column. */
export const GAP = 2 * GRID;
export const VGAP = 3 * GRID;
/** The desk's margin round its boxes. */
export const PAD = 36;
/** Room above a column's first box for its name. */
export const TOP = 48;
/** How near the camera comes to the box in hand; how far it steps back to show the whole desk. */
export const CLOSE = 1;
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

/**
 * Close on the box at `slot` (`h` high) in a face `w` by `hgt`: the box's middle in the face's middle across, its top a
 * little under the face's top (all of it, when it fits; its top, when it does not).
 */
export function closeOn(slot: Slot, h: number, w: number, hgt: number): View {
  const s = CLOSE;
  const x = w / 2 - (slot.x + WIDTH / 2) * s;
  const fits = h * s + 2 * TOP <= hgt;
  const y = fits ? Math.min(TOP, (hgt - h * s) / 2) - slot.y * s : TOP - slot.y * s;
  return {s, x, y};
}

/** Stepped back: the whole desk (`places` with `heights`) in the face, at most WHOLE_MOST, centred across. */
export function wholeOf(places: Map<string, Slot>, heights: (key: string) => number, w: number, hgt: number): View {
  let right = 0, bottom = 0;
  for (const [key, p] of places) { right = Math.max(right, p.x + WIDTH); bottom = Math.max(bottom, p.y + heights(key)); }
  const s = Math.min(WHOLE_MOST, (w - 2 * PAD) / Math.max(right + PAD, 1), (hgt - 2 * PAD) / Math.max(bottom + PAD, 1));
  return {s, x: (w - (right + PAD) * s) / 2, y: PAD};
}

/** The box `from` hands over to going `way` (Alt and an arrow): along its column, or the next column's nearest. */
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
 * `cols` with `key` carried a slot `way` (Ctrl and an arrow): along its column, the others stepping over; or into the
 * next column at the same height (a new column past the last, none emptied but its own going).
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
  const d = c + (way === 'left' ? -1 : 1);
  if (d < 0) return out;
  out[c].splice(i, 1);
  if (d === out.length) out.push([]);
  out[d].splice(Math.min(i, out[d].length), 0, key);
  return out.filter((col, k) => col.length || k === 0);
}
