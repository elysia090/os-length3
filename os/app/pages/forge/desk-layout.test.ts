import assert from 'node:assert/strict';
import {test} from 'node:test';
import {carried, closeOn, GAP, next, PAD, slots, TOP, VGAP, WIDTH, wholeOf} from './desk-layout.ts';

// The desk's places and its camera (desk-layout.ts), as numbers.

const cols = [['term'], ['a.c', 'b.c'], ['README.md']];
const heights = (key: string) => (key === 'term' ? 400 : 200);

test('boxes stand in columns on the grid, one under another', () => {
  const at = slots(cols, heights);
  assert.deepEqual(at.get('term'), {x: PAD, y: TOP});
  assert.deepEqual(at.get('a.c'), {x: PAD + WIDTH + GAP, y: TOP});
  assert.deepEqual(at.get('b.c'), {x: PAD + WIDTH + GAP, y: TOP + 216 + VGAP});
  assert.equal(WIDTH % 24, 0);
});

test('close, the box in hand is in the middle across, under the top; stepped back, the whole desk fits', () => {
  const at = slots(cols, heights);
  const v = closeOn(at.get('a.c')!, 200, 1000, 800);
  assert.equal(v.x + (at.get('a.c')!.x + WIDTH / 2) * v.s, 500);
  assert.ok(v.y + at.get('a.c')!.y * v.s >= 0);
  const w = wholeOf(at, heights, 1000, 800);
  assert.ok(w.s <= 0.5 && w.x + (at.get('README.md')!.x + WIDTH) * w.s <= 1000);
});

test('Alt and an arrow hand over along a column or to the next; Ctrl and an arrow carry a box', () => {
  assert.equal(next(cols, 'a.c', 'down'), 'b.c');
  assert.equal(next(cols, 'b.c', 'right'), 'README.md');
  assert.equal(next(cols, 'term', 'left'), null);
  assert.deepEqual(carried(cols, 'b.c', 'up'), [['term'], ['b.c', 'a.c'], ['README.md']]);
  // Into the next column at the same height; the column it leaves, emptied, goes.
  assert.deepEqual(carried(cols, 'README.md', 'left'), [['term'], ['README.md', 'a.c', 'b.c']]);
  assert.deepEqual(carried(cols, 'b.c', 'right'), [['term'], ['a.c'], ['README.md', 'b.c']]);
});
