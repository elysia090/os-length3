import assert from 'node:assert/strict';
import test from 'node:test';
import {clampCamera} from './camera-placement.mts';

const viewport = {width:800,height:600}, pane = {width:260,height:224};

test('floating host position is rounded and clamped in each axis', () => {
  assert.deepEqual(clampCamera({x:95.25,y:46.9},viewport,pane),{x:95,y:47});
  assert.deepEqual(clampCamera({x:-20,y:900},viewport,pane),{x:8,y:368});
  assert.deepEqual(clampCamera({x:740,y:-3},viewport,pane),{x:532,y:8});
  assert.deepEqual(clampCamera({x:740,y:300},{width:200,height:160},pane),{x:8,y:8});
});

test('invalid host geometry does not replace the previous position', () => {
  assert.equal(clampCamera({x:NaN,y:40},viewport,pane),null);
  assert.equal(clampCamera({x:90,y:-Infinity},viewport,pane),null);
  assert.equal(clampCamera({x:90,y:40},{width:-1,height:600},pane),null);
});
