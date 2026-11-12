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

test('an interrupted arrival cancels its predecessor, including when motion is reduced', (t) => {
  const preference = environment(t), {el, animations} = surface();
  arrive(el, 1, 'y');
  arrive(el, -1, 'y');
  assert.equal(animations.length, 2);
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations[1].frames[0].transform, 'translateY(-12px)');
  preference(true);
  arrive(el, 1, 'y');
  assert.equal(animations[1].cancelled, true);
  assert.equal(animations.length, 2);
});

test('band changes run immediately and use bounded directional motion without snapshots', (t) => {
  const preference = environment(t), {el, animations} = surface();
  let updates = 0;
  panAcross(el, 1, () => updates++);
  assert.equal(updates, 1);
  assert.equal(animations[0].frames[0].transform, 'translateX(16px)');
  assert.equal(animations[0].options.duration, 200);
  preference(true);
  panAcross(el, -1, () => updates++);
  assert.equal(updates, 2);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].cancelled, true);
});
