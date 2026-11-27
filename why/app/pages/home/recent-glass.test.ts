import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recentGlassMap} from './recent-glass.ts';

test('the bevel alone bends inward symmetrically; the centre and cut-off corner stay neutral', () => {
  const w = 64, h = 48, map = recentGlassMap(w, h, 10);
  const at = (x: number, y: number) => [...map.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.deepEqual(at(32, 24), [128, 128, 0, 255]);
  assert.deepEqual(at(14, 24), [128, 128, 0, 255]);
  assert.deepEqual(at(0, 0), [128, 128, 0, 255]);
  assert.ok(at(3, 24)[0]! > 128 && at(60, 24)[0]! < 128);
  assert.ok(at(32, 3)[1]! > 128 && at(32, 44)[1]! < 128);
  assert.equal(at(3, 24)[1], 128);
  assert.equal(at(32, 3)[0], 128);
  assert.equal(at(3, 24)[0]! + at(60, 24)[0]!, 256);
  assert.ok(at(4, 4)[0]! > 128 && at(4, 4)[1]! > 128);
});


test('a weak outer shoulder minifies, then the convex edge magnifies without an inward pocket', () => {
  const w = 396, ht = 136, map = recentGlassMap(w, ht, 10);
  const at = (x: number) => 6.5 * (map[(68 * w + x) * 4]! / 255 - .5);
  assert.ok(at(0) > 1.8 && at(0) <= 2.2);
  const centre = at(w/2);
  for (let x = 1; x <= 17; x++) {
    assert.ok(at(x) >= centre);
    assert.ok(x + at(x) > x - 1 + at(x - 1), String(x));
    if (x >= 5) assert.ok(at(x) <= at(x-1), String(x));
  }
  const scale = (x: number) => 1 / (1 + at(x+1) - at(x));
  assert.ok(scale(1) > .88 && scale(1) < .99);
  assert.ok(scale(10) > 1.2 && scale(10) < 1.4);
  assert.equal(scale(18), 1);
  assert.equal(at(17), centre);
});

test('reflection follows a shallow crown instead of a flat perimeter, and leaves the sides dark', () => {
  const w = 396, ht = 136, map = recentGlassMap(w, ht, 10);
  const at = (x: number, y: number) => map[(y * w + x) * 4 + 2]!;
  const apex = (x: number) => [0, 1, 2, 3, 4, 5, 6].reduce((a, b) => at(x,a) >= at(x,b) ? a : b);
  assert.equal(apex(174), 2);
  assert.equal(apex(47), 1);
  assert.equal(apex(376), 0);
  assert.ok(at(174, 2) > 35);
  assert.ok(at(221, ht-3) > 20 && at(221, ht-3) < at(174, 2));
  for (const x of [0,1,w-2,w-1]) assert.equal(at(x,68), 0);
  assert.equal(at(174, 7), 0);
});

test('scaled presets reduce physical bending on a smaller real panel, preserve centre, and cap the peak', () => {
  const ray = (w: number, ht: number) => {
    const map = recentGlassMap(w, ht, 10);
    const y = Math.floor(ht / 2);
    const d = (x: number) => 6.5 * (map[(y * w + x) * 4]! - 128) / 255;
    assert.equal(d(Math.floor(w / 2)), 0);
    for (let x = 1; x < w/2; x++) assert.ok(x + d(x) > x - 1 + d(x-1));
    return d(0);
  };
  assert.ok(ray(396,136) > ray(372,136));
  assert.ok(ray(372,136) > ray(208,84));
  assert.ok(ray(208,84) > .8);
  assert.ok(ray(396,136) < 2.55);
});
