// Disposable browser host for the existing Linux-in-WebAssembly machine.
//
// The compact LKL module is decoded by kernel.browser. Reached basic blocks
// become QM state-step pages; this worker supplies only external barrier
// events. Root images stay as Blob/HTTP range sources and only requested
// 4 KiB pages cross into Python memory.

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

function rootSource(message) {
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
      event = { operation, coordinate: [], data: Math.floor(performance.now() * 1e6) };
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
  const kernel = await kernelBytes(message);
  const root = rootSource(message);
  const path = `/tmp/linux-${requestId}.wasm`;
  pyodide.FS.writeFile(path, kernel);
  let handle;
  try {
    handle = Number(python(`klb.boot_file(${JSON.stringify(path)}, ${root.length}, ${JSON.stringify(message.entry || 'init')})`));
  } finally {
    pyodide.FS.unlink(path);
  }
  roots.set(handle, root);
  send('booted', { id: message.id, handle });
  const result = await drive(message.id, handle, message.options);
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
      pythonJson(`klb.release(${handle})`);
      roots.delete(handle);
      send('result', { id: message.id, ok: true, handle });
    } else {
      throw new Error(`unknown Linux worker action ${message.action}`);
    }
  } catch (error) {
    send('result', { id: message.id, ok: false, error: error?.message || String(error) });
  }
};

send('ready');
