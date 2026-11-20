import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker as NodeWorker} from 'node:worker_threads';
import {createRoot} from 'ricebox';
import {shellStart} from './shell-fixture.ts';

// Run from the fresh offline npm consumer, with its exact installed Worker.
const args = process.argv.slice(2);
assert.equal(args.length, 3, 'pass TRANSLATOR_WASM MUK STATIC_BUSYBOX');
const [translator, muk, busybox] = args.map(path => new Uint8Array(readFileSync(path)));
const entry = new URL('./worker.js', import.meta.resolve('ricebox')).href;
const bridge = new URL('data:text/javascript,' + encodeURIComponent([
  "import {parentPort, workerData} from 'node:worker_threads';",
  "globalThis.self = {postMessage(value, {transfer=[]}={}) {parentPort.postMessage(value, transfer);}};",
  "await import(workerData.entry);",
  "parentPort.on('message', data => self.onmessage({data}));",
].join('\n')));
const root = createRoot({
  base: '/fixture/', first: [], usedKey: 'everyday-terminal-test-used', planKey: 'everyday-terminal-test-plan',
  message: key => key, missing: () => 'No default root', errorText: String,
});
const OriginalWorker = globalThis.Worker;
globalThis.Worker = class {
  constructor(url) {
    assert.equal(url.href, entry);
    return new NodeWorker(bridge, {workerData: {entry}});
  }
};
let worker;
try { worker = root.rootWorker(); }
finally { globalThis.Worker = OriginalWorker; }

const messages = [], errors = [], output = [];
const encoder = new TextEncoder();
const send = text => worker.postMessage({type: 'input', bytes: encoder.encode(text)});
let received = 0;
const command = text => send(text + '\n');
const text = (epoch, from = 0) => Buffer.concat(output.slice(from)
  .filter(m => epoch === undefined || m.epoch === epoch).map(m => m.bytes)).toString('utf8');
const waits = (from, reason) => messages.slice(from).some(m => m.type === 'waiting' && m.for === reason);
const ICANON = 2, ECHO = 8;
worker.on('error', e => errors.push(e));
worker.on('message', msg => {
  messages.push(msg);
  if (msg.type === 'error') errors.push(new Error(msg.message));
  if (msg.type === 'output') {
    received += msg.bytes.length;
    if (received > 64 * 1024) {
      if (!errors.length) errors.push(new Error('Terminal fixture output exceeded its budget'));
      return;
    }
    output.push({...msg, bytes: Buffer.from(msg.bytes)});
    worker.postMessage({type: 'drained', n: msg.bytes.length});
  }
});
async function until(label, ready) {
  const deadline = performance.now() + 8000;
  while (!ready()) {
    if (errors.length) throw new AggregateError(errors, label + ': ' + text());
    if (performance.now() >= deadline) throw new Error('Timed out: ' + label + ': ' + text());
    await delay(10);
  }
  if (errors.length) throw new AggregateError(errors, label + ': ' + text());
}
const rawMode = m => m.type === 'tty' && (m.lflag & (ICANON | ECHO)) === 0;
const cookedMode = m => m.type === 'tty' && (m.lflag & (ICANON | ECHO)) === (ICANON | ECHO);
try {
  worker.postMessage({...shellStart(translator, muk, busybox), cols: 53, rows: 12});
  await until('real interactive prompt', () => waits(0, 'input') && text().includes('everyday$'));
  assert.equal(messages.find(m => m.type === 'threads')?.apart, true);

  const first = messages.length;
  command("printf '<size:%s>\\n' \"$(/bin/busybox stty size)\"; printf '\\033[31mtty-color\\033[0m\\n'");
  await until('guest ioctl geometry and literal ANSI output', () =>
    waits(first, 'input') && text().includes('<size:12 53>') && text().includes('\x1b[31mtty-color\x1b[0m'));

  const beforeRaw = messages.length;
  command("/bin/busybox stty -icanon -echo min 1 time 0; printf '<r%s>\\n' aw; " +
    "byte=$(/bin/busybox dd bs=1 count=1 2>/dev/null); /bin/busybox stty icanon echo; printf '<read:%s>\\n' \"$byte\"");
  await until('raw no-echo guest read blocks', () =>
    messages.slice(beforeRaw).some(rawMode) && text().includes('<raw>') && waits(beforeRaw, 'input'));
  const beforeKey = messages.length;
  send('q'); // Deliberately no Enter afterward.
  await until('one raw byte read and canonical mode restored', () => waits(beforeKey, 'input') &&
    messages.slice(beforeKey).some(cookedMode) && text().includes('<read:q>'));

  const beforeSleep = messages.length;
  command("printf '<s%s>\\n' leep; /bin/busybox sleep 30");
  await until('guest foreground sleep', () => text().includes('<sleep>') &&
    messages.slice(beforeSleep).some(m => m.type === 'waiting' && m.for === 'time' && m.ms >= 20_000));
  const beforeSignal = messages.length;
  worker.postMessage({type: 'interrupt', sig: 2, flush: 1});
  await until('Ctrl-C returned to a live prompt without waiting for sleep', () =>
    waits(beforeSignal, 'input') && text(1).includes('everyday$'));
  const beforeRecovery = messages.length;
  command("printf '<after:%s>\\n' \"$((6*7))\"");
  await until('the same shell is usable after Ctrl-C', () => waits(beforeRecovery, 'input') &&
    text(1).includes('<after:42>') && !text(0).includes('<after:42>'));

  command('exit');
  await until('guest exit', () => messages.some(m => m.type === 'exit'));
  assert.equal(messages.find(m => m.type === 'exit').status, 0);
  const boundary = messages.findIndex(m => m.type === 'output-boundary');
  assert.ok(boundary !== -1 && boundary < messages.findIndex(m => m.type === 'exit'));
  worker.postMessage({type: 'retire'});
  await until('root admission retirement', () => messages.some(m => m.type === 'retiring'));
  assert.deepEqual(messages.find(m => m.type === 'retiring').failures, []);
  assert.equal(messages[boundary].sentBytes, received);
  assert.ok(!messages.slice(boundary + 1).some(m => m.type === 'output'));
  console.log(JSON.stringify({
    installedRootWorker: true, actualCpuWorker: true, rows: 12, cols: 53,
    ansi: true, rawKeyWithoutEnter: 'q', canonicalRestored: true, recoveredAfterCtrlC: 42,
    outputBoundaryBytes: received, admissionRetired: true,
  }));
} finally { await worker.terminate(); }
