import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CHANGE, FAR} from './camera.ts';

test('going along, the frame come to is there under the one left before that one goes, and the camera stands back to half its size', () => {
  // In under first, then the one left goes: never a moment with neither.
  assert.ok(CHANGE.in[1] <= CHANGE.out[0]);
  assert.ok(CHANGE.in[0] > 0 && CHANGE.out[1] < 1);
  assert.equal(FAR, .5);
});
