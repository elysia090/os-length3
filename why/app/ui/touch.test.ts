import {test} from 'node:test';
import assert from 'node:assert/strict';
import {touch} from './touch.ts';

test('reducing motion cancels a held forwards-filled press before release; restoring it does not replay the press', (t) => {
  const document = new EventTarget(), window = new EventTarget();
  const changes: ((event: {matches: boolean}) => void)[] = [];
  let reduced = false;
  const animations: {cancelled: boolean; options: KeyframeAnimationOptions}[] = [];
  class Button extends EventTarget {
    closest(selector: string) { return selector.startsWith('button') ? this : null; }
    matches() { return false; }
    getBoundingClientRect() { return {width: 40, height: 40}; }
    animate(_frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = {cancelled: false, options};
      animations.push(animation);
      return {cancel() { animation.cancelled = true; }};
    }
  }
  const values = {
    document, window, Element: Button,
    matchMedia: () => ({matches: reduced, addEventListener: (_name: string, fn: typeof changes[number]) => changes.push(fn)}),
    addEventListener: window.addEventListener.bind(window),
  };
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  const button = new Button();
  const press = () => {
    const event = new Event('pointerdown');
    Object.defineProperties(event, {target: {value: button}, button: {value: 0}});
    document.dispatchEvent(event);
  };
  touch();
  press();
  assert.equal(animations.length, 1);
  assert.equal(animations[0].options.fill, 'forwards');
  reduced = true;
  for (const change of changes) change({matches: true});
  assert.equal(animations[0].cancelled, true);
  reduced = false;
  for (const change of changes) change({matches: false});
  window.dispatchEvent(new Event('pointerup'));
  assert.equal(animations.length, 1, 'release after restoring motion must not spring a stale press');
  press();
  assert.equal(animations.length, 2, 'subsequent presses still give feedback');
  reduced = true;
  for (const change of changes) change({matches: true});
});

test('a stroke typed is a key as any other, Enter and Backspace too, and Space the space bar; held, with a command key, or out of a text, it is not typing', async () => {
  const {typedKey} = await import('./touch.ts');
  const k = (key: string, more: Partial<{repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean}> = {}) => ({key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...more});
  for (const key of ['a', 'Z', '7', '/', 'あ', 'Enter', 'Backspace', 'Delete', 'Tab', 'Process']) assert.equal(typedKey(k(key), true), 'key', key);
  assert.equal(typedKey(k(' '), true), 'space');
  assert.equal(typedKey(k('Unidentified', {isComposing: true}), true), 'key');
  for (const key of ['ArrowLeft', 'Escape', 'Shift', 'F5', 'Home']) assert.equal(typedKey(k(key), true), null, key);
  assert.equal(typedKey(k('a', {repeat: true}), true), null);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) assert.equal(typedKey(k('a', {[mod]: true}), true), null, mod);
  assert.equal(typedKey(k('a'), false), null);
});
