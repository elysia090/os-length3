import {test} from 'node:test';
import assert from 'node:assert/strict';
import {steps, way} from './camera.ts';

test('the camera rests at both ends of its flight and stands back between them, soon after it sets off', () => {
  const s = steps([.35, 0, .15, 1], .1);
  assert.deepEqual([s[0].k, s[0].q], [1, 0]);
  assert.ok(Math.abs(s.at(-1)!.k - 1) < 1e-9 && Math.abs(s.at(-1)!.q - 1) < 1e-6);
  const back = Math.min(...s.map((x) => x.k)), at = s.findIndex((x) => x.k === back) / (s.length - 1);
  assert.ok(Math.abs(back - .9) < .005, `stands back to nine tenths, not ${back}`);
  assert.ok(at > .3 && at < .5, `stands furthest back before halfway, not at ${at}`);
  // It goes one way only, never back.
  assert.ok(s.every((x, i) => i === 0 || x.q >= s[i - 1].q));
});

test("the way between two pages is moved by less than half a dot, so the dots left lie on the dots come to", () => {
  const left = {x: 132, y: 25}, come = {x: 140, y: 19};
  const by = way({x: -72, y: -886}, left, come);
  for (const axis of ['x', 'y'] as const) {
    assert.ok(Math.abs(by[axis] - {x: -72, y: -886}[axis]) <= 12, `${axis} moved by at most half a pitch`);
    // Where the page come to starts from (its dots at come + by) is on the lattice of the dots left.
    assert.equal(((come[axis] + by[axis] - left[axis]) % 24 + 24) % 24, 0);
  }
  // With no dots on one side, the way is as asked.
  assert.deepEqual(way({x: 72, y: 886}, null, come), {x: 72, y: 886});
});
