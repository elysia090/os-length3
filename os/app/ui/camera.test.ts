import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stages} from './camera.ts';

const M = {ms: 760, back: .5, out: .26, down: .66};

test('the switch rests at both ends, and goes across stood back', () => {
  const s = stages(M);
  assert.deepEqual([s[0].k, s[0].q], [1, 0]);
  assert.ok(Math.abs(s.at(-1)!.k - 1) < 1e-9 && s.at(-1)!.q === 1);
  // Most of the way across is gone stood all the way back; only its first and last few hundredths run into the moves
  // either side, never near where the camera rests.
  for (const x of s) if (x.q > .1 && x.q < .9) assert.ok(Math.abs(x.k - .5) < 1e-9, `across at k ${x.k}`);
  for (const x of s) if (x.q > .02 && x.q < .98) assert.ok(x.k < .6, `across at k ${x.k}`);
  // It goes one way only, never back.
  assert.ok(s.every((x, i) => i === 0 || x.q >= s[i - 1].q));
});

test('pressed, the screen pulls back from its first step: no wind-up, quickest as it sets off', () => {
  const s = stages(M);
  const first = 1 - s[1].k, second = s[1].k - s[2].k;
  assert.ok(first > .5 * .1, `first step back ${first}`);
  assert.ok(first > second, 'slowing as it gets there, not gathering speed');
});
