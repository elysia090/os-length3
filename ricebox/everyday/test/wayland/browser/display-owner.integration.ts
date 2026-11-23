// Installed browser reference owner; stand-in DOM/Worker, no guest execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const [browser] = process.argv.slice(2);
assert.ok(browser && process.argv.length === 3, 'pass the staged consumer/browser directory');
let cleared = 0, removedPagehide = 0;
const draws: [number, number][] = [], workers: BrowserWorker[] = [];
const window = new class extends EventTarget {
  override removeEventListener(...[type, ...args]: Parameters<EventTarget['removeEventListener']>) {
    if (type === 'pagehide') removedPagehide++;
    super.removeEventListener(type, ...args);
  }
}();
const canvas = Object.assign(new EventTarget(), {
  width: 1, height: 1, style: {}, dataset: {} as Record<string, string>,
  getContext: () => ({
    putImageData(image: ImageData) { draws.push([image.data[0], image.data[3]]); },
    clearRect() { cleared++; },
  }),
});
const viewport = {contains: (x: unknown) => x === canvas};
const status = {dataset: {phase: 'loading'}, textContent: ''}, protocol = {textContent: ''};
const controls = ['pan', 'host-resize', 'guest-resize', 'quit'].map((id): [string, {disabled: boolean}] => ['#' + id, {disabled: true}]);
const dom = new Map<string, unknown>([['#status', status], ['#camera', viewport], ['canvas', canvas], ['#protocol', protocol], ...controls]);
const assets = new Map(['sods.wasm', 'muk', 'wayland-presenter'].map((name, i) => [name, Uint8Array.of(i + 1)]));
const pin = (name: string) => {
  const bytes = assets.get(name);
  assert.ok(bytes);
  return [name, createHash('sha256').update(bytes).digest('hex')];
};
class BrowserWorker extends EventTarget {
  readonly sent: {type: string}[] = [];
  terminated = 0;
  constructor(url: URL) {
    super();
    assert.match(url.pathname, /\/node_modules\/ricebox\/ricebox\/distribution\/runtime\/worker\.js$/);
    workers.push(this);
  }
  postMessage(value: {type: string}) {
    this.sent.push(value);
    if (value.type === 'retire') queueMicrotask(() => this.receive({type: 'retiring', failures: []}));
  }
  terminate() { this.terminated++; }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', {data})); }
}
Object.assign(globalThis, {
  window, location: {search: ''}, document: {querySelector: (selector: string) => dom.get(selector)},
  ImageData: class { constructor(data: Uint8ClampedArray, width: number, height: number) { Object.assign(this, {data, width, height}); } },
  fetch: async (url: string) => url.endsWith('pins.json')
    ? Response.json({translator: pin('sods.wasm'), muk: pin('muk'), elf: pin('wayland-presenter')})
    : new Response(assets.get(url.split('/').pop() ?? '')),
  Worker: BrowserWorker,
});

function frame(worker: BrowserWorker, serial: number) {
  const bytes = new Uint8Array(20), header = new DataView(bytes.buffer);
  bytes.set([82, 66, 70, 49]); // RBF1
  [serial, 1, 1].forEach((n, i) => header.setUint32(4 * (i + 1), n, true));
  bytes.set([serial, 0, 0, 128], 16);
  worker.receive({type: 'changes', files: [{path: 'frame.rgba', bytes}]});
}
await import(pathToFileURL(join(browser, 'demo.mts')).href);
for (let i = 0; i < 200 && !workers[0]?.sent.length; i++) await delay(5);
const [worker] = workers;
assert.equal(worker?.sent[0]?.type, 'start', status.textContent);
for (let n = 1; n <= 32; n++) {
  frame(worker, n);
  assert.equal(draws.length, n);
  assert.equal(canvas.dataset.sequence, String(n));
}
assert.deepEqual(draws.at(-1), [32, 128]);
assert.equal(status.dataset.phase, 'frame');
assert.ok(controls.every(([, c]) => !c.disabled));
worker.dispatchEvent(new MessageEvent('messageerror'));
await Promise.resolve(); // Simulated retirement acknowledgment.
assert.equal(cleared, 1);
assert.equal(status.dataset.phase, 'error');
assert.equal(status.textContent, 'Guest Worker message could not be decoded');
assert.ok(controls.every(([, c]) => c.disabled));
assert.deepEqual(worker.sent.map(m => m.type), ['start', 'retire']);
assert.equal(worker.terminated, 1);
assert.equal(removedPagehide, 1);
frame(worker, 33);
worker.receive({type: 'output', fd: 1, bytes: Uint8Array.of(120)});
assert.equal(draws.length, 32);
assert.equal(protocol.textContent, '');
console.log(JSON.stringify({deliveredDraws: 32, synchronous: true, retiredAfterMessageError: true}));
