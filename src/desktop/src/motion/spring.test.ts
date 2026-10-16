import assert from 'node:assert/strict';
import {test} from 'node:test';
import {settled, spring, step} from './spring.ts';

test('a spring closes half the distance in one half-life without overshoot', () => {
  const s = spring(0);
  s.target = 1;
  let peak = 0;
  for (let t = 0; t < 0.2; t += 1 / 240) peak = Math.max(peak, step(s, 1 / 240, 0.1).value);
  assert.ok(peak <= 1 + 1e-9);
  for (let t = 0; t < 2; t += 1 / 60) step(s, 1 / 60, 0.1);
  assert.ok(settled(s));
});

test('frame rate does not change where the spring lands', () => {
  const fast = spring(0), slow = spring(0);
  fast.target = slow.target = 10;
  for (let i = 0; i < 240; i++) step(fast, 1 / 240, 0.15);
  for (let i = 0; i < 30; i++) step(slow, 1 / 30, 0.15);
  assert.ok(Math.abs(fast.value - slow.value) < 0.05);
});

test('one very long frame stays finite and on target side', () => {
  const s = spring(0);
  s.target = 5;
  step(s, 30, 0.1);
  assert.ok(Number.isFinite(s.value) && Math.abs(s.value - 5) < 1e-6);
});
