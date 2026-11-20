import {createRoot} from 'ricebox';
import {mountGuestSurface, surfaceFromMirror} from 'ricebox/everyday';
import {decodeRaster, rasterFile} from '../support/mirror-raster.ts';
import {rasterStart} from './raster-fixture.ts';
import {offerShell} from './shell-page.mts';
import {placeCamera} from './camera-placement.mts';

function required<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error('Missing fixture control '+selector);
  return found;
}
const status = required('#status'), viewport = required('#camera'), canvas = required<HTMLCanvasElement>('canvas');
const protocol = required('#protocol');
const decoder = new TextDecoder();
const controls = ['pan','host-resize','guest-resize','quit'].map(id => required<HTMLButtonElement>('#'+id));
const [pan,hostResize,guestResize,quit] = controls;
async function load([name,expected]:readonly [string,string], signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response=await fetch('/fixture/'+name,{signal});
  if (!response.ok) throw new Error('Missing pinned fixture '+name);
  const bytes=await response.arrayBuffer();
  signal?.throwIfAborted();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  signal?.throwIfAborted();
  if (hash!==expected) throw new Error('Unexpected fixture bytes '+name);
  return new Uint8Array(bytes);
}
function report(phase: 'frame' | 'closed' | 'error', detail: string) {
  if (status.dataset.phase === 'error' && phase === 'closed') return;
  status.textContent = detail;
  status.dataset.phase = phase;
  for (const button of controls) button.disabled = phase !== 'frame';
}

type Pin = [string,string];
function pin(value: unknown, file: string): value is Pin {
  return Array.isArray(value) && value.length===2 && value[0]===file &&
    typeof value[1]==='string' && /^[0-9a-f]{64}$/.test(value[1]);
}
async function start() {
  const response = await fetch('/fixture/pins.json');
  if (!response.ok) throw new Error('Missing private fixture pins');
  const manifest = await response.json();
  if (!manifest || !pin(manifest.translator,'sods.wasm') || !pin(manifest.muk,'muk') ||
      !pin(manifest.elf,'wayland-presenter')) throw new Error('Invalid fixture pins');
  const shell = pin(manifest.shell,'busybox') ? manifest.shell : null;
  const profile = new URLSearchParams(location.search);
  if (profile.get('scrollbars') === 'hairline') viewport.dataset.scrollbars = 'hairline';
  let displayPin = manifest.elf;
  if (profile.get('surface') === 'alpha') {
    if (!pin(manifest.alpha,'wayland-alpha-presenter')) throw new Error('No staged Wayland alpha guest');
    displayPin = manifest.alpha;
  }
  const [translator,muk,elf] = await Promise.all([load(manifest.translator),load(manifest.muk),load(displayPin)]);
  // The caller owns the pinned fixture assets; use the installed package to
  // make both standard Workers without loading a default distribution.
  const root = createRoot({base:'/fixture/', first:[], usedKey:'everyday-proof-used',
    planKey:'everyday-proof-plan', message:key=>key, missing:()=> 'No default root',
    errorText:error=>String(error)});
  if (shell) {
    const section = required('#shell'), asset = shell;
    const overSurface = profile.get('surface') === 'alpha' && profile.get('over') === 'shell';
    const fit = !overSurface && profile.get('terminalResize') === 'fit';
    function setupShell(terminal?: Parameters<typeof offerShell>[5], fallback = false) {
      try {
        offerShell(section, signal => load(asset, signal), translator, muk, root.rootWorker, terminal, fit);
        if (fallback) required('#shell-status').textContent = 'Terminal view unavailable; the line console is available.';
        if (overSurface) {
          // The controls stay in their own section and never share guest input.
          const stage = required('#stage'), transcript = required('#shell-output');
          const padding = getComputedStyle(stage);
          stage.style.position = 'relative';
          Object.assign(transcript.style, {position:'absolute', top:padding.paddingTop,
            left:padding.paddingLeft, margin:'0', pointerEvents:'none'});
          Object.assign(canvas.style, {position:'relative', zIndex:'1'});
          stage.prepend(transcript);
        }
      } catch {
        section.hidden = false;
        required<HTMLButtonElement>('#shell-open').disabled = true;
        const shellStatus = required('#shell-status');
        shellStatus.dataset.phase = 'error';
        shellStatus.textContent = 'Guest shell view is unavailable.';
      }
    }
    if (profile.get('terminal') === 'screen') {
      let departed = false;
      const pagehide = () => { departed = true; };
      window.addEventListener('pagehide',pagehide,{once:true});
      // The optional shell view loads independently of the Wayland display.
      void import('./terminal-view.mts').then(
        module => { if (!departed) setupShell(module.mountTerminal); },
        () => { if (!departed) setupShell(undefined, true); },
      ).finally(() => window.removeEventListener('pagehide',pagehide));
    } else setupShell();
  }
  const worker = root.rootWorker();
  const post = (bytes: Uint8Array) => worker.postMessage({type:'input',bytes});
  // Only this fixture knows its RBF1 format and control bytes.
  const source = surfaceFromMirror({worker, file:rasterFile, maxEncodedBytes:16+64*48*4,
    decode(bytes) {
      const frame = decodeRaster(bytes);
      return frame && {serial:frame.sequence, width:frame.width, height:frame.height, rgba:frame.pixels};
    },
    encodePointer: ({x, y}) => Uint8Array.of(1, x, y),
    encodeResize: ({width, height}) => Uint8Array.of(2, width, height),
  });
  let surface: ReturnType<typeof mountGuestSurface>;
  try { surface = mountGuestSurface({viewport, canvas, source, limits: {width:64, height:48, bytes:64*48*4}}); }
  catch (error) { worker.terminate(); throw error; }
  const placement = profile.get('camera');
  let stopPlacement: (() => void) | undefined;
  try {
    if (placement === 'floating' || placement === 'pinned') {
      stopPlacement = placeCamera(required('#camera-pane'),required('#camera-toolbar'),
        required('#camera-handle'),required('#camera-pin'),placement);
    }
  } catch (error) { surface.close(); worker.terminate(); throw error; }
  let retiring = false, finished = false, timer: ReturnType<typeof setTimeout> | undefined;
  function stop(acknowledged: boolean) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    worker.removeEventListener('message', message);
    worker.removeEventListener('error', failed);
    worker.terminate();
    report('closed', acknowledged ? 'admission acknowledged' : 'worker terminated without acknowledgement');
  }
  function retire() {
    if (retiring || finished) return;
    retiring = true;
    stopPlacement?.();
    surface.close();
    for (const button of controls) button.disabled = true;
    timer = setTimeout(() => stop(false), 1000);
    try { worker.postMessage({type:'retire'}); }
    catch { stop(false); }
  }
  function message(ev: MessageEvent) {
    const msg = ev.data;
    if (msg?.type === 'retiring') {
      if (retiring) {
        if (msg.failures?.length) report('error', 'Guest admission closed with retirement errors');
        stop(true);
      }
      return;
    }
    if (retiring) return;
    if (msg?.type === 'error') { report('error', String(msg.message)); retire(); return; }
    if (msg?.type === 'output' && msg.bytes instanceof Uint8Array) {
      protocol.textContent=(protocol.textContent+decoder.decode(msg.bytes,{stream:true})).slice(-4096);
      worker.postMessage({type:'drained', n:msg.bytes.length});
    }
    if (msg?.type === 'waiting' && msg.for === 'input') status.dataset.wait = 'input';
    if (msg?.type === 'exit') {
      if (msg.status !== (37 << 8)) report('error', 'Unexpected guest exit ' + String(msg.status));
      retire();
      return;
    }
    const frame = source.current;
    if (msg?.type !== 'changes' || !frame || frame.serial === Number(canvas.dataset.sequence)) return;
    canvas.style.width = frame.width * 8 + 'px';
    canvas.style.height = frame.height * 8 + 'px';
    canvas.dataset.sequence = String(frame.serial);
    report('frame', 'Guest raster ' + frame.width + '×' + frame.height);
  }
  function failed(event: ErrorEvent) { report('error', event.message); retire(); }
  pan.onclick = () => { if (!retiring) viewport.scrollTo(48,36); };
  hostResize.onclick = () => { viewport.style.width='270px'; viewport.style.height='208px'; };
  guestResize.onclick = () => surface.resize(47,19);
  quit.onclick = () => { if (!retiring) post(Uint8Array.of(3,0,0)); };
  worker.addEventListener('message', message);
  worker.addEventListener('error', failed);
  window.addEventListener('pagehide', retire, {once:true});
  try { worker.postMessage(rasterStart(translator,muk,elf)); }
  catch (error) { stopPlacement?.(); surface.close(); stop(false); throw error; }
}
void start().catch(error => report('error', String(error)));
