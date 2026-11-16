import assert from 'node:assert/strict';
import {test} from 'node:test';
import {QUIET, quiet} from './ssh.ts';

test('a device that has not said it still listens for a while is shown as quiet', () => {
  const now = 1_800_000_000_000;
  // It asks every 30 s or so; a missed beat or two are not yet quiet.
  assert.equal(quiet({seen: now - 5_000}, now), false);
  assert.equal(quiet({seen: now - QUIET}, now), false);
  assert.equal(quiet({seen: now - QUIET - 1}, now), true);
});
