import assert from 'node:assert/strict';
import test from 'node:test';
import {surfaceFromMirror, type GuestSurfaceObserver, type MirrorSurfaceOptions} from '../src/surface.ts';

const frameFile = 'scanout.bin';
class Port extends EventTarget {
  input: {type: string; bytes: Uint8Array}[] = [];
  postMessage(message: {type: string; bytes: Uint8Array}) { this.input.push(message); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', {data})); }
  files(...files: {path: string; bytes: unknown}[]) { this.message({type: 'changes', files, dirs: [], removed: []}); }
}
const frame = (serial: number) => ({serial, width: 8, height: 6, rgba: new Uint8ClampedArray(8 * 6 * 4)});
const file = (serial: number, path = frameFile) => ({path, bytes: Uint8Array.of(serial)});
const port = (w: Port) => w as unknown as MirrorSurfaceOptions['worker'];

function fixture(options: Omit<Partial<MirrorSurfaceOptions>, 'worker'> = {}) {
  const worker = new Port(), drew: number[] = [];
  let decodes = 0, ended = 0;
  const source = surfaceFromMirror({worker: port(worker), file: frameFile, maxEncodedBytes: 4,
    decode(bytes) { decodes++; return frame(bytes[0]!); },
    encodePointer: ({x, y}) => Uint8Array.of(x, y),
    encodeResize: ({width, height}) => Uint8Array.of(width, height),
    ...options,
  });
  const observer: GuestSurfaceObserver = {
    frame(f) { drew.push(f.serial); return true; },
    end() { ended++; },
  };
  return {worker, source, observer, drew, decodes: () => decodes, ended: () => ended};
}

test('one selected basename, one port, and input tied to the drawn serial and bounds', () => {
  const f = fixture(), other = new Port();
  const off = f.source.observe(f.observer);
  other.files(file(1));
  f.worker.files(file(2, 'nested/' + frameFile), file(3, frameFile + '.tmp'));
  f.source.pointer?.({serial: 1, x: 0, y: 0});
  assert.equal(f.decodes(), 0);
  assert.deepEqual(f.worker.input, []);
  f.worker.files(file(4));
  assert.deepEqual(f.source.current, {serial: 4, width: 8, height: 6});
  assert.deepEqual(f.drew, [4]);
  for (const point of [
    {serial: 3, x: 1, y: 2}, {serial: 4, x: -1, y: 2}, {serial: 4, x: 8, y: 2},
    {serial: 4, x: 2, y: 6}, {serial: 4, x: 2.5, y: 2}, {serial: 4, x: 2, y: NaN},
  ]) f.source.pointer?.(point);
  f.source.resize?.({serial: 3, width: 7, height: 4});
  f.source.resize?.({serial: 4, width: 0, height: 4});
  assert.deepEqual(f.worker.input, []);
  f.worker.postMessage = other.postMessage.bind(other);
  f.source.pointer?.({serial: 4, x: 7, y: 5});
  f.source.resize?.({serial: 4, width: 7, height: 4});
  assert.deepEqual(f.worker.input, [
    {type: 'input', bytes: Uint8Array.of(7, 5)},
    {type: 'input', bytes: Uint8Array.of(7, 4)},
  ]);
  assert.deepEqual(other.input, []);
  off();
});

test('oversize, detached, shared, duplicate, rejected and stale changes disarm input', () => {
  const f = fixture();
  f.source.observe({end: f.observer.end, frame(value) {
    if (value.serial === 9) return false;
    return f.observer.frame(value);
  }});
  f.worker.files(file(1));
  const detached = Uint8Array.of(2);
  structuredClone(detached.buffer, {transfer: [detached.buffer]});
  for (const bytes of [detached, new Uint8Array(new SharedArrayBuffer(1)), new Uint8Array(5), undefined]) {
    f.worker.files({path: frameFile, bytes});
    assert.equal(f.source.current, null);
    f.source.pointer?.({serial: 1, x: 0, y: 0});
  }
  f.worker.files(file(2), file(3));
  assert.equal(f.decodes(), 1);
  f.worker.files(file(8));
  f.worker.files(file(7));
  assert.equal(f.source.current, null);
  f.worker.files(file(9));
  assert.equal(f.source.current, null);
  f.source.pointer?.({serial: 8, x: 0, y: 0});
  assert.deepEqual(f.worker.input, []);
  assert.deepEqual(f.drew, [1, 8]);
  f.worker.files(file(10));
  assert.deepEqual(f.source.current, {serial: 10, width: 8, height: 6});
});

test('source loss closes one observation; not a Worker launch or retirement', () => {
  for (const loss of [
    (w: Port) => w.message({type: 'changes', dirs: [frameFile], files: [], removed: []}),
    (w: Port) => w.message({type: 'changes', dirs: [], files: [file(2)], removed: [frameFile]}),
    (w: Port) => w.message({type: 'exit', status: 0}),
    (w: Port) => w.message({type: 'retiring'}),
    (w: Port) => w.message({type: 'error', message: 'failure'}),
    (w: Port) => w.dispatchEvent(new Event('messageerror')),
    (w: Port) => w.dispatchEvent(new Event('error')),
  ]) {
    const f = fixture(), off = f.source.observe(f.observer);
    f.worker.files(file(1));
    loss(f.worker);
    off();
    f.worker.files(file(3));
    f.source.pointer?.({serial: 1, x: 0, y: 0});
    assert.equal(f.ended(), 1);
    assert.equal(f.source.current, null);
    assert.deepEqual(f.drew, [1]);
    assert.deepEqual(f.worker.input, []);
    assert.throws(() => f.source.observe(f.observer), /single-use/);
  }
  const cancelled = fixture();
  const stop = cancelled.source.observe(cancelled.observer);
  stop(); stop();
  cancelled.worker.files(file(1));
  assert.deepEqual(cancelled.drew, []);
  assert.equal(cancelled.ended(), 0, 'unsubscribe is not a transport shutdown');
});

test('reentrant decoders and encoders cannot publish or send older work after source changes', () => {
  const worker = new Port(), observed: number[] = [];
  const source = surfaceFromMirror({worker: port(worker), file: frameFile, maxEncodedBytes: 4,
    decode(bytes) {
      const serial = bytes[0]!;
      if (serial === 1) worker.files(file(2));
      if (serial === 3) throw Error('invalid');
      return frame(serial);
    },
    encodePointer() {
      worker.files(file(5));
      return Uint8Array.of(7);
    },
  });
  source.observe({frame(f) { observed.push(f.serial); return true; }, end() {}});
  worker.files(file(1));
  assert.deepEqual(observed, [2]);
  worker.files(file(3));
  assert.equal(source.current, null);
  worker.files(file(4));
  source.pointer?.({serial: 4, x: 0, y: 0});
  assert.deepEqual(observed, [2, 4, 5]);
  assert.deepEqual(source.current, {serial: 5, width: 8, height: 6});
  assert.deepEqual(worker.input, []);
});

test('rejects non-basename paths and unbounded input, with input opt-in only', () => {
  const worker = port(new Port()), decode = () => null;
  for (const file of ['', '.', '..', '/frame', './frame', 'dir/frame', 'dir\\frame', 'frame\0']) {
    assert.throws(() => surfaceFromMirror({worker, file, maxEncodedBytes: 8, decode}), TypeError);
  }
  assert.throws(() => surfaceFromMirror({worker, file: frameFile, maxEncodedBytes: Infinity, decode}), RangeError);
  const source = surfaceFromMirror({worker, file: frameFile, maxEncodedBytes: 8, decode});
  assert.equal(source.pointer, undefined);
  assert.equal(source.resize, undefined);
});
