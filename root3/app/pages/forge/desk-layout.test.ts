import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ABOVE_SEEN, arc, bornOn, EYE, FOOT, FOOT_ROOM, GAP, KEPT, lineKept, next, PAD, PULLED, pulledOn, slots, standardOn, tabbed, TOP, TURNED, VGAP, WHOLE_MOST, WIDTH, wholeOf} from './desk-layout.ts';

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

test('a step back, the box in hand is still in the middle across, smaller, its column\'s top at the eye, the columns beside it in sight', () => {
  const at = slots(cols, heights), slot = at.get('b.c')!, top = at.get('a.c')!.y;
  const v = pulledOn(slot, 200, 1280, 800, top);
  assert.equal(v.s, PULLED);
  assert.ok(WHOLE_MOST < PULLED && PULLED < 1);
  assert.equal(v.x + (slot.x + WIDTH / 2) * v.s, 640);
  // Both neighbours, a good part of each, on the face.
  const left = at.get('term')!, right = at.get('README.md')!;
  assert.ok(v.x + (left.x + WIDTH) * v.s > 150);
  assert.ok(v.x + right.x * v.s < 1280 - 150);
  // High, as the standard's box: the column's first box at the eye, the one in hand under it.
  assert.ok(Math.abs(v.y + top * v.s - EYE) < 1e-9);
  // Too low for that: up till its foot is kept over the face's foot; a tall one from the eye.
  const low = pulledOn({x: slot.x, y: top + 1400}, 200, 1280, 800, top);
  assert.ok(Math.abs(low.y + (top + 1400 + 200) * low.s - (800 - KEPT)) < 1e-9);
  const tall = pulledOn({x: slot.x, y: top + 1400}, 3000, 1280, 800, top);
  assert.ok(Math.abs(tall.y + (top + 1400) * tall.s - EYE) < 1e-9);
});

test('stepped back, the whole desk fits, at most half its size, in the middle across, its top at the eye', () => {
  const at = slots(cols, heights);
  const all = [...at].map(([k, slot]) => ({slot, h: heights(k)}));
  const w = wholeOf(all, 1000, 800);
  assert.ok(w.s <= WHOLE_MOST);
  const right = Math.max(...all.map((b) => b.slot.x + WIDTH + 8));
  assert.ok(w.x + right * w.s <= 1000 - 47);
  const first = Math.min(...all.map((b) => b.slot.y));
  assert.ok(Math.abs(w.y + first * w.s - EYE) < 1e-9);
});

test('Tab goes down each column, then to the next, round again; Shift+Tab back', () => {
  assert.equal(tabbed(cols, 'term'), 'a.c');
  assert.equal(tabbed(cols, 'a.c'), 'b.c');
  assert.equal(tabbed(cols, 'b.c'), 'README.md');
  assert.equal(tabbed(cols, 'README.md'), 'term');
  assert.equal(tabbed(cols, 'term', true), 'README.md');
  assert.equal(tabbed([['term']], 'term'), 'term');
});

test('an arrow goes along a column or to the next', () => {
  assert.equal(next(cols, 'a.c', 'down'), 'b.c');
  assert.equal(next(cols, 'b.c', 'right'), 'README.md');
  assert.equal(next(cols, 'term', 'left'), null);
});

test('a box narrower than 80 columns (the desk half the face, a box beside it) stands in the middle as a full one does, its columns as far apart as it is wide', () => {
  const bw = 430, w = 478, hgt = 700;
  const at = slots([['a.c'], ['b.c']], () => 100, bw);
  assert.equal(at.get('b.c')!.x - at.get('a.c')!.x, bw + GAP);
  const v = standardOn(at.get('a.c')!, 100, w, hgt, 1, bw);
  assert.equal(v.x + at.get('a.c')!.x, (w - bw) / 2);
  assert.equal(v.y + at.get('a.c')!.y, EYE);
});

test('going to another column the camera steps back on the way, about a step back at its middle, and lands exactly', () => {
  const w = 1040, hgt = 820, a = standardOn({x: 0, y: 100}, 300, w, hgt), b = standardOn({x: WIDTH + GAP, y: 100}, 300, w, hgt);
  const r = arc(a, b, w, hgt, 560);
  assert.ok(r);
  const ss = Array.from({length: 41}, (_, i) => r.at(i / 40).s);
  const least = Math.min(...ss);
  assert.ok(least < .85 && least > PULLED - .05, `furthest back ${least}`);
  // Furthest back half way, never nearer than the standard, and where it was asked at its end.
  assert.ok(Math.abs(ss.indexOf(least) - 20) <= 1);
  assert.ok(ss.every((s) => s <= 1 + 1e-9));
  assert.deepEqual(r.at(1), b);
  assert.ok(Math.abs(r.at(0).x - a.x) < 1e-6 && Math.abs(r.at(0).s - 1) < 1e-9);
  assert.ok(r.ms > 560 && r.ms < 700, `${r.ms} ms`);
  // Two columns over: further back, longer, never past the whole desk's furthest.
  const c = arc(a, standardOn({x: 2 * (WIDTH + GAP), y: 100}, 300, w, hgt), w, hgt, 560)!;
  const least2 = Math.min(...Array.from({length: 41}, (_, i) => c.at(i / 40).s));
  assert.ok(least2 < least && least2 >= WHOLE_MOST, `${least2}`);
  assert.ok(c.ms > r.ms && c.ms <= 900);
});

test('what is in sight from where the camera is (the next box down) is gone to with a plain pan, no step back', () => {
  const w = 1040, hgt = 820, a = standardOn({x: 0, y: 100}, 300, w, hgt);
  assert.equal(arc(a, standardOn({x: 0, y: 100 + 300 + VGAP}, 300, w, hgt), w, hgt, 560), null);
});

test('the line at work stays where it is until it nears the face\'s foot, then the page is turned to it', () => {
  const hgt = 820, v = {s: 1, x: 0, y: 0};
  assert.equal(lineKept(v, 300, 320, hgt), v);
  assert.equal(lineKept(v, hgt - FOOT_ROOM - 20, hgt - FOOT_ROOM, hgt), v);
  const t = lineKept(v, hgt - FOOT_ROOM, hgt - FOOT_ROOM + 20, hgt);
  assert.notEqual(t, v);
  assert.ok(Math.abs(t.y + (hgt - FOOT_ROOM) - TURNED * hgt) < 1e-9);
  // Gone up past the face's top (a line far above), it is brought down to the same place.
  const u = lineKept({s: 1, x: 0, y: -2000}, 100, 120, hgt);
  assert.ok(Math.abs(u.y + 100 - TURNED * hgt) < 1e-9);
});
