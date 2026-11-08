import assert from 'node:assert/strict';
import {test} from 'node:test';
import {said, type Said} from '../runtime/waiting.ts';
import type {Held} from '../runtime/parts.ts';
import {have, shell} from './busybox.ts';

const held: Held = {guest: 6, translations: 2, translator: 1, files: 1, total: 10, spare: 2, spareTranslator: 0};
/** What a kernel that waits waits for. */
const waitsFor = (m: Said): string => (m.type === 'waiting' ? m.for : m.type);
/** How long is left of what it waits for (a time). */
const left = (m: Said): number => (m.type === 'waiting' && m.for === 'time' ? m.ms : NaN);

test('a kernel that waits without a time waits for input', () => {
  assert.deepEqual(said({waiting: true}, held, 0), {type: 'waiting', for: 'input', memory: 10, held});
});

test('a kernel that sleeps waits for a time, and says how long is left', () => {
  assert.deepEqual(said({waiting: true, until: 1500}, held, 1000), {type: 'waiting', for: 'time', ms: 500, memory: 10, held});
  assert.equal(left(said({waiting: true, until: 900}, held, 1000)), 0, 'a time already past is now');
});

test('a kernel that ended says how', () => {
  assert.deepEqual(said({status: 256}, held, 0), {type: 'exit', status: 256, memory: 0});
});

test('sleep waits for a time and cat for input, as BusyBox runs them', {skip: !have}, async () => {
  const sleeping = await shell('sleep 2');
  const m = said(sleeping.kernel.pump(), sleeping.kernel.held(), performance.now());
  assert.equal(waitsFor(m), 'time');
  const ms = left(m);
  assert.ok(ms > 1000 && ms <= 2000, `${ms} ms left`);

  const reading = await shell('cat');
  assert.equal(waitsFor(said(reading.kernel.pump(), reading.kernel.held(), performance.now())), 'input');
  reading.input.push(new TextEncoder().encode('hi\n'));
  assert.equal(waitsFor(said(reading.kernel.pump(), reading.kernel.held(), performance.now())), 'input', 'still reading, after what came');
  assert.equal(reading.out(), 'hi\n');
});
