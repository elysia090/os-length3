import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountGuestSurface, surfaceFromMirror} from '../../src/surface.ts';
import {decodeRaster, lendRaster, MirrorRaster, rasterFile} from './support/mirror-raster.ts';

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

test('borrowing validates the full span and uses fixed, exact-offset backing', () => {
  const complete = frame(7, 64, 48);
  const buffer = new ArrayBuffer(complete.length + 40);
  const encoded = new Uint8Array(buffer, 11, complete.length);
  encoded.set(complete);
  const lent = lendRaster(encoded)!;
  const retained = decodeRaster(encoded)!;
  assert.deepEqual([lent.sequence, lent.width, lent.height], [7, 64, 48]);
  assert.equal(lent.pixels.buffer, buffer);
  assert.equal(lent.pixels.byteOffset, 27);
  assert.equal(lent.pixels.byteLength, 12288);
  assert.notEqual(retained.pixels.buffer, buffer);

  for (const invalid of [encoded.subarray(0, 15), encoded.subarray(0, -1), frame(0), frame(1, 0, 48),
    frame(1, 65, 48), frame(1, 64, 49), new Uint8Array(16)]) assert.equal(lendRaster(invalid), null);
  assert.equal(lendRaster(new Uint8Array(buffer, 11, complete.length + 1)), null);
  const shared = new Uint8Array(new SharedArrayBuffer(complete.length));
  shared.set(complete);
  assert.equal(lendRaster(shared), null);

  const movable = new ArrayBuffer(complete.length, {maxByteLength: complete.length + 1});
  const resizable = new Uint8Array(movable);
  resizable.set(complete);
  const fixed = lendRaster(resizable)!;
  assert.equal(fixed.pixels.buffer.resizable, false);
  assert.notEqual(fixed.pixels.buffer, movable);
  assert.deepEqual(fixed.pixels, retained.pixels);

  const detached = frame();
  structuredClone(detached.buffer, {transfer: [detached.buffer]});
  assert.equal(lendRaster(detached), null);
});

test('the received mirror span reaches the synchronous canvas draw with identical RGBA and lifetime', () => {
  const worker = Object.assign(new EventTarget(), {postMessage() {}});
  const painted: number[][] = [];
  let received: Uint8Array<ArrayBuffer>;
  let cleared = 0;
  const canvas = Object.assign(new EventTarget(), {
    width: 0, height: 0,
    getContext: () => ({
      putImageData(image: ImageData, x: number, y: number) {
        assert.deepEqual([x, y, image.width, image.height], [0, 0, 2, 2]);
        assert.equal(image.data.buffer, received.buffer, 'no pixel copy between mirror bytes and draw');
        assert.equal(image.data.byteOffset, received.byteOffset + 16);
        painted.push([...image.data]); // Simulate the canvas's own backing-store write.
      },
      clearRect() { cleared++; },
    }),
  });
  const source = surfaceFromMirror({worker, file: rasterFile, maxEncodedBytes: 48,
    decode(bytes) { const r = lendRaster(bytes); return r && {serial: r.sequence, width: r.width, height: r.height, rgba: r.pixels}; }});
  const previousImageData = globalThis.ImageData;
  class Image {
    readonly data: Uint8ClampedArray<ArrayBuffer>;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  globalThis.ImageData = Image as unknown as typeof ImageData;
  try {
    const display = mountGuestSurface({source, canvas: canvas as unknown as HTMLCanvasElement,
      viewport: {contains: (el: unknown) => el === canvas} as HTMLElement, limits: {width: 2, height: 2, bytes: 16}});
    const outer = new Uint8Array(61);
    const range = outer.subarray(13, 45);
    range.set(frame(8, 2, 2));
    range.set([255, 0, 0, 128, 0, 0, 0, 0, 0, 255, 0, 255, 7, 8, 9, 17], 16);
    const expected = [...decodeRaster(range)!.pixels];
    received = structuredClone(range, {transfer: [outer.buffer]});
    assert.equal(outer.byteLength, 0);
    worker.dispatchEvent(new MessageEvent('message', {data: changed(received)}));
    assert.deepEqual(source.current, {serial: 8, width: 2, height: 2});
    received.fill(0);
    assert.deepEqual(painted, [expected], 'the completed draw keeps no source-byte dependency');
    worker.dispatchEvent(new MessageEvent('message', {data: changed(frame(7, 2, 2))}));
    assert.equal(source.current, null);
    assert.equal(painted.length, 1);
    worker.dispatchEvent(new MessageEvent('message', {data: {type: 'exit'}}));
    assert.equal(cleared, 1);
    worker.dispatchEvent(new MessageEvent('message', {data: changed(frame(9, 2, 2))}));
    display.close();
    assert.equal(painted.length, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.ImageData = previousImageData;
  }
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
