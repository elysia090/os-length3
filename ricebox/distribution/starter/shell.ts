// Static shell, with no server command endpoint and no drawing imports.
import type {Box, createRoot, retireRootWorker as retire} from '../runtime/root.ts';

const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = get('status'), open = get<HTMLButtonElement>('open'), end = get<HTMLButtonElement>('end');
const output = get('output'), form = get<HTMLFormElement>('command');
const line = get<HTMLInputElement>('line'), send = get<HTMLButtonElement>('send');
const base = new URL('../../../ricebox/', import.meta.url).href;
const prefix = 'ricebox-shell:' + base;
const prompt = 'ricebox$ ';
const outputLimit = 8192;

type Phase = 'loading' | 'input' | 'running' | 'closing' | 'closed' | 'error';
type GuestMessage =
  | {type: 'output'; fd: number; bytes: Uint8Array}
  | {type: 'waiting'; for: string}
  | {type: 'output-boundary'; sentBytes: number}
  | {type: 'error'; message: unknown}
  | {type: 'exit'; status: number};
interface Attempt {
  stage: string;
  timer?: ReturnType<typeof setTimeout>;
  worker?: Worker;
  hear?: (event: MessageEvent<GuestMessage | null>) => void;
  failed?: () => void;
  ready: boolean;
  received: number;
  boundary: boolean;
}
let attempt: Attempt | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let retireRootWorker: typeof retire | undefined;

function phase(at: Phase, message: string) {
  status.dataset.phase = at;
  status.textContent = message;
  // Keep keyboard focus on an already focused command field while it is running.
  // Startup must not take focus from the hosting page.
  line.disabled = at !== 'input' && at !== 'running';
  line.readOnly = at !== 'input';
  send.disabled = at !== 'input';
}
function detail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function append(text: string) {
  if (!text) return;
  const following = output.scrollHeight - output.scrollTop - output.clientHeight <= 2;
  const latest = (output.textContent + text).slice(-outputLimit);
  // If the retained slice starts halfway through a Unicode character, drop that half.
  output.textContent = /^[\uDC00-\uDFFF]/.test(latest) ? latest.slice(1) : latest;
  if (following) output.scrollTop = output.scrollHeight;
}
const box: Box = {
  config: JSON.stringify({
    ociVersion: '1.0.2',
    process: {args: ['/usr/bin/busybox', 'sh', '-i'], cwd: '/', noNewPrivileges: true,
      env: ['PATH=/usr/bin:/bin', 'HOME=/', 'TERM=dumb', 'PS1=' + prompt]},
    root: {path: '/', readonly: true},
    linux: {
      namespaces: ['pid', 'network', 'ipc', 'uts', 'mount', 'user'].map(type => ({type})),
      uidMappings: [{containerID: 0, hostID: 0, size: 1}],
      gidMappings: [{containerID: 0, hostID: 0, size: 1}],
    },
  }),
  words: ['run', '--lend', '/', '--ids', '0-0', '-b', '/run/box', 'shell'],
};

async function close(current: Attempt, at: 'closed' | 'error', message: string) {
  if (attempt !== current) return;
  attempt = undefined; // Late fetches or Worker messages cannot reopen this guest.
  clearTimeout(current.timer);
  end.disabled = true;
  if (current.worker && retireRootWorker) {
    phase('closing', 'Closing guest shell…');
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
  open.disabled = false;
}

async function start() {
  if (attempt || open.disabled) return;
  const current: Attempt = {stage: 'runtime module', ready: false, received: 0, boundary: false};
  attempt = current;
  open.disabled = true;
  end.disabled = false;
  output.textContent = line.value = '';
  phase('loading', 'Loading Ricebox runtime…');
  current.timer = setTimeout(() => {
    void close(current, 'error', `Shell startup timed out at ${current.stage}. Check the staged files and browser console.`);
  }, 30_000);
  try {
    if (!root) {
      const runtime = await import('../runtime/root.ts');
      if (attempt !== current) return;
      retireRootWorker = runtime.retireRootWorker;
      root = runtime.createRoot({base, first: ['/usr/bin/busybox'],
        usedKey: prefix + ':used', planKey: prefix + ':plan',
        message: key => key,
        missing: () => 'Missing or invalid ricebox/webroot.json; serve the whole staged directory.',
        errorText: detail});
    }
    current.stage = 'prepared root';
    phase('loading', 'Checking guest assets…');
    const ready = await root.execution.load();
    if (attempt !== current) return;
    if (!ready.muk) throw new Error('Missing or unreadable ricebox/muk.json; stage the release again.');
    current.stage = 'first guest prompt';
    phase('loading', 'Starting the Linux guest…');
    const worker = current.worker = root.rootWorker();
    const stdout = new TextDecoder(), stderr = new TextDecoder();
    const fail = (message: string) => { void close(current, 'error', message); };
    const failed = current.failed = () => fail('The guest Worker failed. Check the staged module files, JavaScript MIME types and browser console.');
    const hear = current.hear = ({data}: MessageEvent<GuestMessage | null>) => {
      if (attempt !== current) return;
      if (data?.type === 'output') {
        if (current.boundary || !(data.bytes instanceof Uint8Array)) { fail('Invalid guest output.'); return; }
        current.received += data.bytes.length;
        append((data.fd === 2 ? stderr : stdout).decode(data.bytes, {stream: true}));
        try { worker.postMessage({type: 'drained', n: data.bytes.length}); } catch { failed(); }
      } else if (data?.type === 'waiting' && data.for === 'input' && !current.boundary) {
        if (!current.ready) {
          if (!output.textContent.includes(prompt)) return;
          current.ready = true;
          clearTimeout(current.timer);
        }
        phase('input', 'Guest shell is ready for a command.');
      } else if (data?.type === 'output-boundary') {
        if (current.boundary || data.sentBytes !== current.received) { fail('Guest output ended before it was fully received.'); return; }
        current.boundary = true;
        append(stdout.decode());
        append(stderr.decode());
        phase('closing', 'Guest shell is exiting…');
      } else if (data?.type === 'error') {
        fail('The Linux guest failed: ' + String(data.message));
      } else if (data?.type === 'exit') {
        if (!current.boundary) fail('Guest output ended without confirmation.');
        else if (data.status === 0 && current.ready) void close(current, 'closed', 'Guest shell ended.');
        else fail(`The Linux guest exited (wait status ${data.status}).`);
      }
    };
    worker.addEventListener('message', hear);
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.postMessage({type: 'start', cwd: '/', box, screen: true,
      profile: ready.profile, generation: ready.generation, executables: root.execution.executablesNow(ready),
      translator: ready.translator, muk: ready.muk, root: {index: ready.index, url: ready.url}});
  } catch (error) {
    void close(current, 'error', `Could not start the shell (${current.stage}): ${detail(error)}`);
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!event.isTrusted || send.disabled || !attempt?.worker) return;
  const current = attempt;
  const worker = current.worker!;
  // Terminal Enter is CR: the guest line discipline translates it when it is cooked,
  // while a raw shell line editor receives the actual Enter key.
  const bytes = new TextEncoder().encode(line.value + '\r');
  line.value = '';
  if (document.activeElement === send) line.focus({preventScroll: true});
  phase('running', 'Guest command is running…');
  try { worker.postMessage({type: 'input', bytes}); } catch { current.failed?.(); }
});
open.addEventListener('click', event => { if (event.isTrusted) void start(); });
end.addEventListener('click', event => {
  if (event.isTrusted && attempt) void close(attempt, 'closed', 'Guest shell ended.');
});
window.addEventListener('pagehide', () => {
  if (attempt) void close(attempt, 'closed', 'Guest shell ended.');
});
if (globalThis.isSecureContext && typeof Worker === 'function' && typeof WebAssembly === 'object') {
  open.disabled = false;
  // This dedicated page (or iframe) is the explicit mount. Do not move focus.
  void start();
} else {
  phase('error', 'Use a browser with module Workers and WebAssembly over HTTPS or loopback HTTP.');
}
