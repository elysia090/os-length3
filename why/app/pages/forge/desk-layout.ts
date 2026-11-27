// Where each piece of the desk lies (desk.ts), and how far along it the desk is turned: kept apart from the page so it
// is measured and tested as numbers. One rule for where a piece is: the pieces lie in a row on a 24 px grid in the
// order they were opened (the terminal first), every one the same width, half a cell between them, so a piece's place is
// its number in the row and nothing else: x = n * (WIDTH + GAP). Every piece's top is on one line, a cell under the
// band (its name stands in that cell); its working surface reaches to the window's foot regardless of line count.
// What is under that is scrolled to inside it. The desk rests only with a piece at its edge: a piece gone to that is
// not whole in sight is brought in by the nearest such rest, and scrolled by hand the desk comes to rest at the nearest.
// (Before: a terminal fourteen cells wide lying askew, wider while in hand; sheets twenty cells wide of 14 px code,
// twice as large pressed twice; before that boxes 80 columns wide in columns, the one in hand brought to the middle.)

import {eased, moveTime} from '../../ui/law.ts';
import {atRest, turnedTo as rowTurnedTo} from '../../ui/row.ts';

/** The grid the desk is laid on, and a line of what is written on it. */
export const GRID = 24;
export const LINE = GRID;
/** What is read and written on the desk: 17 px on a line of a cell. (A small letter of it is a fifth of a degree
 * tall at a desk's distance on an ordinary screen, where reading stops slowing; 14 px is a sixth.) */
export const CODE = 17;
/** A piece's width, a file's or a terminal's: the numbers' two cells before its words (three figures and a letter's
 * room), forty-nine letters (.602 of their size each), and a cell of paper after, up to the grid: twenty-four cells.
 * Every column of it whole cells (DESIGN §3). A window half a screen wide (29 cells of desk) shows one and the edge of
 * the next; a whole screen (61), two and the edge of the third. */
export const WIDTH = up(2 * GRID + 49 * CODE * .602 + GRID);
/** How many lines of the terminal are in sight. */
export const TERM_LINES = 18;
/** Half a cell between papers, including the active paper's thin shadow. */
export const GAP = GRID / 2;
/** The desk's ground before its first piece (none: it starts where the band's keys do), over the pieces (their names
 * stand in it), and under them. */
export const PAD = 0;

/** Fitted work paper on a wide desk, or two full opposite pages when the first explicitly asks for Beside. */
export function widthOn(face: number, fitted: boolean, beside = false): number {
  const floor = (width: number) => Math.max(10 * GRID, GRID * Math.floor(width / GRID));
  if (fitted && beside) return Math.min(WIDTH, floor((face - PAD - SHADOW - GAP) / 2));
  const fits = floor(face - PAD - SHADOW);
  return fitted ? fits : Math.min(WIDTH, fits);
}
export const TOP = GRID;
export const FOOT = GRID;
/** The active paper's shadow (forge-places.css). */
export const SHADOW = 4;

function up(v: number): number { return GRID * Math.ceil(v / GRID); }

/** Where each of `keys` lies along the row, each `width` wide, and where the row ends (the last one's shadow, and a
 * cell after). */
export function row(keys: readonly string[], width = WIDTH): {at: Map<string, number>; end: number} {
  const at = new Map<string, number>();
  keys.forEach((key, n) => at.set(key, PAD + n * (width + GAP)));
  return {at, end: keys.length ? PAD + (keys.length - 1) * (width + GAP) + width + SHADOW + GRID : PAD};
}

/** The tallest a sheet stands on a face `hgt` high: whole lines, a cell of paper over and under them, its foot no lower
 * than FOOT over the face's; never under four lines. */
export function tallest(hgt: number): number {
  return (Math.max(4, Math.floor((hgt - TOP - FOOT - 2 * LINE) / LINE)) + 2) * LINE;
}

/**
 * Where the line being written may stand in a sheet on a face `hgt` high (DESIGN §2, look room): never in the third of
 * the world it goes towards. Measured from the top of what scrolls in the sheet (a cell under the piece's top):
 * `foot`, the lowest a line's foot may be (the lower third line, up to the line above it), and `top`, the highest a
 * line's top may be while there is more above to turn back to (the upper third line, down to the next line).
 */
export function ahead(hgt: number): {top: number; foot: number} {
  const from = TOP + LINE;
  return {top: LINE * Math.ceil((hgt / 3 - from) / LINE), foot: LINE * Math.floor((2 * hgt / 3 - from) / LINE)};
}

/** The terminal's height on a face `hgt` high: its lines and a cell over and under them, as many as keep its last line
 * (where its work is) out of the lower third, at most TERM_LINES and never under four. */
export function termHeight(hgt: number): number {
  const lines = Math.max(4, Math.min(TERM_LINES, Math.floor((2 * hgt / 3 - TOP - LINE) / LINE)));
  return Math.min((lines + 2) * LINE, tallest(hgt));
}

/**
 * Where the desk is turned for the piece at `x` (`w` wide) now in hand, with the desk turned by `now` on a face `face`
 * wide (DESIGN §2, eye-trace before the plane): `pressed`, the eye is on it where it was pressed, and it does not go
 * from under the hand (`turnedTo`); gone to any other way (a key, a find, the place come to), the eye is where the
 * last subject stood, at the desk's edge, and it comes there, the row ahead of it.
 */
export function restFor(pressed: boolean, now: number, x: number, w: number, face: number, starts: readonly number[]): number {
  return pressed ? turnedTo(now, x, w, face, starts) : x;
}

/**
 * Where the desk rests: with a piece's left edge at its own (under the band's first key), and nowhere else; and how
 * far it is turned for a piece gone to. The rule is every row's (ui/row.ts), with this desk's shadow.
 */
export function turnedTo(now: number, x: number, w: number, face: number, starts: readonly number[]): number {
  return rowTurnedTo(now, x, w, face, starts, SHADOW);
}
export {atRest};

/** How wide the desk's plane is so that its last piece, at `last`, can stand at the edge of a face `face` wide. */
export function planeWidth(last: number, face: number): number { return last - PAD + face; }

/** How long the desk takes to go `far` px on a face `face` wide, and how far along it is at a part of that time: the
 * OS's one law (ui/law.ts). */
export const turnTime = moveTime;
export {eased};

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
