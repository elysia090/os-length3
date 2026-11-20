import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeRaster, MirrorRaster, rasterFile} from './support/mirror-raster.ts';

function frame(sequence = 1, width = 32, height = 24): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16 + width * height * 4);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 66, 70, 49]); // RBF1
  for (const [i, value] of [sequence, width, height].entries()) view.setUint32(4 * (i + 1), value, true);
  return bytes;
}
const changed = (bytes: Uint8Array, path = rasterFile) => ({type: 'changes', files: [{path, bytes}]});

test('raster parsing is bounded and owns a copy of the received pixels', () => {
  const bytes = frame(1, 64, 48);
  bytes.set([7, 8, 9, 255], 16);
  const read = decodeRaster(bytes)!;
  assert.deepEqual([read.sequence, read.width, read.height, read.pixels.length], [1, 64, 48, 64 * 48 * 4]);
  bytes[16] = 90;
  assert.deepEqual([...read.pixels.subarray(0, 4)], [7, 8, 9, 255]);
  for (const invalid of [bytes.subarray(0, 15), bytes.subarray(0, -1), frame(0), frame(1, 0, 48),
    frame(1, 65, 48), frame(1, 64, 49), new Uint8Array(16)]) assert.equal(decodeRaster(invalid), null);
});

test('the mirror admits only one exact, non-replayed raster in the owning attachment', () => {
  const surface = new MirrorRaster(), bytes = frame();
  assert.equal(surface.accept(changed(bytes, 'nested/' + rasterFile)), null);
  assert.equal(surface.accept({type: 'file', files: changed(bytes).files}), null);
  assert.equal(surface.accept({type: 'changes', files: [changed(bytes).files[0], changed(bytes).files[0]]}), null);
  assert.deepEqual(surface.accept(changed(bytes))?.sequence, 1);
  assert.equal(surface.accept(changed(bytes)), null);
  assert.deepEqual(surface.accept(changed(frame(2, 47, 19)))?.sequence, 2);
  assert.equal(surface.accept(changed(bytes)), null);
  surface.retire();
  assert.equal(surface.accept(changed(frame(3))), null);
  assert.equal(surface.size, undefined);
  assert.ok(new MirrorRaster().accept(changed(bytes)), 'a different owner starts its own sequence');
});

test('pointer geometry follows the actual camera rectangle, independently of logical resize', () => {
  const surface = new MirrorRaster();
  assert.ok(surface.accept(changed(frame())));
  const initial = {x: 64, y: 44, width: 256, height: 192};
  const panned = {...initial, x: initial.x - 48, y: initial.y - 36};
  const clip = {x: 0, y: 0, width: 245, height: 172};
  assert.deepEqual(surface.pointer(148, 144, initial, clip), Uint8Array.of(1, 10, 12));
  assert.deepEqual(surface.pointer(100, 108, panned, clip), Uint8Array.of(1, 10, 12));
  assert.equal(surface.pointer(245, 60, panned, clip), null);
  assert.equal(surface.pointer(Number.NaN, 60, panned, clip), null);
  assert.equal(surface.pointer(100, 108, {...panned, width: 0}, clip), null);
  assert.deepEqual(surface.resize(47, 19), Uint8Array.of(2, 47, 19));
  assert.equal(surface.resize(47.1, 19), null);
  assert.deepEqual(surface.size, {sequence: 1, width: 32, height: 24}, 'resize request alone cannot change intrinsic size');
  assert.ok(surface.accept(changed(frame(2, 47, 19))));
  assert.deepEqual(surface.size, {sequence: 2, width: 47, height: 19});
  surface.retire();
  assert.equal(surface.pointer(100, 108, panned, clip), null);
  assert.equal(surface.resize(47, 19), null);
});
