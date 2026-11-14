// Where each piece of the desk lies (desk.ts), and how far along it the desk is turned: kept apart from the page so it
// is measured and tested as numbers. One rule for where a piece is: the pieces lie in a row on a 24 px grid in the
// order they were opened (the terminal first), every one the same width, two cells between them, so a piece's place is
// its number in the row and nothing else: x = n * (WIDTH + GAP). Every piece's top is on one line, a cell under the
// band (its name stands in that cell); it is as tall as its lines, never lower than a cell over the window's foot,
// what is under that scrolled to inside it. The desk rests only with a piece at its edge: a piece gone to that is
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
/** A piece's width, a file's or a terminal's: fifty letters (.602 of their size each), the numbers' margin before them
 * (a cell and a half) and half a cell after, up to the grid: twenty-four cells. A window half a screen wide (29 cells
 * of desk) shows one and the edge of the next; a whole screen (61), two and the edge of the third. */
export const WIDTH = up(1.5 * GRID + 50 * CODE * .602 + GRID / 2);
/** How many lines of the terminal are in sight. */
export const TERM_LINES = 18;
/** Between two pieces: the shadow of the one in hand, and a cell and a half clear of it. */
export const GAP = 2 * GRID;
/** The desk's ground before its first piece (none: it starts where the band's keys do), over the pieces (their names
 * stand in it), and under them. */
export const PAD = 0;
export const TOP = GRID;
export const FOOT = GRID;
/** A piece's shadow, half a cell right and down (styles: --shade). */
export const SHADOW = GRID / 2;

function up(v: number): number { return GRID * Math.ceil(v / GRID); }

/** Where each of `keys` lies along the row, each `width` wide, and where the row ends (the last one's shadow, and a
 * cell after). */
export function row(keys: readonly string[], width = WIDTH): {at: Map<string, number>; end: number} {
  const at = new Map<string, number>();
  keys.forEach((key, n) => at.set(key, PAD + n * (width + GAP)));
  return {at, end: keys.length ? PAD + (keys.length - 1) * (width + GAP) + width + SHADOW + GRID : PAD};
}

/** The tallest a sheet stands on a face `hgt` high: whole lines, half a line over and under them, its foot no lower
 * than FOOT over the face's; never under four lines. */
export function tallest(hgt: number): number {
  return (Math.max(4, Math.floor((hgt - TOP - FOOT - LINE) / LINE)) + 1) * LINE;
}

/** The terminal's height on a face `hgt` high: its lines and a cell over and under them, or as tall as a sheet may be. */
export function termHeight(hgt: number): number {
  return Math.min((TERM_LINES + 2) * LINE, tallest(hgt));
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
