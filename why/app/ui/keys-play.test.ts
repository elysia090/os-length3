import {test} from 'node:test';
import assert from 'node:assert/strict';

// Real files are decoded by the browser; here the lifecycle is controlled, including a failed first fetch.
test('sound resumes in the activation, retries a failed load, and never queues hidden or suspended strokes', async (t) => {
  let requests = 0, starts = 0, resumes = 0, fail = true, hidden = false;
  let state = 'suspended';
  const order: string[] = [];
  const node = () => ({gain: {value: 0}, frequency: {value: 0}, playbackRate: {value: 0}, connect() { return this; }, start() { starts++; }});
  class Context {
    destination = {}; currentTime = 0;
    get state() { return state; }
    createGain = node;
    createBufferSource = node;
    createBiquadFilter = node;
    resume() { resumes++; order.push('resume'); state = 'running'; return Promise.resolve(); }
    async decodeAudioData() { return {length: 100, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => new Float32Array(100)}; }
  }
  for (const [name, value] of Object.entries({AudioContext: Context, document: {get hidden() { return hidden; }}})) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(globalThis, 'fetch', async () => {
    requests++; order.push('fetch');
    return {ok: !fail, status: fail ? 503 : 200, arrayBuffer: async () => new ArrayBuffer(0)} as Response;
  });
  const module = './keys.ts?playback-test';
  const {strike} = await import(module);
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  strike('enter');
  assert.equal(order[0], 'resume');
  await settled();
  assert.equal(starts, 0);
  assert.equal(requests, 6);
  fail = false;
  strike('enter');
  await settled();
  assert.equal(requests, 12, 'a failed load is retried without reloading the page');
  assert.equal(starts, 2, 'one press and one release');
  hidden = true;
  strike('key');
  await settled();
  assert.equal(starts, 2);
  hidden = false;
  strike('space');
  hidden = true; // A page can hide while a cached promise or the first fetch is pending.
  await settled();
  assert.equal(starts, 2);
  hidden = false;
  state = 'suspended';
  let finishResume!: () => void;
  const resume = t.mock.method(Context.prototype, 'resume', () => {
    resumes++;
    return new Promise<void>((resolve) => { finishResume = () => { state = 'running'; resolve(); }; });
  });
  strike('enter');
  await settled();
  assert.equal(starts, 2, 'cached samples must wait for asynchronous resume');
  finishResume();
  await settled();
  assert.equal(starts, 4, 'the first activation survives a delayed resume');
  state = 'suspended';
  strike('key');
  await new Promise((resolve) => setTimeout(resolve, 275));
  finishResume();
  await settled();
  assert.equal(starts, 4, 'a resume too late does not replay the stale activation');
  state = 'suspended';
  resume.mock.mockImplementation(() => { resumes++; return Promise.reject(new Error('audio unavailable')); });
  strike('key');
  await settled();
  assert.equal(starts, 4, 'rejected resume is silent');
  assert.equal(resumes, 4);
});
