import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OWED, UNITS, check, unitOf} from './units.ts';

test('every file of code is one unit\'s, or a test, a script or something made (scripts/units.ts)', () => {
  assert.deepEqual(check().homeless, []);
});

test('a unit takes only from the units the table lets it, besides what is owed with the step that ends it', () => {
  const owed = new Set(OWED.map((o) => o.join(' ')));
  assert.deepEqual(check().crossings.map((c) => c.join(' ')).filter((c) => !owed.has(c)), []);
});

test('what is owed is still made: one no longer made is struck from OWED', () => {
  const made = new Set(check().crossings.map((c) => c.join(' ')));
  assert.deepEqual(OWED.map((o) => o.join(' ')).filter((o) => !made.has(o)), []);
});

test('the table is one: each name once, each path held by one unit, each unit taken from is in it', () => {
  const names = UNITS.map((u) => u.name), paths = UNITS.flatMap((u) => u.holds);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(paths).size, paths.length);
  for (const u of UNITS) for (const t of u.takes) assert.ok(t === '*' || names.includes(t), `${u.name} takes ${t}`);
  // A unit's folder is its own; the longest path decides where one unit holds part of another's folder (os/core).
  assert.equal(unitOf('module/sods/runtime/translator.ts')?.name, 'sods');
  assert.equal(unitOf('module/ricebox/runtime/process.ts')?.name, 'ricebox');
  assert.equal(unitOf('os/core/src/prompt/launch.rs')?.name, 'ricebox');
});
