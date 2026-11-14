import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BIG, GAP, GRID, inSight, LINE, next, PAD, row, SHADOW, tabbed, tallest, TERM, TERM_GAP, termHeight, WIDTH} from './desk-layout.ts';

// The desk's places and how far it is turned (desk-layout.ts), as numbers.

const pieces = [{key: 'term', width: TERM, term: true}, {key: 'a.c', width: WIDTH}, {key: 'README.md', width: WIDTH}];

test('the pieces lie in a row on the grid: the terminal, then the files two cells apart', () => {
  const {at, end} = row(pieces);
  assert.equal(at.get('term'), PAD);
  assert.equal(at.get('a.c'), PAD + TERM + TERM_GAP);
  assert.equal(at.get('README.md'), PAD + TERM + TERM_GAP + WIDTH + GAP);
  assert.equal(end, at.get('README.md')! + WIDTH + SHADOW + GRID);
  // Fifty letters, the numbers' margin before them and half a cell after, on the grid; twice that when made larger.
  assert.equal(WIDTH, 20 * GRID);
  assert.equal(WIDTH * BIG, 40 * GRID);
  for (const x of at.values()) assert.equal(x % GRID, 0);
});

test('a sheet is whole lines tall, its foot a cell over the face\'s', () => {
  // A face 804 high: 30 lines and half a line over and under them.
  assert.equal(tallest(804), 31 * LINE);
  // Larger letters, fewer lines, the same foot or higher.
  const big = tallest(804, LINE * BIG);
  assert.ok(big <= 804 - 2 * GRID && big > 804 - 2 * GRID - LINE * BIG);
  // Never under four lines, however low the face.
  assert.equal(tallest(100), 5 * LINE);
  // The terminal: fourteen lines and a cell over and under, or what a low face has room for.
  assert.equal(termHeight(804), 20 * LINE);
  assert.equal(termHeight(300), tallest(300));
});

test('the desk is turned only as far as brings the piece in hand whole into sight', () => {
  const {at, end} = row(pieces), face = 1320;
  // The first two are in sight from the row's start: nothing moves.
  assert.equal(inSight(0, at.get('term')!, TERM, face, end), 0);
  assert.equal(inSight(0, at.get('a.c')!, WIDTH, face, end), 0);
  // The third is cut by the face's edge: turned as little as shows it and its shadow.
  const to = inSight(0, at.get('README.md')!, WIDTH, face, end);
  assert.equal(to, GRID * Math.ceil((at.get('README.md')! + WIDTH + SHADOW - face) / GRID));
  assert.ok(to > 0 && to <= end - face && to % GRID === 0);
  // Back to the terminal from there: turned back to the start, a cell of ground before it.
  assert.equal(inSight(to, at.get('term')!, TERM, face, end), 0);
  // A piece wider than the face is read from its left.
  assert.equal(inSight(0, at.get('a.c')!, WIDTH, 400, end), at.get('a.c')! - PAD);
});

test('Tab goes along the row and round; an arrow to the next, and no further than the ends', () => {
  const keys = pieces.map((p) => p.key);
  assert.equal(tabbed(keys, 'term'), 'a.c');
  assert.equal(tabbed(keys, 'README.md'), 'term');
  assert.equal(tabbed(keys, 'term', true), 'README.md');
  assert.equal(tabbed(keys, 'gone'), 'term');
  assert.equal(next(keys, 'a.c', 'left'), 'term');
  assert.equal(next(keys, 'a.c', 'right'), 'README.md');
  assert.equal(next(keys, 'README.md', 'right'), null);
  assert.equal(next(keys, 'term', 'left'), null);
});
