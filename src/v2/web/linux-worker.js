// Disposable browser host for the existing Linux-in-WebAssembly machine.
//
// The compact LKL module is decoded by kernel.browser. Reached basic blocks
// become QM state-step pages; this worker supplies only external barrier
// events. Root images stay as Blob/HTTP range sources and only requested
// 4 KiB pages cross into Python memory.

import {
  executePureStateStepLoaded,
  load as loadVM,
  mixSpongeRecordsLoaded,
  release as releaseVM,
} from './vm.js';
import { openPageBundle } from './page-fabric.js';

const PYODIDE_VERSIONS = [
  'https://cdn.jsdelivr.net/npm/pyodide@314.0.3/',
  'https://unpkg.com/pyodide@314.0.3/',
  'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/',
];

const BLOCK_PAGE_SIZE = 4096;
let pyodide = null;
let loading = null;
let manifest = null;
const roots = new Map();
const architectures = new Map();
const x86StepPages = [];
const x86StepTokens = new Map();

function send(type, payload = {}) {
  self.postMessage(Object.assign({ type }, payload));
}

async function loadRuntime(id) {
  if (pyodide) return pyodide;
  if (loading) return loading;
  loading = (async () => {
    let lastError = null;
    for (const indexURL of PYODIDE_VERSIONS) {
      try {
        send('progress', { id, message: `loading Linux runtime from ${new URL(indexURL).host}…` });
        const mod = await import(/* webpackIgnore: true */ `${indexURL}pyodide.mjs`);
        pyodide = await mod.loadPyodide({ indexURL });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!pyodide) throw new Error(`no Pyodide build could be loaded (${lastError?.message || lastError})`);

    manifest = await (await fetch('./kernel-manifest.json', { cache: 'no-cache' })).json();
    const root = '/home/pyodide/kernel_pkg';
    pyodide.FS.mkdirTree(root);
    const texts = await Promise.all(manifest.files.map(async (relative) => {
      const response = await fetch(`${manifest.base}/${relative}`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
      return response.text();
    }));
    const directories = new Set();
    manifest.files.forEach((relative, index) => {
      const path = `${root}/${relative}`;
      const directory = path.slice(0, path.lastIndexOf('/'));
      if (!directories.has(directory)) {
        pyodide.FS.mkdirTree(directory);
        directories.add(directory);
      }
      pyodide.FS.writeFile(path, texts[index]);
    });
    pyodide.runPython(`
import sys
if '/home/pyodide/kernel_pkg' not in sys.path:
    sys.path.insert(0, '/home/pyodide/kernel_pkg')
import kernel.browser as klb
`);
    return pyodide;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function python(expression) {
  return pyodide.runPython(expression);
}

function pythonJson(expression) {
  return JSON.parse(python(expression));
}

function positiveInteger(value, fallback, name) {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return result;
}

function sessionHandle(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid Linux session handle');
  return result;
}

async function kernelBytes(message) {
  if (message.kernel) return new Uint8Array(message.kernel);
  if (!message.kernelUrl) throw new Error('boot needs kernel or kernelUrl');
  const response = await fetch(message.kernelUrl);
  if (!response.ok) throw new Error(`kernel: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function initrdBytes(message) {
  if (message.initrd) return new Uint8Array(message.initrd);
  if (!message.initrdUrl) return null;
  const response = await fetch(message.initrdUrl);
  if (!response.ok) throw new Error(`initramfs: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function rootSource(message) {
  const delivery = message.rootfsDelivery || null;
  if (delivery) {
    const fabric = await openPageBundle({
      blob: delivery.blob || null,
      url: delivery.url || null,
      prefixBytes: delivery.prefixBytes,
      prefixSha256: delivery.prefixSha256,
      objectSha256: delivery.objectSha256 || null,
      // Quotient ranks follow first physical occurrence. A small forward wave
      // therefore coalesces filesystem readahead without inventing paths or a
      // second browser VFS cache.
      wavePages: delivery.wavePages == null ? 4 : delivery.wavePages,
      cachePages: delivery.cachePages == null ? 32 : delivery.cachePages,
    });
    const requested = message.rootfsBytes == null
      ? fabric.length : Number(message.rootfsBytes);
    if (!Number.isSafeInteger(requested) || requested !== fabric.length) {
      throw new Error('rootfsBytes does not match the delivered canonical object');
    }
    return { fabric, blob: null, url: null, length: fabric.length };
  }
  const root = message.rootfs || null;
  const length = Number(message.rootfsBytes || root?.size || 0);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('rootfsBytes must be a nonnegative safe integer');
  }
  if (length && !root && !message.rootfsUrl) {
    throw new Error('a nonempty rootfs needs a Blob or rootfsUrl');
  }
  return { blob: root, url: message.rootfsUrl || null, length };
}

async function readRootPage(root, page) {
  const start = page * BLOCK_PAGE_SIZE;
  if (start < 0 || start >= root.length) throw new Error(`rootfs page ${page} is outside the image`);
  const end = Math.min(root.length, start + BLOCK_PAGE_SIZE);
  if (root.fabric) return root.fabric.read(start, end - start);
  if (root.blob) return new Uint8Array(await root.blob.slice(start, end).arrayBuffer());
  const response = await fetch(root.url, {
    headers: { Range: `bytes=${start}-${end - 1}` },
    cache: 'no-cache',
  });
  if (response.status !== 206) {
    throw new Error(`rootfs range ${start}-${end - 1}: expected HTTP 206, got ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== end - start) throw new Error('rootfs range returned the wrong byte count');
  return bytes;
}

function encodeBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const raw = atob(String(value));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

async function installX86VmKernels() {
  await loadVM();
  self.mixSpongeRecords = (lanes, tail, seed, records, rounds) => {
    const mixed = mixSpongeRecordsLoaded(
      decodeBase64(lanes), decodeBase64(tail), decodeBase64(seed),
      decodeBase64(records), Number(rounds),
    );
    return JSON.stringify({
      lanes: encodeBase64(mixed.lanes),
      tail: encodeBase64(mixed.tail),
    });
  };
  self.installX86StateStep = (pageBase64) => {
    pageBase64 = String(pageBase64);
    const present = x86StepTokens.get(pageBase64);
    if (present != null) return present;
    const token = x86StepPages.length + 1;
    x86StepPages.push(decodeBase64(pageBase64));
    x86StepTokens.set(pageBase64, token);
    return token;
  };
  self.executeX86StateStep = (token, valuesBase64) => {
    token = Number(token);
    if (!Number.isSafeInteger(token) || token <= 0
        || token > x86StepPages.length) {
      throw new Error('x86 state-step token is invalid');
    }
    const page = x86StepPages[token - 1];
    const entry = decodeBase64(valuesBase64);
    if (entry.length % 8) throw new Error('x86 state cut is not uint64-aligned');
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const locals = Array.from(
      { length: entry.length / 8 },
      (_unused, index) => view.getBigUint64(index * 8, true),
    );
    const cut = executePureStateStepLoaded(page, locals, []);
    if (cut.stack.length || cut.locals.length !== locals.length) {
      throw new Error('vm.wasm returned a malformed x86 state cut');
    }
    const output = new Uint8Array(cut.locals.length * 8);
    const outputView = new DataView(output.buffer);
    cut.locals.forEach((value, index) => {
      outputView.setBigUint64(index * 8, value, true);
    });
    return encodeBase64(output);
  };
}

function step(handle, event, budget, maxInternal) {
  pyodide.globals.set('_linux_event', JSON.stringify(event));
  try {
    return pythonJson(
      `klb.step(${handle}, _linux_event, ${budget}, ${maxInternal})`,
    );
  } finally {
    pyodide.globals.delete('_linux_event');
  }
}

async function drive(id, handle, options = {}) {
  handle = sessionHandle(handle);
  const root = roots.get(handle);
  if (!root) throw new Error('Linux session has no root source');
  const architecture = architectures.get(handle);
  const budget = positiveInteger(options.budget, 1 << 21, 'budget');
  const maxInternal = positiveInteger(options.maxInternal, 1024, 'maxInternal');
  const maxSteps = positiveInteger(options.maxSteps, 1 << 16, 'maxSteps');
  const stages = Array.from(options.stages || ['rootfs_mount', 'init_probe']);
  let event = null;
  let result = null;
  for (let count = 0; count < maxSteps; count += 1) {
    result = step(handle, event, budget, maxInternal);
    event = null;
    if (result.event) send('trace', { id, handle, event: result.event });
    const operation = result.event?.operation;
    if (operation === 'block_read') {
      const [device, page] = result.event.coordinate;
      if (device !== 0) throw new Error(`no browser block device ${device}`);
      const bytes = await readRootPage(root, page);
      event = { operation, coordinate: [device, page], data_base64: encodeBase64(bytes) };
      continue;
    }
    if (operation === 'clock') {
      if (architecture === 'x86-64') {
        throw new Error('x86 replayable clock escaped its machine step');
      }
      event = { operation, coordinate: [], data: Math.floor(performance.now() * 1e6) };
      continue;
    }
    if (operation === 'interrupt') {
      event = { operation, coordinate: result.event.coordinate };
      continue;
    }
    if (operation === 'console_write' || operation === 'block_write') continue;
    if (result.event) return result;
    if (result.state.stopped) {
      if (!stages.length || result.state.result !== 0) return result;
      const stage = stages.shift();
      pythonJson(`klb.invoke(${handle}, ${JSON.stringify(stage)})`);
      send('stage', { id, handle, stage });
      continue;
    }
    // A bounded state-step quantum ended without external I/O. Yield so the
    // browser remains responsive, then resume the exact continuation.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Linux did not reach an external boundary in ${maxSteps} steps`);
}

async function boot(message) {
  await loadRuntime(message.id);
  const requestId = positiveInteger(message.id, null, 'request id');
  const architecture = message.architecture || 'wasm32';
  const kernel = await kernelBytes(message);
  const initrd = architecture === 'x86-64'
    ? await initrdBytes(message)
    : null;
  const root = await rootSource(message);
  if (!['wasm32', 'x86-64'].includes(architecture)) {
    throw new Error(`unknown Linux architecture ${architecture}`);
  }
  const path = `/tmp/linux-${requestId}.wasm`;
  const initrdPath = `/tmp/linux-${requestId}.initramfs`;
  pyodide.FS.writeFile(path, kernel);
  let handle;
  try {
    if (architecture === 'x86-64') {
      await installX86VmKernels();
      const x86 = Object.assign({}, message.x86 || {});
      if (initrd) {
        pyodide.FS.writeFile(initrdPath, initrd);
        x86.initrd_path = initrdPath;
      }
      pyodide.globals.set('_x86_options', JSON.stringify(x86));
      try {
        handle = Number(python(`klb.boot_x86_file(${JSON.stringify(path)}, _x86_options)`));
      } finally {
        pyodide.globals.delete('_x86_options');
      }
    } else {
      handle = Number(python(`klb.boot_file(${JSON.stringify(path)}, ${root.length}, ${JSON.stringify(message.entry || 'init')})`));
    }
  } finally {
    pyodide.FS.unlink(path);
    if (initrd) pyodide.FS.unlink(initrdPath);
  }
  roots.set(handle, root);
  architectures.set(handle, architecture);
  send('booted', { id: message.id, handle, architecture });
  const driveOptions = Object.assign({}, message.options || {});
  if (architecture === 'x86-64' && driveOptions.stages === undefined) {
    driveOptions.stages = [];
  }
  const result = await drive(message.id, handle, driveOptions);
  send('result', { id: message.id, ok: true, handle, result });
}

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.action === 'boot') {
      await boot(message);
    } else if (message.action === 'drive') {
      const handle = sessionHandle(message.handle);
      const result = await drive(message.id, handle, message.options);
      send('result', { id: message.id, ok: true, handle, result });
    } else if (message.action === 'release') {
      await loadRuntime(message.id);
      const handle = sessionHandle(message.handle);
      const architecture = architectures.get(handle);
      pythonJson(`klb.release(${handle})`);
      const root = roots.get(handle);
      if (root?.fabric) root.fabric.release();
      roots.delete(handle);
      architectures.delete(handle);
      if (architecture === 'x86-64'
          && !Array.from(architectures.values()).includes('x86-64')) {
        delete self.mixSpongeRecords;
        delete self.installX86StateStep;
        delete self.executeX86StateStep;
        x86StepPages.length = 0;
        x86StepTokens.clear();
        releaseVM();
      }
      send('result', { id: message.id, ok: true, handle });
    } else if (message.action === 'input') {
      await loadRuntime(message.id);
      const handle = sessionHandle(message.handle);
      const bytes = new TextEncoder().encode(String(message.data || ''));
      pyodide.globals.set('_console_input', encodeBase64(bytes));
      let result;
      try {
        result = pythonJson(`klb.console_input(${handle}, data_base64=_console_input)`);
      } finally {
        pyodide.globals.delete('_console_input');
      }
      send('result', { id: message.id, ok: true, handle, result });
    } else {
      throw new Error(`unknown Linux worker action ${message.action}`);
    }
  } catch (error) {
    send('result', { id: message.id, ok: false, error: error?.message || String(error) });
  }
};

send('ready');
