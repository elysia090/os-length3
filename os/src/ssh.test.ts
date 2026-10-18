import assert from 'node:assert/strict';
import {test} from 'node:test';
import {QUIET, quiet} from './ssh.ts';

test('a device that has not said it still listens for a while is shown as quiet', () => {
  const now = 1_800_000_000_000;
  // It asks every 5 s; a few missed beats are not yet quiet.
  assert.equal(quiet({seen: now - 5_000}, now), false);
  assert.equal(quiet({seen: now - QUIET}, now), false);
  assert.equal(quiet({seen: now - QUIET - 1}, now), true);
});
