import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ABOVE_SEEN, bornOn, carried, EYE, FOOT, GAP, kept, KEPT, LIFTED_LEAST, liftedOf, next, overAll, PAD, PULLED, pulledOn, slots, standardOn, tabbed, TOP, VGAP, WHOLE_MOST, WIDTH, wholeOf} from './desk-layout.ts';

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
  // Short in a tall face: its top where the eye starts (level with the rail between Home and File), not in the middle.
  assert.ok(Math.abs(v.y + slot.y - EYE) < 1e-9);
  // Taller than the face: from its top, at the same place.
  const tall = standardOn(slot, 3000, 1000, 800);
  assert.equal(tall.y + slot.y, EYE);
  // The box above it in its column (a gap and its name above this one's top) is wholly out of the face.
  // The box above in its column, with all that hangs from its foot, is out of the face.
  assert.ok(EYE - VGAP + FOOT < 0);
});

test('a box just come out from under another keeps that one\'s foot in sight over it, so what it was made under is seen', () => {
  const at = slots(cols, heights), slot = at.get('a.c')!;
  // Under a tall one: ABOVE_SEEN of its foot in the face, the gap, then the new box.
  const v = bornOn(slot, 40, 1000, 800, 600);
  assert.equal(v.x, standardOn(slot, 40, 1000, 800).x);
  assert.ok(Math.abs(v.y + slot.y - (ABOVE_SEEN + VGAP)) < 1e-9);
  // Under a short one: all of it, no more.
  const short = bornOn(slot, 40, 1000, 800, 60);
  assert.ok(Math.abs(short.y + slot.y - (60 + VGAP)) < 1e-9);
});

test('a step back, the box in hand is still in the middle, smaller, and the columns beside it come into sight', () => {
  const at = slots(cols, heights), slot = at.get('a.c')!;
  const v = pulledOn(slot, 200, 1280, 800);
  assert.equal(v.s, PULLED);
  assert.ok(WHOLE_MOST < PULLED && PULLED < 1);
  assert.equal(v.x + (slot.x + WIDTH / 2) * v.s, 640);
  // Both neighbours, a good part of each, on the face.
  const left = at.get('term')!, right = at.get('README.md')!;
  assert.ok(v.x + (left.x + WIDTH) * v.s > 200);
  assert.ok(v.x + right.x * v.s < 1280 - 200);
  // In the middle down too, so what lies above it and under it is in sight; a tall one from the eye.
  assert.ok(Math.abs(v.y + slot.y * v.s - (800 - 200 * PULLED) / 2) < 1e-9);
  const tall = pulledOn(slot, 3000, 1280, 800);
  assert.ok(Math.abs(tall.y + slot.y * tall.s - EYE) < 1e-9);
});

test('stepped back, the whole desk fits, at most half its size, and in the middle', () => {
  const at = slots(cols, heights);
  const all = [...at].map(([k, slot]) => ({slot, h: heights(k)}));
  const w = wholeOf(all, 1000, 800);
  assert.ok(w.s <= WHOLE_MOST);
  const right = Math.max(...all.map((b) => b.slot.x + WIDTH + 8));
  assert.ok(w.x + right * w.s <= 1000 - 47);
});

test('over several boxes at once at the standard: centred when they fit, none when they do not (never stepped back for them)', () => {
  const at = slots(cols, heights);
  const two = overAll([{slot: at.get('a.c')!, h: 200}, {slot: at.get('b.c')!, h: 200}], 1000, 800);
  assert.ok(two && two.s === 1 && Math.abs(two.x + (at.get('a.c')!.x + WIDTH / 2) - 500) < 1e-9);
  assert.equal(overAll([{slot: at.get('term')!, h: 400}, {slot: at.get('a.c')!, h: 200}], 1000, 800), null);
});

test('Tab goes down each column, then to the next, round again; Shift+Tab back', () => {
  assert.equal(tabbed(cols, 'term'), 'a.c');
  assert.equal(tabbed(cols, 'a.c'), 'b.c');
  assert.equal(tabbed(cols, 'b.c'), 'README.md');
  assert.equal(tabbed(cols, 'README.md'), 'term');
  assert.equal(tabbed(cols, 'term', true), 'README.md');
  assert.equal(tabbed([['term']], 'term'), 'term');
});

test('an arrow takes the finger along a column or to the next; Ctrl and an arrow carry a box', () => {
  assert.equal(next(cols, 'a.c', 'down'), 'b.c');
  assert.equal(next(cols, 'b.c', 'right'), 'README.md');
  assert.equal(next(cols, 'term', 'left'), null);
  assert.deepEqual(carried(cols, 'b.c', 'up'), [['term'], ['b.c', 'a.c'], ['README.md']]);
  // A column of its own goes into the next column, at the same place; the column it leaves, emptied, goes.
  assert.deepEqual(carried(cols, 'README.md', 'left'), [['term'], ['README.md', 'a.c', 'b.c']]);
  // Out of a column with others, first into the gap beside it: between two side by side, a column of its own.
  const between = carried(cols, 'b.c', 'right');
  assert.deepEqual(between, [['term'], ['a.c'], ['b.c'], ['README.md']]);
  assert.deepEqual(carried(cols, 'a.c', 'left'), [['term'], ['a.c'], ['b.c'], ['README.md']]);
  // Then on into the next column, at the same place in it (a column of its own: its top). (The desk puts one carried
  // straight back where it was in the column it left: desk.ts carry.)
  assert.deepEqual(carried(between, 'b.c', 'right'), [['term'], ['a.c'], ['b.c', 'README.md']]);
  assert.deepEqual(carried(between, 'b.c', 'left'), [['term'], ['b.c', 'a.c'], ['README.md']]);
  // Out of the last column with others: a column past it; a column of its own at the edge stays.
  assert.deepEqual(carried([['term', 'x']], 'x', 'right'), [['term'], ['x']]);
  assert.deepEqual(carried([['term'], ['x']], 'x', 'right'), [['term'], ['x']]);
});

test('held up, the camera stands over the desk as it may stand: the box carried across it every way stays in sight', () => {
  const tall = (key: string) => (key === 'term' ? 160 : 70);
  const boxes = (c: string[][]) => [...slots(c, tall)].map(([key, slot]) => ({key, slot, h: tall(key)}));
  const start = [['term', 'a.c'], ['README.md'], ['notes.md']];
  const held = boxes(start).find((b) => b.key === 'a.c')!;
  const v = liftedOf(boxes(start), held, true, 956, 780);
  assert.ok(v.s <= WHOLE_MOST && v.s >= LIFTED_LEAST);
  // Every way it can be carried, three steps each way: every box wholly in the face, the camera never moved.
  const seen = (c: string[][]) => {
    for (const b of boxes(c)) {
      const l = v.x + b.slot.x * v.s, t = v.y + b.slot.y * v.s;
      assert.ok(l >= 0 && l + WIDTH * v.s <= 956 && t >= 0 && t + b.h * v.s <= 780, `${b.key} out of sight in ${JSON.stringify(c)}`);
    }
  };
  for (const way of ['left', 'right', 'up', 'down'] as const) {
    let c = start;
    for (let k = 0; k < 3; k++) { c = carried(c, 'a.c', way); seen(c); }
  }
  // A desk too wide for that is seen round the box, at the least.
  const wide = [['term', 'a.c'], ...Array.from({length: 12}, (_, k) => [`f${k}`])];
  const round = liftedOf(boxes(wide), boxes(wide).find((b) => b.key === 'a.c')!, true, 956, 780);
  assert.equal(round.s, LIFTED_LEAST);
  assert.equal(round.x + (PAD + WIDTH / 2) * round.s, 956 / 2);
});

test('carried out of sight, the camera goes only as far as keeps the box in; in sight, it stays', () => {
  const v = {s: .5, x: 0, y: 0}, slot = {x: 100, y: 100};
  assert.equal(kept(v, slot, 70, 956, 780), v);
  const right = kept(v, {x: 1800, y: 100}, 70, 956, 780);
  assert.deepEqual(right, {s: .5, x: 956 - KEPT - (1800 + WIDTH) * .5, y: 0});
  const left = kept(v, {x: -400, y: 100}, 70, 956, 780);
  assert.equal(left.x + -400 * .5, KEPT);
  // Too tall for the face: its top kept a third of the way down, at most.
  const deep = kept(v, {x: 100, y: 1400}, 4000, 956, 780);
  assert.equal(deep.y + 1400 * .5, 780 / 3);
});
