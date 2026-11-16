import {test} from 'node:test';
import assert from 'node:assert/strict';
import {touch} from './touch.ts';

test('a press is down at once and up at once, with less motion asked for too: being held is a state, not a move', (t) => {
  const document = new EventTarget(), window = new EventTarget();
  const animations: {cancelled: boolean; frames: Keyframe[]; options: KeyframeAnimationOptions}[] = [];
  class Button extends EventTarget {
    closest(selector: string) { return selector.startsWith('button') ? this : null; }
    matches() { return false; }
    getBoundingClientRect() { return {width: 40, height: 40}; }
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = {cancelled: false, frames, options};
      animations.push(animation);
      return {cancel() { animation.cancelled = true; }};
    }
  }
  const values = {
    document, window, Element: Button,
    matchMedia: () => ({matches: true, addEventListener: () => {}}),
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
  assert.equal(animations.length, 1, 'held down, motion reduced or not');
  assert.equal(animations[0]!.options.duration, 0, 'down at once, never drawn going down');
  assert.equal(animations[0]!.options.fill, 'forwards', 'held for as long as the press is');
  assert.equal((animations[0]!.frames[0] as {scale: number}).scale, .92, 'a few pixels, never more than 8 %');
  window.dispatchEvent(new Event('pointerup'));
  assert.equal(animations[0]!.cancelled, true, 'up the moment it is let go');
  assert.equal(animations.length, 1, 'and nothing drawn coming home');
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
  // Enter with Ctrl or the command key sends what was written: its last stroke, heard; with Alt, a command.
  for (const mod of ['ctrlKey', 'metaKey'] as const) assert.equal(typedKey(k('Enter', {[mod]: true}), true), 'key', mod);
  assert.equal(typedKey(k('Enter', {altKey: true}), true), null);
  assert.equal(typedKey(k('a'), false), null);
});
