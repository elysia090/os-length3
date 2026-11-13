// Where each piece of the desk lies (desk.ts), and how far along it the desk is turned: kept apart from the page so it
// is measured and tested as numbers. The desk is a row on a 24 px grid: the terminal first, from the desk's own edge
// (the rail's corner, under the band's keys and as wide as they are), then the files, each a sheet fifty letters
// wide, three cells between them. Every piece's top is on one line; a sheet is as tall as
// its lines, never lower than two cells over the window's foot, what is under that scrolled to inside it. The desk is
// turned along the row only as far as brings the piece in hand whole into sight (before: boxes 80 columns wide in
// columns, one under another, the one in hand brought to the middle of the face by a camera).

/** The grid the desk is laid on, and a line of what is written on it at its own size. */
export const GRID = 24;
export const LINE = GRID;
/** The desk's code at rest: 14 px on a line of a cell (a sheet at rest is found and glanced at; made larger it is
 * read: `BIG`). */
export const CODE = 14;
/** A sheet's width: fifty letters of the desk's code (.602 of its size a letter), the numbers' margin before them (a
 * cell and a half) and half a cell after, up to the grid: twenty cells. */
export const WIDTH = up(1.5 * GRID + 50 * CODE * .602 + GRID / 2);
/** The terminal's width, and how many lines of it are in sight. */
export const TERM = 14 * GRID;
export const TERM_LINES = 18;
/** The terminal in hand: opened out to work in, wider and taller, the files gone along the row to make it room. */
export const TERM_HELD = 22 * GRID;
export const TERM_HELD_LINES = 20;
/** Between two sheets (the second is cut by the window's edge, and says the row goes on); after the terminal, which
 * lies askew and casts its shadow that way. */
export const GAP = 3 * GRID;
export const TERM_GAP = 3 * GRID;
/** The desk's ground before its first piece (none: the terminal starts where the band's keys do), over the pieces
 * (their names stand in it), and under them. */
export const PAD = 0;
export const TOP = 2 * GRID;
export const FOOT = 2 * GRID;
/** A piece's shadow, a cell right and down. */
export const SHADOW = GRID;
/** A piece pressed twice is this many times as large: exactly twice, so its letters (28 px), its lines (two cells),
 * its margins and its width (forty cells) are all on the desk's grid as they are at rest. */
export const BIG = 2;

function up(v: number): number { return GRID * Math.ceil(v / GRID); }

/** A piece of the row: its key, how wide it is, and whether it is the terminal (the gap after it is wider). */
export interface Piece { key: string; width: number; term?: boolean }

/** Where each piece's left edge is on the desk, and where the row ends (the last one's shadow, and a cell after). */
export function row(pieces: readonly Piece[]): {at: Map<string, number>; end: number} {
  const at = new Map<string, number>();
  let x = PAD, end = PAD;
  for (const p of pieces) {
    at.set(p.key, x);
    end = x + p.width + SHADOW + GRID;
    x += p.width + (p.term ? TERM_GAP : GAP);
  }
  return {at, end};
}

/** The tallest a sheet stands on a face `hgt` high, its lines `line` high: whole lines, half a line over and under
 * them, its foot no lower than FOOT over the face's; never under four lines. */
export function tallest(hgt: number, line = LINE): number {
  return (Math.max(4, Math.floor((hgt - TOP - FOOT - line) / line)) + 1) * line;
}

/** The terminal's height on a face `hgt` high: its lines (more of them while it is `held`) and a cell over and under
 * them, or as tall as a sheet may be. */
export function termHeight(hgt: number, line = LINE, held = false): number {
  return Math.min(((held ? TERM_HELD_LINES : TERM_LINES) + 2) * line, tallest(hgt, line));
}

/**
 * How far the desk is turned (from `now`) to bring the piece from `x`, `w` wide, into sight on a face `face` wide, the
 * row ending at `end`: where it is while the piece and its shadow are in sight; else as little further as shows them,
 * the piece at the desk's own edge (where the band's keys start); a piece wider than the face from its left. Never
 * past the row's end. A piece made larger (`lead`) is the page's one sheet: brought to the desk's edge, under the
 * band's keys, wherever it was.
 */
export function inSight(now: number, x: number, w: number, face: number, end: number, lead = false): number {
  const most = Math.max(0, end - face), left = x - PAD, right = x + w + SHADOW + GRID - face;
  const to = lead || now > left ? left : now < right ? Math.min(right, left) : now;
  return Math.max(0, Math.min(most, to));
}

/** The piece after `from` (before it, `back`) as Tab goes along the row, round again. */
export function tabbed(keys: readonly string[], from: string, back = false): string | null {
  const i = keys.indexOf(from);
  if (i < 0) return keys[0] ?? null;
  return keys[(i + (back ? keys.length - 1 : 1)) % keys.length];
}

/** The piece `from` hands over to going `way` (an arrow, the keyboard on the desk): the next along the row. */
export function next(keys: readonly string[], from: string, way: 'left' | 'right'): string | null {
  const i = keys.indexOf(from);
  if (i < 0) return null;
  return keys[i + (way === 'left' ? -1 : 1)] ?? null;
}
