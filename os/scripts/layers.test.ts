import assert from 'node:assert/strict';
import {test} from 'node:test';
import {coreCycles, coreViolations, cycles, violations} from './layers.ts';

test('every import goes down the layers, never up or across out of order (scripts/layers.ts)', () => {
  assert.deepEqual(violations().map(([tree, from, to, file, spec]) => `${tree}: ${from} -> ${to} (${file} -> ${spec})`), []);
});

test('no file of the app reaches back to itself through what it takes (scripts/layers.ts cycles)', () => {
  assert.deepEqual(cycles(), []);
});

test('the core takes only from its own layer and the ones lib.rs lists before it (scripts/layers.ts core)', () => {
  assert.deepEqual(coreViolations().map(([from, to, file]) => `${from} -> ${to} (${file})`), []);
});

test('no unit of a core layer reaches back to itself through its siblings (scripts/layers.ts core cycles)', () => {
  assert.deepEqual(coreCycles(), []);
});
