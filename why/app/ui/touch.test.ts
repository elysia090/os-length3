import {test} from 'node:test';
import assert from 'node:assert/strict';
import {touch} from './touch.ts';

test('a press is down at once and up at once, with less motion asked for too: being held is a state, not a move', (t) => {
  const document = new EventTarget(), window = new EventTarget();
  const animations: {target: Button; cancelled: boolean; frames: Keyframe[]; options: KeyframeAnimationOptions}[] = [];
  class Button extends EventTarget {
    face: Button | null = null;
    closest(selector: string) { return selector.startsWith('button') ? this : null; }
    matches() { return false; }
    querySelector(selector: string) { return selector === ':scope > [data-press-face]' ? this.face : null; }
    getBoundingClientRect() { return {width: 40, height: 40}; }
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = {target: this, cancelled: false, frames, options};
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
  assert.equal(animations[0]!.target, button, 'the whole control gives if it has no separate face');

  button.face = new Button();
  press();
  assert.equal(animations.length, 2);
  assert.equal(animations[1]!.target, button.face, 'a separate face gives without shrinking the hit target');
  window.dispatchEvent(new Event('pointerup'));
  assert.equal(animations[1]!.cancelled, true, 'the face comes up immediately too');
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

test('release cleanup from an earlier press cannot make the next press sound twice, even on the same control', (t) => {
  const handlers = new Map<string, EventListener[]>();
  const listen = (name: string, handler: EventListener) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  };
  const pending: (() => void)[] = [];
  const window = new EventTarget();
  const heard: string[] = [];
  window.addEventListener('why-key', (event) => heard.push((event as CustomEvent<string>).detail));
  class Button {
    closest(selector: string) { return selector.startsWith('button') ? this : null; }
    matches(selector: string) { return selector.startsWith('button'); }
    querySelector() { return null; }
    getBoundingClientRect() { return {width: 40, height: 40}; }
    animate() { return {cancel() {}}; }
  }
  class Mouse {}
  const values = {
    document: {addEventListener: listen}, window, Element: Button, MouseEvent: Mouse,
    addEventListener: listen,
    setTimeout: (callback: () => void) => { pending.push(callback); return pending.length; },
  };
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  const button = new Button();
  const fire = (name: string, more: Record<string, unknown> = {}) => {
    const event = Object.assign(new Mouse(), {target: button, isTrusted: true, button: 0, pointerType: 'mouse', detail: 0, repeat: false}, more);
    for (const handler of handlers.get(name) ?? []) handler(event as unknown as Event);
  };
  const flush = () => { for (const callback of pending.splice(0)) callback(); };
  touch();
  for (const previous of ['Enter', 'pointer']) {
    for (const next of [' ', 'pointer']) {
      heard.length = 0;
      if (previous === 'Enter') {
        fire('keydown', {key: 'Enter'});
        fire('click');
        fire('keyup', {key: 'Enter'});
      } else {
        fire('pointerdown');
        fire('pointerup');
        fire('click', {detail: 1});
      }
      assert.deepEqual(heard, ['enter']);
      // The previous release timer is still queued when a new press starts on the very same button.
      if (next === 'pointer') fire('pointerdown');
      else fire('keydown', {key: next});
      flush();
      assert.deepEqual(heard, ['enter', 'enter']);
      if (next === 'pointer') fire('pointerup');
      else fire('keyup', {key: next});
      fire('click', {detail: next === 'pointer' ? 1 : 0});
      assert.deepEqual(heard, ['enter', 'enter'], `${previous} followed by ${next}: one sound per press`);
      flush();
      // Once release cleanup finishes, an independent native activation still sounds.
      fire('click');
      assert.deepEqual(heard, ['enter', 'enter', 'enter']);
    }
  }
});
