import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OWED, UNDER_RICEBOX, UNITS, check, unitOf} from './units.ts';

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
  // A unit's folder is its own; the longest path decides where one unit holds part of another's folder (src/core).
  assert.equal(unitOf('module/sods/runtime/translator.ts')?.name, 'sods');
  assert.equal(unitOf('module/ricebox/runtime/process.ts')?.name, 'ricebox');
  assert.equal(unitOf('src/core/src/prompt/launch.rs')?.name, 'muk');
});

test('ricebox can be cut out with the units under it: none of them takes from a unit over them, by the table or by an import', () => {
  for (const u of UNITS) if (UNDER_RICEBOX.includes(u.name)) assert.deepEqual(u.takes.filter((t) => !UNDER_RICEBOX.includes(t)), [], u.name);
  assert.deepEqual(check().crossings.filter(([from, to]) => UNDER_RICEBOX.includes(from) && !UNDER_RICEBOX.includes(to)), []);
  // muk is the thinnest: it stands on lib alone. No unit's folder is inside another's.
  assert.deepEqual(UNITS.find((u) => u.name === 'muk')?.takes, ['lib']);
  const folders = UNITS.flatMap((u) => u.holds.filter((h) => h.startsWith('module/')).map((h) => [u.name, h.split('/').slice(0, 2).join('/')]));
  for (const [a, fa] of folders) for (const [b, fb] of folders) assert.ok(a === b || fa !== fb, `${a} and ${b} share ${fa}`);
});
