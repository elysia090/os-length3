import assert from 'node:assert/strict';
import {test} from 'node:test';
import {carried, GAP, next, overAll, PAD, slots, standardOn, TOP, VGAP, WHOLE_MOST, WIDTH, wholeOf} from './desk-layout.ts';

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

test('at the standard, the box in hand is in the middle across, at its own size, never low in a tall face', () => {
  const at = slots(cols, heights), slot = at.get('a.c')!;
  const v = standardOn(slot, 200, 1000, 800);
  assert.equal(v.s, 1);
  assert.equal(v.x + (slot.x + WIDTH / 2) * v.s, 500);
  // Short in a tall face: a third of the way down at most, not in the middle.
  assert.ok(Math.abs(v.y + slot.y - 800 * .3) < 1e-9);
  // Taller than the face: from its top.
  const tall = standardOn(slot, 3000, 1000, 800);
  assert.equal(tall.y + slot.y, TOP + 16);
});

test('stepped back, the whole desk fits, at most half its size, and in the middle', () => {
  const at = slots(cols, heights);
  const all = [...at].map(([k, slot]) => ({slot, h: heights(k)}));
  const w = wholeOf(all, 1000, 800);
  assert.ok(w.s <= WHOLE_MOST);
  const right = Math.max(...all.map((b) => b.slot.x + WIDTH + 8));
  assert.ok(w.x + right * w.s <= 1000 - 47);
});

test('over several boxes at once: at the standard, centred, when they fit; stepped back as far as they need when not', () => {
  const at = slots(cols, heights);
  const two = overAll([{slot: at.get('a.c')!, h: 200}, {slot: at.get('b.c')!, h: 200}], 1000, 800);
  assert.ok(two.s === 1 && Math.abs(two.x + (at.get('a.c')!.x + WIDTH / 2 + 4) - 500) < 1e-9);
  const both = overAll([{slot: at.get('term')!, h: 400}, {slot: at.get('a.c')!, h: 200}], 1000, 800);
  assert.ok(both.s < 1 && both.s >= .4);
  // Side by side, both in the face, the term's left and a.c's right inside it.
  assert.ok(both.x + at.get('term')!.x * both.s >= 0);
  assert.ok(both.x + (at.get('a.c')!.x + WIDTH) * both.s <= 1000);
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
