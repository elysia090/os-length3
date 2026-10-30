import * as dotfiles from '../../home/dotfiles.ts';
import {agentUse} from '../../home/agent-key.ts';
import {store} from '../../repos/repos.ts';
import {bytes, h} from '../../ui/dom.ts';
import {isNative, promptOpen, rootFetch, rootStatus, type Holding, type Stopped} from '../../app/host.ts';
import {currentLang, onLang, t, tn} from '../../i18n.ts';
import {filesNow, keepMore, keepReached, keepTranslation, keptNow, loadL3, promptWorker, usedKept, warmL3, watchLoad, type L3, type Stage} from '../../prompt/userland.ts';
import {every} from '../../app/runs.ts';
import {errorText} from '../../app/errors.ts';
import {still} from '../../ui/glide.ts';
import {Activity} from './activity.ts';
import {endLine, goDark, jolt, switchOver} from './ending.ts';
import {Output, strip} from './output.ts';
import {FirstPrompt, waitsAt} from './prompt-line.ts';
import {mirror, snapshot, WriteBack} from './repo-copy.ts';

// A shell per repo: in a browser, l3's root (its BusyBox sh, and every other
// program of it) translated in a Worker; in the app, the same root on the
// machine. Sessions outlive page switches: the workbench re-attaches the same element. A
// session only shows output (output.ts); what is typed comes from the prompt box through
// send(). The repo in the shell is the repo: what the shell changes under
// /root/<repo> is written back through the store, and what is saved
// elsewhere (Forge, Git, l3 on the host… through the store) is put into the
// shell's copy (repo-copy.ts).

const sessions = new Map<string, Session>();
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

/**
 * What a browser's Prompt's Worker is told to start with: l3, the repo's copy (`copy`), what was kept of l3, and the
 * Agent's key, if one is kept on this device, under its maker's variable (`key`), as the app's Prompts have it.
 */
function startMessage(repo: string, l3: L3, copy: Awaited<ReturnType<typeof snapshot>>, kept: unknown, key: string[]) {
  const cwd = `/root/${repo}`;
  return {
    type: 'start', translator: l3.translator,
    // l3's hot programs at their own paths (the same bytes as the root's), the person's dotfiles fresh in every Prompt, and the repo.
    files: [...filesNow(l3), ...dotfiles.asFiles(), ...copy.files],
    dirs: copy.dirs,
    // The whole root around them: the same programs, files and links as the app's Prompt, each file read when a program first opens it.
    root: {index: l3.index, url: l3.url},
    argv: ['/bin/sh', '-i'],
    // l3 here sees repos where the shell does, under /root; its shell reads as the app's.
    env: ['HOME=/root', 'TERM=dumb', 'LENGTH3_REPOS=/root', 'L3_PROMPT=1', `LENGTH3_LANG=${currentLang()}`, `LENGTH3_REPO=${repo}`,
      'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'ENV=/etc/length3/shrc', ...key],
    cwd,
    mirror: cwd,
    // The translations Prompts before it made of the root's programs, read when a program is first run.
    kept,
  };
}

/**
 * A repo's shell: started once it is written to (shown, it holds nothing), what it printed on its element, the lines
 * run in it, how it ended.
 */
export class Session {
  readonly element: HTMLElement;
  private out = new Output();
  private status: HTMLElement;
  private activity: Activity;
  private live = false;
  private worker: Worker | null = null;
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
  /** On the root, still being prepared (.packages, .setup), as its record says: what it holds is what prepares it. */
  preparing = false;
  /** What it runs on: the distribution's root on this machine, or l3 through xlat. */
  on: 'root' | 'l3' | null = null;
  /** How the last stop went, on the root: what it held, and how long until none was left. */
  stopped: Stopped | null = null;
  private native: Awaited<ReturnType<typeof promptOpen>> | null = null;
  /** What the root's processes hold, read every 3 s while the page is in view. */
  private measuring: {stop(): void} | null = null;
  private readonly id = `shell:${Math.random().toString(36).slice(2)}`;
  /** l3, in a browser, until the shell's first prompt line. */
  private l3: L3 | null = null;
  /** The l3 it runs, in a browser. */
  private l3of: L3 | null = null;
  private unwatch: (() => void) | null = null;
  private copy: WriteBack;
  /** Whether the shell has waited at a prompt line yet; what was sent before it did, held for it. */
  private first = new FirstPrompt();
  /** The prompt line last told to the watchers. */
  private toldLine = '';

  constructor(repo: string) {
    this.repo = repo;
    // Nothing to say until it is written to: that starts it.
    this.status = h('p', {class: 'muted small'});
    // A Prompt that ended says so in the language chosen since, as the rest of the page does.
    onLang(() => this.sayEnded());
    this.activity = new Activity({live: () => this.live, interrupt: () => this.interrupt(), restart: () => this.restart()});
    // Folded away (put back into the box), what it printed before is one line at the screen's top, pressed to open.
    this.earlier = h('button', {type: 'button', class: 'term-earlier', hidden: ''}) as HTMLButtonElement;
    this.earlier.addEventListener('click', () => this.unfold());
    this.element = h('div', {class: 'term'}, this.status, this.earlier, this.out.element, this.activity.element);
    this.copy = new WriteBack(repo, this.id, (said) => { this.status.textContent = said; });
  }

  /** Whether it was started: written to, or begun being written to (box.ts). Shown alone, it is not. */
  private begun = false;

  /** Started, once: what is written to it starts it, never its being shown. */
  begin() {
    if (this.begun) return;
    this.begun = true;
    this.status.textContent = t('Starting…');
    void this.start();
  }

  /** The prompt line the shell waits at (`garden $ `), or nothing while a line runs or it is not running. */
  get promptLine(): string {
    if (!this.live || this.runs.at(-1)?.ms === null) return '';
    return waitsAt(this.out.lastLine);
  }

  /** Hear when a run starts, grows or ends; returns how to stop. */
  watch(fn: () => void): () => void { this.watchers.add(fn); return () => this.watchers.delete(fn); }
  // Over a copy: a watcher may stop and start watching while it is told,
  // and a Set visits what is added during its iteration.
  private tell() { this.toldLine = this.promptLine; for (const fn of [...this.watchers]) fn(); }

  /** How long until what was printed last has all come in, in ms: what comes after it (the prompt line) waits that long. */
  settlesIn(): number { return this.out.settlesIn(); }

  /** Type `text` into the shell, one line per line, starting it if it was not yet. False once it has ended. */
  send(text: string): boolean {
    if (this.ended) return false;
    this.begin();
    const lines = text.endsWith('\n') ? text : `${text}\n`;
    // Coming up, or up but the shell has not yet said the prompt line it waits at (a cold start is some seconds): the
    // line waits for it, then goes, drawn after that line as any run is (sent before it, it was drawn before the
    // prompt line, and what it printed read as the line run).
    if (!this.first.waited) { this.first.hold(lines); return true; }
    if (!this.live || (!this.worker && !this.native)) return false;
    this.out.sent(lines);
    this.runs.push({line: lines.trimEnd(), output: '', started: Date.now(), ms: null});
    if (this.runs.length > RUNS) this.runs.shift();
    this.activity.inputWait = false;
    this.activity.sleepsUntil = 0;
    this.activity.heard = Date.now();
    this.follow();
    this.tell();
    if (this.native) { void this.native.input(lines).catch(() => this.end(() => t('Not running'))); return true; }
    const bytes = new TextEncoder().encode(lines);
    this.worker!.postMessage({type: 'input', bytes}, [bytes.buffer]);
    return true;
  }

  /**
   * Something the box did that is not the shell's (an issue written, a TODO added: `head` and its words), in the
   * Prompt's flow as it came, pressed to `go` to it (output.ts). Its line is returned, there now, for what lands on it.
   */
  note(head: string, words: string, go: (row: HTMLElement) => void): HTMLElement { return this.out.note(head, words, go); }
  /** Under a question asked of the Agent (`row`, note's), where its answer comes in (output.ts). */
  answer(row: HTMLElement): HTMLElement { return this.out.answer(row); }

  /** The line over what is folded away. */
  private earlier: HTMLButtonElement;

  /**
   * Put back into the box: up again, the screen starts at its prompt line, what it printed before folded away under
   * one line that opens it (output.ts fold). The pane still lists the lines run.
   */
  fold() {
    const n = this.out.fold();
    this.earlier.hidden = !n;
    this.earlier.textContent = t('Earlier ({n})', {n});
  }

  /** What was folded away, opened again where it stood. */
  unfold() {
    this.out.unfold();
    this.earlier.hidden = true;
  }

  /** Output goes on screen and into the run in progress, which ends at the next prompt. */
  private received(s: string) {
    if (this.status.textContent === t('Starting…')) this.status.textContent = '';
    this.out.print(s);
    const waits = !!waitsAt(this.out.lastLine);
    this.first.heard(waits, (held) => { if (this.live) this.send(held); });
    // Its first prompt line: up. What the Prompts after it are given ahead of time (l3's translation) comes a moment later, quietly,
    // so it takes nothing from the first line run.
    if (this.l3 && waits) { const l3 = this.l3; this.l3 = null; setTimeout(() => warmL3(l3), 3000); }
    const run = this.runs.at(-1);
    // Waiting at a prompt line it had not shown yet (its first, or after output of its own): watchers hear.
    if (!run || run.ms !== null) { if (this.promptLine !== this.toldLine) this.tell(); return; }
    this.into(run, s, waits);
    this.tell();
  }

  /** What came (`s`) goes into the run in progress; at the prompt line (`waits`), the run is over. */
  private into(run: Run, s: string, waits: boolean) {
    run.output += strip(s);
    // (A run's output starts on a line of its own, after the line sent: its last line is the screen's.)
    if (waits) {
      run.output = run.output.slice(0, Math.max(0, run.output.lastIndexOf('\n')));
      run.ms = Date.now() - run.started;
      this.follow();
      // On the root the shell wrote the repo itself: everyone reads it again.
      if (this.native) { store.changedOutside(this.repo, this.id); void this.measure(); }
    }
    else if (run.output.length > 100_000) run.output = run.output.slice(-80_000);
  }

  /** On the root, what the Prompt's processes hold, read from the host. */
  private async measure() {
    // Measured every 3 s: one not answered keeps the last figures until the next.
    const h: Holding | null = await this.native?.held().catch(() => null) ?? null;
    if (!h) return;
    this.memory = h.memory;
    this.processes = h.processes;
    this.preparing = h.preparing;
    this.tell();
  }

  private async start() {
    try {
      if (isNative) await this.startNative(); else await this.startL3();
    } catch (e) {
      // Said short at the Prompt's foot; why is the line's title, there when asked for, not a sentence beside the switch.
      const why = errorText(e);
      this.end(() => t('Could not start'), why);
    }
  }

  /**
   * In the app the Prompt is the distribution's root on this machine, and nothing else: l3 through xlat is the
   * browser's (its build carries none). The first one fetches the root it runs on, as the browser's first fetches l3,
   * the status saying how far it is (Runtime fetches it ahead, and chooses another).
   */
  private async startNative() {
    if (await this.startRoot()) return;
    await rootFetch((got, of, retry) => {
      this.status.textContent = retry ? t('{why}; continuing where it stopped', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
    });
    if (await this.startRoot()) return;
    throw new Error(t('There is no root on this device yet: Runtime installs it'));
  }

  /** The distribution's root, on this machine's kernel (l3 open). */
  private async startRoot(): Promise<boolean> {
    const root = await rootStatus();
    if (!root?.current) return false;
    this.native = await promptOpen(this.repo, {
      output: (text) => { this.activity.heard = Date.now(); this.received(text); },
      exit: (code) => { if (this.live) this.end(() => t('Exited ({code})', {code})); },
    });
    this.on = 'root';
    this.live = true;
    this.tell();
    this.status.textContent = '';
    void this.measure();
    this.measuring = every(3000, () => this.measure());
    return true;
  }

  /** In a browser: l3's root in a Worker, given the repo's copy. */
  private async startL3() {
    this.on = 'l3';
    // While l3 comes, the status says how far it is and what it is doing.
    const unwatch = watchLoad((s) => { this.status.textContent = loadWords(s); });
    // Its Worker is made now, while l3 and the repo's copy come, and starts the Workers its first threads run in:
    // their scripts are loaded and run by the time it is given what to run, rather than after.
    const worker = promptWorker();
    this.worker = worker;
    worker.postMessage({type: 'warm'});
    worker.onmessage = ({data}) => this.fromWorker(data);
    const [l3, copy, kept, use] = await Promise.all([loadL3(), snapshot(this.repo), loadL3().then(keptNow).catch(() => null), agentUse()]).finally(unwatch);
    // Stopped while it came: it stays stopped.
    if (this.worker !== worker) return;
    this.l3of = l3;
    worker.postMessage(startMessage(this.repo, l3, copy, kept, use ? [`${use.variable}=${use.key}`] : []));
    // What is saved elsewhere comes into the shell's copy.
    this.unwatch = mirror(this.repo, this.id, (m) => this.worker?.postMessage(m));
    // Running is the usual state and says nothing; only what is missing is said. Until the shell says its first
    // line (a cold start is some seconds), it is still starting, and says so: not an empty Prompt.
    this.status.textContent = copy.complete ? t('Starting…') : t('Large files and binaries are not included');
    this.live = true;
    this.l3 = l3;
    this.tell();
  }

  /** What the Worker says. */
  private fromWorker(data: MessageEvent['data']) {
    this.activity.heard = Date.now();
    switch (data.type) {
      case 'output': this.received(new TextDecoder().decode(data.bytes)); break;
      case 'changes': this.copy.write(data); break;
      // Code its shell reached later, a program of the root it translated and the code that reached later, and what it
      // read of what was kept: kept for the Prompts after it, and counted as used.
      case 'more': keepMore(data.path, data.from, data.more); break;
      case 'translated': if (this.l3of) keepTranslation(this.l3of, data.origin, data.wasm, data.segments); break;
      case 'reached': if (this.l3of) keepReached(this.l3of, data.origin, data.from, data.more); break;
      case 'used': usedKept(data.urls); break;
      // Where its threads run: each in a Worker of its own (the page is cross-origin isolated), or in turn in this one.
      case 'threads': this.element.dataset.threads = data.apart ? 'apart' : 'in-turn'; break;
      case 'freed':
        this.memory = data.after.total;
        this.spare = data.after.spare;
        this.freed = data.before.total - data.after.total;
        this.tell();
        break;
      case 'waiting': this.waiting(data); break;
      case 'exit': this.end(() => t('Exited ({code})', {code: data.status >> 8})); break;
      case 'error': this.end(() => t('Halted: {message}', {message: data.message.split('\n')[0]})); break;
    }
  }

  /** The Worker paused: what it holds, and with a run still open, whether what runs reads what is typed or sleeps for a while. */
  private waiting(data: {memory?: number; held?: {spare: number}; for: string; ms: number}) {
    this.memory = data.memory ?? 0;
    this.spare = data.held?.spare ?? 0;
    const open = this.runs.at(-1)?.ms === null;
    // ('read': a program's kept translation is being read, and it goes on by itself once it is.)
    this.activity.inputWait = open && data.for === 'input';
    this.activity.sleepsUntil = open && data.for === 'time' ? Date.now() + data.ms : 0;
    this.follow();
    this.tell();
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
   * then does it say so, and the promise is kept once it has.
   */
  stop(): Promise<void> {
    if (!this.native) { this.end(() => t('Stopped')); return Promise.resolve(); }
    // On the root: stopped only once the host shows none of its processes left.
    const n = this.native;
    return n.close().then((s) => {
      this.stopped = s;
      this.end(() => {
        const back = s.before.memory ? t('{size} given back', {size: bytes(s.before.memory)}) : '';
        return s.left ? tn('Stopping ({n} process left)', 'Stopping ({n} processes left)', s.left)
          : back ? t('Stopped ({back} · {ms} ms)', {back, ms: String(s.ms)}) : t('Stopped');
      });
    }, () => this.end(() => t('Stopped')));
  }

  /** While a line runs, say what it is doing, once it has taken a moment (activity.ts). */
  private follow() { this.activity.follow(this.runs.at(-1)); }

  /** Ctrl-C: what runs in front of the shell ends, and the shell goes on. */
  interrupt() {
    if (!this.live) return;
    // Said where the run is cut, as a terminal says it; the screen jolts as it is cut, at once (it answers the hand).
    if (this.runs.at(-1)?.ms === null) {
      this.out.print('^C');
      this.activity.cut();
      jolt(this.element, this.out.element);
    }
    if (this.native) { void this.native.interrupt(); return; }
    this.worker?.postMessage({type: 'interrupt'});
    this.activity.inputWait = false;
    this.activity.sleepsUntil = 0;
  }

  /** A new shell for this repo in this place. */
  restart() {
    this.restarting = true;
    if (!this.ended) this.stop();
    sessions.delete(this.repo);
    // Started again on purpose: the new one starts now. Whoever showed this one hears that another has taken its place.
    const next = sessionFor(this.repo);
    next.begin();
    switchOver(this.element, next.element, () => this.tell());
  }
  /** Started again: its own ending is not shown going dark, the new one comes at once. */
  private restarting = false;

  /** What the ended Prompt says, drawn again in the language chosen meanwhile. */
  private said: (() => string) | null = null;
  /** Why it ended, when it did not start: the title of what it says. */
  private why = '';

  private end(message: () => string, why = '') {
    this.ended = true;
    this.said = message;
    this.why = why;
    this.activity.end();
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
    this.preparing = false;
    this.tell();
    this.sayEnded(true);
  }

  /** What it says once ended; `now` as it ends, which is seen: the switch goes over to off, and the screen goes dark. */
  private sayEnded(now = false) {
    if (!this.ended || !this.said) return;
    const {line, power} = endLine(this.said(), this.why, () => this.restart());
    this.element.classList.add('ended');
    this.status.replaceChildren();
    this.out.ended(line);
    if (!now || this.restarting || still()) return;
    goDark(power, this.out.element);
  }
}

/** Every session started in this window, running or stopped. */
export const allSessions = (): [string, Session][] => [...sessions];

/** The repo's session if one is running, without starting one. */
export const sessionIfAny = (repo: string): Session | undefined => sessions.get(repo);

/** How the repo's Prompt holds it: 'busy' while a line runs in it, 'idle' while it waits at its prompt line, null when none runs. */
export function promptHolds(repo: string): 'busy' | 'idle' | null {
  const s = sessions.get(repo);
  if (!s?.running) return null;
  return s.runs.at(-1)?.ms === null ? 'busy' : 'idle';
}

/** The repo's Prompt stopped, before its repo goes from here or takes another name; `gone`: let go of, too (its copy is of a repo no longer here). */
export async function stopPrompt(repo: string, gone = false) {
  const s = sessions.get(repo);
  if (s?.running) await s.stop();
  if (gone) sessions.delete(repo);
}

/** The repo's session, made if it has none (made, it is not started: writing to it starts it). */
export function sessionFor(repo: string): Session {
  let s = sessions.get(repo);
  if (!s) { s = new Session(repo); sessions.set(repo, s); }
  return s;
}

/**
 * The repo's Prompt as it is shown, its session made if it has none. Shown, it is not started; what it will run (l3,
 * in a browser) is read ahead meanwhile, so the first line written does not wait for it, and holds no repo.
 */
export function terminalFor(repo: string): HTMLElement {
  if (!isNative) void loadL3().catch(() => { /* said by the Prompt that starts, if it fails again there */ });
  return sessionFor(repo).element;
}
