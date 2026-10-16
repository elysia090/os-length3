import {h} from '../dom.ts';
import {onChange, store} from '../repos.ts';

// A shell per repo, running translated BusyBox (and l3) in a Worker. Sessions
// outlive page switches: the workbench re-attaches the same element. A
// session only shows output; what is typed comes from the prompt box through
// send(). The repo in the shell is the repo: what the shell changes under
// /root/<repo> is written back through the store, and what is saved
// elsewhere (Forge, Git, l3 on the host… through the store) is put into the
// shell's copy. Binary files and files over the read limit stay where they are.

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

export class Session {
  readonly element: HTMLElement;
  private output: HTMLElement;
  private status: HTMLElement;
  private live = false;
  private worker: Worker | null = null;
  private text = '';
  private repo: string;

  constructor(repo: string) {
    this.repo = repo;
    this.output = h('pre', {class: 'term-out', 'aria-live': 'polite'});
    this.status = h('p', {class: 'muted small'}, '起動中…');
    this.element = h('div', {class: 'term'}, this.status, this.output);
    void this.start();
  }

  /** Type `text` into the shell, one line per line. False while it is not running. */
  send(text: string): boolean {
    if (!this.live || !this.worker) return false;
    const lines = text.endsWith('\n') ? text : `${text}\n`;
    this.print(lines);
    const bytes = new TextEncoder().encode(lines);
    this.worker.postMessage({type: 'input', bytes}, [bytes.buffer]);
    return true;
  }

  private print(s: string) {
    this.text += strip(s);
    // Keep the last 200k characters; older output scrolls away.
    if (this.text.length > 200_000) this.text = this.text.slice(-150_000);
    this.output.textContent = this.text;
    this.output.scrollTop = this.output.scrollHeight;
  }

  private readonly id = `shell:${Math.random().toString(36).slice(2)}`;
  private stop: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();

  /** Write the shell's changes back to the repo, in order, one batch after another. */
  private writeBack(c: {dirs: string[]; files: {path: string; bytes: Uint8Array; existed: boolean}[]; removed: string[]}) {
    this.queue = this.queue.then(async () => {
      const skipped: string[] = [];
      for (const d of c.dirs) await store.mkdir(this.repo, d, this.id).catch(() => skipped.push(`${d}/`));
      for (const f of c.files) {
        let text: string;
        try { text = new TextDecoder('utf-8', {fatal: true}).decode(f.bytes); } catch { skipped.push(f.path); continue; }
        if (f.bytes.length > 256 * 1024) { skipped.push(f.path); continue; }
        const at = f.path.lastIndexOf('/');
        const ok = f.existed
          ? store.write(this.repo, f.path, text, this.id)
          : store.add(this.repo, at < 0 ? '' : f.path.slice(0, at), f.path.slice(at + 1), text, this.id)
            .catch(() => store.write(this.repo, f.path, text, this.id));
        await ok.catch(() => skipped.push(f.path));
      }
      for (const r of c.removed) await store.remove(this.repo, r, this.id).catch(() => skipped.push(r));
      if (skipped.length) this.status.textContent = `repoに書き戻せなかったもの（バイナリ・大きすぎる等）: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}`;
    });
  }

  private async start() {
    try {
      const [translator, busybox, applets, l3, copy] = await Promise.all([
        fetchBytes('/userland/xlat.wasm'), fetchBytes('/userland/busybox'),
        fetch('/userland/applets').then((r) => r.text()),
        fetchBytes('/userland/l3').catch(() => null), snapshot(this.repo)]);
      const worker = new Worker(new URL('../../../../xlat/runtime/worker.mjs', import.meta.url), {type: 'module'});
      this.worker = worker;
      worker.onmessage = ({data}) => {
        if (data.type === 'output') this.print(new TextDecoder().decode(data.bytes));
        else if (data.type === 'changes') this.writeBack(data);
        else if (data.type === 'exit') this.end(`終了しました（${data.status >> 8}）`);
        else if (data.type === 'error') this.end(`停止しました: ${data.message.split('\n')[0]}`);
      };
      const cwd = `/root/${this.repo}`;
      worker.postMessage({
        type: 'start', translator,
        files: [{path: '/bin/busybox', bytes: busybox, mode: 0o755},
          ...(l3 ? [{path: '/bin/l3', bytes: l3, mode: 0o755}] : []), ...copy.files],
        dirs: copy.dirs,
        links: applets.split('\n').filter((a) => a && a !== 'busybox').map((a) => ({path: `/bin/${a}`, target: 'busybox'})),
        argv: ['/bin/sh', '-i'],
        // l3 here sees repos where the shell does, under /root.
        env: ['HOME=/root', 'PATH=/bin', 'TERM=dumb', 'PS1=$PWD $ ', 'LENGTH3_REPOS=/root', 'L3_PROMPT=1'],
        cwd,
        mirror: cwd,
      });
      // What is saved elsewhere comes into the shell's copy.
      this.stop = onChange((c) => {
        if (c.repo !== this.repo || c.by === this.id || c.what === 'repo') return;
        const what = c.what === 'file' ? new TextEncoder().encode(c.text ?? '') : c.what === 'dir' ? 'dir' : null;
        this.worker?.postMessage({type: 'put', path: c.path, what});
      });
      this.status.textContent = copy.complete
        ? 'このrepoで動いています。ここで変えたファイルはrepoに書き戻されます（テキストのみ）。'
        : 'このrepoで動いています（大きいファイル・バイナリは入っていません）。ここで変えたファイルはrepoに書き戻されます。';
      this.live = true;
    } catch (e) {
      this.end(`起動できませんでした: ${String(e)}`);
    }
  }

  private end(message: string) {
    this.stop?.();
    this.stop = null;
    this.worker?.terminate();
    this.worker = null;
    this.live = false;
    const restart = h('button', {class: 'button', type: 'button'}, 'もう一度起動');
    restart.addEventListener('click', () => {
      sessions.delete(this.repo);
      this.element.replaceWith(terminalFor(this.repo));
    });
    this.status.replaceChildren(message, ' ', restart);
  }
}

export function sessionFor(repo: string): Session {
  let s = sessions.get(repo);
  if (!s) { s = new Session(repo); sessions.set(repo, s); }
  return s;
}

export const terminalFor = (repo: string): HTMLElement => sessionFor(repo).element;
