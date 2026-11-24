import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkPointerCommits} from './pointer-proof.ts';

const first = 'WAYLAND_COMMIT seq=1 size=32x24 configure=1 pointer=0 stride=128';
const response = 'WAYLAND_COMMIT seq=2 size=32x24 configure=1 pointer=3 stride=128';
const closed = 'WAYLAND_LAYER_CLIENT_DESTROY';
const receipt = (second: string) => [first, second, closed].join('\n');

test('accepts a second same-configure panel commit after a forwarded pointer', () => {
  checkPointerCommits(receipt(response));
});

test('neither a no-input repaint nor a resize proves a pointer response', () => {
  assert.throws(() => checkPointerCommits(receipt(response.replace('pointer=3', 'pointer=0'))), /actual forwarded/);
  assert.throws(() => checkPointerCommits(receipt(response.replace('configure=1', 'configure=4'))), /configure\/resize/);
  assert.throws(() => checkPointerCommits(receipt(response.replace('32x24', '47x19'))), /actual forwarded/);
});

test('an extra commit or missing layer retirement fails the witness', () => {
  assert.throws(() => checkPointerCommits(receipt(response) + '\n' + response), /exactly two/);
  assert.throws(() => checkPointerCommits([first, closed, response].join('\n')), /close after/);
  assert.throws(() => checkPointerCommits([first, response].join('\n')), /close after/);
  assert.throws(() => checkPointerCommits([first, response, `Not a guest close: ${closed}`].join('\n')), /close after/);
});
