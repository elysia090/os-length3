// Disposable compiler residency. The LLVM core, its WASI instance memories,
// and the resource filesystem live only in this worker. The analysis worker
// retains the small compiled wasm result, never the compiler working set.

import { ClangDriver, ClangUnavailable } from './clang.js';

let clang = null;
let queue = Promise.resolve();

function serializableError(error) {
  return {
    message: String((error && error.message) || error),
    stderr: (error && error.stderr) || '',
    unavailable: error instanceof ClangUnavailable,
  };
}

async function handle(message) {
  if (!clang) clang = new ClangDriver(message.config || {});
  const progress = (text) => self.postMessage({
    type: 'progress', id: message.id, message: text,
  });

  try {
    if (message.action === 'load') {
      await clang.load(progress);
      self.postMessage({
        type: 'result', id: message.id, ok: true,
        result: { clang: clang.describe() },
      });
      return;
    }
    if (message.action !== 'wasm') return;

    const bytes = await clang.wasm(
      message.source || '', { opt: message.opt || '-O2' }, progress,
    );
    // A compiler driver may return a view into a larger allocation. Transfer
    // an exact result buffer so the compiler worker can release everything
    // else immediately when it is terminated.
    const wasm = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
      ? bytes : bytes.slice();
    self.postMessage({
      type: 'result', id: message.id, ok: true,
      result: { wasm, clang: clang.describe() },
    }, [wasm.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'result', id: message.id, ok: false,
      error: serializableError(error),
    });
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  queue = queue.then(() => handle(message));
};
