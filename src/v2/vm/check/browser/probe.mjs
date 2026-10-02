import { fixture } from './fixture.mjs';
import { inspectCapabilities } from './capabilities.mjs';

const output = document.getElementById('result');
const report = { format: 'browser-machine-boundary-probe-v1', linuxBoot: 'not-tested',
  secureContext: window.isSecureContext, isolated: window.crossOriginIsolated,
  capabilities: inspectCapabilities(window), workers: [], errors: [] };

function workerProbe(generation) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 10000);
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    worker.onmessage = ({ data }) => {
      if (data.generation !== generation) return;
      clearTimeout(timer);
      worker.terminate();
      data.ok ? resolve(data) : reject(new Error(data.error));
    };
    worker.postMessage({ generation });
  });
}

try {
  if (!window.isSecureContext) throw new Error('not a secure context');
  if (!WebAssembly.validate(fixture)) throw new Error('invalid Wasm ABI fixture');
  const response = await fetch('/probe.wasm', { headers: { Range: 'bytes=0-7' } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 206 || response.headers.get('content-range') !== `bytes 0-7/${fixture.length}`
      || bytes.length !== 8 || bytes.some((byte, i) => byte !== fixture[i])) {
    throw new Error('bounded byte-range transport failed');
  }
  report.range = '8 bytes / 206';
  report.workers.push(await workerProbe(1));
  report.workers.push(await workerProbe(2));
  report.workerLifecycle = 'terminated then fresh instance; RSS reclamation not measured';
  report.status = 'pass';
} catch (error) {
  report.status = 'fail';
  report.errors.push(String(error));
}
output.textContent = JSON.stringify(report, null, 2);
output.dataset.status = report.status;
document.title = `Browser boundary: ${report.status}`;
