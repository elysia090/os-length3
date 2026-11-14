import assert from 'node:assert/strict';
import {test} from 'node:test';
import {atRest, CODE, eased, GAP, GRID, LINE, next, planeWidth, row, SHADOW, tabbed, tallest, termHeight, turnedTo, turnTime, WIDTH} from './desk-layout.ts';

// The desk's places and how far it is turned (desk-layout.ts), as numbers.

const keys = ['term', 'a.c', 'README.md'];

test('a piece\'s place is its number in the row: all one width, two cells apart, on the grid', () => {
  const {at, end} = row(keys);
  keys.forEach((key, n) => assert.equal(at.get(key), n * (WIDTH + GAP)));
  assert.equal(end, at.get('README.md')! + WIDTH + SHADOW + GRID);
  // Fifty letters of 17 px, the numbers' margin before them and half a cell after, up to the grid.
  assert.equal(CODE, 17);
  assert.equal(WIDTH, 24 * GRID);
  for (const x of at.values()) assert.equal(x % GRID, 0);
  // A narrower piece (a window narrower than one): the same rule.
  assert.equal(row(keys, 14 * GRID).at.get('a.c'), 16 * GRID);
  assert.deepEqual(row([]), {at: new Map(), end: 0});
});

test('a window half a screen wide shows one piece and the edge of the next; a whole screen, two and the edge of the third', () => {
  const {at} = row(keys), half = 768 - 48, whole = 1536 - 48;
  assert.ok(at.get('term')! + WIDTH + SHADOW <= half && at.get('a.c')! < half && at.get('a.c')! + WIDTH > half);
  assert.ok(at.get('a.c')! + WIDTH + SHADOW <= whole && at.get('README.md')! < whole && at.get('README.md')! + WIDTH > whole);
});

test('a sheet is whole lines tall, its foot a cell over the face\'s', () => {
  // A face 804 high: 30 lines and half a line over and under them.
  assert.equal(tallest(804), 31 * LINE);
  // Never under four lines, however low the face.
  assert.equal(tallest(100), 5 * LINE);
  // The terminal: eighteen lines and a cell over and under, or what a low face has room for.
  assert.equal(termHeight(804), 20 * LINE);
  assert.equal(termHeight(300), tallest(300));
});

test('the desk rests with a piece at its edge and nowhere else; a piece whole in sight is gone to where it lies, one cut or out of sight by the nearest rest that shows it whole', () => {
  const four = [...keys, 'Makefile'], {at} = row(four), starts = [...at.values()], pitch = WIDTH + GAP;
  const go = (now: number, key: string, face: number) => turnedTo(now, at.get(key)!, WIDTH, face, starts);
  // A whole screen (61 cells of desk): two pieces whole in sight. The second pressed: nothing moves.
  const whole = 1536 - 48;
  assert.equal(go(0, 'term', whole), 0);
  assert.equal(go(0, 'a.c', whole), 0);
  // The third is cut by the edge: brought in by one piece, the second now at the edge (not the third: the least move).
  assert.equal(go(0, 'README.md', whole), pitch);
  // The fourth from the start: the third at the edge.
  assert.equal(go(0, 'Makefile', whole), 2 * pitch);
  // Back to one before the edge: that one at the edge.
  assert.equal(go(2 * pitch, 'term', whole), 0);
  assert.equal(go(2 * pitch, 'a.c', whole), pitch);
  // Half a screen (29 cells): one piece whole in sight. Any other gone to is at the edge.
  const half = 768 - 48;
  assert.equal(go(0, 'a.c', half), pitch);
  assert.equal(go(pitch, 'Makefile', half), 3 * pitch);
  // A phone (a piece as wide as the face has room for): the same.
  const narrow = row(four, 13 * GRID), ns = [...narrow.at.values()];
  assert.equal(turnedTo(0, narrow.at.get('a.c')!, 13 * GRID, 342, ns), 15 * GRID);
  // Every rest is a piece's start, on the grid.
  for (const face of [whole, half]) for (const from of starts) for (const key of four) { const to = go(from, key, face); assert.ok(starts.includes(to) && to % GRID === 0); }
  // Scrolled by hand and let go, the desk comes to rest at the nearest piece.
  assert.equal(atRest(0, starts), 0);
  assert.equal(atRest(.49 * pitch, starts), 0);
  assert.equal(atRest(.51 * pitch, starts), pitch);
  assert.equal(atRest(99999, starts), 3 * pitch);
  assert.equal(atRest(77, []), 0);
  // The last piece can stand at the edge: the plane is that much wider than the row.
  assert.equal(planeWidth(at.get('Makefile')!, whole) - whole, at.get('Makefile')!);
});

test('one law for every move of the desk: off at once, most of the way in the first third, at rest at the end; a longer way takes a little longer, never over 420 ms', () => {
  assert.equal(eased(0), 0);
  assert.equal(eased(1), 1);
  assert.ok(eased(1 / 3) > .7 && eased(1 / 3) < .8);
  assert.ok(eased(.05) > 0);
  for (let u = 0; u < 1; u += .05) assert.ok(eased(u + .05) > eased(u));
  assert.equal(turnTime(0, 1488), 250);
  assert.equal(turnTime(744, 1488), 335);
  assert.equal(turnTime(1488, 1488), 420);
  assert.equal(turnTime(-9999, 1488), 420);
});

test('Tab goes along the row and round; an arrow to the next, and no further than the ends', () => {
  assert.equal(tabbed(keys, 'term'), 'a.c');
  assert.equal(tabbed(keys, 'README.md'), 'term');
  assert.equal(tabbed(keys, 'term', true), 'README.md');
  assert.equal(tabbed(keys, 'gone'), 'term');
  assert.equal(next(keys, 'a.c', 'left'), 'term');
  assert.equal(next(keys, 'a.c', 'right'), 'README.md');
  assert.equal(next(keys, 'README.md', 'right'), null);
  assert.equal(next(keys, 'term', 'left'), null);
});
