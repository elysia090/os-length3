// One terminal owns one disposable Linux worker. Build tools may produce the
// x86 state pages, but browser execution receives only artifact progress,
// physical page/barrier observations and console bytes from vm.wasm.
import {openWorkspaceSession} from './workspace-authority.mjs';
import {ensurePreparedMachineRelease,openPreparedMachineRelease} from './prepared-release.mjs';
import {readSelectedWorkspaceRelease} from './workspace-release.mjs';

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
  const releaseUrl=supplied.releaseUrl||queryValue(query,'linux-release');
  if (!kernelUrl && !kernelArtifact && !machineArtifact && !releaseUrl) return null;
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
    releaseUrl,
    releaseSha256: supplied.releaseSha256 || queryValue(query,'linux-release-sha256'),
    storage: supplied.storage || null,
    workspace: supplied.workspace || queryValue(query,'linux-workspace','default'),
    workspaceBytes: supplied.workspaceBytes ?? Number(queryValue(query,'linux-workspace-bytes',256*1048576)),
    network: supplied.network || null,
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
    this.cancelled = false;
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
    this.closeButton=root.getElementById('btn-shell-close');
    this.resumeButton=root.getElementById('btn-shell-resume');
    this.closeButton?.addEventListener('click',()=>this.release());
    this.resumeButton?.addEventListener('click',()=>{
      if(this.worker||!this.config)return;
      const config={...this.config};if(config.storage?.trusted)config.storage=null;
      this.started=false;this.cancelled=false;this.serviceReady=false;this.outputStarted=false;
      this.start(config);
    });
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
    if (update.profile) {
      this.progress.dataset.liveProfile = JSON.stringify(update.profile);
    }

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
    if(message.type==='service-status'){
      this.serviceStatus=message;this.progress.dataset.serviceStatus=JSON.stringify(message);
      if(message.state==='failed'){
        this.serviceReady=false;
        this.showProgress({state:'error',label:message.reason==='readiness-deadline'
          ?'Services did not become ready before the observation deadline':'Service initialization failed',
          detail:'The local console remains available'});
        if(!this.input.disabled)this.session.lastChild.textContent=' local · services failed';
      }
      return;
    }
    if(message.type==='fault'){
      this.onMessage({type:'result',id:0,ok:false,error:message.error});
      return;
    }
    if(message.type==='service-ready'){
      this.serviceReady=true;
      this.showProgress({state:'complete',label:'Linux services are ready'});
      if(!this.input.disabled)this.setSession('local',true);
      return;
    }
    if(message.type==='storage-head'){
      if(this.config.storage)this.config.storage.expectedHead=new Uint8Array(message.envelope);
      return;
    }
    if (message.type === 'ready') {
      const generation=this.config.storage?.trusted?this.config.storage.generation:(this.config.storage?.generation??0n)+1n;
      if(this.config.storage)this.config.storage.generation=generation;
      this.config.generation=generation;
      this.send('boot', this.config);
      return;
    }
    if (message.type === 'progress') {
      if(this.serviceStatus?.state==='failed'){
        if(message.profile)this.progress.dataset.liveProfile=JSON.stringify(message.profile);
      }else this.showProgress(message);
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
      this.pending.clear();this.progress.hidden=true;
      this.input.placeholder='Resume to reopen this workspace';
      const session=this.workspaceSession;this.workspaceSession=null;
      this.setSession('idle');
      if(this.closeButton)this.closeButton.disabled=true;
      Promise.resolve(session?.close()).then(()=>{if(this.resumeButton)this.resumeButton.disabled=false;});
      return;
    }
    this.handle = message.handle ?? this.handle;
    if (!message.result?.ready) {
      this.showProgress({
        state: 'error',
        label: 'Linux stopped before the shell prompt',
        detail: 'state-step quantum exhausted',
      });
      this.setSession('failed');
      this.input.disabled = true;
      this.input.placeholder = 'shell prompt unavailable';
      return;
    }
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
    this.serviceReady=message.result.serviceReady===true||this.serviceReady===true;
    if(!this.serviceReady)this.session.lastChild.textContent=this.serviceStatus?.state==='failed'
      ?' local · services failed':' local · services pending';
    this.input.disabled = false;
    this.input.placeholder = 'shell input';
  }

  async start(config) {
    if (!config || this.started) return false;
    this.started = true;
    this.startedAt = performance.now();
    this.config = config;
    if(this.closeButton)this.closeButton.disabled=true;
    if(this.resumeButton)this.resumeButton.disabled=true;
    this.setSession('starting', true);
    this.showProgress({ label: 'Opening the boot image' });
    if(config.releaseUrl&&!config.storage){
      try{this.workspaceSession=await openWorkspaceSession(config.workspace,{bytes:config.workspaceBytes});
        config.storage=this.workspaceSession.storage;}
      catch(error){this.onMessage({type:'result',id:0,ok:false,error:error.message});return false;}
    }
    if(config.releaseUrl){
      try{
        if(config.storage?.trusted&&!config.storage.create){
          // Recovery follows the authenticated selected head, including a
          // previous explicit rollback, instead of a new catalog/config pin.
          config.releaseSha256=await readSelectedWorkspaceRelease(config.storage);
          const prepared=await openPreparedMachineRelease(config.releaseSha256);
          try{await prepared.verify();}finally{prepared.close();}
        }else await ensurePreparedMachineRelease(config.releaseUrl,config.releaseSha256,{onProgress:p=>
          this.showProgress({label:'Saving the Linux release for recovery',loaded:p.completed,total:p.total,asset:p.name})});
        config.preparedRelease=true;
      }catch(error){await this.workspaceSession?.close();this.workspaceSession=null;
        this.onMessage({type:'result',id:0,ok:false,error:error.message});return false;}
    }
    if(this.cancelled){this.workspaceSession?.close();this.workspaceSession=null;return false;}
    try{this.worker = new Worker(new URL('linux-worker.js', import.meta.url), {
      type: 'module',
    });}catch(error){
      this.workspaceSession?.close();this.workspaceSession=null;
      this.onMessage({type:'result',id:0,ok:false,error:error.message});return false;
    }
    this.worker.addEventListener('message', (event) => this.onMessage(event.data || {}));
    this.worker.addEventListener('error', (event) => this.onMessage({
      type: 'result', id: 0, ok: false,
      error: event.message || 'Linux worker failed',
    }));
    if(this.closeButton)this.closeButton.disabled=false;
    return true;
  }

  release() {
    this.cancelled=true;
    this.input.disabled=true;
    if(this.closeButton)this.closeButton.disabled=true;
    const enableResume=()=>{if(this.resumeButton)this.resumeButton.disabled=false;};
    if (!this.worker) {Promise.resolve(this.workspaceSession?.close()).then(enableResume);this.workspaceSession=null;return;}
    if (this.handle != null) this.send('release', { handle: this.handle });
    else {
      this.worker.terminate();
      this.worker = null;
      this.pending.clear();this.progress.hidden=true;
      this.workspaceSession?.close();this.workspaceSession=null;
      enableResume();this.setSession('idle');
    }
  }
}

export function mountLinuxTerminal(search = location.search) {
  const terminal = new LinuxTerminal();
  terminal.start(readLinuxConfig(search));
  return terminal;
}
