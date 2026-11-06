import assert from 'node:assert/strict';
import {test} from 'node:test';
import {baseOn, carried, CLOSE_LEAST, CLOSE_MOST, closeOn, GAP, next, overAll, PAD, slots, TOP, VGAP, WIDTH} from './desk-layout.ts';

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

test('at the base, the box in hand is in the middle across, under the top, at its own size', () => {
  const at = slots(cols, heights);
  const v = baseOn(at.get('a.c')!, 200, 1000, 800);
  assert.equal(v.s, 1);
  assert.equal(v.x + (at.get('a.c')!.x + WIDTH / 2) * v.s, 500);
  assert.ok(v.y + at.get('a.c')!.y * v.s >= 0);
});

test('close, as near as the box fits across: where the work is stays in sight, the box never let past its top or its foot', () => {
  const at = slots(cols, heights), slot = at.get('a.c')!;
  // A tall box, the work far down it, in a narrow face: from the box's left edge, the work a little over the middle.
  const v = closeOn(slot, 3000, 900, 800, {x: 60, y: 2000});
  assert.equal(v.s, CLOSE_LEAST);
  assert.equal(v.x + slot.x * v.s, PAD);
  // A face wide enough: the box fills it across, a margin either side, and no nearer than the most.
  const fit = closeOn(slot, 200, 1000, 800, null);
  assert.ok(Math.abs(fit.s - (1000 - 2 * PAD) / WIDTH) < 1e-9 && fit.s <= CLOSE_MOST);
  assert.ok(Math.abs(fit.x + slot.x * fit.s - PAD) < 1e-9);
  assert.equal(closeOn(slot, 200, 4000, 800, null).s, CLOSE_MOST);
  const workY = v.y + (slot.y + 2000) * v.s;
  assert.ok(workY > 800 * .3 && workY < 800 * .6);
  // The work at the box's top: the box's top is not let down past the top margin.
  const top = closeOn(slot, 3000, 900, 800, {x: 60, y: 10});
  assert.ok(top.y + slot.y * top.s <= TOP);
  // Work far along a line: the camera goes along with it.
  const far = closeOn(slot, 3000, 900, 800, {x: 700, y: 100});
  assert.ok(far.x + (slot.x + 700) * far.s < 900 - PAD);
});

test('over several boxes at once at the base: centred when they fit, none when they do not (never smaller)', () => {
  const at = slots(cols, heights);
  const two = overAll([{slot: at.get('a.c')!, h: 200}, {slot: at.get('b.c')!, h: 200}], 1000, 800);
  assert.ok(two && two.s === 1 && Math.abs(two.x + (at.get('a.c')!.x + WIDTH / 2) - 500) < 1e-9);
  assert.equal(overAll([{slot: at.get('term')!, h: 400}, {slot: at.get('a.c')!, h: 200}], 1000, 800), null);
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
