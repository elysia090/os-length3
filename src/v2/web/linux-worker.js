// Disposable host for the native x86 machine.
//
// The Worker owns only artifact/page delivery and scheduling. CPU state, MMU,
// exceptions, control flow, and QM state-step execution remain in vm.wasm.
// Missing native coverage is an error: there is no interpreter fallback.

import { openArtifact } from './artifact.js';
import { openNativeX86Artifact } from './x86-machine.js';
import {
  openX86Machine,
  release as releaseVM,
} from './vm.js';

const sessions = new Map();
const profiles = new Map();
let nextHandle = 1;
let queue = Promise.resolve();

function consoleState() {
  return {
    decoder: new TextDecoder(),
    tail: '',
    boot: true,
    ready: false,
  };
}

function observeConsole(runtime, bytes) {
  runtime.tail = (runtime.tail
    + runtime.decoder.decode(bytes, { stream: true })).slice(-4096);
  const prompt = /(?:^|\r?\n)# $/.test(runtime.tail);
  runtime.ready = prompt
    && (!runtime.boot || runtime.tail.includes('BusyBox is ready.'));
}

function send(type, payload = {}) {
  self.postMessage(Object.assign({ type }, payload));
}

function base64(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
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
  if (!Number.isSafeInteger(result) || !sessions.has(result)) {
    throw new Error('Linux session handle is not resident');
  }
  return result;
}

function profileStart(id) {
  const profile = { started: performance.now(), marks: {} };
  profiles.set(id, profile);
  return profile;
}

function profileMark(id, name) {
  const profile = profiles.get(id);
  if (!profile) return;
  profile.marks[name] = Math.round(
    (performance.now() - profile.started) * 1000,
  ) / 1000;
}

function profileLayout(id) {
  return { ...(profiles.get(id)?.marks || {}) };
}

function status(machine, raw = machine.status()) {
  return {
    halted: raw.halted,
    rip_hex: raw.rip.toString(16).padStart(16, '0'),
    retired: raw.retired.toString(),
    work: raw.work.toString(),
    span: raw.span.toString(),
    stopped: raw.halted,
  };
}

function machineArtifact(message) {
  const explicit = message.machineArtifact || message.x86?.machineArtifact;
  if (explicit) return String(explicit);
  const source = String(message.kernelArtifact || 'linux-x86-64');
  return source.endsWith('-machine') ? source : `${source}-machine`;
}

async function drive(id, handle, options = {}) {
  handle = sessionHandle(handle);
  const session = sessions.get(handle);
  const quantum = positiveInteger(
    options.quantum ?? options.maxBlocks, 65536, 'x86 block quantum',
  );
  const maxQuanta = positiveInteger(options.maxQuanta, 256, 'x86 quanta');
  let raw = session.machine.status();
  for (let count = 0; count < maxQuanta; count += 1) {
    raw = await session.machine.advance(quantum);
    if (raw.missingBlock != null) {
      const rip = raw.missingBlock.toString(16).padStart(16, '0');
      throw new Error(
        `native QM artifact has no x86 block at RIP 0x${rip}`,
      );
    }
    if (raw.halted || session.console.ready) break;
    if ((count & 15) === 15) {
      send('progress', {
        id,
        phase: 'execute',
        label: 'Running Linux in vm.wasm',
        detail: `${raw.retired.toString()} source instructions`,
      });
      // A scheduling yield is not an execution fallback or guest barrier.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return {
    state: status(session.machine, raw),
    ready: session.console.ready,
    layout: session.artifact.layout(),
  };
}

async function boot(message) {
  if ((message.architecture || 'x86-64') !== 'x86-64') {
    throw new Error('Linux browser runtime currently accepts native x86-64 artifacts only');
  }
  profileStart(message.id);
  const name = machineArtifact(message);
  send('progress', {
    id: message.id,
    phase: 'download',
    label: 'Opening the native Linux machine',
    asset: name,
  });
  const opened = await openArtifact(name, {
    root: message.artifactRoot || null,
    // The outer machine descriptor is one known sequential extent.  Give it
    // a wider transfer wave without changing the small on-demand RAM wave
    // passed below to openNativeX86Artifact.
    wavePages: message.x86?.deliveryWavePages
      ?? message.x86?.wavePages ?? 4,
    cachePages: message.x86?.deliveryCachePages ?? 16,
  });
  profileMark(message.id, 'artifact_mapped');
  let artifact;
  let machine;
  const console = consoleState();
  try {
    artifact = await openNativeX86Artifact(opened.fabric, message.x86 || {});
    profileMark(message.id, 'physical_pages_opened');
    machine = await openX86Machine({
      ...artifact,
      devices: {
        consoleWrite(bytes) {
          observeConsole(console, bytes);
          send('trace', {
            event: {
              operation: 'console_write',
              data_base64: base64(bytes),
            },
          });
        },
      },
    });
    profileMark(message.id, 'vm_opened');
  } catch (error) {
    artifact?.release();
    opened.fabric.release();
    throw error;
  }
  const handle = nextHandle++;
  sessions.set(handle, { artifact, machine, opened, console });
  send('booted', { id: message.id, handle, architecture: 'x86-64' });
  try {
    const result = await drive(
      message.id, handle, message.options || {},
    );
    profileMark(message.id, 'first_drive_complete');
    send('result', {
      id: message.id,
      ok: true,
      handle,
      result,
      profile: profileLayout(message.id),
    });
  } finally {
    profiles.delete(message.id);
  }
}

function releaseSession(handle) {
  handle = sessionHandle(handle);
  const session = sessions.get(handle);
  session.machine.release();
  session.artifact.release();
  session.opened.fabric.release();
  sessions.delete(handle);
  if (!sessions.size) releaseVM();
  return handle;
}

async function handleMessage(message) {
  if (message.action === 'boot') {
    await boot(message);
    return;
  }
  if (message.action === 'drive') {
    const handle = sessionHandle(message.handle);
    const result = await drive(message.id, handle, message.options || {});
    send('result', { id: message.id, ok: true, handle, result });
    return;
  }
  if (message.action === 'release') {
    const handle = releaseSession(message.handle);
    send('result', { id: message.id, ok: true, handle });
    return;
  }
  if (message.action === 'input') {
    const handle = sessionHandle(message.handle);
    const session = sessions.get(handle);
    const bytes = new TextEncoder().encode(String(message.data || ''));
    session.console.tail = '';
    session.console.boot = false;
    session.console.ready = false;
    const accepted = session.machine.feedConsole(bytes);
    send('result', { id: message.id, ok: true, handle, accepted });
    return;
  }
  throw new Error(`unknown Linux worker action ${message.action}`);
}

self.onmessage = (event) => {
  const message = event.data || {};
  queue = queue.then(
    () => handleMessage(message),
    () => handleMessage(message),
  ).catch((error) => {
    profileMark(message.id, 'failed');
    send('result', {
      id: message.id,
      ok: false,
      error: error?.message || String(error),
      profile: profileLayout(message.id),
    });
    profiles.delete(message.id);
  });
};

send('ready');
