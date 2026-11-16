import assert from 'node:assert/strict';
import {test} from 'node:test';
import {amid, laid} from './on-grid.ts';

test('a menu is laid on the grid lines nearest where it was asked, as wide as whole cells', () => {
  // The person's menu, as it was: left 54, top 546, 280 wide, 312 tall, in 1536 × 864.
  assert.deepEqual(laid({left: 54, top: 546, width: 280, height: 312}, 1536, 864), {dx: -6, dy: -18, width: 288});
  // A thing's menu under its chevron: on the line under the name.
  assert.deepEqual(laid({left: 672, top: 124, width: 280, height: 120}, 1536, 864), {dx: 0, dy: -4, width: 288});
});

test('a menu the window would cut, with its shadow, is laid along by whole cells into it', () => {
  // A row's deeds on a phone, past its right edge: along till its shadow is inside the window.
  const at = laid({left: 330, top: 410, width: 216, height: 192}, 390, 844);
  assert.equal(at.width, 216);
  assert.ok(330 + at.dx + 216 + 12 <= 390);
  assert.equal((330 + at.dx) % 24, 0);
  // At the window's foot: up by whole cells till its shadow is in.
  const low = laid({left: 48, top: 552, width: 288, height: 312}, 390, 844);
  assert.ok(552 + low.dy + 312 + 12 <= 844);
  assert.equal((552 + low.dy) % 24, 0);
});

test('never laid past the frame\'s corner to fit', () => {
  const at = laid({left: 60, top: 60, width: 600, height: 900}, 390, 844);
  assert.ok(60 + at.dx >= 48 && 60 + at.dy >= 48);
});

test('the first move of an empty place is whole cells, its middle nearest the world\'s on the grid', () => {
  // Create your first repo, 177 × 72, in 1536 × 864: eight cells by three, half a cell up where it must choose.
  assert.deepEqual(amid(177, 72, 1536, 864), {left: 696, top: 408, width: 192, height: 72});
  // On a phone: the world 342 wide; 192 in it leaves 150, three cells and a bit each side.
  const p = amid(177, 72, 390, 844);
  assert.equal(p.left % 24, 0);
  assert.ok(Math.abs(p.left + 96 - (48 + 390) / 2) <= 12);
  // Never past the frame's corner, however small the window.
  assert.deepEqual(amid(300, 100, 200, 100), {left: 48, top: 48, width: 312, height: 120});
});
