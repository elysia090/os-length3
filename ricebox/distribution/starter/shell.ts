// A single guest owner and one bounded terminal attachment. The staged plan is data,
// never a visitor command, a host shell, or a second guest.
import type {Box, createRoot, retireRootWorker as retire} from '../runtime/root.ts';
import {stagedPlan} from './plan.ts';
import {guestScreen} from '../../everyday/terminal/vt.ts';
import {ScreenView} from '../../everyday/terminal/vt-view.ts';

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = get('status'), open = get<HTMLButtonElement>('open'), end = get<HTMLButtonElement>('end');
const output = get('output'), line = get<HTMLInputElement>('line');
const site = new URL('../../../', import.meta.url);
const base = new URL('ricebox/', site).href;
const encode = new TextEncoder();

type Phase = 'loading' | 'attached' | 'closing' | 'closed' | 'error';
type Mode = {iflag: number; oflag: number; lflag: number};
type GuestMessage =
  | ({type: 'tty'} & Mode)
  | {type: 'output'; bytes: Uint8Array; epoch: number}
  | {type: 'waiting'; for: string}
  | {type: 'output-boundary'; sentBytes: number}
  | {type: 'error'; message: unknown}
  | {type: 'exit'; status: number};
interface Attempt {
  stage: string;
  timer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  worker?: Worker;
  hear?: (event: MessageEvent<GuestMessage | null>) => void;
  failed?: () => void;
  terminal?: ReturnType<typeof terminal>;
}
let attempt: Attempt | undefined;
let retireRootWorker: typeof retire | undefined;
const pageLifetime = new AbortController();
let page: {binding: string; root: ReturnType<typeof createRoot>} | undefined;
let reloadNeeded = false;
const ended = 'Guest admission closed.';

function phase(at: Phase, message: string) {
  status.dataset.phase = at;
  status.textContent = message;
  line.disabled = at !== 'attached';
}
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

function box(argv: string[]): Box {
  return {
    config: JSON.stringify({
      ociVersion: '1.0.2',
      process: {args: argv, cwd: '/', noNewPrivileges: true,
        env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/root', 'TERM=xterm']},
      root: {path: '/', readonly: true},
      mounts: [{destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'mode=1777', 'size=16m']}],
      linux: {
        namespaces: ['pid', 'network', 'ipc', 'uts', 'mount', 'user'].map(type => ({type})),
        uidMappings: [{containerID: 0, hostID: 0, size: 1}],
        gidMappings: [{containerID: 0, hostID: 0, size: 1}],
      },
    }),
    words: ['run', '--lend', '/', '--ids', '0-0', '-b', '/run/box', 'terminal'],
  };
}

const ICANON = 2, ISIG = 1, ICRNL = 0x100, OPOST = 1, ONLCR = 4, NOFLSH = 0x80;
const arrows: Readonly<Record<string, string>> = {ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D'};
const keyBytes = new Map([['Backspace', '\x7f'], ['Escape', '\x1b'], ['Delete', '\x1b[3~']]);
function terminal(current: Attempt, cols: number, rows: number) {
  const post = (data: object) => {
    if (attempt !== current) return;
    try { current.worker?.postMessage(data); } catch { current.failed?.(); }
  };
  const send = (text: string) => {
    const bytes = encode.encode(text);
    if (bytes.length && bytes.length <= 4096) post({type: 'input', bytes});
  };
  const model = guestScreen(cols, rows, send);
  const view = new ScreenView(model);
  view.element.setAttribute('aria-live', 'off');
  output.dataset.grid = cols + 'x' + rows;
  output.replaceChildren(view.element);
  view.draw();
  let frame = 0, received = 0, epoch = 0, lastTag = 0, sealed = false, composing = false;
  let decoder = new TextDecoder();
  let tty: Mode = {iflag: ICRNL, oflag: OPOST | ONLCR, lflag: ICANON | ISIG};
  const signal = current.abort.signal;
  const live = () => attempt === current && !line.disabled && !sealed;
  function draw() { frame = 0; view.draw(); }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => {
      try { draw(); } catch { current.failed?.(); }
    });
  }
  function commitText() {
    const text = line.value;
    line.value = '';
    if (live() && !/[\r\n]/.test(text)) send(text);
  }
  line.addEventListener('input', event => {
    if (event.isTrusted && !composing && !(event as InputEvent).isComposing) commitText();
  }, {signal});
  line.addEventListener('compositionstart', event => { if (event.isTrusted) composing = true; }, {signal});
  line.addEventListener('compositionend', event => {
    if (!event.isTrusted) return;
    composing = false;
    queueMicrotask(() => { if (!composing && live() && document.activeElement === line) commitText(); });
  }, {signal});
  line.addEventListener('blur', () => { composing = false; line.value = ''; }, {signal});
  line.addEventListener('paste', event => {
    if (!event.isTrusted || !live()) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (/[\r\n]/.test(text) && !model.bracketed) return;
    send(model.bracketed && text ? '\x1b[200~' + text + '\x1b[201~' : text);
  }, {signal});
  line.addEventListener('keydown', event => {
    if (!event.isTrusted || !live() || composing || event.isComposing || event.altKey || event.metaKey) return;
    if (event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === 'c') {
        event.preventDefault();
        if (tty.lflag & ISIG) {
          if (tty.lflag & NOFLSH) post({type: 'interrupt', sig: 2});
          else {
            decoder = new TextDecoder(); model.discardPartial();
            post({type: 'interrupt', sig: 2, flush: ++epoch});
          }
        } else if (!(tty.lflag & ICANON)) send('\x03');
      } else if (key === 'd' || key === 'l') {
        event.preventDefault();
        send(key === 'd' ? '\x04' : '\x0c');
      }
      return;
    }
    const direction = Object.hasOwn(arrows, event.key) ? arrows[event.key] : undefined;
    const bytes = direction ? '\x1b' + (model.appCursor ? 'O' : '[') + direction :
      event.key === 'Enter' ? (tty.lflag & ICANON || tty.iflag & ICRNL ? '\n' : '\r') : keyBytes.get(event.key);
    if (bytes !== undefined) { event.preventDefault(); send(bytes); }
  }, {signal});
  return {
    mode(next: Mode) {
      if (![next.iflag, next.oflag, next.lflag].every(Number.isSafeInteger)) throw new Error('Invalid guest terminal mode');
      tty = next;
      model.newline = !!(tty.oflag & OPOST) && !!(tty.oflag & ONLCR);
    },
    data(bytes: Uint8Array, tag: number) {
      if (sealed || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(tag) || tag < lastTag || tag > epoch) {
        throw new Error('Invalid guest terminal output');
      }
      lastTag = tag;
      received += bytes.length;
      if (!Number.isSafeInteger(received)) throw new Error('Guest output count overflow');
      if (tag === epoch) { model.write(decoder.decode(bytes, {stream: true})); schedule(); }
      post({type: 'drained', n: bytes.length});
    },
    seal(sentBytes: number) {
      if (sealed || sentBytes !== received) throw new Error('Guest terminal output was incomplete');
      sealed = true;
      model.write(decoder.decode());
      model.discardPartial();
      schedule();
    },
    get sealed() { return sealed; },
    close() {
      if (frame) cancelAnimationFrame(frame);
      line.value = '';
      draw();
    },
  };
}

async function close(current: Attempt, at: 'closed' | 'error', message: string) {
  if (attempt !== current) return;
  attempt = undefined; // A delayed fetch or event cannot reopen this guest.
  clearTimeout(current.timer);
  current.abort.abort();
  try { current.terminal?.close(); }
  catch { at = 'error'; message = 'The guest terminal could not finish drawing.'; }
  end.disabled = true;
  if (current.worker && retireRootWorker) {
    phase('closing', 'Closing the Linux guest…');
    if (current.hear) current.worker.removeEventListener('message', current.hear);
    if (current.failed) {
      current.worker.removeEventListener('error', current.failed);
      current.worker.removeEventListener('messageerror', current.failed);
    }
    const retired = await retireRootWorker(current.worker, 1000);
    if (retired.admission !== 'acknowledged' || retired.failures.length) {
      phase('error', message + ' Worker retirement was not confirmed. Reload before trying again.');
      return;
    }
  }
  phase(at, message);
  open.disabled = pageLifetime.signal.aborted || reloadNeeded;
}

async function start(automatic = false) {
  if (pageLifetime.signal.aborted || reloadNeeded || attempt || open.disabled) return;
  const current: Attempt = {stage: 'terminal declaration', abort: new AbortController()};
  attempt = current;
  open.disabled = true;
  end.disabled = false;
  output.textContent = line.value = '';
  delete output.dataset.grid;
  phase('loading', 'Reading the terminal configuration…');
  current.timer = setTimeout(() => {
    void close(current, 'error', `Terminal startup timed out at ${current.stage}.`);
  }, 30_000);
  try {
    const response = await fetch(new URL('ricebox-starter.json', site).href, {cache: 'no-store', signal: current.abort.signal});
    if (!response.ok) throw new Error(`ricebox-starter.json: ${response.status}`);
    const plan = stagedPlan(await response.json());
    if (attempt !== current) return;
    if (automatic && !plan.terminal.autoStart) {
      void close(current, 'closed', 'Ready to start a guest.');
      return;
    }
    current.stage = 'runtime module';
    phase('loading', 'Loading Ricebox runtime…');
    const runtime: {createRoot: typeof createRoot; retireRootWorker: typeof retire} = await import('../runtime/root.ts');
    if (attempt !== current) return;
    retireRootWorker = runtime.retireRootWorker;
    current.stage = 'prepared root';
    phase('loading', 'Checking guest assets…');
    const binding = JSON.stringify(plan);
    if (page && page.binding !== binding) {
      reloadNeeded = true;
      throw new Error('The staged declaration changed. Reload the page to use it.');
    }
    const prefix = 'ricebox-terminal:' + base;
    const {root} = page ??= {binding, root: runtime.createRoot({base, first: [plan.program],
      usedKey: prefix + ':used', planKey: prefix + ':plan', checkSignal: pageLifetime.signal, restCheckerAfterLoad: true,
      message: key => key, missing: () => 'Missing staged guest assets.', errorText: detail})};
    const ready = await root.execution.load();
    if (attempt !== current) return;
    if (ready.generation !== plan.generation || !ready.muk ||
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', ready.muk as BufferSource))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('') !== plan.makerSha256) {
      throw new Error('Guest assets do not match the staged declaration.');
    }
    if (attempt !== current) return;
    current.stage = 'terminal attachment';
    phase('loading', 'Starting the Linux guest…');
    const worker = current.worker = root.rootWorker();
    const {argv, cols, rows} = plan.terminal;
    const view = current.terminal = terminal(current, cols, rows);
    const fail = (message: string) => { void close(current, 'error', message); };
    const failed = current.failed = () => fail('The guest Worker failed.');
    function attach() {
      if (attempt === current && status.dataset.phase === 'loading') {
        clearTimeout(current.timer);
        phase('attached', 'Connected to the guest terminal.');
      }
    }
    const hear = current.hear = ({data}: MessageEvent<GuestMessage | null>) => {
      if (attempt !== current || !data) return;
      try {
        if (data.type === 'output') { view.data(data.bytes, data.epoch); attach(); }
        else if (data.type === 'tty') { view.mode(data); attach(); }
        else if (data.type === 'waiting' && data.for === 'input') attach();
        else if (data.type === 'output-boundary') { view.seal(data.sentBytes); phase('closing', 'Guest is exiting…'); }
        else if (data.type === 'error') fail('The Linux guest failed: ' + String(data.message));
        else if (data.type === 'exit') {
          if (!view.sealed) fail('Guest output ended without confirmation.');
          else if (data.status === 0) void close(current, 'closed', ended);
          else fail(`The Linux guest exited (wait status ${data.status}).`);
        }
      } catch (error) { fail(detail(error)); }
    };
    worker.addEventListener('message', hear);
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.postMessage({type: 'start', cwd: '/', box: box(argv), screen: true, cols, rows,
      profile: ready.profile, generation: ready.generation, executables: root.execution.executablesNow(ready),
      translator: ready.translator, muk: ready.muk, root: {index: ready.index, url: ready.url}});
  } catch (error) {
    void close(current, 'error', `Could not attach the terminal (${current.stage}): ${detail(error)}`);
  }
}

open.addEventListener('click', event => { if (event.isTrusted) void start(); });
end.addEventListener('click', event => { if (event.isTrusted && attempt) void close(attempt, 'closed', ended); });
window.addEventListener('pagehide', () => {
  pageLifetime.abort();
  open.disabled = true;
  if (attempt) void close(attempt, 'closed', ended + ' Reload to start a new guest.');
}, {once: true});
if (globalThis.isSecureContext && typeof Worker === 'function' && typeof WebAssembly === 'object') {
  open.disabled = false;
  void start(true); // The dedicated page or iframe is the explicit mount; never steal focus.
} else {
  phase('error', 'Use a browser with module Workers and WebAssembly over HTTPS or loopback HTTP.');
}
