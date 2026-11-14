import assert from 'node:assert/strict';
import {test} from 'node:test';
import {atRest, CODE, GAP, GRID, inSight, LINE, next, row, SHADOW, tabbed, tallest, termHeight, WIDTH} from './desk-layout.ts';

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

test('the desk is turned only as far as brings the piece in hand whole into sight, in whole cells', () => {
  const {at, end} = row(keys), face = 1488;
  // The first two are in sight from the row's start: nothing moves.
  assert.equal(inSight(0, at.get('term')!, WIDTH, face, end), 0);
  assert.equal(inSight(0, at.get('a.c')!, WIDTH, face, end), 0);
  // The third is cut by the face's edge: turned as little as shows it and its shadow.
  const to = inSight(0, at.get('README.md')!, WIDTH, face, end);
  assert.equal(to, GRID * Math.ceil((at.get('README.md')! + WIDTH + SHADOW - face) / GRID));
  assert.ok(to > 0 && to % GRID === 0);
  // Back to the terminal from there: turned back to the start.
  assert.equal(inSight(to, at.get('term')!, WIDTH, face, end), 0);
  // A piece wider than the face is read from its left.
  assert.equal(inSight(0, at.get('a.c')!, WIDTH, 400, end), at.get('a.c')!);
  // Let go of between two lines of the grid, the desk rests on the nearer.
  assert.equal(atRest(130), 5 * GRID);
  assert.equal(atRest(133), 6 * GRID);
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
