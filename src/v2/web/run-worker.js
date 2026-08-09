// Disposable execution residency. The driver and vm.wasm share this worker so
// a minimized-kernel call remains wasm-to-wasm. Terminating the worker releases
// its WebAssembly.Memory; the analysis worker keeps only rebuildable inputs.

import { prepareEvaluator } from './vm.js';

const EXEC_LIMIT = 1 << 20;
let activeSource = null;
let evaluator = null;
let io = null;

// Tell the parent that the module worker itself is warm. vm.wasm is not
// instantiated here: an idle standby has no WebAssembly.Memory to retain.
self.postMessage({ type: 'ready' });

function environment() {
  return {
    qm_getchar: () => (
      io && io.at < io.stdin.length ? io.stdin[io.at++] : -1
    ),
    qm_putchar: (value) => {
      if (!io || io.out.length >= EXEC_LIMIT) {
        if (io) io.overflowed = true;
        return;
      }
      io.out.push(value & 255);
    },
  };
}

async function execute(message) {
  const prepareStarted = performance.now();
  const env = environment();
  if (message.plan && message.artifact) {
    if (activeSource !== message.source || !evaluator) {
      evaluator = await prepareEvaluator(
        message.artifact, message.plan, message.vmModule,
      );
      activeSource = message.source;
    }
    env[message.plan.import_function || message.plan.function] = evaluator.fn;
  } else {
    evaluator = null;
    activeSource = message.source;
  }

  io = {
    stdin: new TextEncoder().encode(message.stdin || ''),
    at: 0,
    out: [],
    overflowed: false,
  };
  const callsBefore = evaluator ? evaluator.calls() : 0;
  const runStarted = performance.now();
  try {
    const { instance } = await WebAssembly.instantiate(message.wasm, { env });
    if (typeof instance.exports.main !== 'function') {
      return { ok: false, error: 'the paste defines no main to run' };
    }
    const code = instance.exports.main();
    if (evaluator && !evaluator.ok()) {
      evaluator = null;
      activeSource = null;
      return { ok: false, error: 'the minimized artifact refused an input' };
    }
    const text = new TextDecoder().decode(new Uint8Array(io.out))
      + (io.overflowed ? '\n[output truncated]\n' : '');
    return {
      ok: true,
      stdout: text,
      code: Number(code) || 0,
      ran: evaluator ? evaluator.calls() - callsBefore : 0,
      elapsed_ms: performance.now() - runStarted,
      prepare_ms: runStarted - prepareStarted,
    };
  } finally {
    io = null;
  }
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'exec') return;
  let result;
  try {
    result = await execute(message);
  } catch (error) {
    result = { ok: false, error: String((error && error.message) || error) };
  }
  self.postMessage({ id: message.id, result });
};
