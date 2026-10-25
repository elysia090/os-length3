import * as dotfiles from '../dotfiles.ts';
import {inPieces, onChange, store, walkRepo} from '../repos.ts';
import {bytes, h} from '../dom.ts';
import {isNative, promptOpen, rootFetch, rootStatus, type Held, type Stopped} from '../host.ts';
import {currentLang, onLang, t, tn} from '../i18n.ts';
import {filesNow, keepMore, keepReached, keepTranslation, keptNow, loadL3, promptWorker, usedKept, warmL3, watchLoad, type L3, type Stage} from '../userland.ts';
import {every} from '../runs.ts';
import {errorText} from '../errors.ts';
import {LAND, paced, still} from '../glide.ts';
import {kindColon, mark as todoMark} from './todo-box.ts';

// A shell per repo: in a browser, l3's root (its BusyBox sh, and every other
// program of it) translated in a Worker; in the app, the same root on the
// machine. Sessions outlive page switches: the workbench re-attaches the same element. A
// session only shows output; what is typed comes from the prompt box through
// send(). The repo in the shell is the repo: what the shell changes under
// /root/<repo> is written back through the store, and what is saved
// elsewhere (Forge, Git, l3 on the host… through the store) is put into the
// shell's copy. Binary files and files over the read limit stay where they are.

const sessions = new Map<string, Session>();
const LIMIT_FILES = 2000;
const LIMIT_BYTES = 32 << 20;

/** What clears a terminal's screen (clear, Ctrl+L): the output before it goes. */
const CLEARS = /\x1b\[H\x1b\[[23]?J|\x1b\[[23]J|\x1bc/g;
/** Escape sequences are dropped; the console is plain lines for now. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
/** sh -i says this once because the console is not a terminal; it means nothing here. */
const NO_TTY = "/bin/sh: can't access tty; job control turned off\n";
/**
 * The prompt line the shell waits at, if `line` (the last line of what it wrote) is one: `x $ `, `x/src $ ` (the root's
 * shrc), or a path (`/root/x $ `) outside the repo; a run is over when it comes back. '' otherwise.
 */
const waitsAt = (line: string): string => (/\S \$ $/.test(line) ? line : '');
/** What a run prints comes in a line after another (styles.css .fresh): this far apart, each over this long. */
const STAGGER = 30, FADE = 240;
const RUNS = 50;
/** Output kept on the screen, in characters: past the most, the oldest lines go until the least is left. */
const KEEP_MOST = 200_000, KEEP_LEAST = 150_000;
/**
 * Lines printed all at once are drawn in blocks of about this many characters, each a box of its own: what comes
 * after one is laid out without laying out again the lines before it (one text of 1 MB took the page 16 to 30 ms
 * a frame to add a few lines to and scroll; in blocks, a millisecond).
 */
const BLOCK = 8_000;
/** Of what a run prints in one frame, the lines that come in one after another; the rest comes in with the last of them. */
const ONE_BY_ONE = 24;
/** In the pane, what a line printed is its last this many lines (styles.css .term-home .above, .cut). */
const TAIL = 5;

/**
 * A line of the box's own in the Prompt's flow (an issue written, a TODO added from the box), marked at its start
 * (an invisible separator) so a drawing of it all from the text knows it again; what each goes to when pressed, by
 * its words.
 */
const SAID = '\u2063';
const goes = new Map<string, (row: HTMLElement) => void>();

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
 * Copy a repo's files for the guest: [{path, bytes}] under /root/<repo>. The repo is listed a level at a time and
 * its files (in the walk's order, up to the limits) read at once a few megabytes at a time: a repo of hundreds
 * of files is a few trips to the core, not one a file.
 */
async function snapshot(repo: string) {
  const dirs: string[] = [`/root/${repo}`];
  const wanted: {path: string; size: number}[] = [];
  let total = 0, complete = true;
  for (const {path, entry: e} of await walkRepo(repo)) {
    if (e.kind === 'dir') { dirs.push(`/root/${repo}/${path}`); continue; }
    if (e.kind !== 'file') continue;
    if (wanted.length >= LIMIT_FILES || total + e.size > LIMIT_BYTES) { complete = false; continue; }
    total += e.size;
    wanted.push({path, size: e.size});
  }
  const read = await inPieces(wanted, (f) => f.size, (f) => store.bytes(repo, f.path).catch(() => null));
  const files: {path: string; bytes: Uint8Array}[] = [];
  wanted.forEach((f, k) => { const bytes = read[k]; if (bytes) files.push({path: `/root/${repo}/${f.path}`, bytes}); else complete = false; });
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
    // A Prompt that ended says so in the language chosen since, as the rest of the page does.
    onLang(() => this.sayEnded());
    // Not a live region: its count goes up each second, which a screen reader would read out each second.
    this.activity = h('div', {class: 'term-activity small'});
    this.element = h('div', {class: 'term'}, this.status, this.output, this.activity);
    void this.start();
  }

  /** The prompt line the shell waits at (`garden $ `), or nothing while a line runs or it is not running. */
  get promptLine(): string {
    if (!this.live || this.runs.at(-1)?.ms === null) return '';
    return waitsAt(this.lastLine);
  }
  /** The prompt line last told to the watchers. */
  private toldLine = '';

  /** Hear when a run starts, grows or ends; returns how to stop. */
  watch(fn: () => void): () => void { this.watchers.add(fn); return () => this.watchers.delete(fn); }
  // Over a copy: a watcher may stop and start watching while it is told,
  // and a Set visits what is added during its iteration.
  private tell() { this.toldLine = this.promptLine; for (const fn of [...this.watchers]) fn(); }

  /** Type `text` into the shell, one line per line. False while it is not running. */
  send(text: string): boolean {
    if (!this.live || (!this.worker && !this.native)) return false;
    const lines = text.endsWith('\n') ? text : `${text}\n`;
    this.echo = lines;
    this.print(lines);
    this.runs.push({line: lines.trimEnd(), output: '', started: Date.now(), ms: null});
    if (this.runs.length > RUNS) this.runs.shift();
    this.inputWait = false;
    this.sleepsUntil = 0;
    this.heard = Date.now();
    this.follow();
    this.tell();
    if (this.native) { void this.native.input(lines).catch(() => this.end(() => t('Not running'))); return true; }
    const bytes = new TextEncoder().encode(lines);
    this.worker!.postMessage({type: 'input', bytes}, [bytes.buffer]);
    return true;
  }

  /**
   * Something the box did that is not the shell's (an issue written, a TODO added: `head` and its words), in the
   * Prompt's flow as it came: a line of its own before the prompt line the shell waits at (after a line being
   * printed, under it), pressed to `go` to it (told the line pressed: a drawing of it all from the text draws it anew).
   * Its line is returned, there now, for what lands on it.
   */
  note(head: string, words: string, go: (row: HTMLElement) => void): HTMLElement {
    // What waits for the next frame is drawn first: the line goes after all that came before it.
    if (this.painting) { cancelAnimationFrame(this.painting); this.draw(); }
    const line = `${SAID}${head} ${words.replace(/\s+/g, ' ').trim()}\n`;
    goes.set(line, go);
    const row = this.ownLine(line);
    const tail = this.tail?.isConnected && waitsAt(this.lastLine) ? this.tail : null;
    if (tail) {
      this.text = this.text.slice(0, this.text.length - this.lastLine.length) + line + this.lastLine;
      this.output.insertBefore(row, tail);
    } else {
      const under = this.lastLine ? '\n' : '';
      this.text += under + line;
      this.output.append(under, row);
      this.lastLine = '';
      this.drawnLast = '';
    }
    this.drawnLength = this.text.length;
    this.trim();
    this.output.scrollTo({top: this.output.scrollHeight});
    return row.querySelector('button')!;
  }
  /**
   * A line of the box's own, as it stands in the flow: its head as the box's pill said it (#3 in ink, TODO with its
   * circle) and its words, which are a person's, not the shell's; pressed, it opens where it stands.
   */
  private ownLine(line: string): HTMLElement {
    const words = line.slice(SAID.length, -1), cut = words.indexOf(' ');
    const head = cut < 0 ? words : words.slice(0, cut), todo = head === 'TODO';
    // Its Kind's colon set as everywhere (todo-box.ts kindWords), the words as they were.
    // A TODO's kind may be written with the narrow colon (Buy: …), an issue's is the wide one (Fix：…): either is its kind.
    const said = words.slice(head.length), kind = /^(\s*(?:[^\s：:]+(?=：)|[A-Za-z][A-Za-z0-9-]{0,15}(?=:(?!\/\/))))([：:])/.exec(said);
    const b = h('button', {type: 'button', class: 'term-said-go'}, h('b', {}, ...(todo ? [todoMark(false)] : []), head),
      h('span', {class: 'said-words'}, ...(kind ? [h('b', {class: 'said-kind'}, kind[1], kind[2] === '：' ? kindColon() : ':'), said.slice(kind[0].length)] : [said])));
    b.addEventListener('click', () => goes.get(line)?.(b));
    return h('span', {class: `term-said ${todo ? 'said-todo' : 'said-issue'}`}, SAID, b, '\n');
  }
  /** A line sent, after the prompt line it was written at: its words an element of their own, its line break after. */
  private command(line: string): Node[] {
    const ends = line.endsWith('\n');
    return [h('span', {class: 'cmd'}, ends ? line.slice(0, -1) : line), ...(ends ? [document.createTextNode('\n')] : [])];
  }

  /**
   * What the shell wrote goes on the screen at the next frame. Nothing here looks at all that came before (a run
   * printing a megabyte comes a kilobyte at a time): what came since the last frame is kept apart (`fresh`), and the
   * last line (where the prompt line comes) is followed as each piece comes.
   */
  private print(s: string) {
    // Cleared: what was on the screen goes, as in a terminal; what comes after the clearing stays.
    let cleared = -1;
    for (const m of s.matchAll(CLEARS)) cleared = m.index + m[0].length;
    if (cleared >= 0) { this.text = ''; this.fresh = ''; this.whole = true; this.lastLine = ''; s = s.slice(cleared); }
    const plain = strip(s);
    this.text += plain;
    this.fresh += plain;
    const nl = plain.lastIndexOf('\n');
    this.lastLine = nl < 0 ? this.lastLine + plain : plain.slice(nl + 1);
    // It may come in pieces; it goes once whole (before anything after it is drawn).
    if (!this.ttySaid && this.text.includes(NO_TTY)) {
      this.text = this.text.replace(NO_TTY, '');
      this.ttySaid = true;
      this.whole = true;
      this.lastLine = this.text.slice(this.text.lastIndexOf('\n') + 1);
    }
    // Until then, what may still become it is not drawn: never a frame of it on the screen.
    if (!this.ttySaid && this.text && NO_TTY.startsWith(this.text)) return;
    // Far more than is kept on the screen came before a frame could draw it: only the last of it is kept.
    if (this.fresh.length > 4 * KEEP_MOST) { this.text = this.text.slice(-KEEP_LEAST); this.whole = true; }
    // Drawn once a frame, however many pieces came in it. Output comes a stdio buffer (about 1 KB) at a time,
    // and drawing up to 200k characters and scrolling to them for each piece measured about 22 ms a piece in
    // Chromium: 1 MB of output held the page for 22 s; drawn once for every 17 pieces, 1.3 s.
    this.painting ||= requestAnimationFrame(() => this.draw());
  }

  /**
   * What came since the last frame, at the foot: a few lines come in a line after another, so a run is seen
   * coming rather than appearing; a lot at once is added whole, in blocks (BLOCK), never drawing again what was
   * there; the start cut away (cleared) is drawn whole. Past KEEP_MOST the oldest lines go from the top.
   */
  private draw() {
    this.painting = 0;
    if (!this.fresh && !this.whole) return;
    // The prompt line it waited at stays a prompt line, seen once something follows it.
    this.tail?.classList.remove('waits');
    this.tail = null;
    const add = this.whole || !this.drawnLength ? null : this.fresh;
    const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (add !== null && add.length < 4000 && moving) {
      // The line just sent is the line written moved up a line, as a terminal's is: it does not come in again.
      // Sent from elsewhere (a line pressed, Git), what goes on after the prompt line is the line run all the same.
      const nl = add.indexOf('\n') + 1;
      const echo = this.echo && add.startsWith(this.echo) ? this.echo : nl && this.prompts.has(this.drawnLast) ? add.slice(0, nl) : '';
      if (echo) this.output.append(...this.command(echo));
      const lines = add.slice(echo.length).split(/(?<=\n)/).filter(Boolean);
      // Each a beat after the one above it, the first ONE_BY_ONE; the rest (a run printing hundreds a frame) all
      // together with the last of those, as one block, not hundreds of lines each coming in on its own.
      const one = lines.slice(0, ONE_BY_ONE), rest = lines.slice(ONE_BY_ONE).join('');
      const end = rest.lastIndexOf('\n') + 1;
      const fresh = [...one.map((line) => h('span', {class: 'fresh'}, line)),
        ...(end ? [h('div', {class: 'fresh term-lines'}, rest.slice(0, end))] : []), ...(end < rest.length ? [h('span', {class: 'fresh'}, rest.slice(end))] : [])];
      fresh.forEach((s, i) => { s.style.animationDelay = `${Math.min(i, ONE_BY_ONE) * STAGGER}ms`; });
      this.output.append(...fresh);
      // Its last line under way: what comes after (the prompt line) follows it in.
      this.settles = lines.length ? performance.now() + Math.min(lines.length - 1, ONE_BY_ONE) * STAGGER + FADE / 2 : 0;
    } else if (add !== null) this.output.append(...this.blocks(add, this.drawnLast === ''));
    else this.output.replaceChildren(...this.blocks(this.text, true));
    this.echo = '';
    this.fresh = '';
    this.whole = false;
    this.drawnLength = this.text.length;
    this.drawnLast = this.lastLine;
    this.trim();
    this.markTail();
    this.tails(add === null);
    // Full, what comes in scrolls the rest up, smoothly, as a terminal's screen does (at once when much came at once).
    const far = this.output.scrollHeight - this.output.clientHeight - this.output.scrollTop;
    const smooth = add !== null && far < this.output.clientHeight && moving;
    this.output.scrollTo({top: this.output.scrollHeight, behavior: smooth ? 'smooth' : 'auto'});
  }

  /**
   * The pane refers, it does not hold: of what each line run printed, its last TAIL lines are shown there. From the foot
   * back, each piece of a run's output past them is marked above (not shown in the pane), the one they start in cut to
   * its last lines with a fade where more is above. Up as the screen, the marks mean nothing: all of it is there. Only
   * the runs just drawn are walked (the last two: one ended and the next started in the same frame); drawn whole, all.
   */
  private tails(all: boolean) {
    let left = TAIL, top: HTMLElement | null = null, starts = 0;
    for (let n = this.output.lastChild; n; n = n.previousSibling) {
      const el = n instanceof HTMLElement ? n : null;
      if (el && (el.classList.contains('ps') || el.classList.contains('term-said'))) {
        if (el.classList.contains('waits')) continue;
        if (!all && ++starts === 2) return;
        left = TAIL; top = null;
        continue;
      }
      if (el?.classList.contains('cmd') || el?.classList.contains('term-end')) continue;
      if (left <= 0) {
        top?.classList.add('cut');
        if (el) el.classList.add('above');
        // A piece of a line between blocks (the rest of a line one frame began) is put in a span to be marked.
        else if (n.textContent) { const held = h('span', {class: 'above'}); n.replaceWith(held); held.append(n); n = held; }
        continue;
      }
      const text = n.textContent ?? '', lines = text.split('\n').length - 1;
      if (!el) { left -= lines; continue; }
      if (lines > left) { el.classList.add('cut'); el.style.setProperty('--tail', String(left)); }
      left -= Math.max(lines, 1);
      top = el;
    }
  }

  /** Past KEEP_MOST, the oldest lines go from the top of the screen (whole lines, down to KEEP_LEAST), as from the text. */
  private trim() {
    if (this.drawnLength <= KEEP_MOST) return;
    const nl = this.text.indexOf('\n', this.text.length - KEEP_LEAST);
    let left = nl < 0 ? this.text.length - KEEP_LEAST : nl + 1;
    let cut = 0;
    while (left > 0 && this.output.firstChild) {
      const node = this.output.firstChild;
      const n = node.textContent?.length ?? 0;
      if (n <= left || node.childNodes.length > 1) { node.remove(); left -= n; cut += n; continue; }
      // Within a block (or a text): its first lines go, the rest of it stays where it is.
      const text = (node.nodeType === Node.TEXT_NODE ? node : node.firstChild) as Text;
      text.deleteData(0, left);
      cut += left;
      left = 0;
    }
    this.text = this.text.slice(cut);
    this.drawnLength = this.text.length;
  }

  /**
   * `text` as nodes to add at the screen's foot (`fresh`: it starts a line): the rest of the line it continues as it
   * is, whole lines in blocks (a prompt line the shell waited at, at a line's start, in a span of its own between
   * them, as `.ps`), and a line not ended yet (the prompt line it waits at, a line half printed) as it is, after.
   */
  private blocks(text: string, fresh: boolean): Node[] {
    const out: Node[] = [];
    let at = 0;
    if (!fresh) {
      const nl = text.indexOf('\n');
      at = nl < 0 ? text.length : nl + 1;
      // After the prompt line it waited at, what goes on that line is what was run.
      if (at) out.push(...(this.prompts.has(this.drawnLast) ? this.command(text.slice(0, at)) : [document.createTextNode(text.slice(0, at))]));
    }
    const end = text.lastIndexOf('\n') + 1;
    let block = '';
    const close = () => { if (block) out.push(h('div', {class: 'term-lines'}, block)); block = ''; };
    const prompts = [...this.prompts];
    while (at < end) {
      const nl = text.indexOf('\n', at) + 1;
      const line = text.slice(at, nl);
      at = nl;
      if (line.startsWith(SAID)) { close(); out.push(this.ownLine(line)); continue; }
      const ps = prompts.length ? prompts.find((p) => line.startsWith(p)) : undefined;
      if (ps) { close(); out.push(h('span', {class: 'ps'}, ps), ...this.command(line.slice(ps.length))); continue; }
      block += line;
      if (block.length >= BLOCK) close();
    }
    close();
    if (at < text.length) out.push(document.createTextNode(text.slice(at)));
    return out;
  }
  private painting = 0;
  /** What came since the last frame drew the screen, to add at its foot; or the whole of it is drawn again (cleared). */
  private fresh = '';
  private whole = false;
  /** How much of the text is on the screen, and its last line (a line not ended yet, or '' when it ends one). */
  private drawnLength = 0;
  private drawnLast = '';
  /** The last line of all the shell wrote: where the prompt line it waits at is. */
  private lastLine = '';
  /** The line just sent, until it is drawn. */
  private echo = '';
  /** When what was printed last has all come in (performance.now()). */
  private settles = 0;
  /** How long until what was printed last has all come in, in ms: what comes after it (the prompt line) waits that long. */
  settlesIn(): number { return Math.max(0, this.settles - performance.now()); }
  /** The prompt line the output ends with, in a span of its own: up over the center, the box's line says it instead
   * (bench.ts), so it is not said twice. Once something follows it, it is a prompt line among the output (`.ps`),
   * which the screen tells from what the lines run printed. Its words are what came last; they do not come in again. */
  private tail: HTMLElement | null = null;
  /** Every prompt line the shell has waited at, to tell them again in output drawn whole. */
  private prompts = new Set<string>();
  private markTail() {
    const waits = waitsAt(this.lastLine);
    let left = waits.length;
    if (!left) return;
    this.prompts.add(waits);
    // From the end back to where the prompt line starts, through what was drawn whole or a line after another.
    let node: Node | null = this.output.lastChild;
    while (node?.lastChild) node = node.lastChild;
    const walk = document.createTreeWalker(this.output, NodeFilter.SHOW_TEXT);
    if (node) walk.currentNode = node;
    for (let at = node?.nodeType === Node.TEXT_NODE ? node as Text : walk.previousNode() as Text | null; at; at = walk.previousNode() as Text | null) {
      if (at.length < left) { left -= at.length; continue; }
      const r = document.createRange();
      r.setStart(at, at.length - left);
      r.setEnd(this.output, this.output.childNodes.length);
      const tail = h('span', {class: 'ps waits'});
      tail.append(r.extractContents());
      for (const f of tail.querySelectorAll('.fresh')) f.classList.remove('fresh');
      this.output.append(tail);
      this.tail = tail;
      return;
    }
  }

  /** Output goes on screen and into the run in progress, which ends at the next prompt. */
  private received(s: string) {
    if (this.status.textContent === t('Starting…')) this.status.textContent = '';
    this.print(s);
    // Its first prompt line: up. What the Prompts after it are given ahead of time (l3's translation) comes a moment later, quietly,
    // so it takes nothing from the first line run.
    if (this.l3 && waitsAt(this.lastLine)) { const l3 = this.l3; this.l3 = null; setTimeout(() => warmL3(l3), 3000); }
    const run = this.runs.at(-1);
    // Waiting at a prompt line it had not shown yet (its first, or after output of its own): watchers hear.
    if (!run || run.ms !== null) { if (this.promptLine !== this.toldLine) this.tell(); return; }
    run.output += strip(s);
    // (A run's output starts on a line of its own, after the line sent: its last line is the screen's.)
    if (waitsAt(this.lastLine)) {
      run.output = run.output.slice(0, Math.max(0, run.output.lastIndexOf('\n')));
      run.ms = Date.now() - run.started;
      this.follow();
      // On the root the shell wrote the repo itself: everyone reads it again.
      if (this.native) { store.changedOutside(this.repo, this.id); void this.measure(); }
    }
    else if (run.output.length > 100_000) run.output = run.output.slice(-80_000);
    this.tell();
  }

  private readonly id = `shell:${Math.random().toString(36).slice(2)}`;
  /** l3, in a browser, until the shell's first prompt line. */
  private l3: L3 | null = null;
  /** The l3 it runs, in a browser. */
  private l3of: L3 | null = null;
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
        // Any file, text or not, as the app's Prompt writes the repo itself.
        if (this.budget.files <= 0 || this.budget.bytes < f.bytes.length) { skipped.push(f.path); continue; }
        this.budget.files--;
        this.budget.bytes -= f.bytes.length;
        await store.put(this.repo, f.path, f.bytes, this.id).catch(() => skipped.push(f.path));
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

  private async start() {
    try {
      // In the app the Prompt is the distribution's root on this machine, and nothing else: l3 through xlat
      // is the browser's (its build carries none). The first one fetches the root it runs on, as the browser's
      // first fetches l3, the status saying how far it is (Runtime fetches it ahead, and chooses another).
      if (isNative) {
        if (await this.startRoot()) return;
        await rootFetch((got, of, retry) => {
          this.status.textContent = retry ? t('{why}; continuing where it stopped', {why: retry}) : t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
        });
        if (await this.startRoot()) return;
        throw new Error(t('There is no root on this device yet: Runtime installs it'));
      }
      this.on = 'l3';
      // While l3 comes, the status says how far it is and what it is doing.
      const unwatch = watchLoad((s) => { this.status.textContent = loadWords(s); });
      // Its Worker is made now, while l3 and the repo's copy come, and starts the Workers its first threads run in:
      // their scripts are loaded and run by the time it is given what to run, rather than after.
      const worker = promptWorker();
      this.worker = worker;
      worker.postMessage({type: 'warm'});
      worker.onmessage = ({data}) => {
        this.heard = Date.now();
        if (data.type === 'output') this.received(new TextDecoder().decode(data.bytes));
        else if (data.type === 'changes') this.writeBack(data);
        // Code its shell reached later, a program of the root it translated and the code that reached later, and what it
        // read of what was kept: kept for the Prompts after it, and counted as used.
        else if (data.type === 'more') keepMore(data.path, data.from, data.more);
        else if (data.type === 'translated') { if (this.l3of) keepTranslation(this.l3of, data.origin, data.wasm, data.segments); }
        else if (data.type === 'reached') { if (this.l3of) keepReached(this.l3of, data.origin, data.from, data.more); }
        else if (data.type === 'used') usedKept(data.urls);
        // Where its threads run: each in a Worker of its own (the page is cross-origin isolated), or in turn in this one.
        else if (data.type === 'threads') this.element.dataset.threads = data.apart ? 'apart' : 'in-turn';
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
          // ('read': a program's kept translation is being read, and it goes on by itself once it is.)
          this.inputWait = open && data.for === 'input';
          this.sleepsUntil = open && data.for === 'time' ? Date.now() + data.ms : 0;
          this.follow();
          this.tell();
        }
        else if (data.type === 'exit') this.end(() => t('Exited ({code})', {code: data.status >> 8}));
        else if (data.type === 'error') this.end(() => t('Halted: {message}', {message: data.message.split('\n')[0]}));
      };
      const [l3, copy, kept] = await Promise.all([loadL3(), snapshot(this.repo), loadL3().then(keptNow).catch(() => null)]).finally(unwatch);
      // Stopped while it came: it stays stopped.
      if (this.worker !== worker) return;
      this.l3of = l3;
      const cwd = `/root/${this.repo}`;
      worker.postMessage({
        type: 'start', translator: l3.translator,
        // l3's hot programs at their own paths (the same bytes as the root's), the person's dotfiles fresh in every Prompt, and the repo.
        files: [...filesNow(l3), ...dotfiles.asFiles(), ...copy.files],
        dirs: copy.dirs,
        // The whole root around them: the same programs, files and links as the app's Prompt, each file read when a program first opens it.
        root: {index: l3.index, url: l3.url},
        argv: ['/bin/sh', '-i'],
        // l3 here sees repos where the shell does, under /root; its shell reads as the app's.
        env: ['HOME=/root', 'TERM=dumb', 'LENGTH3_REPOS=/root', 'L3_PROMPT=1', `LENGTH3_LANG=${currentLang()}`, `LENGTH3_REPO=${this.repo}`,
          'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'ENV=/etc/length3/shrc'],
        cwd,
        mirror: cwd,
        // The translations Prompts before it made of the root's programs, read when a program is first run.
        kept,
      });
      // What is saved elsewhere comes into the shell's copy.
      this.unwatch = onChange((c) => {
        if (c.repo !== this.repo || c.by === this.id || c.what === 'repo') return;
        const what = c.what === 'file' ? new TextEncoder().encode(c.text ?? '') : c.what === 'dir' ? 'dir' : null;
        this.worker?.postMessage({type: 'put', path: c.path, what});
      });
      // Running is the usual state and says nothing; only what is missing is said. Until the shell says its first
      // line (a cold start is some seconds), it is still starting, and says so: not an empty Prompt.
      this.status.textContent = copy.complete ? t('Starting…') : t('Large files and binaries are not included');
      this.live = true;
      this.l3 = l3;
      this.tell();
    } catch (e) {
      // Said short at the Prompt's foot; why is the line's title, there when asked for, not a sentence beside the switch.
      const why = errorText(e);
      this.end(() => t('Could not start'), why);
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
    if (!this.native) { this.end(() => t('Stopped')); return; }
    // On the root: stopped only once the host shows none of its processes left.
    const n = this.native;
    void n.close().then((s) => {
      this.stopped = s;
      this.end(() => {
        const back = s.before.memory ? t('{size} given back', {size: bytes(s.before.memory)}) : '';
        return s.left ? tn('Stopping ({n} process left)', 'Stopping ({n} processes left)', s.left)
          : back ? t('Stopped ({back} · {ms} ms)', {back, ms: String(s.ms)}) : t('Stopped');
      });
    }, () => this.end(() => t('Stopped')));
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
    if (!this.live || !run || run.ms !== null) { this.unfollow(); return; }
    this.leaving?.cancel();
    this.leaving = null;
    // Made once for the run and only moved in or out: a button drawn anew each second would drop the keyboard on it.
    const said = h('span', {class: 'muted'});
    const cut = h('button', {class: 'button small-button', type: 'button'}, t('Interrupt'));
    cut.addEventListener('click', () => this.interrupt());
    const again = h('button', {class: 'button small-button', type: 'button'}, t('Stop and start again'));
    again.addEventListener('click', () => this.restart());
    const paint = () => {
      if (run.ms !== null || !this.live) { clearInterval(this.ticker); this.unfollow(); return; }
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

  /** What the run was doing, once it is done: put aside to its right, not gone at once. */
  private unfollow() {
    if (this.leaving) return;
    if (!this.activity.firstChild || still()) { this.activity.replaceChildren(); return; }
    const going = this.leaving = this.activity.animate([{opacity: 1}, {opacity: 0, translate: '12px 0'}], {duration: paced(170), easing: 'ease-in'});
    going.finished.then(() => { if (this.leaving === going) { this.leaving = null; this.activity.replaceChildren(); } }, () => {});
  }
  private leaving: Animation | null = null;

  /** Ctrl-C: what runs in front of the shell ends, and the shell goes on. */
  interrupt() {
    if (!this.live) return;
    // Said where the run is cut, as a terminal says it; the screen jolts as it is cut, at once (it answers the hand).
    if (this.runs.at(-1)?.ms === null) {
      this.print('^C');
      // What it was doing goes as it is cut, not once the shell says it is back.
      clearInterval(this.ticker);
      this.unfollow();
      // By its place (left, never a layer of its own, which would come over what stands on it) and, on the screen, the
      // light of its words.
      const lit = this.element.closest('.screen') ? '0 0 10px var(--done), 0 0 2px var(--add-tint)' : null;
      if (!still()) this.output.animate([{left: '0px'}, {left: '4px', ...lit && {textShadow: lit}, offset: .12}, {left: '-3px', offset: .3},
        {left: '1px', offset: .55}, {left: '0px'}], {duration: 280, easing: 'ease-out'});
    }
    if (this.native) { void this.native.interrupt(); return; }
    this.worker?.postMessage({type: 'interrupt'});
    this.inputWait = false;
    this.sleepsUntil = 0;
  }

  /** A new shell for this repo in this place. */
  restart() {
    this.restarting = true;
    if (!this.ended) this.stop();
    sessions.delete(this.repo);
    const next = terminalFor(this.repo), old = this.element, box = old.parentElement;
    const swap = () => {
      const was = box?.getBoundingClientRect().height ?? 0;
      if (old.isConnected) old.replaceWith(next);
      // Whoever showed this one hears that another has taken its place.
      this.tell();
      if (still() || !box || !next.isConnected) return;
      // Switched on, as a tube is: the box goes from the old screen's height to the new one's, and the new one opens
      // out of a bright line across its middle.
      const now = box.getBoundingClientRect().height;
      if (Math.abs(now - was) > 1) box.animate([{height: `${was}px`}, {height: `${now}px`}], {duration: paced(300), easing: LAND});
      next.animate([{scale: '1 .02', filter: 'brightness(2.6)', opacity: .85}, {scale: '1 .02', filter: 'brightness(2.6)', offset: .22},
        {scale: '1 1', filter: 'brightness(1)', opacity: 1}], {duration: paced(300), easing: LAND});
    };
    if (still() || !old.isConnected) { swap(); return; }
    // The old one goes first, as a tube switched off does: down to a bright line across its middle.
    old.animate([{scale: '1 1', filter: 'brightness(1)'}, {scale: '1 .02', filter: 'brightness(2.4)'}],
      {duration: paced(140), easing: 'cubic-bezier(.5, 0, .9, .5)', fill: 'forwards'}).finished.then(swap, swap);
  }
  /** Started again: its own ending is not shown going dark, the new one comes at once. */
  private restarting = false;

  /** What the ended Prompt says, drawn again in the language chosen meanwhile. */
  private said: (() => string) | null = null;
  /** Why it ended, when it did not start: the title of what it says. */
  private why = '';
  /** How it ended, at the foot of its output. */
  private endLine: HTMLElement | null = null;

  private end(message: () => string, why = '') {
    this.ended = true;
    this.said = message;
    this.why = why;
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
    this.sayEnded(true);
  }

  /** What it says once ended; `now` as it ends, which is seen: the switch goes over to off, and the screen goes dark. */
  private sayEnded(now = false) {
    if (!this.ended || !this.said) return;
    // Ended: what happened and, at the Prompt's bottom right under its output, its power switch, off: switched on,
    // it starts again (styles.css). The same switch as SSH's and a repo card's, no taller than the line.
    const restart = h('button', {class: 'power', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': t('Start again')}, h('span', {class: 'knob'}));
    restart.addEventListener('click', () => this.restart());
    this.element.classList.add('ended');
    // The last thing on its thread, under what it printed last: how it ended, and the switch beside it (in the pane a
    // dot of its own, off), not a row of its own over the box's Run.
    const end = h('div', {class: 'term-end'}, h('span', this.why ? {title: this.why} : {}, this.said()), restart);
    if (this.endLine?.isConnected) this.endLine.replaceWith(end); else this.output.append(end);
    this.endLine = end;
    this.status.replaceChildren();
    this.output.scrollTop = this.output.scrollHeight;
    if (!now || this.restarting || still()) return;
    // From on, its knob across and the green going from under it; the output flares as a tube does and dims to its
    // rest (styles.css .term.ended).
    restart.animate([{backgroundColor: 'var(--raised)', borderColor: 'var(--edge)'}, {}], {duration: paced(260), easing: 'ease-out'});
    restart.firstElementChild!.animate([{transform: 'translateX(24px)', backgroundColor: 'var(--done)'}, {}], {duration: paced(280), easing: LAND});
    this.output.animate([{filter: 'brightness(1.8)'}, {filter: 'brightness(.5)', offset: .3}, {}], {duration: paced(460), easing: 'ease-out'});
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
