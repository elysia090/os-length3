import {h} from '../dom.ts';
import {store} from '../repos.ts';

// A shell per repo, running translated BusyBox in a Worker. Sessions outlive
// page switches: File re-attaches the same element.

const sessions = new Map<string, Session>();
const LIMIT_FILES = 2000;
const LIMIT_BYTES = 32 << 20;

/** Escape sequences are dropped; the console is plain lines for now. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');

async function fetchBytes(path: string): Promise<Uint8Array> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Copy a repo's files for the guest: [{path, bytes}] under /root/<repo>. */
async function snapshot(repo: string) {
  const files: {path: string; bytes: Uint8Array}[] = [];
  const dirs: string[] = [`/root/${repo}`];
  let total = 0, complete = true;
  const walk = async (dir: string) => {
    for (const e of await store.tree(repo, dir)) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') { dirs.push(`/root/${repo}/${path}`); await walk(path); continue; }
      if (e.kind !== 'file') continue;
      if (files.length >= LIMIT_FILES || total + e.size > LIMIT_BYTES) { complete = false; continue; }
      const c = await store.read(repo, path);
      if (c.text === null || c.truncated) { complete = false; continue; }
      const bytes = new TextEncoder().encode(c.text);
      total += bytes.length;
      files.push({path: `/root/${repo}/${path}`, bytes});
    }
  };
  await walk('');
  return {files, dirs, complete};
}

class Session {
  readonly element: HTMLElement;
  private output: HTMLElement;
  private input: HTMLInputElement;
  private status: HTMLElement;
  private worker: Worker | null = null;
  private text = '';
  private repo: string;

  constructor(repo: string) {
    this.repo = repo;
    this.output = h('pre', {class: 'term-out', 'aria-live': 'polite'});
    this.input = h('input', {class: 'term-in', 'aria-label': 'shellへの入力', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', disabled: ''}) as HTMLInputElement;
    this.status = h('p', {class: 'muted small'}, '起動中…');
    const form = h('form', {class: 'term-line'}, h('span', {'aria-hidden': 'true'}, '$'), this.input);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const line = this.input.value;
      this.input.value = '';
      this.print(line + '\n');
      const bytes = new TextEncoder().encode(line + '\n');
      this.worker?.postMessage({type: 'input', bytes}, [bytes.buffer]);
    });
    this.element = h('div', {class: 'term'}, this.status, this.output, form);
    this.output.addEventListener('click', () => this.input.focus());
    void this.start();
  }

  private print(s: string) {
    this.text += strip(s);
    // Keep the last 200k characters; older output scrolls away.
    if (this.text.length > 200_000) this.text = this.text.slice(-150_000);
    this.output.textContent = this.text;
    this.output.scrollTop = this.output.scrollHeight;
  }

  private async start() {
    try {
      const [translator, busybox, applets, copy] = await Promise.all([
        fetchBytes('/userland/xlat.wasm'), fetchBytes('/userland/busybox'),
        fetch('/userland/applets').then((r) => r.text()), snapshot(this.repo)]);
      const worker = new Worker(new URL('../../../../xlat/runtime/worker.mjs', import.meta.url), {type: 'module'});
      this.worker = worker;
      worker.onmessage = ({data}) => {
        if (data.type === 'output') this.print(new TextDecoder().decode(data.bytes));
        else if (data.type === 'exit') this.end(`終了しました（${data.status >> 8}）`);
        else if (data.type === 'error') this.end(`停止しました: ${data.message.split('\n')[0]}`);
      };
      const cwd = `/root/${this.repo}`;
      worker.postMessage({
        type: 'start', translator,
        files: [{path: '/bin/busybox', bytes: busybox, mode: 0o755}, ...copy.files],
        dirs: copy.dirs,
        links: applets.split('\n').filter((a) => a && a !== 'busybox').map((a) => ({path: `/bin/${a}`, target: 'busybox'})),
        argv: ['/bin/sh', '-i'],
        env: ['HOME=/root', 'PATH=/bin', 'TERM=dumb', 'PS1=$PWD $ '],
        cwd,
      });
      this.status.textContent = copy.complete
        ? 'repoの写しで動いています。ここでの変更はrepoに保存されません。'
        : 'repoの一部（大きいファイルを除く）の写しで動いています。変更はrepoに保存されません。';
      this.input.disabled = false;
    } catch (e) {
      this.end(`起動できませんでした: ${String(e)}`);
    }
  }

  private end(message: string) {
    this.worker?.terminate();
    this.worker = null;
    this.input.disabled = true;
    const restart = h('button', {class: 'button', type: 'button'}, 'もう一度起動');
    restart.addEventListener('click', () => {
      sessions.delete(this.repo);
      this.element.replaceWith(terminalFor(this.repo));
    });
    this.status.replaceChildren(message, ' ', restart);
  }
}

export function terminalFor(repo: string): HTMLElement {
  let s = sessions.get(repo);
  if (!s) { s = new Session(repo); sessions.set(repo, s); }
  return s.element;
}
