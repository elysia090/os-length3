import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_PURPOSE, NEW_REPO, PURPOSES, RAIL, purpose, restorePurpose, stepPurpose} from './purposes.ts';

test('the rail lists the places by how far they are from the person, in groups: mine, the work, people, the machine; then what is not a place', () => {
  assert.deepEqual(PURPOSES.map((p) => p.label),
    ['Home', 'Forge', 'Git', 'Inbox', 'Server', 'Runtime', 'Remote', 'File', 'Plugin']);
  assert.deepEqual(RAIL.map((p) => p.group),
    ['mine', 'work', 'work', 'people', 'people', 'machine', 'machine', 'tools', 'tools', 'tools']);
  assert.equal(RAIL.at(-1), NEW_REPO);
  assert.equal(new Set(RAIL.map((p) => p.id)).size, RAIL.length);
  // A group is together: none comes back once another has begun.
  const seen: string[] = [];
  for (const p of RAIL) { if (seen.at(-1) !== p.group) { assert.ok(!seen.includes(p.group), p.group); seen.push(p.group); } }
});

test('only the built pages claim real state', () => {
  assert.deepEqual(RAIL.filter((p) => p.implemented).map((p) => p.id), ['home', 'forge', 'git', 'inbox', 'server', 'runtime', 'remote', 'file', 'plugin', 'new-repo']);
});

test('arrow keys wrap and Home/End jump to the ends', () => {
  assert.equal(stepPurpose('home', 'ArrowDown'), 'forge');
  assert.equal(stepPurpose('home', 'ArrowUp'), 'new-repo');
  assert.equal(stepPurpose('new-repo', 'ArrowDown'), 'home');
  assert.equal(stepPurpose('server', 'ArrowDown'), 'runtime');
  assert.equal(stepPurpose('git', 'Home'), 'home');
  assert.equal(stepPurpose('git', 'End'), 'new-repo');
  assert.equal(stepPurpose('git', 'Enter'), null);
  assert.equal(stepPurpose('git', 'ArrowRight'), null);
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
