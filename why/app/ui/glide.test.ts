import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {arrive, panAcross, reduced, still} from './glide.ts';

// Timing/ownership contracts independent of a browser. Actual geometry, CSS and input live in motion.spec.ts.
function environment(t: TestContext) {
  let less = false;
  const values = {
    matchMedia: () => ({matches: less}),
    document: {documentElement: {}},
    getComputedStyle: () => ({getPropertyValue: () => '1'}),
  };
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  return (value: boolean) => { less = value; };
}
function surface() {
  const animations: {cancelled: boolean; frames: Keyframe[]; options: KeyframeAnimationOptions}[] = [];
  const el = {isConnected: true, animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
    const run = {cancelled: false, frames, options};
    animations.push(run);
    return {finished: new Promise<void>(() => {}), cancel() { run.cancelled = true; }};
  }} as unknown as HTMLElement;
  return {el, animations};
}

test('motion follows the live system preference rather than a permanent off switch', (t) => {
  const preference = environment(t);
  assert.equal(still(), false);
  preference(true);
  assert.equal(reduced(), true);
  preference(false);
  assert.equal(still(), false);
});

test('what comes is there at once: an arrival is a cut, with motion asked for or not (DESIGN §8: the mind completes the way between)', (t) => {
  const preference = environment(t), {el, animations} = surface();
  arrive(el, 1, 'y');
  arrive(el, -1, 'y');
  assert.equal(animations.length, 0);
  preference(true);
  arrive(el, 1, 'y');
  assert.equal(animations.length, 0);
});

test('a band changed is changed at once: no pan, no snapshot, with motion asked for or not', (t) => {
  const preference = environment(t), {el, animations} = surface();
  let updates = 0;
  panAcross(el, 1, () => updates++);
  assert.equal(updates, 1);
  assert.equal(animations.length, 0);
  preference(true);
  panAcross(el, -1, () => updates++);
  assert.equal(updates, 2);
  assert.equal(animations.length, 0);
});
