import assert from 'node:assert/strict';
import {test} from 'node:test';
import {have, shell} from './busybox.mjs';

test('Ctrl-C ends what waits in front of the shell, and the shell goes on', {skip: !have}, async () => {
  const {kernel, out} = await shell('cat; echo "after $?"');
  // cat waits for input that does not come.
  assert.deepEqual(kernel.pump(), {waiting: true});
  assert.ok(kernel.interrupt());
  assert.deepEqual(kernel.pump(), {status: 0});
  assert.equal(out(), 'after 130\n');
  // With only the shell left there is nothing to interrupt.
  assert.equal(kernel.interrupt(), false);
});
