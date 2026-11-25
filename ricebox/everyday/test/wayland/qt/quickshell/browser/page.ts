import {mountGuestSurface, surfaceFromMirror} from '../../../../../src/surface.ts';
import {lendRaster, rasterFile} from '../../../support/mirror-raster.ts';

const canvas = document.querySelector('canvas')!;
const mode = new URLSearchParams(location.search);
const pointer = mode.get('pointer') === '1';
const preparedDiagnostics = pointer && mode.get('prepared-diagnostics') === '1';
const status = document.querySelector<HTMLElement>('#status')!;
const receipt = document.querySelector<HTMLElement>('#receipt')!;
const resize = document.querySelector<HTMLButtonElement>('#resize')!;
const close = document.querySelector<HTMLButtonElement>('#close')!;
const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
const source = surfaceFromMirror({worker, file: rasterFile, maxEncodedBytes: 16 + 64 * 48 * 4,
  decode(bytes) {
    const frame = lendRaster(bytes);
    return frame && {serial: frame.sequence, width: frame.width, height: frame.height, rgba: frame.pixels};
  },
  ...(pointer && {encodePointer: ({x, y}: {x: number; y: number}) => {
    status.dataset.pointerContacts = String(Number(status.dataset.pointerContacts ?? 0) + 1);
    return Uint8Array.of(1, x, y);
  }}),
  encodeResize: ({width, height}) => Uint8Array.of(2, width, height),
});
const surface = mountGuestSurface({canvas, source, viewport: document.querySelector<HTMLElement>('#viewport')!,
  limits: {width: 64, height: 48, bytes: 64 * 48 * 4}});

function finish(phase: 'closed' | 'error', message: string) {
  surface.close();
  worker.terminate();
  resize.disabled = close.disabled = true;
  status.dataset.phase = phase;
  status.textContent = message;
}
worker.addEventListener('message', ({data}) => {
  if (preparedDiagnostics && data.type === 'prepared-diagnostics')
    receipt.dataset.preparedDiagnostics = JSON.stringify(data.receipt);
  const frame = source.current;
  if (data.type === 'changes' && frame) {
    canvas.style.width = `${frame.width * 8}px`;
    canvas.style.height = `${frame.height * 8}px`;
    canvas.dataset.sequence = String(frame.serial);
    resize.disabled = pointer || frame.serial !== 1;
    close.disabled = false;
    status.dataset.phase = 'frame';
    status.textContent = `Guest frame ${frame.serial}`;
  }
  if (data.type === 'exit' || data.type === 'error') {
    receipt.textContent = [data.display, data.guest].filter(Boolean).join('\n');
    if (data.type === 'exit') {
      status.dataset.preparedReads = String(data.preparedReads);
      finish('closed', 'Guest owners retired');
    } else finish('error', data.message);
  }
});
worker.addEventListener('error', event => finish('error', event.message));
worker.addEventListener('messageerror', () => finish('error', 'Could not decode guest Worker message'));
resize.onclick = () => surface.resize(47, 19);
close.onclick = () => {
  resize.disabled = close.disabled = true;
  worker.postMessage({type: 'input', bytes: Uint8Array.of(3, 0, 0)});
};
window.addEventListener('pagehide', () => { surface.close(); worker.terminate(); }, {once: true});

void fetch('/pins.json').then(response => {
  if (!response.ok) throw new Error('Missing Quickshell fixture pins');
  return response.json();
}).then(pins => {
  if (pointer !== Object.hasOwn(pins, 'pointer.qml')) throw new Error('Quickshell fixture lane does not match its pins');
  worker.postMessage({type: 'start', pins, ...(preparedDiagnostics && {preparedDiagnostics})});
}).catch(error => finish('error', String(error)));
