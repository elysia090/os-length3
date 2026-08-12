// One terminal owns one disposable Linux worker. Build tools may produce the
// x86 state pages, but browser execution receives only artifact progress,
// physical page/barrier observations and console bytes from vm.wasm.

const textDecoder = new TextDecoder();

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatBytes(value) {
  value = finite(value);
  if (value == null) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function decodeBase64(value) {
  const raw = atob(String(value || ''));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function briefError(value) {
  const lines = String(value || 'Linux stopped').split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) || 'Linux stopped')
    .replace(/^(?:[\w.]+\.)?\w*(?:Error|Exception):\s*/, '');
}

function queryValue(query, name, fallback = null) {
  const value = query.get(name);
  return value == null || value === '' ? fallback : value;
}

/** Read an opt-in boot source without inventing a second browser VFS. */
export function readLinuxConfig(search = location.search) {
  const query = new URLSearchParams(search);
  const supplied = globalThis.QM_LINUX || {};
  const kernelUrl = supplied.kernelUrl
    || queryValue(query, 'linux-kernel');
  const kernelArtifact = supplied.kernelArtifact
    || queryValue(query, 'linux-artifact');
  const machineArtifact = supplied.machineArtifact
    || queryValue(query, 'linux-machine-artifact');
  if (!kernelUrl && !kernelArtifact && !machineArtifact) return null;
  const rootfsBytes = finite(
    supplied.rootfsBytes ?? queryValue(query, 'linux-rootfs-bytes'),
  );
  return {
    architecture: supplied.architecture
      || queryValue(query, 'linux-architecture', 'x86-64'),
    kernelUrl,
    kernelArtifact,
    machineArtifact,
    artifactRoot: supplied.artifactRoot
      || queryValue(query, 'linux-artifact-root'),
    initrdUrl: supplied.initrdUrl || queryValue(query, 'linux-initrd'),
    rootfsUrl: supplied.rootfsUrl || queryValue(query, 'linux-rootfs'),
    rootfsBytes,
    rootfsDelivery: supplied.rootfsDelivery || null,
    x86: supplied.x86 || {},
    options: supplied.options || {},
  };
}

export class LinuxTerminal {
  constructor(root = document) {
    this.root = root;
    this.worker = null;
    this.handle = null;
    this.request = 0;
    this.pending = new Map();
    this.started = false;
    this.startedAt = null;
    this.coldMs = null;
    this.outputStarted = false;
    this.profile = null;
    this.progress = root.getElementById('boot-transfer');
    this.track = root.getElementById('boot-transfer-track');
    this.fill = root.getElementById('boot-transfer-fill');
    this.value = root.getElementById('boot-transfer-value');
    this.phase = root.getElementById('boot-transfer-phase');
    this.bytes = root.getElementById('boot-transfer-bytes');
    this.output = root.getElementById('shell-out');
    this.input = root.getElementById('shell-in');
    this.session = root.getElementById('shell-state');
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || this.input.disabled) return;
      event.preventDefault();
      const line = `${this.input.value}\n`;
      this.input.value = '';
      this.send('input', { handle: this.handle, data: line });
    });
  }

  setSession(label, active = false) {
    this.session.lastChild.textContent = ` ${label}`;
    this.session.classList.toggle('is-active', active && label === 'local');
    this.session.classList.toggle('is-booting', active && label !== 'local');
    this.session.classList.toggle('is-error', label === 'failed');
  }

  showProgress(update = {}) {
    const loaded = finite(update.loaded);
    const total = finite(update.total);
    const determinate = loaded != null && total != null && total > 0;
    const percent = determinate
      ? Math.max(0, Math.min(100, (loaded / total) * 100)) : null;
    const state = update.state || 'active';

    this.progress.hidden = false;
    this.progress.classList.toggle('is-indeterminate', !determinate
      && state === 'active');
    this.progress.classList.toggle('is-complete', state === 'complete');
    this.progress.classList.toggle('is-error', state === 'error');
    this.progress.setAttribute('aria-busy', String(state === 'active'));
    this.phase.textContent = update.label || update.message || 'Opening the machine';

    if (determinate) {
      this.progress.style.setProperty('--boot-progress', `${percent}%`);
      this.track.setAttribute('aria-valuenow', String(Math.round(percent)));
      this.value.textContent = `${Math.round(percent)}%`;
      const ratio = `${formatBytes(loaded)} / ${formatBytes(total)}`;
      this.bytes.textContent = update.asset
        ? `${update.asset} · ${ratio}` : ratio;
    } else {
      this.track.removeAttribute('aria-valuenow');
      this.value.textContent = state === 'complete' ? 'ready'
        : state === 'error' ? 'failed' : '';
      this.bytes.textContent = update.detail || '';
    }
  }

  append(bytes) {
    if (!bytes.length) return;
    if (!this.outputStarted) {
      this.output.replaceChildren();
      this.outputStarted = true;
    }
    this.output.append(document.createTextNode(
      textDecoder.decode(bytes, { stream: true }),
    ));
    this.output.scrollTop = this.output.scrollHeight;
  }

  send(action, payload = {}) {
    if (!this.worker) return null;
    const id = ++this.request;
    this.pending.set(id, action);
    this.worker.postMessage(Object.assign({ id, action }, payload));
    return id;
  }

  onMessage(message) {
    if (message.type === 'ready') {
      this.send('boot', this.config);
      return;
    }
    if (message.type === 'progress') {
      this.showProgress(message);
      return;
    }
    if (message.type === 'stage') {
      this.showProgress({ label: `Entering ${message.stage}`, detail: 'state-step' });
      return;
    }
    if (message.type === 'trace') {
      if (message.event?.operation === 'console_write'
          && message.event.data_base64) {
        this.append(decodeBase64(message.event.data_base64));
      }
      if (message.event?.operation === 'block_read') {
        const page = message.event.coordinate?.[1];
        this.showProgress({
          label: 'Reading rootfs on demand',
          detail: Number.isInteger(page) ? `page ${page}` : 'direct page',
        });
      }
      return;
    }
    if (message.type === 'booted') {
      this.handle = message.handle;
      this.setSession('booting', true);
      this.showProgress({ label: 'Entering the kernel', detail: 'state-step pages' });
      return;
    }
    if (message.type !== 'result') return;

    const action = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.profile) {
      this.profile = message.profile;
      this.progress.dataset.bootProfile = JSON.stringify(message.profile);
    }
    if (!message.ok) {
      const elapsed = this.startedAt == null ? null
        : performance.now() - this.startedAt;
      this.showProgress({
        state: 'error',
        label: briefError(message.error),
        detail: elapsed == null ? '' : `${Math.round(elapsed)} ms`,
      });
      this.setSession('failed');
      this.input.disabled = true;
      this.input.placeholder = 'kernel did not start';
      return;
    }
    if (action === 'input') {
      this.send('drive', { handle: this.handle, options: this.config.options });
      return;
    }
    if (action === 'release') {
      this.worker.terminate();
      this.worker = null;
      this.handle = null;
      this.setSession('idle');
      return;
    }
    this.handle = message.handle ?? this.handle;
    if (message.result?.state?.halted && !this.outputStarted) {
      const rip = String(message.result.state.rip_hex || '');
      this.showProgress({
        state: 'error',
        label: 'Linux halted before console output',
        detail: /^[0-9a-f]{16}$/.test(rip) ? `RIP 0x${rip}` : '',
      });
      this.setSession('failed');
      this.input.disabled = true;
      this.input.placeholder = 'kernel halted before /init';
      return;
    }
    this.coldMs = performance.now() - this.startedAt;
    this.showProgress({
      state: 'complete',
      label: 'Linux is resident',
      detail: `${Math.round(this.coldMs)} ms cold`,
    });
    this.setSession('local', true);
    this.input.disabled = false;
    this.input.placeholder = 'shell input';
  }

  start(config) {
    if (!config || this.started) return false;
    this.started = true;
    this.startedAt = performance.now();
    this.config = config;
    this.setSession('starting', true);
    this.showProgress({ label: 'Opening the boot image' });
    this.worker = new Worker(new URL('linux-worker.js', import.meta.url), {
      type: 'module',
    });
    this.worker.addEventListener('message', (event) => this.onMessage(event.data || {}));
    this.worker.addEventListener('error', (event) => this.onMessage({
      type: 'result', id: 0, ok: false,
      error: event.message || 'Linux worker failed',
    }));
    return true;
  }

  release() {
    if (!this.worker) return;
    if (this.handle != null) this.send('release', { handle: this.handle });
    else {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

export function mountLinuxTerminal(search = location.search) {
  const terminal = new LinuxTerminal();
  terminal.start(readLinuxConfig(search));
  return terminal;
}
