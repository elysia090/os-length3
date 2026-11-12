import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activateOnPress} from './press.ts';

function fixture() {
  const button = new EventTarget();
  let calls = 0;
  activateOnPress(button as unknown as HTMLElement, () => calls++);
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    button.dispatchEvent(Object.assign(new Event(type), {pointerType: 'mouse', pointerId: 1, button: 0,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, detail: type === 'click' ? 1 : 0, ...fields}));
  };
  return {send, calls: () => calls};
}

test('a mouse press activates immediately and its click does not activate again', () => {
  const f = fixture();
  f.send('pointerdown'); assert.equal(f.calls(), 1);
  f.send('click'); assert.equal(f.calls(), 1);
  f.send('pointerdown'); f.send('click'); assert.equal(f.calls(), 2);
});
test('pointer cancellation does not eat the next keyboard or pointer activation', () => {
  for (const detail of [0, 1]) {
    const f = fixture(); f.send('pointerdown'); f.send('pointercancel');
    f.send('click', {detail}); assert.equal(f.calls(), 2);
  }
});
test('keyboard and programmatic clicks are never the old mouse press', () => {
  const f = fixture(); f.send('pointerdown'); // release elsewhere can produce no click on this button
  f.send('click', {detail: 0}); assert.equal(f.calls(), 2);
  f.send('click', {detail: 0}); assert.equal(f.calls(), 3);
});
test('touch retains click activation even after an unfinished mouse press', () => {
  const f = fixture(); f.send('pointerdown');
  f.send('pointerdown', {pointerType: 'touch', pointerId: 2}); assert.equal(f.calls(), 1);
  f.send('click', {pointerType: 'touch', pointerId: 2}); assert.equal(f.calls(), 2);
});
test('modified and secondary presses do not activate early or inherit mouse state', () => {
  for (const fields of [{ctrlKey: true}, {metaKey: true}, {altKey: true}, {shiftKey: true}, {button: 2}]) {
    const f = fixture(); f.send('pointerdown'); f.send('pointerdown', fields);
    assert.equal(f.calls(), 1);
    f.send('click', {...fields, detail: 0}); assert.equal(f.calls(), 2);
  }
});
test('a different pointer click is not swallowed; legacy MouseEvent clicks still deduplicate', () => {
  const f = fixture(); f.send('pointerdown'); f.send('click', {pointerId: 2}); assert.equal(f.calls(), 2);
  const button = new EventTarget(); let calls = 0;
  activateOnPress(button as unknown as HTMLElement, () => calls++);
  button.dispatchEvent(Object.assign(new Event('pointerdown'), {pointerType: 'mouse', pointerId: 1, button: 0}));
  button.dispatchEvent(Object.assign(new Event('click'), {detail: 1}));
  assert.equal(calls, 1);
});
