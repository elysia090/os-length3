import {canonicalPackedFileSet} from '../../../../../../distribution/format/executable-source.ts';
import {readReleaseIndex, releaseIndexAsset, type About} from '../../../../../../distribution/format/manifest.ts';
import {loadMappedCode} from '../../../../../../distribution/runtime/mapped-code.ts';
import {syncRange} from '../../../../../../distribution/runtime/pack-range.ts';
import {prepareTree} from '../../../../../../distribution/runtime/prepared-tree.ts';
import {rangeNow} from '../../../../../../sods/runtime/host.ts';
import {Kernel, Mirror, captureMappedLibraries, prepareMappedInitial} from '../../../../../../sods/runtime/linux.ts';
import {loadTranslator} from '../../../../../../sods/runtime/translate.ts';

const quickshell = '/usr/bin/quickshell', qml = '/etc/ricebox/shell.qml', pointerQml = '/etc/ricebox/pointer.qml';
const quickshellSha256 = '5f108683b0e292772cd7c0bb1ce0265e1c3257a3214ec5cb712d1fcad174779c';
const out = '/display-out', socket = '/run/user/0/wayland-0';
const decoder = new TextDecoder();
const send = (data: object, transfer: Transferable[] = []) => self.postMessage(data, {transfer});
type Command = {type: 'start'; pins: Record<string, string>} | {type: 'input'; bytes: Uint8Array};

function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const base = new URL('/', self.location.href);
const read = async (path: string) => {
  const response = await fetch(new URL(path, base));
  need(response.ok, `Cannot read Quickshell fixture ${path}`);
  return new Uint8Array(await response.arrayBuffer());
};
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const json = <T>(bytes: Uint8Array): T => JSON.parse(decoder.decode(bytes)) as T;

async function start(pins: Record<string, string>) {
  const pinned = async (path: string) => {
    const bytes = await read(path);
    need(pins[path] && await sha256(bytes) === pins[path], `Changed Quickshell fixture ${path}`);
    return bytes;
  };
  const [aboutBytes, wasm, muk, executable, utc, sourcesBytes] = await Promise.all([
    pinned('web/webroot.json'), pinned('sods.wasm'), pinned('muk'), pinned('listener'), pinned('utc'), pinned('guest-sources.json'),
  ]);
  const pointer = Object.hasOwn(pins, 'pointer.qml') ? await pinned('pointer.qml') : undefined;
  const about = json<About>(aboutBytes), asset = releaseIndexAsset(about), indexBytes = await pinned('web/' + asset.path);
  need(indexBytes.length === asset.size && pins['web/' + asset.path] === asset.sha256, 'Quickshell fixture index witness changed');
  const index = readReleaseIndex(indexBytes, about);
  const {main, interpreter, libraries, pin} = json<{main: string; interpreter: string; libraries: string[]; pin: string}>(sourcesBytes);
  need(main === quickshell && pin === quickshellSha256, 'Expected the official Quickshell fixture');
  const paths = canonicalPackedFileSet(index, [main, interpreter, ...libraries]);
  const range = syncRange(new URL('web/', base).href, rangeNow, new Map(index.packs.map(({name, bytes}) => [name, bytes])));
  const tree = prepareTree({muk, captureSources: paths, root: {index, reading: {range,
    decode: (bytes, size) => translate.unzstd(bytes, size), sha256: bytes => translate.sha256(bytes),
  }}});
  const {vfs} = tree;
  let preparedReads = 0;
  const mode = pins['prepared/index.json'] ? await loadMappedCode({...tree, generation: asset.sha256}, wasm,
    json(await pinned('prepared/index.json')), hash => {
      const request = new XMLHttpRequest();
      request.open('GET', new URL(`prepared/${hash}.wasm`, base), false);
      request.responseType = 'arraybuffer';
      request.send();
      if (request.status !== 200) return undefined;
      preparedReads++;
      return new Uint8Array(request.response as ArrayBuffer);
    }) : {translate: await loadTranslator(wasm), preparedCode: undefined};
  const {translate, preparedCode} = mode;
  if (pins['prepared/index.json']) need(preparedCode, 'Prepared Quickshell code does not match this root and translator');
  need(await sha256(new Uint8Array(vfs.readFile(quickshell))) === quickshellSha256, 'Quickshell executable pin changed');
  const [app, ld, ...deps] = paths.map(({origin}) => tree.sources.get(origin)!);
  vfs.mkdirp(out);
  vfs.writeFile('/usr/local/bin/wayland-listener', executable, 0o755);
  vfs.writeFile('/etc/localtime', utc);
  if (pointer) vfs.writeFile(pointerQml, pointer, 0o644);
  const mirror = new Mirror(vfs, out);
  let displayLog = '', guestLog = '', input: Uint8Array = new Uint8Array(0);
  const server = new Kernel({vfs, translate, console: {
    read(n) { if (!input.length) return null; const next = input.subarray(0, n); input = input.subarray(n); return next; },
    ready: () => input.length > 0, pending: () => input.length,
    write(_fd, bytes) { displayLog = (displayLog + decoder.decode(bytes)).slice(-4096); },
  }});
  const client = new Kernel({vfs, translate, mappedCodeBytes: 128 << 20, console: {
    read: () => null,
    write(_fd, bytes) { guestLog = (guestLog + decoder.decode(bytes)).slice(-4096); },
  }});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeBy = Infinity;
  const retire = () => {
    clearTimeout(timer);
    self.onmessage = null;
    try { if (client.status === null) client.halt(); }
    finally {
      try { if (server.status === null) server.halt(); }
      finally { range.clear(); }
    }
  };
  try {
    const listener = '/usr/local/bin/wayland-listener';
    server.start(listener, [listener, socket, out], []);
    need(server.pump().waiting && displayLog.includes('WAYLAND_LISTENER_READY'), 'The guest Wayland listener did not start');
    const env = ['PATH=/usr/bin', 'HOME=/root', 'LANG=C.UTF-8', 'XDG_RUNTIME_DIR=/run/user/0', 'TZ=UTC0',
      'QT_QPA_PLATFORM=wayland', 'WAYLAND_DISPLAY=wayland-0', 'QT_QUICK_BACKEND=software', 'QSG_INFO=1',
      'QT_WAYLAND_DISABLE_WINDOWDECORATION=1', 'QT_PLUGIN_PATH=/usr/lib/x86_64-linux-gnu/qt6/plugins',
      'QML_IMPORT_PATH=/usr/lib/x86_64-linux-gnu/qt6/qml'];
    const held = prepareMappedInitial(client, {path: main, argv: [main, '--no-color', '--path', pointer ? pointerQml : qml], env},
      {main: app, interpreter: ld, libraries: captureMappedLibraries(vfs, deps), preparedCode}, '/root');
    try { held.checkStart(); }
    catch (error) { held.discard(); throw error; }
    held.publishInitial();
    const process = client.initOf(), task = process?.own, memory = process?.memory;
    need(task && memory?.mappedVm, 'Quickshell did not start through the mapped VM');
    function pump() {
      clearTimeout(timer);
      try {
        const guest = client.pump(), display = server.pump();
        const changes = mirror.changes();
        if (changes) send({type: 'changes', ...changes}, changes.files.map(file => file.bytes.buffer as ArrayBuffer));
        if (guest.status !== undefined) need(guest.status === 0, `Quickshell returned ${guest.status}`);
        if (display.status !== undefined) need(display.status === 0, `Wayland listener returned ${display.status}`);
        if (guest.status === 0 && display.status === 0) {
          need(task!.dead && !process!.memory && memory!.users === 0 && !client.tasks.size && !server.tasks.size &&
            client.retireInitialMounts() && server.retireInitialMounts(), 'Guest owners were not fully retired');
          if (preparedCode) need(preparedReads, 'Quickshell did not request any prepared code');
          retire();
          send({type: 'exit', display: displayLog, guest: guestLog, preparedReads});
          return;
        }
        if (performance.now() >= closeBy) {
          const waits = (kernel: Kernel) => [...kernel.blocked].map(task => task.call?.nr).join(',');
          throw new Error(`Quickshell close timed out (client ${client.status ?? waits(client)}, display ${server.status ?? waits(server)})`);
        }
        timer = setTimeout(pump, 5);
      } catch (error) {
        try { retire(); }
        finally { send({type: 'error', message: String(error), display: displayLog, guest: guestLog}); }
      }
    }
    self.onmessage = ({data}: MessageEvent<Command>) => {
      if (data.type !== 'input' || !(data.bytes instanceof Uint8Array) || data.bytes.length !== 3 || input.length) return;
      if (data.bytes[0] === 3) closeBy = performance.now() + 8000;
      input = data.bytes;
      server.inputs = (server.inputs ?? 0) + 1;
      pump();
    };
    pump();
  } catch (error) { retire(); throw error; }
}

self.onmessage = ({data}: MessageEvent<Command>) => {
  if (data.type !== 'start') return;
  self.onmessage = null;
  void start(data.pins).catch(error => send({type: 'error', message: String(error)}));
};
