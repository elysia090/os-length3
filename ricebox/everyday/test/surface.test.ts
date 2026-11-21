import assert from 'node:assert/strict';
import test from 'node:test';
import {mountGuestSurface, type GuestFrame, type GuestSurfaceOptions, type GuestSurfaceObserver} from '../src/surface.ts';

const imageData = globalThis.ImageData;
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
test.before(() => { globalThis.ImageData = Image as typeof ImageData; });
test.after(() => { globalThis.ImageData = imageData; });

class Canvas extends EventTarget {
  width = 0;
  height = 0;
  box = {left: 80, top: 45, width: 192, height: 144};
  painted: {width: number; height: number; pixels: Uint8ClampedArray}[] = [];
  clear = 0;
  getContext() {
    return {putImageData: (image: Image) => {
      this.painted.push({width: image.width, height: image.height, pixels: new Uint8ClampedArray(image.data)});
    }, clearRect: () => { ++this.clear; }};
  }
  getBoundingClientRect() { return this.box; }
  click(clientX: number, clientY: number, button = 0, isPrimary = true) {
    this.dispatchEvent(Object.assign(new Event('pointerdown'), {clientX, clientY, button, isPrimary}));
  }
}

function fixture() {
  const canvas = new Canvas();
  const view = {
    clientLeft: 2, clientTop: 3, clientWidth: 180, clientHeight: 140,
    getBoundingClientRect: () => ({left: 100, top: 60, width: 186, height: 143}),
    contains: (target: unknown) => target === canvas,
  };
  let observer!: GuestSurfaceObserver, stops = 0;
  const pointers: unknown[] = [], resizes: unknown[] = [];
  const options: GuestSurfaceOptions = {
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport: view as unknown as HTMLElement,
    source: {
      observe(next) { observer = next; return () => { ++stops; }; },
      pointer: p => pointers.push(p),
      resize: r => resizes.push(r),
    },
    limits: {width: 100, height: 80, bytes: 96 * 72 * 4},
  };
  return {options, canvas, view, pointers, resizes, observer: () => observer, stops: () => stops};
}
const frame = (serial = 1, width = 96, height = 72): GuestFrame =>
  ({serial, width, height, rgba: new Uint8ClampedArray(width * height * 4)});

test('bounded, monotone RGBA is drawn synchronously and no reference is retained by the mount', () => {
  const f = fixture(), display = mountGuestSurface(f.options);
  const observe = f.observer();
  const empty = frame(), pixels = empty.rgba;
  pixels.set([11, 12, 13, 129]);
  assert.equal(observe.frame(empty), true);
  pixels.fill(0);
  assert.deepEqual([...f.canvas.painted[0]!.pixels.subarray(0, 4)], [11, 12, 13, 129]);
  assert.deepEqual([f.canvas.width, f.canvas.height], [96, 72]); // not the 64×48 test fixture
  const detached = frame(2);
  structuredClone(detached.rgba.buffer, {transfer: [detached.rgba.buffer]});
  const shared = new Uint8ClampedArray(new SharedArrayBuffer(pixels.byteLength));
  for (const invalid of [null, frame(), frame(0), frame(2, 101), frame(2, 98, 75), frame(2, 96, 81),
    {...frame(2), width: Infinity}, {...frame(2), serial: 2 ** 53}, {...frame(2), width: 0},
    {...frame(2), rgba: new Uint8ClampedArray(pixels.length + 1)}, detached,
    {...frame(2), rgba: shared}, {...frame(2), rgba: new Uint8Array(pixels.length)}]) {
    assert.equal(observe.frame(invalid as GuestFrame), false);
  }
  assert.equal(f.canvas.painted.length, 1);
  // A bounded view does not require bytes outside its own span to be accepted.
  const next = frame(2, 30, 20), backing = new Uint8ClampedArray(next.rgba.length + 32);
  assert.equal(observe.frame({...next, rgba: backing.subarray(12, 12 + next.rgba.length)}), true);
  assert.deepEqual([f.canvas.width, f.canvas.height], [30, 20]);
  display.close();
});

test('live camera and viewport geometry map CSS coordinates, but pan/resize of the host do not forward', () => {
  const f = fixture(), display = mountGuestSurface(f.options);
  f.canvas.click(104, 65);
  assert.deepEqual(f.pointers, []);
  assert.equal(display.resize(22, 18), false);
  assert.equal(f.observer().frame(frame(7)), true);

  f.canvas.click(106, 66);
  assert.deepEqual(f.pointers, [{serial: 7, x: 13, y: 10}]);
  f.canvas.box = {left: 49, top: 31, width: 144, height: 108};
  f.view.clientWidth = 100;
  f.view.clientHeight = 75;
  const before = f.pointers.length;
  for (const [x, y] of [[100, 66], [105, 62], [193, 67], [106, 138], [202, 65], [NaN, 67],
    [106, Infinity], [106, 139]] as const) f.canvas.click(x, y);
  f.canvas.click(107, 65, 2);
  f.canvas.click(107, 65, 0, false);
  assert.equal(f.pointers.length, before);
  assert.deepEqual(f.resizes, []);
  f.canvas.click(107, 65);
  assert.deepEqual(f.pointers.at(-1), {serial: 7, x: 38, y: 22});
  assert.equal(display.resize(47, 19), true);
  assert.deepEqual(f.resizes, [{serial: 7, width: 47, height: 19}]);
  assert.deepEqual([f.canvas.width, f.canvas.height], [96, 72], 'wait for actual guest frame');
  for (const [w, h] of [[99, 79], [3.5, 20], [96, 0], [100, -7], [900, 30]] as const) {
    assert.equal(display.resize(w, h), false);
  }
  f.view.contains = () => false;
  f.canvas.click(107, 65);
  assert.equal(f.pointers.length, before + 1);
  f.view.contains = () => true;
  const differentTransport: unknown[] = [];
  f.options.source.pointer = p => differentTransport.push(p);
  f.options.source.resize = r => differentTransport.push(r);
  f.canvas.click(107, 65);
  assert.equal(display.resize(30, 20), true);
  assert.equal(f.pointers.length, before + 2);
  assert.equal(f.resizes.length, 2);
  assert.deepEqual(differentTransport, [], 'an admitted view does not silently move to another sink');
  display.close();
});

test('no listener without capability, one canvas owner, and source end disables stale observers', () => {
  const f = fixture(), display = mountGuestSurface(f.options);
  assert.throws(() => mountGuestSurface(f.options), /already mounted/);
  assert.equal(f.observer().frame(frame(1)), true);
  const expired = f.observer();
  expired.end();
  display.close();
  assert.equal(f.stops(), 1);
  assert.equal(f.canvas.clear, 1);
  assert.equal(expired.frame(frame(2)), false);
  assert.equal(display.resize(20, 20), false);
  f.canvas.click(107, 65);
  assert.deepEqual(f.pointers, []);

  let observer!: GuestSurfaceObserver, input = 0;
  const source = {observe(next: GuestSurfaceObserver) { observer = next; return () => {}; }};
  const subsequent = mountGuestSurface({...f.options, source});
  // Adding a pointer capability afterward does not register a DOM listener.
  Object.assign(source, {pointer: () => { ++input; }});
  assert.equal(observer.frame(frame(1)), true);
  f.canvas.click(107, 65);
  assert.equal(input, 0);
  subsequent.close();
});

test('initial synchronous end, failing subscriptions and invalid binding leave no owner behind', () => {
  const f = fixture();
  let stopped = 0, seen!: GuestSurfaceObserver;
  const display = mountGuestSurface({...f.options, source: {observe(obs) {
    seen = obs;
    assert.equal(obs.frame(frame(1)), true);
    obs.end();
    return () => { ++stopped; };
  }}});
  display.close();
  assert.equal(seen.frame(frame(2)), false);
  assert.equal(stopped, 1);
  assert.throws(() => mountGuestSurface({...f.options, source: {observe() { throw Error('denied'); }}}), /denied/);
  assert.throws(() => mountGuestSurface({...f.options, limits: {...f.options.limits, bytes: Infinity}}), RangeError);
  f.view.contains = () => false;
  assert.throws(() => mountGuestSurface(f.options), /belong/);
  f.view.contains = () => true;
  mountGuestSurface(f.options).close();
});

test('a close and new owner during a canvas resize cannot be overwritten by a stale frame', () => {
  const f = fixture(), first = mountGuestSurface(f.options);
  const expired = f.observer();
  let width = 0, replacement: ReturnType<typeof mountGuestSurface> | undefined;
  Object.defineProperty(f.canvas, 'width', {
    get: () => width,
    set(value) {
      width = value;
      if (replacement) return;
      first.close();
      replacement = mountGuestSurface(f.options);
    },
  });
  assert.equal(expired.frame(frame(2)), false);
  assert.equal(f.canvas.painted.length, 0);
  assert.equal(f.observer().frame(frame(1, 20, 20)), true);
  assert.equal(f.canvas.painted.length, 1);
  assert.equal(f.stops(), 1);
  replacement!.close();
  assert.equal(f.stops(), 2);
});
