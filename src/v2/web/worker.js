/* Playground control boundary.
 *
 * Source execution is deliberately unavailable until the C post-link compiler
 * is published as an accepted optimized ELF and lowered through the common VM.
 * This worker never imports a language runtime, compiler wrapper, or alternate
 * WebAssembly executor. Keeping the UI responsive while the product gate is
 * red is preferable to silently reviving a second execution route.
 */

const unavailable = {
  message: 'native post-link emission is not published yet',
  text: 'Run requires linked x86 -> optimized x86 -> VM. The native emitter is still the active publication gate.',
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
    result: { ok: false, stage: 'postlink', error: unavailable },
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
