import assert from 'node:assert/strict';
import {test} from 'node:test';
import {have, shell} from './busybox.mjs';

// The app's Prompt's console is a terminal (worker.mjs): a shell reads lines on it, with job control, and a program
// that asks for each key as it comes is heard by what shows the terminal (console.mode), which then sends keys so.

const enc = (s) => new TextEncoder().encode(s);

test('an interactive shell on the terminal reads a line, runs it, and has job control', {skip: !have}, async () => {
  const {kernel, input, out} = await shell('', ['sh', 'echo', 'cat'], {interactive: true, argv: ['/bin/sh', '-i']});
  assert.deepEqual(kernel.pump(), {waiting: true});
  input.push(enc('echo hi\n'));
  assert.deepEqual(kernel.pump(), {waiting: true});
  assert.match(out(), /hi\n/);
  assert.doesNotMatch(out(), /can't access tty|job control turned off/);
  input.push(enc('exit\n'));
  assert.deepEqual(kernel.pump(), {status: 0});
});

test('a program asking for each key as it comes is heard, and heard again as it gives the terminal back', {skip: !have}, async () => {
  const {kernel, modes} = await shell('stty -icanon -echo; stty icanon', ['sh', 'stty'], {interactive: true});
  assert.deepEqual(kernel.pump(), {status: 0});
  const ICANON = 2;
  assert.ok(modes.length >= 2, `told ${modes.length} times`);
  assert.equal(modes[0].lflag & ICANON, 0, 'each key as it comes');
  assert.equal(modes.at(-1).lflag & ICANON, ICANON, 'a line at a time again');
});

test('a key the program in front asked for comes at once, not waiting for a line', {skip: !have}, async () => {
  const {kernel, input, out} = await shell('stty -icanon -echo; c=$(dd bs=1 count=1 2>/dev/null); echo "got $c"', ['sh', 'stty', 'dd', 'echo'], {interactive: true});
  assert.deepEqual(kernel.pump(), {waiting: true});
  input.push(enc('x'));
  assert.deepEqual(kernel.pump(), {status: 0});
  assert.equal(out(), 'got x\n');
});
