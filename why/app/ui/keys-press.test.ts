import {test} from 'node:test';
import assert from 'node:assert/strict';
import {begun, edged} from './keys.ts';

test('a recording silent before it sounds is played from where it sounds, and faded in there', () => {
  // Thirty milliseconds of silence, as before Enter's press, then the sound.
  const data = new Float32Array(4410);
  data.fill(0.5, 1323);
  const buffer = {length: data.length, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => data} as unknown as AudioBuffer;
  edged(buffer);
  // A millisecond before its first sample that sounds.
  assert.ok(Math.abs(begun(buffer) - 0.029) < 0.0005, `begins at ${begun(buffer)}`);
  const from = Math.round(begun(buffer) * 44100);
  assert.equal(data[from], 0);
  assert.equal(data[1323 + 200], 0.5);
});

// The context and the fetch are stood in for, as in keys-play.test.ts: what is counted is what is started, and when.
test('a press sounds as it goes down and its release as it is let go; a stroke that could not sound in time is not played late', async (t) => {
  const started: number[] = [];
  let slow = 0;
  const node = () => ({gain: {value: 0}, frequency: {value: 0}, playbackRate: {value: 0}, connect() { return this; }, start(at: number) { started.push(at); }});
  class Context {
    destination = {}; currentTime = 10; state = 'running';
    createGain = node;
    createBufferSource = node;
    createBiquadFilter = node;
    resume() { return Promise.resolve(); }
    async decodeAudioData() { return {length: 100, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => new Float32Array(100)}; }
  }
  for (const [name, value] of Object.entries({AudioContext: Context, document: {hidden: false}})) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(globalThis, 'fetch', async () => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, slow));
    return {ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0)} as Response;
  });
  const module = './keys.ts?press-test';
  const {lift, press, strike} = await import(module);
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  // The recordings take longer to come than a stroke may wait: it is silent, not late.
  slow = 300;
  strike('enter');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(started, [], 'a stroke struck long before its sound was ready is not played');

  // They are there now: a press sounds its press alone, at once.
  slow = 0;
  press('enter');
  await settled();
  assert.deepEqual(started, [10], 'the press, at the context\'s now');
  // Let go at once, its release still follows the press by a moment.
  lift();
  await settled();
  assert.equal(started.length, 2);
  assert.ok(started[1] > 10 && started[1] <= 10.035, `the release, a moment after: ${started[1]}`);
  // Let go again, nothing more.
  lift();
  await settled();
  assert.equal(started.length, 2);
  // A stroke whole (a key's activation) sounds both.
  strike('key');
  await settled();
  assert.equal(started.length, 4);
});
