import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_PURPOSE, depth, isFar, NEW_REPO, placeOf, PURPOSES, RAIL, purpose, restorePurpose, stepPurpose} from './purposes.ts';

test('the rail lists the places by how far they are from the person, each with its far side right under it, then what is not a place', () => {
  assert.deepEqual(RAIL.map((p) => p.label), ['Home', 'Remote', 'Forge', 'Git', 'Server', 'Inbox', 'Runtime', 'File', 'Plugin', 'New repo']);
  assert.deepEqual(RAIL.map((p) => p.group), ['mine', 'mine', 'work', 'work', 'people', 'people', 'machine', 'tools', 'tools', 'tools']);
  assert.equal(RAIL.at(-1), NEW_REPO);
  assert.equal(new Set(RAIL.map((p) => p.id)).size, RAIL.length);
  for (const [far, place] of [['git', 'forge'], ['remote', 'home'], ['inbox', 'server']] as const) {
    assert.equal(RAIL.findIndex((p) => p.id === far), RAIL.findIndex((p) => p.id === place) + 1, `${far} under ${place}`);
  }
});

test('a far side lies along from its place, not down: the two are at one depth', () => {
  for (const [far, place] of [['git', 'forge'], ['remote', 'home'], ['inbox', 'server']] as const) {
    assert.equal(placeOf(far), place);
    assert.equal(placeOf(place), place);
    assert.ok(isFar(far) && !isFar(place));
    assert.equal(depth(far), depth(place));
  }
  // Down the rail, the world goes down: never up again.
  const depths = RAIL.map((p) => depth(p.id));
  assert.deepEqual(depths, [...depths].sort((x, y) => x - y));
});

test('only the built pages claim real state', () => {
  assert.deepEqual([...PURPOSES, NEW_REPO].filter((p) => p.implemented).map((p) => p.id), ['home', 'remote', 'forge', 'git', 'server', 'inbox', 'runtime', 'file', 'plugin', 'new-repo']);
});

test('arrow keys wrap and Home/End jump to the ends', () => {
  assert.equal(stepPurpose('home', 'ArrowDown'), 'remote');
  assert.equal(stepPurpose('home', 'ArrowUp'), 'new-repo');
  assert.equal(stepPurpose('new-repo', 'ArrowDown'), 'home');
  assert.equal(stepPurpose('server', 'ArrowDown'), 'inbox');
  assert.equal(stepPurpose('inbox', 'ArrowDown'), 'runtime');
  assert.equal(stepPurpose('forge', 'Home'), 'home');
  assert.equal(stepPurpose('forge', 'End'), 'new-repo');
  assert.equal(stepPurpose('forge', 'Enter'), null);
  assert.equal(stepPurpose('forge', 'ArrowRight'), null);
});

test('a stored purpose is validated and falls back to Home', () => {
  assert.equal(restorePurpose('inbox'), 'inbox');
  assert.equal(restorePurpose('settings'), DEFAULT_PURPOSE);
  assert.equal(restorePurpose('new-repo'), DEFAULT_PURPOSE);
  assert.equal(restorePurpose('file'), DEFAULT_PURPOSE);
  assert.equal(restorePurpose('server'), 'server');
  assert.equal(restorePurpose('plugin'), DEFAULT_PURPOSE);
  assert.equal(restorePurpose(null), DEFAULT_PURPOSE);
  assert.equal(restorePurpose('__proto__'), DEFAULT_PURPOSE);
  assert.throws(() => purpose('nope' as never));
});
