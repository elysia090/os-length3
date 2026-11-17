import {parentPort, workerData} from 'node:worker_threads';
import {IDLE, REQUEST, RETURN, LEAVE, MAX_SEQUENCE} from './protocol.ts';

const port = parentPort!;
const {module, memory, channel, stackPointer} = workerData as {module: WebAssembly.Module; memory: WebAssembly.Memory; channel: SharedArrayBuffer; stackPointer?: bigint};
const control = new Int32Array(channel, 0, 2), words = new BigUint64Array(channel, 8, 10);
const leave = {};
let ready = false, running = false, invocation = 0n, sequence = 0;
const denied = (): never => { throw new Error('Unsupported guest import or initialization call'); };
const instance = new WebAssembly.Instance(module, {env: {
  memory,
  syscall: (nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint) => {
    if (!ready || !running) return denied();
    if (sequence === MAX_SEQUENCE || Atomics.load(control, 0) !== IDLE) throw new Error('Guest request slot unavailable');
    const seq = ++sequence;
    words[0] = invocation; words[1] = nr; words[2] = a; words[3] = b;
    words[4] = c; words[5] = d; words[6] = e; words[7] = f;
    words[8] = next; words[9] = 0n;
    Atomics.store(control, 1, seq);
    Atomics.store(control, 0, REQUEST);
    port.postMessage({kind: 'request', sequence: seq, invocation});
    while (Atomics.load(control, 0) === REQUEST) Atomics.wait(control, 0, REQUEST);
    if (Atomics.load(control, 1) !== seq || words[0] !== invocation) throw new Error('Guest response identity mismatch');
    const state = Atomics.load(control, 0), value = words[9];
    Atomics.store(control, 0, IDLE);
    if (state === LEAVE) throw leave;
    if (state !== RETURN) throw new Error('Invalid guest response');
    return value;
  },
  trap: denied, div128: denied, clock: denied, fpu: denied, trace: denied, miss: denied,
  time: () => { if (!ready || !running) return denied(); return NaN; },
}});
const {run} = instance.exports;
if (typeof run !== 'function') throw new Error('Unsupported guest exports');
if (stackPointer !== undefined) {
  const rsp = instance.exports.r4;
  if (!(rsp instanceof WebAssembly.Global) || typeof rsp.value !== 'bigint') throw new Error('Unsupported guest stack register');
  rsp.value = stackPointer; // Immutable or incorrectly typed globals fail before ready.
}
ready = true;
port.on('message', (message: {kind: string; invocation: bigint; entry: bigint}) => {
  if (message.kind !== 'run' || running || invocation !== 0n || message.invocation <= 0n) throw new Error('Invalid guest invocation');
  invocation = message.invocation; running = true;
  let outcome: {kind: string; error?: unknown} = {kind: 'returned'};
  try { run(message.entry); }
  catch (error) { outcome = error === leave ? {kind: 'left'} : {kind: 'failed', error}; }
  finally { running = false; }
  // Only here is the guest Wasm stack known to have unwound.
  port.postMessage({kind: 'unwound', invocation, outcome: {...outcome, unwound: true}});
});
port.postMessage({kind: 'ready'});
