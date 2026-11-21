// Installed browser reference owner; stand-in DOM/Worker, no guest execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const [browser, failure] = process.argv.slice(2);
assert.ok(browser && (failure === undefined || failure === '--clear-fails'), 'pass the staged consumer/browser directory');
let worker, cleared = 0, removedPagehide = 0;
const workers = [];
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
    clearRect() { if (++cleared===1 && failure) throw Error('test-only clear failure'); },
  }),
});
const viewport = {contains: x => x === canvas};
const status = {dataset: {phase: 'loading'}, textContent: ''}, protocol = {textContent: ''};
const controls = ['pan', 'host-resize', 'guest-resize', 'quit'].map(id => ['#' + id, {disabled: true}]);
const start = {disabled: true}, stop = {disabled: true};
const dom = new Map([['#show-drawing', start], ['#stop-drawing', stop],['#status', status], ['#camera', viewport], ['canvas', canvas], ['#protocol', protocol], ...controls]);
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
      worker = this; workers.push(this);
    }
    postMessage(value) {
      this.sent.push(value);
      if (value.type === 'retire') queueMicrotask(() => this.receive({type: 'retiring', failures: []}));
    }
    terminate() { this.terminated++; }
    receive(data) { this.dispatchEvent(new MessageEvent('message', {data})); }
  },
});

function frame(serial, target=worker) {
  const bytes = new Uint8Array(20), header = new DataView(bytes.buffer);
  bytes.set([82, 66, 70, 49]); // RBF1
  [serial, 1, 1].forEach((n, i) => header.setUint32(4 * (i + 1), n, true));
  bytes.set([serial, 0, 0, 128], 16);
  target.receive({type: 'changes', files: [{path: 'frame.rgba', bytes}]});
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
const old=worker;
stop.onclick({isTrusted:false});
assert.deepEqual(old.sent.map(m=>m.type),['start']);
stop.onclick({isTrusted:true});
assert.equal(start.disabled,true);
start.onclick({isTrusted:true}); // Prior Worker has not yet acknowledged retirement.
assert.equal(workers.length,1);
await delay(0);
assert.equal(old.terminated,1);
assert.equal(cleared,1);
if (failure) {
  assert.equal(start.disabled,true);
  assert.equal(status.dataset.phase,'error');
  assert.equal(status.textContent,'Drawing view cleanup was not confirmed');
  assert.deepEqual(old.sent.map(m=>m.type),['start','retire']);
  assert.equal(workers.length,1);
  console.log(JSON.stringify({clearFailed:true,workerRetired:true,newGenerationBlocked:true}));
  process.exit(0);
}
assert.equal(start.disabled,false);
start.onclick({isTrusted:false});
assert.equal(workers.length,1);
start.onclick({isTrusted:true});
assert.equal(workers.length,2);
assert.notEqual(worker,old);
assert.equal(canvas.dataset.sequence,undefined);
frame(33,old);assert.equal(draws.length,32);
frame(1);assert.equal(draws.length,33);
assert.equal(canvas.dataset.sequence,'1');
worker.dispatchEvent(new MessageEvent('messageerror'));
await delay(0);
assert.equal(cleared, 2);
assert.equal(status.dataset.phase, 'error');
assert.equal(status.textContent, 'Guest Worker message could not be decoded');
assert.ok(controls.every(([, c]) => c.disabled));
assert.deepEqual(worker.sent.map(m => m.type), ['start', 'retire']);
assert.equal(worker.terminated, 1);
assert.equal(removedPagehide, 2);
assert.equal(start.disabled,true); // Unconfirmed graphics errors never rearm.
frame(2);
worker.receive({type: 'output', fd: 1, bytes: Uint8Array.of(120)});
assert.equal(draws.length, 33);
assert.equal(protocol.textContent, '');
console.log(JSON.stringify({deliveredDraws: 33, generations: 2, oldGenerationIgnored: true, retiredAfterMessageError: true}));
