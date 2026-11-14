import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OWED, UNDER_RICEBOX, UNITS, check, reaches, unitOf} from './units.ts';

test('every file of code is one unit\'s, or a test, a script or something made (scripts/units.ts)', () => {
  assert.deepEqual(check().homeless, []);
});

test('a unit takes only from the units the table lets it, besides what is owed with the step that ends it', () => {
  const owed = new Set(OWED.map((o) => o.join(' ')));
  assert.deepEqual(check().crossings.map((c) => c.join(' ')).filter((c) => !owed.has(c)), []);
});

test('muk and prompt: a terminal and what is kept are prompt\'s, and muk takes nothing of it', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;
  assert.equal(unitOf('why/core/src/prompt/running.rs')?.name, 'prompt');
  assert.equal(unitOf('why/core/src/prompt/writes.rs')?.name, 'prompt');
  assert.equal(unitOf('why/app/prompt/userland.ts')?.name, 'app');
  assert.equal(unitOf('module/prompt/README.md')?.name, 'prompt');
  // (the box itself and its filter are muk's, to be replaced by muk run)
  assert.equal(unitOf('why/core/src/prompt/seccomp.rs')?.name, 'muk');
  assert.deepEqual(unit('prompt').takes, []);
  assert.ok(!unit('muk').takes.includes('prompt'));
  // (nothing under ricebox takes it: it is cut out without a Prompt)
  for (const name of UNDER_RICEBOX) assert.ok(!unit(name).takes.includes('prompt'), name);
});

test('what is owed is still made: one no longer made is struck from OWED', () => {
  const made = new Set(check().crossings.map((c) => c.join(' ')));
  assert.deepEqual(OWED.map((o) => o.join(' ')).filter((o) => !made.has(o)), []);
});

test('muk and sods have no implementation dependencies or waived crossings', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;
  assert.ok(!unit('muk').takes.includes('sods'));
  assert.ok(!unit('sods').takes.includes('muk'));
  assert.deepEqual(check().crossings.filter(([from, to]) =>
    (from === 'muk' && to === 'sods') || (from === 'sods' && to === 'muk')), []);
  assert.deepEqual(OWED.filter(([from, to]) =>
    (from === 'muk' && to === 'sods') || (from === 'sods' && to === 'muk')), []);
});

test('muk, prompt and sods are taken from through their entries alone: muk and prompt are programs, sods is three files and its table', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;
  assert.deepEqual(reaches(), []);
  assert.deepEqual(unit('muk').entries, []);
  assert.deepEqual(unit('prompt').entries, []);
  assert.deepEqual(unit('sods').entries, ['translate', 'linux', 'host', 'targets'].map((name) => `module/sods/runtime/${name}.ts`));
  // (what reads an image's layers is the distribution's, not the machine's: muk holds no TypeScript that runs)
  assert.equal(unitOf('module/ricebox/layers/mount.ts')?.name, 'ricebox');
  assert.equal(unitOf('module/sods/src/cache.rs')?.name, 'sods');
});

test('the table is one: each name once, each path held by one unit, each unit taken from is in it', () => {
  const names = UNITS.map((u) => u.name), paths = UNITS.flatMap((u) => u.holds);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(paths).size, paths.length);
  for (const u of UNITS) for (const t of u.takes) assert.ok(t === '*' || names.includes(t), `${u.name} takes ${t}`);
  // A unit's folder is its own; the longest path decides where one unit holds part of another's folder (why/core).
  assert.equal(unitOf('module/sods/runtime/translation/translator.ts')?.name, 'sods');
  assert.equal(unitOf('module/sods/runtime/linux/process.ts')?.name, 'sods');
  assert.equal(unitOf('module/ricebox/make/db.ts')?.name, 'ricebox');
  assert.equal(unitOf('why/core/src/prompt/launch.rs')?.name, 'muk');
});

test('ricebox can be cut out with the units under it: none of them takes from a unit over them, by the table or by an import', () => {
  for (const u of UNITS) if (UNDER_RICEBOX.includes(u.name)) assert.deepEqual(u.takes.filter((t) => !UNDER_RICEBOX.includes(t)), [], u.name);
  assert.deepEqual(check().crossings.filter(([from, to]) => UNDER_RICEBOX.includes(from) && !UNDER_RICEBOX.includes(to)), []);
  // muk is the machine, not a client of sods' implementation. No unit's folder is inside another's.
  assert.deepEqual(UNITS.find((u) => u.name === 'muk')?.takes, ['lib']);
  const folders = UNITS.flatMap((u) => u.holds.filter((h) => h.startsWith('module/')).map((h) => [u.name, h.split('/').slice(0, 2).join('/')]));
  for (const [a, fa] of folders) for (const [b, fb] of folders) assert.ok(a === b || fa !== fb, `${a} and ${b} share ${fa}`);
});
