import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync, readdirSync} from 'node:fs';
import {CORE_PARTS} from './core-wasm.ts';
import {TREES, coreCycles, coreViolations, cycles, violations} from './layers.ts';

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

test('why is its parts, faces, tests and release composition: every folder has one responsibility', () => {
  const why = new URL('../why/', import.meta.url);
  const folders = readdirSync(why, {withFileTypes: true}).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  const tree = TREES.find((t) => t.root === 'why')!;
  assert.deepEqual(folders, [...tree.order, ...tree.skip ?? [], ...tree.build ?? []].sort());
  // A part is what the core is made of as well (a face is not), whichever layers of lib.rs are in it.
  const parts = tree.order.filter((p) => p !== 'app');
  assert.deepEqual([...CORE_PARTS].sort(), [...parts].sort());
  for (const part of parts) assert.ok(existsSync(new URL(`${part}/mod.rs`, why)), `${part} has no Rust of the core`);
  // No folder is left from before the parts were why's own folders.
  for (const gone of ['why/core', 'why/remote', 'why/shared', 'tests']) assert.ok(!existsSync(new URL(`../${gone}`, import.meta.url)), gone);
});
