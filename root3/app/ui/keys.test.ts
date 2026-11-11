import {test} from 'node:test';
import assert from 'node:assert/strict';
import {edged} from './keys.ts';

test('a key recording cut off still sounding is faded to silence at its end (and from silence at its start): no click', () => {
  const data = new Float32Array(4410).fill(0.5);
  const buffer = {length: data.length, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => data} as unknown as AudioBuffer;
  edged(buffer);
  assert.equal(data[0], 0);
  assert.equal(data[data.length - 1], 0);
  assert.ok(data[data.length - 2] > 0 && data[data.length - 2] < 0.01);
  assert.equal(data[2205], 0.5);
  // The fade falls only, never back up, over its last samples.
  for (let i = data.length - 530; i < data.length - 1; i++) assert.ok(data[i + 1] <= data[i]);
});
