// Installed browser reference owner with a stand-in DOM and Worker.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const [browser, scenario, ...extra] = process.argv.slice(2);
assert.ok(browser && !extra.length && [undefined, '--clear-fails', '--inner-window'].includes(scenario),
  'pass the staged consumer/browser directory and optional scenario');
const failure = scenario === '--clear-fails', innerWindow = scenario === '--inner-window';
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
    clearRect() { if (++cleared === 1 && failure) throw new Error('test-only clear failure'); },
  }),
});
const viewport = {contains: (x: unknown) => x === canvas};
const status = {dataset: {phase: 'loading'}, textContent: ''}, protocol = {textContent: ''};
const dom = new Map<string, unknown>([['#status', status], ['#camera', viewport], ['canvas', canvas], ['#protocol', protocol]]);
const document = {querySelector: (selector: string) => dom.get(selector), activeElement: null as Control | null};

class Control {
  disabled = false;
  hidden = false;
  textContent = '';
  readonly attributes = new Map<string, string>();
  onclick?: (event: {isTrusted: boolean}) => void;
  focus() { document.activeElement = this; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  click(isTrusted: boolean) {
    assert.ok(this.onclick);
    this.onclick({isTrusted});
  }
}
const controls = ['pan', 'host-resize', 'guest-resize', 'quit'].map(id => {
  const control = {disabled: true};
  dom.set('#' + id, control);
  return control;
});
const start = Object.assign(new Control(), {disabled: true}), stop = Object.assign(new Control(), {disabled: true});
dom.set('#show-drawing', start).set('#stop-drawing', stop);
const close = new Control(), open = new Control(), end = new Control(), windowStatus = new Control();
const panel = Object.assign(new Control(), {classList: {add() {}}, contains: (element: unknown) => element === close});
const titlebar = {hidden: true}, session = {hidden: true};
const shell = new Map<string, unknown>([
  ['#shell-open', new Control()], ['#shell-status', {dataset: {}}], ['#shell-output', new Control()],
  ['form', {querySelector: () => new Control()}],
]);
const terminal = {querySelector: (selector: string) => shell.get(selector)};
if (innerWindow) for (const [selector, element] of Object.entries({
  '#drawing-window': panel, '#drawing-window-titlebar': titlebar,
  '#drawing-window-close': close, '#drawing-window-open': open,
  '#view-session': session, '#view-end': end, '#view-status': windowStatus, '#shell': terminal,
})) dom.set(selector, element);

const assets = new Map(['sods.wasm', 'muk', 'wayland-presenter', 'busybox'].map((name, i) => [name, Uint8Array.of(i + 1)]));
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
  window, location: {search: ''}, document,
  ImageData: class { constructor(data: Uint8ClampedArray, width: number, height: number) { Object.assign(this, {data, width, height}); } },
  fetch: async (url: string) => url.endsWith('pins.json')
    ? Response.json({translator: pin('sods.wasm'), muk: pin('muk'), elf: pin('wayland-presenter'),
      ...(innerWindow ? {shell: pin('busybox')} : {})})
    : new Response(assets.get(url.split('/').pop() ?? '')),
  Worker: BrowserWorker,
});

function frame(target: BrowserWorker, serial: number) {
  const bytes = new Uint8Array(20), header = new DataView(bytes.buffer);
  bytes.set([82, 66, 70, 49]); // RBF1
  [serial, 1, 1].forEach((n, i) => header.setUint32(4 * (i + 1), n, true));
  bytes.set([serial, 0, 0, 128], 16);
  target.receive({type: 'changes', files: [{path: 'frame.rgba', bytes}]});
}
await import(pathToFileURL(join(browser, 'demo.mts')).href);
for (let i = 0; i < 200 && !workers[0]?.sent.length; i++) await delay(5);
const [first] = workers;
assert.equal(first?.sent[0]?.type, 'start', status.textContent);
if (innerWindow) {
  assert.equal(session.hidden, false);
  frame(first, 1);
  close.click(false);
  assert.equal(panel.hidden, false);
  close.focus();
  close.click(true);
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, open);
  assert.equal(open.attributes.get('aria-disabled'), 'true');
  open.click(true);
  assert.equal(panel.hidden, true);
  assert.equal(workers.length, 1);
  await delay(0);
  assert.equal(open.attributes.get('aria-disabled'), 'false');
  assert.equal(first.terminated, 1);
  open.click(false);
  assert.equal(panel.hidden, true);
  open.click(true);
  assert.equal(panel.hidden, false);
  assert.equal(document.activeElement, close);
  assert.equal(workers.length, 2);
  const reopened = workers[1];
  frame(first, 2);
  assert.equal(draws.length, 1);
  frame(reopened, 1);
  assert.equal(draws.length, 2);
  end.click(true);
  await delay(0);
  assert.equal(panel.hidden, true);
  assert.equal(open.attributes.get('aria-disabled'), 'true');
  assert.equal(windowStatus.textContent, 'Guest session ended.');
  assert.equal(reopened.terminated, 1);
  console.log(JSON.stringify({innerWindow: true, earlyOpenBlocked: true, focusReturned: true, oldFrameIgnored: true}));
  process.exit(0);
}
for (let n = 1; n <= 32; n++) {
  frame(first, n);
  assert.equal(draws.length, n);
  assert.equal(canvas.dataset.sequence, String(n));
}
assert.deepEqual(draws.at(-1), [32, 128]);
assert.equal(status.dataset.phase, 'frame');
assert.ok(controls.every(control => !control.disabled));
stop.click(false);
assert.deepEqual(first.sent.map(m => m.type), ['start']);
stop.click(true);
assert.equal(start.disabled, true);
start.click(true); // Prior Worker has yet to acknowledge retirement.
assert.equal(workers.length, 1);
await delay(0);
assert.equal(first.terminated, 1);
assert.equal(cleared, 1);
if (failure) {
  assert.equal(start.disabled, true);
  assert.equal(status.dataset.phase, 'error');
  assert.equal(status.textContent, 'Drawing view cleanup was not confirmed');
  assert.deepEqual(first.sent.map(m => m.type), ['start', 'retire']);
  assert.equal(workers.length, 1);
  console.log(JSON.stringify({clearFailed: true, workerRetired: true, newGenerationBlocked: true}));
  process.exit(0);
}
assert.equal(start.disabled, false);
start.click(false);
assert.equal(workers.length, 1);
start.click(true);
assert.equal(workers.length, 2);
const reopened = workers[1];
assert.notEqual(reopened, first);
assert.equal(canvas.dataset.sequence, undefined);
frame(first, 33);
assert.equal(draws.length, 32);
frame(reopened, 1);
assert.equal(draws.length, 33);
assert.equal(canvas.dataset.sequence, '1');
reopened.dispatchEvent(new MessageEvent('messageerror'));
await delay(0);
assert.equal(cleared, 2);
assert.equal(status.dataset.phase, 'error');
assert.equal(status.textContent, 'Guest Worker message could not be decoded');
assert.ok(controls.every(control => control.disabled));
assert.deepEqual(reopened.sent.map(m => m.type), ['start', 'retire']);
assert.equal(reopened.terminated, 1);
assert.equal(removedPagehide, 2);
assert.equal(start.disabled, true);
frame(reopened, 2);
reopened.receive({type: 'output', fd: 1, bytes: Uint8Array.of(120)});
assert.equal(draws.length, 33);
assert.equal(protocol.textContent, '');
console.log(JSON.stringify({deliveredDraws: 33, generations: 2, oldGenerationIgnored: true, retiredAfterMessageError: true}));
