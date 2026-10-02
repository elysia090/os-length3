/* Playground control boundary.
 *
 * Source execution is unavailable until the browser frontend and accepted-x86
 * lowering are connected to the compiled machine. Native post-link publication
 * does not by itself establish a runnable browser backend.
 * This worker never imports a language runtime, compiler wrapper, or alternate
 * WebAssembly executor. Keeping the UI responsive while the product gate is
 * red is preferable to silently reviving a second execution route.
 */

const unavailable = {
  message: 'browser execution is not connected yet',
  text: 'Run requires linked x86 -> optimized x86 -> Wasm -> VM. The native bundle is published; browser lowering and machine execution remain incomplete.',
};

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function ready() {
  post('ready', {
    capabilities: {
      versions: { qm: 'postlink-c' },
      frontend: 'linked-x86',
      execution: 'optimized-x86-vm',
      available: false,
    },
    compiler: null,
  });
}

function rejectSolve() {
  post('done', {
    has_main: false,
    run_ready: false,
    result: { ok: false, stage: 'browser', error: unavailable },
  });
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'boot') {
    ready();
    return;
  }
  if (message.type === 'solve') {
    rejectSolve();
    return;
  }
  if (message.type === 'exec') {
    post('ran', { result: { ok: false, error: unavailable.message } });
  }
};
