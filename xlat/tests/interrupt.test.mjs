import assert from 'node:assert/strict';
import {test} from 'node:test';
import {have, shell} from './busybox.mjs';

// Ctrl-C is SIGINT to the group in front on the console: the shell's own,
// so everything in it gets it, as at a terminal without job control.

test('Ctrl-C ends a shell that does not catch it, with what it runs', {skip: !have}, async () => {
  const {kernel, out} = await shell('cat; echo "after $?"');
  // cat waits for input that does not come.
  assert.deepEqual(kernel.pump(), {waiting: true});
  assert.ok(kernel.interrupt());
  assert.deepEqual(kernel.pump(), {status: 2}, 'killed by SIGINT');
  assert.equal(out(), '');
});

test('a shell that traps SIGINT survives it; what it ran does not, and the trap runs', {skip: !have}, async () => {
  const {kernel, out} = await shell('trap "echo caught" INT; cat; echo "after $?"');
  assert.deepEqual(kernel.pump(), {waiting: true});
  assert.ok(kernel.interrupt());
  assert.deepEqual(kernel.pump(), {status: 0});
  assert.equal(out(), 'caught\nafter 130\n');
  // With nothing left there is nobody to interrupt.
  assert.equal(kernel.interrupt(), false);
});

test('a job that ignores SIGINT (as nohup and background jobs do) runs on', {skip: !have}, async () => {
  const {kernel, out} = await shell('trap "" INT; cat; echo "after $?"');
  assert.deepEqual(kernel.pump(), {waiting: true});
  assert.ok(kernel.interrupt());
  assert.deepEqual(kernel.pump(), {waiting: true}, 'cat inherited the ignore and still reads');
  assert.equal(out(), '');
});
