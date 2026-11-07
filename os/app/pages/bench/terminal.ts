import * as dotfiles from '../../home/dotfiles.ts';
import {agentUse} from '../../account/agent-key.ts';
import {store} from '../../repos/repos.ts';
import {bytes, h} from '../../ui/dom.ts';
import {promptOpen, rootFetch, rootHere, rootStatus, type Holding, type Stopped} from '../../host/host.ts';
import {currentLang, onLang, t, tn} from '../../i18n/i18n.ts';
import {filesNow, hearLater, keepMore, keepReached, keepTranslation, keptNow, loadL3, promptWorker, readyPrompt, takeReady, usedKept, warmL3, watchLoad, type L3, type Stage} from '../../prompt/userland.ts';
import {every} from '../../host/runs.ts';
import {errorText} from '../../host/errors.ts';
import {still} from '../../ui/glide.ts';
import {aheadFor, hearAhead, holdAhead, translateAhead} from '../../prompt/ahead.ts';
import {Activity} from './activity.ts';
import {endLine, goDark, jolt, switchOver} from './ending.ts';
import {clips, heldBack, OSC, RAN} from './osc.ts';
import {Output, strip} from './output.ts';
import {scrollThumb} from '../../ui/scroll-thumb.ts';
import {asOne, FirstPrompt, waitsAt} from './prompt-line.ts';
import {mirror, snapshot, WriteBack} from './repo-copy.ts';
import {sessions, type Prompt, type Run} from './sessions.ts';

// A shell per repo: in a browser, l3's root (its BusyBox sh, and every other
// program of it) translated in a Worker; in the app, the same root on the
// machine. Sessions outlive page switches: the workbench re-attaches the same element. A
// session only shows output (output.ts); what is typed comes from the prompt box through
// send(). The repo in the shell is the repo: what the shell changes under
// /root/<repo> is written back through the store, and what is saved
// elsewhere (Forge, Git, l3 on the host… through the store) is put into the
// shell's copy (repo-copy.ts).

const RUNS = 50;
/** The terminal's size, as programs are told it. */
const COLS = 80, ROWS = 24;
/** termios bits the page reads keys by: signals from keys (ISIG), a line at a time (ICANON), Enter read as a line feed
 * (ICRNL); lines put out with a carriage return (OPOST and ONLCR). */
const ISIG = 1, ICANON = 2, ECHO = 8, NOFLSH = 0x80, IEXTEN = 0x8000, OPOST = 1, ONLCR = 4, ICRNL = 0x100;

/** What a key sends a terminal's program (`app`: the arrows as an application's, as it asked), or null for none. */
export function keyBytes(e: KeyboardEvent, app: boolean): string | null {
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
  const csi = (final: string, n = '1') => (mod > 1 ? `\x1b[${n};${mod}${final}` : n === '1' && app && 'ABCDHF'.includes(final) ? `\x1bO${final}` : n === '1' ? `\x1b[${final}` : `\x1b[${n}${final}`);
  const tilde = (n: number) => (mod > 1 ? `\x1b[${n};${mod}~` : `\x1b[${n}~`);
  const named: Record<string, () => string> = {
    ArrowUp: () => csi('A'), ArrowDown: () => csi('B'), ArrowRight: () => csi('C'), ArrowLeft: () => csi('D'),
    Home: () => csi('H'), End: () => csi('F'), PageUp: () => tilde(5), PageDown: () => tilde(6), Insert: () => tilde(2), Delete: () => tilde(3),
    Enter: () => (e.altKey ? '\x1b\r' : '\r'), Tab: () => (e.shiftKey ? '\x1b[Z' : '\t'), Escape: () => '\x1b',
    Backspace: () => (e.ctrlKey ? '\x08' : e.altKey ? '\x1b\x7f' : '\x7f'),
    F1: () => '\x1bOP', F2: () => '\x1bOQ', F3: () => '\x1bOR', F4: () => '\x1bOS',
    F5: () => tilde(15), F6: () => tilde(17), F7: () => tilde(18), F8: () => tilde(19), F9: () => tilde(20), F10: () => tilde(21), F11: () => tilde(23), F12: () => tilde(24),
  };
  if (named[e.key]) return named[e.key]();
  if (e.key.length !== 1 || e.metaKey) return null;
  // Ctrl and a letter (or @ [ \ ] ^ _ and space): the control letter it stands for.
  if (e.ctrlKey && !e.altKey) {
    const c = e.key === ' ' ? 0 : e.key.toUpperCase().charCodeAt(0);
    if (c === 0 || (c >= 0x40 && c <= 0x5f)) return String.fromCharCode(c & 0x1f);
    if (e.key === '?') return '\x7f';
    return null;
  }
  return e.altKey ? `\x1b${e.key}` : e.key;
}

/** One line for where loading l3 is; nothing once it is ready. */
function loadWords(s: Stage): string {
  const of = (got: number, all: number) => (all ? `${bytes(got)} / ${bytes(all)}` : '');
  switch (s.at) {
    case 'fetch': return `${t('Loading l3 ({size})', {size: of(s.got, s.of)})}${s.quiet ? ` · ${t('Waiting for reply ({n}s)', {n: s.quiet})}` : ''}`;
    case 'retry': return `${t('{why}. Resuming download (attempt {n})', {why: s.why, n: s.attempt})}${s.got ? ` ${of(s.got, s.of)}` : ''}`;
    case 'prepare': return t('Preparing…');
    case 'ready': return t('Starting…');
    case 'failed': return '';
  }
}

/** How long starting takes before the Prompt says it is starting: a start that comes at once says nothing (said at
 * once, it was there a frame, and moved the line under it down and back). */
const STARTING_SAID = 600;

/** The Prompt's shell, as the app's Prompts run it. */
const SHELL = ['/bin/sh', '-i'];
/** The person's time zone by its name, as the browser knows it: the root has every zone, so its clock reads as theirs. */
function zone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(z) ? z : 'UTC';
  } catch { return 'UTC'; }
}
/** Its environment, as the app's Prompts on the machine have it (core's prompt/launch.rs): l3 here sees repos where the
 * shell does, under /root; its shell reads as the app's; its clock is the person's; its terminal is a colour xterm's
 * (output.ts draws what one draws, vt.ts). */
const shellEnv = (repo: string) => ['HOME=/root', 'USER=root', 'LOGNAME=root', 'SHELL=/bin/sh', 'TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8',
  `TZ=${zone()}`, 'LENGTH3_REPOS=/root', 'L3_PROMPT=1', `LENGTH3_LANG=${currentLang()}`, `LENGTH3_REPO=${repo}`,
  'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'ENV=/etc/length3/shrc'];
/** A start rehearsed in a Worker readied ahead (readyPrompt): the same shell, in no repo yet, with no key. */
const readyNext = (l3: L3) => readyPrompt(l3, {argv: SHELL, env: shellEnv(''), cwd: '/root'});

/**
 * What a browser's Prompt's Worker is told to start with: l3, the repo's copy (`copy`), what was kept of l3, and the
 * Agent's key, if one is kept on this device, under its maker's variable (`key`), as the app's Prompts have it. A
 * Worker readied ahead (readyPrompt) has the translator, the root and the files `given` already: only the rest goes.
 */
function startMessage(repo: string, l3: L3, copy: Awaited<ReturnType<typeof snapshot>>, kept: unknown, key: string[], given: Set<string> | null) {
  const cwd = `/root/${repo}`;
  return {
    type: 'start',
    // l3's hot programs at their own paths (the same bytes as the root's), the person's dotfiles fresh in every Prompt, and the repo.
    files: [...filesNow(l3).filter((f) => !given?.has(f.path)), ...dotfiles.asFiles(), ...copy.files],
    dirs: copy.dirs,
    // The whole root around them: the same programs, files and links as the app's Prompt, each file read when a program first opens it.
    ...(given ? {} : {translator: l3.translator, root: {index: l3.index, url: l3.url}}),
    argv: SHELL,
    env: [...shellEnv(repo), ...key],
    // It is a terminal, shown as a screen as wide as a box on the desk (80 columns) and 24 rows tall: a listing comes in
    // columns, and a whole-screen program (vi, less, top) has all of it.
    screen: true, cols: COLS, rows: ROWS,
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
export class Session implements Prompt {
  readonly element: HTMLElement;
  private out = new Output();
  private status: HTMLElement;
  private activity: Activity;
  private live = false;
  /** The prompt line put at the foot for a shell not yet started (a line the Agent ran, shown): its own takes its place. */
  private standIn = '';
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
  /** The paths its Worker was given (the hot programs among them), and how it stops hearing of those ready later. */
  private given = new Set<string>();
  private unhear: (() => void) | null = null;
  private copy: WriteBack;
  /** Whether the shell has waited at a prompt line yet; what was sent before it did, held for it. */
  private first = new FirstPrompt();
  /** "Starting…", to be said if the shell has not said its first line by then. */
  private startingSaid = 0;
  /** An OSC begun in the last piece of output and not yet ended (osc.ts): read when it ends. */
  private oscHeld = '';
  /** The prompt line last told to the watchers. */
  private toldLine = '';
  /** How the program in front has the terminal set, as the kernel says (worker.ts 'tty'). */
  private tty = {iflag: ICRNL, lflag: ISIG | ICANON | ECHO | IEXTEN, oflag: OPOST | ONLCR};
  /** Bytes the output decodes a piece at a time: a letter cut between pieces is read whole. */
  private decoder = new TextDecoder();

  constructor(repo: string) {
    this.repo = repo;
    // Nothing to say until it is written to: that starts it.
    this.status = h('p', {class: 'muted small'});
    // A Prompt that ended says so in the language chosen since, as the rest of the page does.
    onLang(() => this.sayEnded());
    this.activity = new Activity({live: () => this.live, interrupt: () => this.interrupt(), restart: () => this.restart()});
    this.element = h('div', {class: 'term'}, this.status, this.out.element, this.activity.element);
    // Its own scroll, drawn in its box (on the desk: forge-desk.css .scroll-thumb), in place of the page's thin bar.
    scrollThumb(this.out.element);
    this.copy = new WriteBack(repo, this.id, (said) => { this.status.textContent = said; });
  }

  /** Whether it was started: written to, or begun being written to (box.ts). Shown alone, it is not. */
  get begun() { return this.#begun; }
  #begun = false;

  /** Started, once: what is written to it starts it, never its being shown. */
  begin() {
    if (this.#begun) return;
    this.#begun = true;
    this.sayStarting();
    void this.start();
  }

  /** "Starting…" said, if the shell has not said its first line in STARTING_SAID. */
  private sayStarting() {
    clearTimeout(this.startingSaid);
    this.startingSaid = window.setTimeout(() => { if (!this.first.waited && !this.ended) this.status.textContent = t('Starting…'); }, STARTING_SAID);
  }

  /** Whether the program in front reads each key as it comes (vi, less, top): the box sends keys as they are pressed
   * (key, typeIn), and what it prints is shown on a terminal's whole screen. */
  get raw(): boolean { return this.live && !(this.tty.lflag & ICANON); }

  /** Whether what is typed is kept out of sight (ECHO put out: a password asked for, `stty -echo`): the box hides it,
   * and the line sent is neither shown nor kept among the runs. */
  get hushed(): boolean { return this.live && !this.raw && !(this.tty.lflag & ECHO); }

  /**
   * A key pressed while the program in front reads each key as it comes: sent as a terminal sends it (Ctrl-C, where
   * the terminal makes signals of keys, the signal). False for a key that sends nothing.
   */
  key(e: KeyboardEvent): boolean {
    if (!this.raw) return false;
    const isig = !!(this.tty.lflag & ISIG) && e.ctrlKey && !e.altKey && !e.metaKey;
    if (isig && (e.key === 'c' || e.key === 'C')) { this.signal(2); return true; }
    if (isig && (e.key === 'z' || e.key === 'Z')) { this.signal(20); return true; }
    if (isig && e.key === '\\') { this.signal(3); return true; }
    const bytes = keyBytes(e, this.out.appCursor);
    if (bytes === null) return false;
    this.typeIn(bytes === '\r' && this.tty.iflag & ICRNL ? '\n' : bytes);
    return true;
  }

  /** `text` given to the program in front as it is (a conversion confirmed, a paste: bracketed where it asked). */
  typeIn(text: string, pasted = false) {
    if (!this.live || !text) return;
    const said = pasted && this.out.bracketed ? `\x1b[200~${text}\x1b[201~` : text;
    if (this.native) { void this.native.input(said).catch(() => {}); return; }
    const bytes = new TextEncoder().encode(said);
    this.worker?.postMessage({type: 'input', bytes}, [bytes.buffer]);
  }

  /** Keys pressed on the page: its kernel waits for them to be still before work that would hold up the page (worker.ts). */
  typing() { this.worker?.postMessage({type: 'typing'}); }

  /** `sig` to what runs in front (a key that makes a signal). */
  private signal(sig: number) {
    if (this.native) { void this.native.interrupt(); return; }
    this.worker?.postMessage({type: 'interrupt', sig, ...this.flush()});
  }

  /**
   * A key that makes a signal flushes what was written and not yet shown, as a terminal's line discipline does (unless
   * the program set NOFLSH): what comes from the worker of an epoch before this one is dropped (worker.ts), so ^C
   * stands where the run was cut, not under the megabyte a flood had on its way.
   */
  private flush(): {flush?: number} {
    if (this.tty.lflag & NOFLSH) return {};
    return {flush: ++this.epoch};
  }
  private epoch = 0;

  /** How the program in front now has the terminal set: reading each key, its screen is shown whole, and back. */
  private setTty(tio: {iflag: number; lflag: number; oflag: number}) {
    const was = this.raw, hushed = this.hushed;
    this.tty = {iflag: tio.iflag, lflag: tio.lflag, oflag: tio.oflag};
    this.out.keys(this.raw ? {cols: COLS, rows: ROWS, newline: !!(tio.oflag & OPOST) && !!(tio.oflag & ONLCR), reply: (text) => this.typeIn(text)} : null);
    // A whole-screen program waits for keys by its nature: nothing is said of it under its screen.
    this.element.classList.toggle('raw', this.raw);
    this.holding(this.raw);
    if (was !== this.raw || hushed !== this.hushed) this.tell();
  }

  /** Whether this Prompt holds what is translated ahead (a program in front reads each key as it comes: ahead.ts). */
  private held = false;
  private holding(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    holdAhead(on);
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
  private tell() {
    cancelAnimationFrame(this.telling);
    this.telling = 0;
    this.toldLine = this.promptLine;
    for (const fn of [...this.watchers]) fn();
  }

  /** How long until what was printed last has all come in, in ms: what comes after it (the prompt line) waits that long. */
  settlesIn(): number { return this.out.settlesIn(); }

  /**
   * `line` run here as a line typed is (the Agent's: it runs, and is seen, as the person's would), and what it printed
   * and how it ended once its prompt line is back: its status as the root's shrc says it (OSC 133 D), null where the
   * root does not, or the Prompt ended first.
   */
  run(line: string): Promise<{output: string; status: number | null}> {
    const since = Date.now(), typed = line.trim();
    if (!this.send(typed)) return Promise.resolve({output: '', status: null});
    return new Promise((resolve) => {
      const look = () => {
        const r = this.runs.find((x) => x.started >= since && x.line === typed);
        if (r && r.ms !== null) { stop(); resolve({output: r.output, status: r.status ?? null}); }
        else if (this.ended) { stop(); resolve({output: r?.output ?? '', status: null}); }
      };
      const stop = this.watch(look);
      look();
    });
  }

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
    // What ran before is the pane's (it lists every line run, and reads one pressed with all it printed): at its
    // prompt line the screen starts again from the line sent, as it does when it comes up. Input to a program still
    // running goes on under what that program said.
    // Sent at the prompt line, several lines go as one, run whole (prompt-line.ts asOne); what is shown and kept is
    // what was written. To a program still running, they go as they are, its input.
    const atPrompt = !!this.promptLine, wire = atPrompt ? asOne(lines) : lines;
    // The shell has the line before anything is drawn for it: what it prints comes back a frame sooner (drawn first, it
    // came back after the frame that showed the line sent, the page putting frames before messages just after a key,
    // and was drawn a frame after that, Enter to answer 30 ms).
    if (this.native) void this.native.input(wire).catch(() => this.end(() => t('Not running')));
    else { const bytes = new TextEncoder().encode(wire); this.worker!.postMessage({type: 'input', bytes}, [bytes.buffer]); }
    if (atPrompt) this.out.fold();
    // Typed out of sight (a password): not shown, as a terminal echoes nothing, and never kept among the runs the pane
    // lists.
    if (!this.hushed) {
      this.out.sent(lines);
      this.runs.push({line: lines.trimEnd(), output: '', started: Date.now(), ms: null});
      if (this.runs.length > RUNS) this.runs.shift();
    }
    this.activity.inputWait = false;
    this.activity.sleepsUntil = 0;
    this.activity.heard = Date.now();
    this.follow();
    this.tell();
    return true;
  }


  /**
   * Put back into the box: up again, the screen starts at its prompt line (output.ts fold). What came before is the
   * pane's: it lists the lines run, and a line pressed there is read there with all it printed.
   */
  fold() { this.out.fold(); }

  /**
   * `line` shown run here, with what it printed and how it ended, as the Agent ran it in a Prompt of its own
   * (agentSessionFor): in the flow and among the runs as any line run, never run in this shell. The screen starts
   * again from it at its prompt line, as at a line sent.
   */
  shown(line: string, output: string, status: number | null) {
    const typed = line.trim(), ps = this.promptLine || `${this.repo} $ `;
    this.out.fold();
    if (!this.out.lastLine) this.out.print(ps);
    this.out.sent(`${typed}\n`);
    this.out.print(`${output}${output && !output.endsWith('\n') ? '\n' : ''}${ps}`);
    // A shell not yet started says its own first prompt line: this one, put there for it, makes way for it then.
    this.standIn = this.live ? '' : ps;
    this.runs.push({line: typed, output, started: Date.now(), ms: 0, status});
    if (this.runs.length > RUNS) this.runs.shift();
    this.tell();
  }

  /** Output goes on screen and into the run in progress, which ends at the next prompt. */
  private received(piece: string) {
    // What a shell says to its terminal and not to the person (osc.ts) is read whole, however it came in pieces.
    const {now, held} = heldBack(this.oscHeld, piece);
    this.oscHeld = held;
    let s = now;
    // What it puts on the clipboard (clip, tmux) goes there, as a terminal puts it; it says itself what it sent.
    for (const text of clips(s)) void navigator.clipboard?.writeText(text).catch(() => {});
    // How the line run ended, where the shell says it: kept on its run, and none of what it says shown.
    // (The first it says for a run: the line's own, before the prompt line says the last command's again.)
    for (const m of s.matchAll(RAN)) { const r = this.runs.at(-1); if (r && r.ms === null && r.status === undefined) r.status = m[1] === undefined ? null : Number(m[1]); }
    s = s.replace(OSC, '');
    if (!s) return;
    clearTimeout(this.startingSaid);
    if (this.status.textContent === t('Starting…')) this.status.textContent = '';
    if (this.standIn) { this.out.takeBack(this.standIn); this.standIn = ''; }
    this.out.print(s);
    const waits = !!waitsAt(this.out.lastLine);
    this.first.heard(waits, (held) => { if (this.live) this.send(held); });
    // Its first prompt line: up. What the Prompts after it are given ahead of time (l3's translation) comes a moment later, quietly,
    // so it takes nothing from the first line run.
    if (this.l3 && waits) {
      const l3 = this.l3;
      this.l3 = null;
      setTimeout(() => {
        if (!this.worker) return;
        warmL3(l3);
        // And this Prompt runs each of them from its next run on, as it is ready.
        const hot = hearLater((f) => {
          if (this.given.has(f.path) || !this.worker) return;
          this.given.add(f.path);
          this.worker.postMessage({type: 'hot', files: [f]});
          // Which programs it was given so, as its threads are said (data-threads).
          this.element.dataset.ahead = [this.element.dataset.ahead, f.path].filter(Boolean).join(' ');
        });
        // What this repo is likely to run next, translated by this browser while the person reads (ahead.ts): each one
        // kept is told to this Prompt's kernel, which reads it when it is first run rather than translating it then.
        const ahead = hearAhead((origin, url) => this.worker?.postMessage({type: 'kept', at: {[origin]: {main: url, more: null}}}));
        this.unhear = () => { hot(); ahead(); };
        void translateAhead(l3, aheadFor(l3.index));
      }, 3000);
    }
    const run = this.runs.at(-1);
    // Waiting at a prompt line it had not shown yet (its first, or after output of its own): watchers hear.
    if (!run || run.ms !== null) { if (this.promptLine !== this.toldLine) this.tell(); return; }
    this.into(run, s, waits);
    // A run ended is told at once; one growing, once a frame however many pieces came in it (a flood comes in
    // thousands, and each watcher, the pane's rows among them, would look again at each).
    if (run.ms !== null) this.tell(); else this.tellSoon();
  }

  /** Output taken in, said to the kernel once a frame: it lets what writes to the terminal go on only as fast as the
   * page takes it (worker.ts 'drained'), so a flood never piles up on its way here. */
  private drained(n: number) {
    this.taken += n;
    // Hidden, the page draws no frames and keeps only the last of what comes (output.ts): taken in as it comes, so a
    // build printing on in a tab behind goes on.
    if (document.hidden) { this.sayDrained(); return; }
    this.draining ||= requestAnimationFrame(() => this.sayDrained());
    // No frame drawn soon (the tab hidden meanwhile): said all the same.
    this.drainingLate ||= window.setTimeout(() => this.sayDrained(), 250);
  }
  private sayDrained() {
    cancelAnimationFrame(this.draining);
    clearTimeout(this.drainingLate);
    this.draining = this.drainingLate = 0;
    if (this.taken) this.worker?.postMessage({type: 'drained', n: this.taken});
    this.taken = 0;
  }
  private taken = 0;
  private draining = 0;
  private drainingLate = 0;

  /** Told on the next frame, once, however often asked before it. */
  private tellSoon() {
    this.telling ||= requestAnimationFrame(() => { this.telling = 0; this.tell(); });
  }
  private telling = 0;

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
      if ((await rootHere()).native) await this.startNative(); else await this.startL3();
    } catch (e) {
      // Said short at the Prompt's foot; why is the line's title, there when asked for, not a sentence beside the switch.
      const why = errorText(e);
      this.end(() => t('Failed to start'), why);
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
      this.status.textContent = retry ? t('{why}; resuming from breakpoint', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
    });
    if (await this.startRoot()) return;
    throw new Error(t('No root environment on device; install via Runtime'));
  }

  /** The distribution's root, on this machine's kernel (l3 open). */
  private async startRoot(): Promise<boolean> {
    const root = await rootStatus();
    if (!root?.current) return false;
    this.native = await promptOpen(this.repo, {
      output: (text) => { this.activity.heard = Date.now(); this.received(text); },
      exit: (code) => { if (this.live) this.end(() => t('Exited with code {code}', {code}), '', true); },
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
    // (Ready, it is starting: what loading said goes, and starting is said only if it takes a while, as a start at once
    // says nothing.)
    const unwatch = watchLoad((s) => {
      if (s.at !== 'ready') { this.status.textContent = loadWords(s); return; }
      this.status.textContent = '';
      this.sayStarting();
    });
    // Its Worker was readied while the Prompt was shown (readyPrompt), else it is made now, while l3 and the repo's copy
    // come, and starts the Workers its first threads run in: their scripts are loaded and run by the time it is given
    // what to run, rather than after.
    const ready = takeReady();
    const worker = ready?.worker ?? promptWorker();
    this.worker = worker;
    if (!ready) worker.postMessage({type: 'warm'});
    worker.onmessage = ({data}) => this.fromWorker(data);
    const [l3, copy, kept, use] = await Promise.all([loadL3(), snapshot(this.repo), loadL3().then(keptNow).catch(() => null), agentUse(false)]).finally(unwatch);
    // Stopped while it came: it stays stopped.
    if (this.worker !== worker) return;
    this.l3of = l3;
    const start = startMessage(this.repo, l3, copy, kept, use ? [`${use.variable}=${use.key}`] : [], ready?.given ?? null);
    worker.postMessage(start);
    this.given = new Set([...(ready?.given ?? []), ...start.files.map((f) => f.path)]);
    // What is saved elsewhere comes into the shell's copy.
    this.unwatch = mirror(this.repo, this.id, (m) => this.worker?.postMessage(m));
    // Running is the usual state and says nothing; only what is missing is said. Until the shell says its first
    // line (a cold start is some seconds), it is still starting, and says so: not an empty Prompt.
    if (copy.complete) this.sayStarting(); else this.status.textContent = t('Large files and binaries excluded');
    this.live = true;
    this.l3 = l3;
    this.tell();
  }

  /** What the Worker says. */
  private fromWorker(data: MessageEvent['data']) {
    this.activity.heard = Date.now();
    switch (data.type) {
      case 'output':
        // (Written before a key flushed it: taken in, not shown.)
        if ((data.epoch ?? 0) >= this.epoch) this.received(this.decoder.decode(data.bytes, {stream: true}));
        this.drained(data.bytes.length);
        break;
      case 'tty': this.setTty(data); break;
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
      case 'exit': this.end(() => t('Exited with code {code}', {code: data.status >> 8}), '', true); break;
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
    if (!this.native) { this.end(() => t('Stopped'), '', true); return Promise.resolve(); }
    // On the root: stopped only once the host shows none of its processes left.
    const n = this.native;
    return n.close().then((s) => {
      this.stopped = s;
      this.end(() => {
        const back = s.before.memory ? t('Freed {size}', {size: bytes(s.before.memory)}) : '';
        return s.left ? tn('Stopping ({n} process remaining)', 'Stopping ({n} processes remaining)', s.left)
          : back ? t('Stopped (freed {back} · {ms} ms)', {back, ms: String(s.ms)}) : t('Stopped');
      }, '', true);
    }, () => this.end(() => t('Stopped'), '', true));
  }

  /** While a line runs, say what it is doing, once it has taken a moment (activity.ts). */
  private follow() { this.activity.follow(this.runs.at(-1)); }

  /** Ctrl-Z: what runs in front of the shell stops, a job the shell holds (fg, bg, jobs); false at the prompt line,
   * where nothing runs (the key is the box's then: its undo), and on a device, whose shell has no terminal to stop
   * from. */
  suspend(): boolean {
    if (!this.live || this.promptLine || this.native) return false;
    this.out.print('^Z');
    this.worker?.postMessage({type: 'interrupt', sig: 20, ...this.flush()});
    return true;
  }

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
    this.worker?.postMessage({type: 'interrupt', ...this.flush()});
    this.activity.inputWait = false;
    this.activity.sleepsUntil = 0;
  }

  /**
   * The end of what is typed (Ctrl-D on an empty line), as a terminal gives it: what reads it reads its end, once (cat
   * ends; at the prompt line, the shell, as a terminal's does), and reads on after it.
   */
  endOfInput() {
    if (!this.live) return;
    if (this.native) { void this.native.input('\x04').catch(() => {}); return; }
    // (Nothing to read, once: a read of no bytes, the end.)
    this.worker?.postMessage({type: 'input', bytes: new Uint8Array(0)});
  }

  /** At the prompt line, the screen cleared (Ctrl-L), the prompt line said again at its top, as a terminal's line
   * editor does; false while a line runs (the key is the program's then). */
  clearScreen(): boolean {
    const ps = this.promptLine;
    if (!ps) return false;
    this.out.print(`\x1b[H\x1b[2J${ps}`);
    return true;
  }

  /** At the prompt line, `line` written and let go (Ctrl-C), said cut and the prompt line again under it, as a
   * terminal's line editor does: nothing runs. False while a line runs (Ctrl-C interrupts it then). */
  abandon(line: string): boolean {
    const ps = this.promptLine;
    if (!ps) return false;
    this.out.sent(`${line}^C\n`);
    this.out.print(ps);
    return true;
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

  /**
   * Ended: what it says once ended (`message`; `why` it did not start, where it did not). `gone`: it ended as one
   * closes a terminal (exit, stopped), not by failing: whatever shows it hears so ('term-gone', bubbling from its
   * element: a desk takes its box off, to be opened again from the band), unless it is being started again.
   */
  private end(message: () => string, why = '', gone = false) {
    this.ended = true;
    this.holding(false);
    this.said = message;
    this.why = why;
    this.activity.end();
    this.unwatch?.();
    this.unwatch = null;
    this.unhear?.();
    this.unhear = null;
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
    if (gone && !this.restarting) this.element.dispatchEvent(new CustomEvent('term-gone', {bubbles: true}));
  }

  /** What it says once ended; `now` as it ends, which is seen: the switch goes over to off, and the screen goes dark. */
  private sayEnded(now = false) {
    if (!this.ended || !this.said) return;
    const {line, power} = endLine(this.said(), this.why, () => this.restart());
    this.element.classList.add('ended');
    this.status.replaceChildren();
    this.out.ended(line);
    // Its prompt line goes with it on a desk (forge-desk.css): the keys there go to its switch.
    if (now && this.element.closest('.desk-term')?.contains(document.activeElement)) power.focus({preventScroll: true});
    if (!now || this.restarting || still()) return;
    goDark(power, this.out.element);
  }
}

/** Keys pressed anywhere on the page: every Prompt hears of it, at most every so often (Session.typing). */
let typedAt = 0;
if (typeof addEventListener === 'function') addEventListener('keydown', () => {
  const now = performance.now();
  if (now - typedAt < 400) return;
  typedAt = now;
  for (const s of [...sessions.values(), ...agents.values()]) if (s instanceof Session) s.typing();
}, {capture: true, passive: true});

/** The repo's session, made if it has none (made, it is not started: writing to it starts it). */
export function sessionFor(repo: string): Session {
  const s = sessions.get(repo);
  if (s instanceof Session) return s;
  const made = new Session(repo);
  sessions.set(repo, made);
  return made;
}

/** The Agent's own Prompt in each repo: never on screen, what it runs shown after in the repo's Prompt (shown). */
const agents = new Map<string, Session>();

/** The Agent's Prompt in `repo`, made if it has none: it runs at once, whatever the screen is playing. */
export function agentSessionFor(repo: string): Session {
  let s = agents.get(repo);
  if (!s || s.ended) agents.set(repo, s = new Session(repo));
  return s;
}

/**
 * The repo's Prompt as it is shown, its session made if it has none. Shown, it is not started; what it will run (l3,
 * in a browser) is read ahead meanwhile, and a Worker readied with it (readyPrompt), so the first line written waits
 * for neither, and holds no repo.
 */
export function terminalFor(repo: string): HTMLElement {
  const session = sessionFor(repo);
  // (Not once it has begun: it made its own Worker, and another made beside it now only takes from its start.)
  void rootHere().then((here) => {
    if (!here.native) void loadL3().then((l3) => { if (!session.begun) readyNext(l3); }, () => { /* said by the Prompt that starts, if it fails again there */ });
  });
  return session.element;
}
