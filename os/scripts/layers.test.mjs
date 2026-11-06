import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cycles, violations} from './layers.mjs';

test('every import goes down the layers, never up or across out of order (scripts/layers.mjs)', () => {
  assert.deepEqual(violations().map(([tree, from, to, file, spec]) => `${tree}: ${from} -> ${to} (${file} -> ${spec})`), []);
});

test('no file of the app reaches back to itself through what it takes (scripts/layers.mjs cycles)', () => {
  assert.deepEqual(cycles(), []);
});
