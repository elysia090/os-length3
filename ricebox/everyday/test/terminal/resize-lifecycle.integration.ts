import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker as NodeWorker, type Transferable} from 'node:worker_threads';
import type {GuestEvent} from '../wayland/support/worker-events.ts';

const {createRoot} = await import(import.meta.resolve('ricebox')) as typeof import('../../../distribution/runtime/root.ts');
const {shellStart} = await import(new URL('./shell-fixture.ts', import.meta.url).href) as typeof import('../wayland/browser/shell-fixture.ts');
type Event = GuestEvent | {type: 'test-winched' | 'test-interrupted'} | {type: 'test-root-exited'; stillLive: boolean};

// Run the actual installed Kernel/Worker. Synchronous probes make the two
// short lifecycle intervals observable without changing guest scheduling.
async function bootstrap() {
  const {parentPort: port, workerData} = await import('node:worker_threads');
  if (!port) throw new Error('The browser Worker fixture needs a parent port');
  function post(data: object) {
    if (!scope.onmessage) throw new Error('Root Worker did not register its receiver');
    void scope.onmessage({data});
  }
  function probe(request: number) {
    post({type: 'terminal-resize', request, cols: 93, rows: 31});
  }
  let testedDuringOutput = false;
  const sendInput = (text: string) => {
    post({type: 'input', bytes: new TextEncoder().encode(text)});
  };
  const scope = {
    onmessage: undefined as ((event: {data: object}) => unknown) | undefined,
    postMessage(value: GuestEvent, {transfer=[]}: {transfer?: Transferable[]} = {}) {
    if (value.type === 'terminal-geometry') {
      switch (workerData.mode) {
        case 'input-before-marker': sendInput('observe\n'); break;
        case 'drained-before-marker':
          // Let the actual guest sleep become due while the outward
          // marker has not been forwarded, then reenter with flow credit.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450);
          post({type: 'drained', n: 0});
          break;
        case 'interrupt-before-marker':
          sendInput('discard\n');
          post({type: 'interrupt', sig: 23, flush: 1});
          sendInput('observe\n');
          break;
        case 'retire-at-marker':
        case 'fail-marker': sendInput('arrived-before-closure\n'); break;
      }
    }
    port.postMessage(value, transfer);
    if (workerData.mode === 'missing-guest' && value.type === 'threads') probe(1);
    if (workerData.mode === 'background' && value.type === 'output' && !testedDuringOutput) {
      testedDuringOutput = true;
      probe(7); // Output has posted, but its byte prefix has not committed yet.
    }
    if (value.type === 'terminal-geometry' && workerData.mode === 'retire-at-marker') {
      post({type: 'retire'});
    }
    if (value.type === 'terminal-geometry' && workerData.mode === 'fail-marker') {
      throw new Error('Test geometry publication became uncertain');
    }
  }};
  Object.assign(globalThis, {self: scope});
  const url = new URL('../../sods/runtime/linux.js', workerData.entry);
  const {Kernel} = await import(url.href) as typeof import('../../../sods/runtime/linux.ts');
  if (workerData.mode === 'missing-guest') {
    const note = Kernel.prototype.noteRootConsoleChild;
    let observed = false;
    Kernel.prototype.noteRootConsoleChild = function (launcher, child) {
      note.call(this, launcher, child);
      if (!observed && this.initOf() === launcher && this.procs.get(child.pid) === child && launcher.children.has(child)) {
        observed = true;
        // A real direct child is now published but has not yet executed.
        probe(5);
      }
    };
  }
  if (['retire-at-marker', 'fail-marker', 'interrupt-before-marker'].includes(workerData.mode)) {
    const interrupt = Kernel.prototype.interrupt;
    Kernel.prototype.interrupt = function (sig) {
      if (sig === 28) port.postMessage({type: 'test-winched'});
      if (sig === 23) port.postMessage({type: 'test-interrupted'});
      return interrupt.call(this, sig);
    };
  }
  if (workerData.mode === 'background') {
    const end = Kernel.prototype.endTask;
    let observed = false;
    Kernel.prototype.endTask = function (task) {
      const p = task.proc, root = this.initOf();
      if (!observed && p.state === 'zombie' && p.argv?.at(-1) === workerData.script && root?.children.has(p)) {
        observed = true;
        // The owner has ended; normal PID-namespace cleanup has not yet
        // retired its children. Do not change either participant or delay exit.
        port.postMessage({type: 'test-root-exited',
          stillLive: [...p.children].some(child => child.state === 'live' && this.procs.get(child.pid) === child)});
        probe(3);
      }
      return end.call(this, task);
    };
  }
  await import(workerData.entry);
  port.on('message', post);
}
const bridge = new URL('data:text/javascript,' + encodeURIComponent('await (' + bootstrap.toString() + ')()'));
const entry = new URL('./worker.js', import.meta.resolve('ricebox')).href;
const args = process.argv.slice(2);
assert.equal(args.length, 3, 'pass TRANSLATOR_WASM MUK STATIC_BUSYBOX');
const [translator, muk, busybox] = args.map(path => new Uint8Array(readFileSync(path)));
const root = createRoot({
  base: '/fixture/', first: [], usedKey: 'terminal-resize-life-used', planKey: 'terminal-resize-life-plan',
  message: key => key, missing: () => 'No default root', errorText: String,
});
const scopeScript = "/bin/busybox sleep 30 & printf '<root-ready>\\n'; IFS= read -r line; exit";
const modes = ['broken-launcher', 'missing-guest', 'background', 'retire-at-marker', 'fail-marker'];
const reentryModes = ['input-before-marker', 'drained-before-marker', 'interrupt-before-marker'];
if (process.env.SODS_INLINE) modes.push(...reentryModes);
const encoder = new TextEncoder();
for (const mode of modes) {
  const before = mode === 'input-before-marker' ? 'IFS= read -r line;' : mode === 'drained-before-marker'
    ? '/bin/busybox sleep 0.3;' : '/bin/busybox sleep 1; IFS= read -r line;';
  const observe = "printf '<ioctl:%s>' \"$line\"; /bin/busybox stty size; IFS= read -r line; exit";
  const rootScript = reentryModes.includes(mode) ? "printf '<root-ready>\\n'; " + before + ' ' + observe :
    mode === 'fail-marker' ? "printf '<root-ready>\\n'; IFS= read -r line; " + observe : scopeScript;
  const OriginalWorker = globalThis.Worker;
  Object.assign(globalThis, {Worker: class {
    constructor(url: URL) {
      assert.equal(url.href, entry);
      return new NodeWorker(bridge, {workerData: {entry, mode, script: rootScript}});
    }
  }});
  let worker: NodeWorker;
  try { worker = root.rootWorker() as unknown as NodeWorker; }
  finally { globalThis.Worker = OriginalWorker; }

  const messages: Event[] = [], packets: Buffer[] = [], errors: unknown[] = [];
  worker.on('error', error => errors.push(error));
  worker.on('message', (m: Event) => {
    messages.push(m);
    if (m.type === 'output') {
      packets.push(Buffer.from(m.bytes));
      worker.postMessage({type: 'drained', n: m.bytes.length});
    }
  });
  async function until(label: string, ready: () => boolean) {
    const end = performance.now() + 8000;
    while (!ready()) {
      if (errors.length) throw new AggregateError(errors, label);
      if (performance.now() >= end) throw new Error(label + ': ' + JSON.stringify(messages.filter(m => m.type !== 'output')) + '\n' + Buffer.concat(packets));
      await delay(10);
    }
  }
  const ask = (request: number) => worker.postMessage({type: 'terminal-resize', request, cols: 93, rows: 31});
  const reply = (request: number) => messages.find((m): m is Extract<GuestEvent, {type: 'terminal-size'}> =>
    m.type === 'terminal-size' && m.request === request);
  const start = {...shellStart(translator, muk, busybox), cols: 53, rows: 12, terminalResize: true};
  const config = JSON.parse(start.box.config);
  if (mode === 'broken-launcher') start.muk = Uint8Array.of(0); // ordinary non-executable fixture
  if (mode === 'missing-guest') config.process.args = ['/bin/no-such-terminal-program'];
  if (mode !== 'broken-launcher' && mode !== 'missing-guest') {
    config.process.args = ['/bin/busybox', 'sh', '-c', rootScript];
  }
  start.box.config = JSON.stringify(config);
  try {
    worker.postMessage(start);
    if (reentryModes.includes(mode)) {
      await until('inline guest parked before resize', () => Buffer.concat(packets).includes('<root-ready>') &&
        messages.some(m => m.type === 'waiting' && m.for === (mode === 'input-before-marker' ? 'input' : 'time')));
      assert.equal(messages.find(m => m.type === 'threads')?.apart, false);
      ask(2);
      const observed = mode === 'drained-before-marker' ? '<ioctl:>31 93' : '<ioctl:observe>31 93';
      await until('actual ioctl output from resumed guest', () => !!reply(2) && Buffer.concat(packets).includes(observed));
      const markerAt = messages.findIndex(m => m.type === 'terminal-geometry');
      const outputAt = messages.findIndex(m => m.type === 'output' && Buffer.from(m.bytes).includes('31 93'));
      assert.ok(markerAt >= 0 && markerAt < outputAt);
      const marker = messages[markerAt];
      assert.equal(marker.type, 'terminal-geometry');
      assert.equal(marker.sentBytes,
        messages.slice(0, markerAt).reduce((count, m) => count + (m.type === 'output' ? m.bytes.length : 0), 0));
      if (mode === 'interrupt-before-marker') {
        const signalAt = messages.findIndex(m => m.type === 'test-interrupted');
        assert.ok(markerAt < signalAt && signalAt < outputAt);
        const output = messages[outputAt];
        assert.equal(output.type, 'output');
        assert.equal(output.epoch, 1);
        assert.ok(!Buffer.concat(packets).includes('<ioctl:discard>'));
      }
      worker.postMessage({type: 'retire'});
      await until('retirement after reentry test', () => messages.some(m => m.type === 'retiring'));
      assert.deepEqual(messages.find(m => m.type === 'retiring')?.failures, []);
      console.log(JSON.stringify({mode, markerAt, outputAt, afterCut: true}));
      continue;
    }
    if (mode === 'retire-at-marker' || mode === 'fail-marker') {
      await until('guest before marker', () => Buffer.concat(packets).includes('<root-ready>'));
      ask(2);
      await until('publication detached or failed', () => messages.some(m => m.type === 'terminal-geometry') &&
        messages.some(m => m.type === (mode === 'retire-at-marker' ? 'retiring' : 'error')));
      ask(4);
      await until('any resize after detach or publication failure is closed', () => !!reply(4));
      assert.equal(reply(4)?.error, 'closed');
      assert.equal(reply(2), undefined);
      assert.ok(!messages.some(m => m.type === 'test-winched'));
      if (mode === 'fail-marker') {
        worker.postMessage({type: 'input', bytes: encoder.encode('fresh-after-failure\n')});
        await until('later ordinary input still sees already applied geometry', () =>
          Buffer.concat(packets).includes('<ioctl:fresh-after-failure>31 93'));
        assert.ok(!Buffer.concat(packets).includes('<ioctl:arrived-before-closure>'));
        worker.postMessage({type: 'retire'});
      }
      await until('retirement after geometry test', () => messages.some(m => m.type === 'retiring'));
      assert.deepEqual(messages.find(m => m.type === 'retiring')?.failures, []);
      console.log(JSON.stringify({mode, suppressedSignal: true, laterResize: 'closed'}));
      continue;
    }
    if (mode === 'broken-launcher') {
      await until('real launcher load reported failure', () => messages.some(m => m.type === 'error'));
      ask(2);
      await until('resize after observed launcher failure refused', () => !!reply(2));
      assert.equal(reply(2)?.error, 'closed');
    } else {
      if (mode === 'missing-guest') {
        await until('pre-exec resize refused at launcher threads receipt and published child', () => !!reply(1) && !!reply(5));
        assert.equal(reply(1)?.error, 'inactive');
        assert.equal(reply(5)?.error, 'inactive');
      } else {
        await until('real root guest and background child started', () =>
          Buffer.concat(packets).includes('<root-ready>') && messages.some(m => m.type === 'waiting'));
        assert.equal(reply(7)?.error, 'busy');
        assert.ok(!messages.some(m => m.type === 'terminal-geometry' && m.request === 7));
        ask(2);
        await until('resize accepted while root guest lives', () => !!reply(2));
        assert.equal(reply(2)?.changed, true);
        worker.postMessage({type: 'input', bytes: encoder.encode('finish\n')});
        await until('root guest exit probe', () => !!reply(3));
        assert.equal(messages.find(m => m.type === 'test-root-exited')?.stillLive, true);
        assert.equal(reply(3)?.error, 'closed');
      }
      await until('Muk finished', () => messages.some(m => m.type === 'exit'));
      const exit = messages.find(m => m.type === 'exit');
      assert.ok(exit);
      assert.equal(exit.status === 0, mode === 'background');
      if (mode === 'background') {
        const closed = reply(3);
        assert.ok(closed && messages.indexOf(closed) < messages.findIndex(m => m.type === 'output-boundary'));
      }
      ask(4);
      await until('final output-closed resize refused', () => !!reply(4));
      assert.equal(reply(4)?.error, 'closed');
    }
    worker.postMessage({type: 'retire'});
    await until('retirement acknowledged', () => messages.some(m => m.type === 'retiring'));
    assert.deepEqual(messages.find(m => m.type === 'retiring')?.failures, []);
    console.log(JSON.stringify({mode, actualCpuWorker: messages.find(m => m.type === 'threads')?.apart,
      outcomes: messages.filter(m => m.type === 'terminal-size').map(m => m.error ?? 'applied')}));
  } finally { await worker.terminate(); }
}
