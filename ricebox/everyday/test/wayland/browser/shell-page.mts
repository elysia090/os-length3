// Reference: a line console by default or an explicitly opted-in VT view.
import {retireRootWorker} from 'ricebox';
import {shellStart} from './shell-fixture.ts';
import type {mountTerminal} from './terminal-view.mts';
import type {TerminalPost} from './terminal-input.mts';
import type {ResizeRequest} from './terminal-resize.mts';

export function offerShell(section: HTMLElement, load: (signal: AbortSignal) => Promise<Uint8Array>,
  translator: Uint8Array, muk: Uint8Array, rootWorker: () => Worker,
  createTerminal?: typeof mountTerminal, fit = false): void {
  const open = section.querySelector<HTMLButtonElement>('#shell-open')!;
  const status = section.querySelector<HTMLElement>('#shell-status')!;
  const output = section.querySelector<HTMLElement>('#shell-output')!;
  const form = section.querySelector<HTMLFormElement>('form')!;
  const line = form.querySelector<HTMLInputElement>('input')!;
  const send = form.querySelector<HTMLButtonElement>('button')!;
  const out = new TextDecoder(), err = new TextDecoder(), encode = new TextEncoder();
  let worker: Worker | undefined, closing = false;
  const loading = new AbortController();
  function post(data: TerminalPost | ResizeRequest | {type: 'drained'; n: number}) {
    if (closing) return;
    try { worker?.postMessage(data); } catch { failed(); }
  }
  const terminal = createTerminal?.(section, output, line, send, post, failed, fit ? {
    post,
    fail: () => { phase('error', 'Guest terminal resize could not be verified'); void retire(); },
  } : undefined);

  function phase(state: string, text: string) {
    status.dataset.phase = state;
    status.textContent = text;
    if (terminal) terminal.phase(state);
    else line.disabled = send.disabled = state !== 'input';
  }
  async function retire() {
    if (closing) return;
    closing = true;
    open.disabled = true;
    open.onclick = form.onsubmit = null;
    window.removeEventListener('pagehide', onPageHide);
    loading.abort();
    try { terminal?.close(); } catch { phase('error', 'Guest terminal view failed'); }
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
      try {
        if (terminal) terminal.output(msg.bytes, msg.epoch);
        else output.textContent = (output.textContent + (msg.fd === 2 ? err : out).decode(msg.bytes, {stream: true})).slice(-8192);
        post({type: 'drained', n: msg.bytes.length});
      } catch { failed(); return; }
    }
    if (msg?.type === 'terminal-geometry') terminal?.resize?.marker(msg);
    if (msg?.type === 'terminal-size') terminal?.resize?.reply(msg);
    if (msg?.type === 'output-boundary' && terminal) {
      try { terminal.seal(msg.sentBytes); }
      catch { phase('error', 'Guest terminal output was incomplete'); void retire(); return; }
      phase('closing', 'Closing guest shell');
    }
    if (msg?.type === 'tty') terminal?.mode(msg);
    if (msg?.type === 'waiting' && !terminal?.sealed) {
      if (terminal) status.dataset.wait = msg.for;
      phase(msg.for === 'input' ? 'input' : 'running', 'Guest shell');
    }
    if (msg?.type === 'exit') {
      if (terminal && !terminal.sealed) phase('error', 'Guest terminal output ended without a boundary');
      else if (msg.status !== 0) phase('error', 'Guest shell exited with status ' + String(msg.status));
      else phase('closing', 'Closing guest shell');
      void retire();
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (closing || !worker || send.disabled) return;
    try { terminal?.echoCooked(line.value); } catch { failed(); return; }
    const bytes = encode.encode(line.value + '\n');
    line.value = '';
    if (terminal) delete status.dataset.wait;
    phase('running', 'Guest shell');
    post({type: 'input', bytes});
  };
  open.onclick = async () => {
    if (closing || open.disabled) return;
    open.disabled = true;
    phase('loading', 'Opening guest shell');
    try {
      const busybox = await load(loading.signal);
      if (closing) return;
      worker = rootWorker();
      worker.addEventListener('message', hear);
      worker.addEventListener('error', failed);
      worker.addEventListener('messageerror', failed);
      const start = shellStart(translator, muk, busybox);
      if (terminal) worker.postMessage({...start, cols: terminal.cols, rows: terminal.rows,
        ...(terminal.resize && {terminalResize: true})});
      else worker.postMessage(start);
    } catch { if (!closing) failed(); }
  };
  function onPageHide() { void retire(); }
  window.addEventListener('pagehide', onPageHide, {once: true});
  section.hidden = false;
}
