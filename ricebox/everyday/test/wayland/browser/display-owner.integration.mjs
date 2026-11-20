// Installed browser reference owner; stand-in DOM/Worker, no guest execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const [browser] = process.argv.slice(2);
assert.ok(browser && process.argv.length === 3, 'pass the staged consumer/browser directory');
let worker, cleared = 0, removedPagehide = 0;
const draws = [];
const window = new class extends EventTarget {
  removeEventListener(type, ...args) {
    if (type === 'pagehide') removedPagehide++;
    super.removeEventListener(type, ...args);
  }
}();
const canvas = Object.assign(new EventTarget(), {
  width: 1, height: 1, style: {}, dataset: {},
  getContext: () => ({
    putImageData(image) { draws.push([image.data[0], image.data[3]]); },
    clearRect() { cleared++; },
  }),
});
const viewport = {contains: x => x === canvas};
const status = {dataset: {phase: 'loading'}, textContent: ''}, protocol = {textContent: ''};
const controls = ['pan', 'host-resize', 'guest-resize', 'quit'].map(id => ['#' + id, {disabled: true}]);
const dom = new Map([['#status', status], ['#camera', viewport], ['canvas', canvas], ['#protocol', protocol], ...controls]);
const assets = new Map(['sods.wasm', 'muk', 'wayland-presenter'].map((name, i) => [name, Uint8Array.of(i + 1)]));
const pin = name => [name, createHash('sha256').update(assets.get(name)).digest('hex')];
Object.assign(globalThis, {
  window, location: {search: ''}, document: {querySelector: selector => dom.get(selector)},
  ImageData: class { constructor(data, width, height) { Object.assign(this, {data, width, height}); } },
  fetch: async url => url.endsWith('pins.json')
    ? Response.json({translator: pin('sods.wasm'), muk: pin('muk'), elf: pin('wayland-presenter')})
    : new Response(assets.get(url.split('/').at(-1))),
  Worker: class extends EventTarget {
    sent = [];
    terminated = 0;
    constructor(url) {
      super();
      assert.match(url.pathname, /\/node_modules\/ricebox\/ricebox\/distribution\/runtime\/worker\.js$/);
      worker = this;
    }
    postMessage(value) {
      this.sent.push(value);
      if (value.type === 'retire') queueMicrotask(() => this.receive({type: 'retiring', failures: []}));
    }
    terminate() { this.terminated++; }
    receive(data) { this.dispatchEvent(new MessageEvent('message', {data})); }
  },
});

function frame(serial) {
  const bytes = new Uint8Array(20), header = new DataView(bytes.buffer);
  bytes.set([82, 66, 70, 49]); // RBF1
  [serial, 1, 1].forEach((n, i) => header.setUint32(4 * (i + 1), n, true));
  bytes.set([serial, 0, 0, 128], 16);
  worker.receive({type: 'changes', files: [{path: 'frame.rgba', bytes}]});
}
await import(pathToFileURL(join(browser, 'demo.mts')).href);
for (let i = 0; i < 200 && !worker?.sent.length; i++) await delay(5);
assert.equal(worker?.sent[0]?.type, 'start', status.textContent);
for (let n = 1; n <= 32; n++) {
  frame(n);
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
frame(33);
worker.receive({type: 'output', fd: 1, bytes: Uint8Array.of(120)});
assert.equal(draws.length, 32);
assert.equal(protocol.textContent, '');
console.log(JSON.stringify({deliveredDraws: 32, synchronous: true, retiredAfterMessageError: true}));
