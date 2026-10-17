import assert from 'node:assert/strict';
import {test} from 'node:test';
import {said} from '../runtime/waiting.mjs';
import {have, shell} from './busybox.mjs';

const held = {total: 10, spare: 2};

test('a kernel that waits without a time waits for input', () => {
  assert.deepEqual(said({waiting: true}, held, 0), {type: 'waiting', for: 'input', memory: 10, held});
});

test('a kernel that sleeps waits for a time, and says how long is left', () => {
  assert.deepEqual(said({waiting: true, until: 1500}, held, 1000), {type: 'waiting', for: 'time', ms: 500, memory: 10, held});
  assert.equal(said({waiting: true, until: 900}, held, 1000).ms, 0, 'a time already past is now');
});

test('a kernel that ended says how', () => {
  assert.deepEqual(said({status: 256}, held, 0), {type: 'exit', status: 256, memory: 0});
});

test('sleep waits for a time and cat for input, as BusyBox runs them', {skip: !have}, async () => {
  const sleeping = await shell('sleep 2');
  const m = said(sleeping.kernel.pump(), sleeping.kernel.held(), performance.now());
  assert.equal(m.for, 'time');
  assert.ok(m.ms > 1000 && m.ms <= 2000, `${m.ms} ms left`);

  const reading = await shell('cat');
  assert.equal(said(reading.kernel.pump(), reading.kernel.held(), performance.now()).for, 'input');
  reading.input.push(new TextEncoder().encode('hi\n'));
  assert.equal(said(reading.kernel.pump(), reading.kernel.held(), performance.now()).for, 'input', 'still reading, after what came');
  assert.equal(reading.out(), 'hi\n');
});
