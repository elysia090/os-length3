import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gap, keyOf, leadIn} from './cadence.ts';

// The hand the Agent's typing is played with (cadence.ts): steady, about 120 ms a key, nothing far from it.

/** A seeded stream of numbers in [0, 1) (mulberry32). */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('a line of code is struck about 120 ms a key, close to even', () => {
  const rnd = seeded(7);
  const text = 'for (int c; (c = getchar()) != EOF;) n += c == 10; printf("%d", n);';
  const gaps = [...text].map((ch, i) => gap(ch, text[i - 1] ?? '', rnd)).sort((a, b) => a - b);
  const at = (q: number) => gaps[Math.floor(q * (gaps.length - 1))];
  assert.ok(at(0.5) > 105 && at(0.5) < 130, `median ${at(0.5)}`);
  assert.ok(at(0.05) > 80 && at(0.95) < 175, `${at(0.05)}…${at(0.95)}`);
});

test('a new line is a breath longer; the first key waits for the hand', () => {
  const rnd = seeded(3);
  assert.ok(gap('i', '\n', rnd) > 500);
  assert.ok(gap('\n', ';', rnd) > gap('x', 'y', () => 0.5));
  const lead = leadIn(rnd);
  assert.ok(lead >= 420 && lead <= 680);
  assert.deepEqual(['a', ' ', '\n'].map(keyOf), ['key', 'space', 'enter']);
});
