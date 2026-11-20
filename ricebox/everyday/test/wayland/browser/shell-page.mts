// Reference UI only: a bounded line console, not an ANSI terminal emulator.
import {retireRootWorker} from 'ricebox';
import {shellStart} from './shell-fixture.ts';

export function offerShell(section: HTMLElement, load: () => Promise<Uint8Array>,
  translator: Uint8Array, muk: Uint8Array, rootWorker: () => Worker): void {
  const open = section.querySelector<HTMLButtonElement>('#shell-open')!;
  const status = section.querySelector<HTMLElement>('#shell-status')!;
  const output = section.querySelector<HTMLElement>('#shell-output')!;
  const form = section.querySelector<HTMLFormElement>('form')!;
  const line = form.querySelector<HTMLInputElement>('input')!;
  const send = form.querySelector<HTMLButtonElement>('button')!;
  const out = new TextDecoder(), err = new TextDecoder(), encode = new TextEncoder();
  let worker: Worker | undefined, closing = false;

  function phase(state: string, text: string) {
    status.dataset.phase = state;
    status.textContent = text;
    line.disabled = send.disabled = state !== 'input';
  }
  async function retire() {
    if (closing) return;
    closing = true;
    open.disabled = true;
    const closingWorker = worker;
    worker = undefined;
    closingWorker?.removeEventListener('message', hear);
    closingWorker?.removeEventListener('error', failed);
    closingWorker?.removeEventListener('messageerror', failed);
    if (closingWorker) {
      const result = await retireRootWorker(closingWorker, 1000);
      if (result.admission !== 'acknowledged' || result.failures.length) {
        phase('error', 'Shell Worker retirement unconfirmed');
        return;
      }
    }
    if (status.dataset.phase !== 'error') phase('closed', 'Shell admission closed');
  }
  function failed() { phase('error', 'Guest shell Worker failed'); void retire(); }
  function hear(event: MessageEvent) {
    const msg = event.data;
    if (msg?.type === 'error') { failed(); return; }
    if (msg?.type === 'output' && msg.bytes instanceof Uint8Array) {
      output.textContent = (output.textContent + (msg.fd === 2 ? err : out).decode(msg.bytes, {stream: true})).slice(-8192);
      worker?.postMessage({type: 'drained', n: msg.bytes.length});
    }
    if (msg?.type === 'waiting') phase(msg.for === 'input' ? 'input' : 'running', 'Guest shell');
    if (msg?.type === 'exit') {
      if (msg.status !== 0) phase('error', 'Guest shell exited with status ' + String(msg.status));
      else phase('closing', 'Closing guest shell');
      void retire();
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (closing || !worker || line.disabled) return;
    const bytes = encode.encode(line.value + '\n');
    line.value = '';
    phase('running', 'Guest shell');
    try { worker.postMessage({type: 'input', bytes}); } catch { failed(); }
  };
  open.onclick = async () => {
    if (closing || open.disabled) return;
    open.disabled = true;
    phase('loading', 'Opening guest shell');
    try {
      const busybox = await load();
      if (closing) return;
      worker = rootWorker();
      worker.addEventListener('message', hear);
      worker.addEventListener('error', failed);
      worker.addEventListener('messageerror', failed);
      worker.postMessage(shellStart(translator, muk, busybox));
    } catch { failed(); }
  };
  window.addEventListener('pagehide', () => { void retire(); }, {once: true});
  section.hidden = false;
}
