import * as dotfiles from '../dotfiles.ts';
import {onChange, store} from '../repos.ts';
import {bytes, h} from '../dom.ts';
import {isNative, promptOpen, rootStatus, type Held, type Stopped} from '../host.ts';
import {currentLang, t, tn} from '../i18n.ts';
import {loadUserland, loadWebRoot, watchLoad, type Stage} from '../userland.ts';
import {every} from '../runs.ts';
import {errorText} from '../errors.ts';

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
/** sh -i says this once because the console is not a terminal; it means nothing here. */
const NO_TTY = "/bin/sh: can't access tty; job control turned off\n";
/**
 * The prompt the shell prints, at the end of what it wrote: a run is over
 * when it comes back. `/root/x $ ` (l3's userland, PS1 "$PWD $ ") or
 * `x $ `, `x/src $ ` (the root's shrc).
 */
const PROMPT = /(?:^|\n)[^\n]*\S \$ $/;
const RUNS = 50;

/** One line sent from the prompt box and what came out until the prompt returned. */
export interface Run { line: string; output: string; started: number; ms: number | null }

/** One line for where loading l3 is; nothing once it is ready. */
function loadWords(s: Stage): string {
  const of = (got: number, all: number) => (all ? `${bytes(got)} / ${bytes(all)}` : '');
  switch (s.at) {
    case 'fetch': return `${t('Loading l3 {size}', {size: of(s.got, s.of)})}${s.quiet ? ` · ${t('waiting for a reply {n}s', {n: s.quiet})}` : ''}`;
    case 'retry': return `${t('{why}. Continuing where it stopped (attempt {n})', {why: s.why, n: s.attempt})}${s.got ? ` ${of(s.got, s.of)}` : ''}`;
    case 'prepare': return t('Preparing…');
    case 'ready': return t('Starting…');
    case 'failed': return '';
  }
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
  /** What was run here, newest last. */
  readonly runs: Run[] = [];
  private watchers = new Set<() => void>();
  /** Bytes it holds, as the worker or the host last said (in a browser: guest memory, translations, the translator and root files read). */
  memory = 0;
  /** Of `memory`, in a browser, what can go without stopping anything (Kernel.held's spare). */
  spare = 0;
  /** What the last Free gave back, in a browser. */
  freed: number | null = null;
  /** Processes it runs, where that is known (on the root). */
  processes = 0;
  /** What it runs on: the distribution's root on this machine, or l3 through xlat. */
  on: 'root' | 'l3' | null = null;
  /** How the last stop went, on the root: what it held, and how long until none was left. */
  stopped: Stopped | null = null;
  private native: Awaited<ReturnType<typeof promptOpen>> | null = null;
  /** What the root's processes hold, read every 3 s while the page is in view. */
  private measuring: {stop(): void} | null = null;
  private ttySaid = false;

  constructor(repo: string) {
    this.repo = repo;
    this.output = h('pre', {class: 'term-out', 'aria-live': 'polite'});
    this.status = h('p', {class: 'muted small'}, t('Starting…'));
    // Not a live region: its count goes up each second, which a screen reader would read out each second.
    this.activity = h('div', {class: 'term-activity small'});
    this.element = h('div', {class: 'term'}, this.status, this.output, this.activity);
    void this.start();
  }

  /** Hear when a run starts, grows or ends; returns how to stop. */
  watch(fn: () => void): () => void { this.watchers.add(fn); return () => this.watchers.delete(fn); }
  // Over a copy: a watcher may stop and start watching while it is told,
  // and a Set visits what is added during its iteration.
  private tell() { for (const fn of [...this.watchers]) fn(); }

  /** Type `text` into the shell, one line per line. False while it is not running. */
  send(text: string): boolean {
    if (!this.live || (!this.worker && !this.native)) return false;
    const lines = text.endsWith('\n') ? text : `${text}\n`;
    this.print(lines);
    this.runs.push({line: lines.trimEnd(), output: '', started: Date.now(), ms: null});
    if (this.runs.length > RUNS) this.runs.shift();
    this.inputWait = false;
    this.sleepsUntil = 0;
    this.heard = Date.now();
    this.follow();
    this.tell();
    if (this.native) { void this.native.input(lines).catch(() => this.end(t('Not running'))); return true; }
    const bytes = new TextEncoder().encode(lines);
    this.worker!.postMessage({type: 'input', bytes}, [bytes.buffer]);
    return true;
  }

  private print(s: string) {
    this.text += strip(s);
    // It may come in pieces; it goes once whole.
    if (!this.ttySaid && this.text.includes(NO_TTY)) { this.text = this.text.replace(NO_TTY, ''); this.ttySaid = true; }
    // Keep the last 200k characters; older output scrolls away.
    if (this.text.length > 200_000) this.text = this.text.slice(-150_000);
    // Drawn once a frame, however many pieces came in it. Output comes a stdio buffer (about 1 KB) at a time,
    // and drawing up to 200k characters and scrolling to them for each piece measured about 22 ms a piece in
    // Chromium: 1 MB of output held the page for 22 s; drawn once for every 17 pieces, 1.3 s.
    this.painting ||= requestAnimationFrame(() => {
      this.painting = 0;
      this.output.textContent = this.text;
      this.output.scrollTop = this.output.scrollHeight;
    });
  }
  private painting = 0;

  /** Output goes on screen and into the run in progress, which ends at the next prompt. */
  private received(s: string) {
    this.print(s);
    const run = this.runs.at(-1);
    if (!run || run.ms !== null) return;
    run.output += strip(s);
    const end = PROMPT.exec(run.output);
    if (end) {
      run.output = run.output.slice(0, end.index);
      run.ms = Date.now() - run.started;
      this.follow();
      // On the root the shell wrote the repo itself: everyone reads it again.
      if (this.native) { store.changedOutside(this.repo, this.id); void this.measure(); }
    }
    else if (run.output.length > 100_000) run.output = run.output.slice(-80_000);
    this.tell();
  }

  private readonly id = `shell:${Math.random().toString(36).slice(2)}`;
  private activity: HTMLElement;
  /** When the worker last said anything. */
  private heard = 0;
  /** Paused with a run open: what runs reads what is typed. */
  private inputWait = false;
  /** Asleep with a run open, until this time (Date.now()): it goes on by itself, and hears Interrupt meanwhile. */
  private sleepsUntil = 0;
  private ticker = 0;
  private unwatch: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** What the shell may still write back, in files and bytes: the snapshot's limits. */
  private budget = {files: LIMIT_FILES, bytes: LIMIT_BYTES};

  /** Write the shell's changes back to the repo, in order, one batch after another. */
  private writeBack(c: {dirs: string[]; files: {path: string; bytes: Uint8Array; existed: boolean}[]; removed: string[]}) {
    this.queue = this.queue.then(async () => {
      const skipped: string[] = [];
      for (const d of c.dirs) await store.mkdir(this.repo, d, this.id).catch(() => skipped.push(`${d}/`));
      for (const f of c.files) {
        let text: string;
        try { text = new TextDecoder('utf-8', {fatal: true}).decode(f.bytes); } catch { skipped.push(f.path); continue; }
        if (f.bytes.length > 256 * 1024 || this.budget.files <= 0 || this.budget.bytes < f.bytes.length) { skipped.push(f.path); continue; }
        this.budget.files--;
        this.budget.bytes -= f.bytes.length;
        const at = f.path.lastIndexOf('/');
        const ok = f.existed
          ? store.write(this.repo, f.path, text, this.id)
          : store.add(this.repo, at < 0 ? '' : f.path.slice(0, at), f.path.slice(at + 1), text, this.id)
            .catch(() => store.write(this.repo, f.path, text, this.id));
        await ok.catch(() => skipped.push(f.path));
      }
      for (const r of c.removed) await store.remove(this.repo, r, this.id).catch(() => skipped.push(r));
      if (skipped.length) this.status.textContent = t('Not written back to the repo: {list}', {list: `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}`});
    });
  }

  /** On the root, what the Prompt's processes hold, read from the host. */
  private async measure() {
    // Measured every 3 s: one not answered keeps the last figures until the next.
    const h: Held | null = await this.native?.held().catch(() => null) ?? null;
    if (!h) return;
    this.memory = h.memory;
    this.processes = h.processes;
    this.tell();
  }

  /** The distribution's root, on this machine's kernel (l3 open). */
  private async startRoot(): Promise<boolean> {
    const root = await rootStatus();
    if (!root?.current) return false;
    this.native = await promptOpen(this.repo, {
      output: (text) => { this.heard = Date.now(); this.received(text); },
      exit: (code) => { if (this.live) this.end(t('Exited ({code})', {code})); },
    });
    this.on = 'root';
    this.live = true;
    this.tell();
    this.status.textContent = '';
    void this.measure();
    this.measuring = every(3000, () => this.measure());
    return true;
  }

  private async start() {
    try {
      // In the app the Prompt is the distribution's root; l3 through xlat
      // only until a root is installed, and the Runtime page says which.
      let why = '';
      if (isNative && await this.startRoot().catch((e) => { why = errorText(e); return false; })) return;
      this.on = 'l3';
      // While l3 comes, the status says how far it is and what it is doing.
      const unwatch = watchLoad((s) => { this.status.textContent = loadWords(s); });
      // The whole root not reached: the Prompt runs l3 and its BusyBox alone, and says why.
      let rootWhy = '';
      const [land, copy, root] = await Promise.all([loadUserland(), snapshot(this.repo),
        loadWebRoot().catch((e: unknown) => { rootWhy = errorText(e); return null; })]).finally(unwatch);
      const worker = new Worker(new URL('../../../xlat/runtime/worker.mjs', import.meta.url), {type: 'module'});
      this.worker = worker;
      worker.onmessage = ({data}) => {
        this.heard = Date.now();
        if (data.type === 'output') this.received(new TextDecoder().decode(data.bytes));
        else if (data.type === 'changes') this.writeBack(data);
        else if (data.type === 'freed') {
          this.memory = data.after.total;
          this.spare = data.after.spare;
          this.freed = data.before.total - data.after.total;
          this.tell();
        }
        else if (data.type === 'waiting') {
          this.memory = data.memory ?? 0;
          this.spare = data.held?.spare ?? 0;
          // Paused with a run still open: what runs reads what is typed, or sleeps for a while.
          const open = this.runs.at(-1)?.ms === null;
          this.inputWait = open && data.for !== 'time';
          this.sleepsUntil = open && data.for === 'time' ? Date.now() + data.ms : 0;
          this.follow();
          this.tell();
        }
        else if (data.type === 'exit') this.end(t('Exited ({code})', {code: data.status >> 8}));
        else if (data.type === 'error') this.end(t('Halted: {message}', {message: data.message.split('\n')[0]}));
      };
      const cwd = `/root/${this.repo}`;
      worker.postMessage({
        type: 'start', translator: land.translator,
        // The person's dotfiles, fresh in every Prompt.
        files: [...land.files, ...dotfiles.asFiles(), ...copy.files],
        dirs: [...land.dirs, ...copy.dirs],
        links: land.links,
        // The whole root, where this build has it: the same programs as the app's Prompt.
        ...(root ? {root: {index: root.index, url: root.url}} : {}),
        argv: ['/bin/sh', '-i'],
        // l3 here sees repos where the shell does, under /root; with the root, its shell reads as the app's.
        env: ['HOME=/root', 'TERM=dumb', 'LENGTH3_REPOS=/root', 'L3_PROMPT=1', `LENGTH3_LANG=${currentLang()}`, `LENGTH3_REPO=${this.repo}`,
          ...(root ? ['PATH=/bin:/usr/bin:/sbin:/usr/sbin', 'ENV=/etc/length3/shrc'] : ['PATH=/bin', 'PS1=$PWD $ '])],
        cwd,
        mirror: cwd,
      });
      // What is saved elsewhere comes into the shell's copy.
      this.unwatch = onChange((c) => {
        if (c.repo !== this.repo || c.by === this.id || c.what === 'repo') return;
        const what = c.what === 'file' ? new TextEncoder().encode(c.text ?? '') : c.what === 'dir' ? 'dir' : null;
        this.worker?.postMessage({type: 'put', path: c.path, what});
      });
      // Running is the usual state and says nothing; only what is missing is said.
      this.status.textContent = why ? t('Could not open on the root ({why})', {why})
        : rootWhy ? t('Without the whole root ({why}): l3 and BusyBox only', {why: rootWhy})
        : copy.complete ? '' : t('Large files and binaries are not included');
      this.live = true;
      this.tell();
    } catch (e) {
      this.end(t('Could not start: {message}', {message: errorText(e)}));
    }
  }

  /**
   * In a browser, give back what the Prompt keeps for programs it ran
   * (their translations, the translator's memory, root files read) without
   * stopping it; programs run again are translated and read again.
   */
  free() { this.worker?.postMessage({type: 'free'}); }

  /** Whether it has ended (stopped, exited, or never started): only then does its switch start it again. */
  ended = false;

  /** Whether the shell is running (its worker or its root process exists). */
  get running() { return this.live && (this.worker !== null || this.native !== null); }

  /**
   * Stop: the worker and every guest process in it end at once (terminate is
   * synchronous), so what they held is the browser engine's to free. Only
   * then does it say so.
   */
  stop() {
    if (!this.native) { this.end(t('Stopped')); return; }
    // On the root: stopped only once the host shows none of its processes left.
    const n = this.native;
    void n.close().then((s) => {
      this.stopped = s;
      const back = s.before.memory ? t('{size} given back', {size: bytes(s.before.memory)}) : '';
      this.end(s.left ? tn('Stopping ({n} process left)', 'Stopping ({n} processes left)', s.left)
        : back ? t('Stopped ({back} · {ms} ms)', {back, ms: String(s.ms)}) : t('Stopped'));
    }, () => this.end(t('Stopped')));
  }

  /**
   * While a line runs, say what it is doing, once it has taken a moment:
   * reading input (Interrupt reaches it: the kernel is paused), running and
   * still talking (Interrupt lands when it next stops), sleeping (running,
   * quiet, and Interrupt reaches it: the kernel is paused until its time),
   * or running without a word for a while, when a busy worker cannot hear
   * anything and only starting again is sure (what it changed since the
   * last line is not written back).
   */
  private follow() {
    clearInterval(this.ticker);
    const run = this.runs.at(-1);
    if (!this.live || !run || run.ms !== null) { this.activity.replaceChildren(); return; }
    // Made once for the run and only moved in or out: a button drawn anew each second would drop the keyboard on it.
    const said = h('span', {class: 'muted'});
    const cut = h('button', {class: 'button small-button', type: 'button'}, t('Interrupt'));
    cut.addEventListener('click', () => this.interrupt());
    const again = h('button', {class: 'button small-button', type: 'button'}, t('Stop and start again'));
    again.addEventListener('click', () => this.restart());
    const paint = () => {
      if (run.ms !== null || !this.live) { clearInterval(this.ticker); this.activity.replaceChildren(); return; }
      const s = Math.floor((Date.now() - run.started) / 1000);
      // A sleep is quiet but heard: quiet is counted from when it is over.
      const now = Date.now(), quiet = Math.floor((now - Math.max(this.heard, Math.min(this.sleepsUntil, now))) / 1000);
      said.textContent = this.inputWait ? t('Waiting for input') : `${t('Running {n}s', {n: s})}${quiet >= 5 ? ` · ${t('no output')}` : ''}`;
      const parts = this.inputWait ? [said, cut] : s < 2 ? [] : quiet >= 10 ? [said, cut, again] : [said, cut];
      const shown = [...this.activity.childNodes];
      if (parts.length !== shown.length || parts.some((x, i) => x !== shown[i])) this.activity.replaceChildren(...parts);
    };
    paint();
    this.ticker = window.setInterval(paint, 1000);
  }

  /** Ctrl-C: what runs in front of the shell ends, and the shell goes on. */
  interrupt() {
    if (!this.live) return;
    if (this.native) { void this.native.interrupt(); return; }
    this.worker?.postMessage({type: 'interrupt'});
    this.inputWait = false;
    this.sleepsUntil = 0;
  }

  /** A new shell for this repo in this place. */
  restart() {
    this.stop();
    sessions.delete(this.repo);
    this.element.replaceWith(terminalFor(this.repo));
  }

  private end(message: string) {
    this.ended = true;
    clearInterval(this.ticker);
    this.activity.replaceChildren();
    this.unwatch?.();
    this.unwatch = null;
    this.worker?.terminate();
    this.worker = null;
    this.measuring?.stop();
    this.measuring = null;
    this.native?.forget();
    this.native = null;
    this.live = false;
    this.memory = 0;
    this.processes = 0;
    this.tell();
    const restart = h('button', {class: 'button', type: 'button'}, t('Start again'));
    restart.addEventListener('click', () => this.restart());
    this.status.replaceChildren(message, ' ', restart);
  }
}

/** Every session started in this window, running or stopped. */
export const allSessions = (): [string, Session][] => [...sessions];

/** The repo's session if one is running, without starting one. */
export const sessionIfAny = (repo: string): Session | undefined => sessions.get(repo);

export function sessionFor(repo: string): Session {
  let s = sessions.get(repo);
  if (!s) { s = new Session(repo); sessions.set(repo, s); }
  return s;
}

export const terminalFor = (repo: string): HTMLElement => sessionFor(repo).element;
