import {mountGuestSurface, type GuestSurfaceSource, type GuestSurfaceObserver} from '../../../src/surface.ts';
import {MirrorRaster} from '../support/mirror-raster.ts';
import {rasterStart} from './raster-fixture.ts';

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
async function load([name,expected]:readonly [string,string]): Promise<Uint8Array<ArrayBuffer>> {
  const response=await fetch('/fixture/'+name);
  if (!response.ok) throw new Error('Missing pinned fixture '+name);
  const bytes=await response.arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
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
  const [translator,muk,elf] = await Promise.all([load(manifest.translator),load(manifest.muk),load(manifest.elf)]);
  const worker = new Worker(new URL('../../../../distribution/runtime/worker.ts',import.meta.url),{type:'module'});
  const post = (bytes: Uint8Array) => worker.postMessage({type:'input',bytes});
  // This fixture alone knows its RBF1 file and control bytes. Neither the
  // mount nor another consumer of the Worker gets a display capability by default.
  const model = new MirrorRaster();
  let observer: GuestSurfaceObserver | undefined;
  const source: GuestSurfaceSource = {
    observe(next) { observer = next; return () => { observer = undefined; model.retire(); }; },
    pointer({x, y}) { post(Uint8Array.of(1, x, y)); },
    resize({width, height}) { post(Uint8Array.of(2, width, height)); },
  };
  let surface: ReturnType<typeof mountGuestSurface>;
  try { surface = mountGuestSurface({viewport, canvas, source, limits: {width:64, height:48, bytes:64*48*4}}); }
  catch (error) { worker.terminate(); throw error; }
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
    const frame = model.accept(msg);
    if (!frame || !observer?.frame({serial:frame.sequence, width:frame.width, height:frame.height, rgba:frame.pixels})) return;
    canvas.style.width = frame.width * 8 + 'px';
    canvas.style.height = frame.height * 8 + 'px';
    canvas.dataset.sequence = String(frame.sequence);
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
  catch (error) { surface.close(); stop(false); throw error; }
}
void start().catch(error => report('error', String(error)));
