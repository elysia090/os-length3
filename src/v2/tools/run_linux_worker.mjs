#!/usr/bin/env node
// Exercise the browser Linux worker protocol without replacing its runtime.

const [artifactRoot, machineArtifact = 'linux-x86-64-postlink'] =
  process.argv.slice(2);
if (!artifactRoot) {
  throw new Error(
    'usage: run_linux_worker.mjs ARTIFACT_ROOT [MACHINE_ARTIFACT]',
  );
}

globalThis.QM_ARTIFACT_ROOT = new URL(artifactRoot).href;

let nextId = 0;
const pending = new Map();
const progress = [];
let consoleText = '';

globalThis.self = {
  postMessage(message) {
    if (message.type === 'trace'
        && message.event?.operation === 'console_write') {
      consoleText += Buffer.from(
        message.event.data_base64 || '', 'base64',
      ).toString('utf8');
    }
    if (message.type === 'progress' || message.type === 'stage') {
      progress.push(message);
    }
    if (message.type !== 'result') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(new Error(message.error || 'Linux worker failed'));
  },
};

await import(new URL('../web/linux-worker.js', import.meta.url));

function invoke(action, payload = {}) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  self.onmessage({ data: { id, action, ...payload } });
  return result;
}

const started = performance.now();
const boot = await invoke('boot', {
  architecture: 'x86-64',
  machineArtifact,
  artifactRoot: globalThis.QM_ARTIFACT_ROOT,
});
const bootCompleted = performance.now();
if (!boot.result?.ready || !/(?:^|\r?\n)# $/.test(consoleText)) {
  throw new Error('Linux worker returned before the BusyBox prompt');
}

const beforeCommand = consoleText.length;
await invoke('input', {
  handle: boot.handle,
  data: 'echo QM-WORKER\n',
});
const command = await invoke('drive', { handle: boot.handle });
const commandCompleted = performance.now();
const commandOutput = consoleText.slice(beforeCommand);
if (!command.result?.ready
    || !commandOutput.includes('QM-WORKER\r\n')
    || !/(?:^|\r?\n)# $/.test(commandOutput)) {
  throw new Error('Linux worker command did not return to the shell prompt');
}

await invoke('release', { handle: boot.handle });
const released = performance.now();
process.stdout.write(`${JSON.stringify({
  bootMilliseconds: bootCompleted - started,
  commandMilliseconds: commandCompleted - bootCompleted,
  releaseMilliseconds: released - commandCompleted,
  bootProfile: boot.profile,
  bootState: boot.result.state,
  commandState: command.result.state,
  delivery: boot.result.layout,
  progressMessages: progress.length,
  consoleTail: consoleText.slice(-1024),
}, null, 2)}\n`);
