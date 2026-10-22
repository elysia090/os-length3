import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_PURPOSE, NEW_REPO, PURPOSES, RAIL, purpose, restorePurpose, stepPurpose} from './purposes.ts';

test('the rail lists the eight purposes in order, the plug, then the new repo square', () => {
  assert.deepEqual(PURPOSES.map((p) => p.label),
    ['Home', 'Forge', 'File', 'Git', 'Runtime', 'Remote', 'Server', 'Inbox', 'Plugin']);
  assert.equal(RAIL.at(-1), NEW_REPO);
  assert.equal(new Set(RAIL.map((p) => p.id)).size, RAIL.length);
});

test('only the built pages claim real state', () => {
  assert.deepEqual(RAIL.filter((p) => p.implemented).map((p) => p.id), ['home', 'forge', 'file', 'git', 'runtime', 'remote', 'server', 'inbox', 'plugin', 'new-repo']);
});

test('arrow keys wrap and Home/End jump to the ends', () => {
  assert.equal(stepPurpose('home', 'ArrowDown'), 'forge');
  assert.equal(stepPurpose('home', 'ArrowUp'), 'new-repo');
  assert.equal(stepPurpose('new-repo', 'ArrowDown'), 'home');
  assert.equal(stepPurpose('remote', 'ArrowDown'), 'server');
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
  assert.equal(restorePurpose('server'), DEFAULT_PURPOSE);
  assert.equal(restorePurpose('plugin'), DEFAULT_PURPOSE);
  assert.equal(restorePurpose(null), DEFAULT_PURPOSE);
  assert.equal(restorePurpose('__proto__'), DEFAULT_PURPOSE);
  assert.throws(() => purpose('nope' as never));
});
