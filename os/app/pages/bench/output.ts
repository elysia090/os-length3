import {h} from '../../ui/dom.ts';
import {waitsAt} from './prompt-line.ts';
import {css, LineState, Screen, runs as runsOf, sgrOf, type Row, type Run} from './vt.ts';
import {ScreenView, styled} from './vt-view.ts';

// What a Prompt shows of what its shell wrote (terminal.ts), as a terminal shows it: lines at the foot of its screen,
// drawn once a frame, in the colours the programs give them, a run's lines coming in one after another, the prompt
// lines it waited at told apart from what the lines run printed. The line under way is its own, drawn again as it
// changes, so a carriage return or an erase rewrites it (a counter, a progress bar). A program that reads each key as it
// comes (vi, less, top) is shown on a terminal's whole screen (vt.ts) in place of the last lines, until it gives the
// terminal back. What the box does that is not the shell's is the pane's (rows.ts), not the Prompt's.

/** What clears a terminal's screen (clear, Ctrl+L): the output before it goes. */
const CLEARS = /\x1b\[H\x1b\[[23]?J|\x1b\[[23]J|\x1bc/g;
/** What a run printed, as plain text (the pane's): escape sequences dropped, line ends a line feed. */
export const strip = (s: string) => s.replace(/\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-B]/g, '').replace(/\r\n?/g, '\n');
/** sh -i says this once where the console is not a terminal; it means nothing here. */
const NO_TTY = "/bin/sh: can't access tty; job control turned off\n";
/** What a run prints comes in a line after another (styles.css .fresh): this far apart, each over this long. */
const STAGGER = 30, FADE = 240;
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

/** A stretch of the kept text in one style: `n` letters of style `st` (0 plain). */
interface Span { n: number; st: number }

/** A line sent, after the prompt line it was written at: its words an element of their own, its line break after. */
function command(line: string): Node[] {
  return [h('span', {class: 'cmd'}, line)];
}

/**
 * Lines a run printed, each a beat after the one above it, the first ONE_BY_ONE; the rest (a run printing hundreds a
 * frame) all together with the last of those, as one block, not hundreds of lines each coming in on its own.
 */
function oneByOne(lines: string[]): HTMLElement[] {
  const one = lines.slice(0, ONE_BY_ONE), rest = lines.slice(ONE_BY_ONE).join('');
  const fresh = [...one.map((line) => h('span', {class: 'fresh'}, line)), ...(rest ? [h('div', {class: 'fresh term-lines'}, rest)] : [])];
  fresh.forEach((s, i) => { s.style.animationDelay = `${Math.min(i, ONE_BY_ONE) * STAGGER}ms`; });
  return fresh;
}

/** Spans laid end to end, those of one style joined. */
function push(to: Span[], n: number, st: number) {
  if (!n) return;
  const last = to.at(-1);
  if (last && last.st === st) last.n += n; else to.push({n, st});
}

/** How a program has the terminal set, as the page sends keys and shows lines by it. */
export interface Keys { cols: number; rows: number; newline: boolean; reply(text: string): void }

/** A Prompt's screen: what its shell wrote, and the lines of the box's own among them. */
export class Output {
  readonly element = h('pre', {class: 'term-out', 'aria-live': 'polite'});
  /** The lines ended (each with its line feed), kept as plain text, with their styles beside them. */
  #done = '';
  #spans: Span[] = [];
  /** The lines ended since the last frame drew the screen, to add at its foot, and their styles; or the whole of it is
   * drawn again (cleared). */
  #fresh = '';
  #freshSpans: Span[] = [];
  #whole = false;
  /** The line under way, read a letter at a time (vt.ts), and where it is drawn: always the last of the lines. */
  readonly #line = new LineState((rs) => this.#ended(rs));
  readonly #live = h('span', {class: 'term-live'});
  #liveDrawn = '';
  /** The line under way as the last frame showed it: ended since, what was seen of it does not come in again. */
  #livePlain = '';
  #ttySaid = false;
  #painting = 0;
  #drawnLength = 0;
  /** The line just sent, until it is drawn. */
  #echo = '';
  /** When what was printed last has all come in (performance.now()). */
  #settles = 0;
  /** Every prompt line the shell has waited at, to tell them again in output drawn whole. */
  #prompts = new Set<string>();
  /** How the Prompt ended, at the foot of its output. */
  #endLine: HTMLElement | null = null;
  /** A whole-screen program's screen, while one has the terminal. */
  #screen: {screen: Screen; view: ScreenView} | null = null;

  constructor() {
    // A line come in is fresh only while it comes in: once it has, it is a line as the others (a style worked out again
    // later, the desk's camera setting off, would bring it in a second time, fading, long after it was printed).
    this.element.addEventListener('animationend', (e) => { (e.target as Element).classList.remove('fresh'); });
  }

  /** The line under way: where the prompt line the shell waits at is. */
  get lastLine(): string { return this.#line.text; }

  /** How long until what was printed last has all come in, in ms: what comes after it (the prompt line) waits that long. */
  settlesIn(): number { return Math.max(0, this.#settles - performance.now()); }

  /** `line`, the line under way as it stands (a prompt line put there for the shell, not by it), taken back; false when
   * the line under way is something else now. */
  takeBack(line: string): boolean {
    if (!line || this.#line.text !== line) return false;
    this.#line.clear();
    this.#painting ||= requestAnimationFrame(() => this.#draw());
    return true;
  }

  /** `lines` sent from the box, echoed as a terminal does: drawn as the line written moved up a line. */
  sent(lines: string) {
    this.#echo = lines;
    this.print(lines);
  }

  /**
   * What the shell wrote goes on the screen at the next frame. Nothing here looks at all that came before (a run
   * printing a megabyte comes a kilobyte at a time): what ends lines since the last frame is kept apart (`fresh`), and
   * the line under way is followed as each piece comes.
   */
  print(s: string) {
    if (this.#screen) { this.#screen.screen.write(s); this.#painting ||= requestAnimationFrame(() => this.#draw()); return; }
    s = this.#cleared(s);
    this.#line.write(s);
    if (this.#noTty()) return;
    // Far more than is kept on the screen came before a frame could draw it: only the last of it is kept.
    if (this.#fresh.length > 4 * KEEP_MOST) this.#keepLast(KEEP_LEAST);
    // Drawn once a frame, however many pieces came in it. Output comes a stdio buffer (about 1 KB) at a time,
    // and drawing up to 200k characters and scrolling to them for each piece measured about 22 ms a piece in
    // Chromium: 1 MB of output held the page for 22 s; drawn once for every 17 pieces, 1.3 s.
    this.#painting ||= requestAnimationFrame(() => this.#draw());
  }

  /**
   * A program reads each key as it comes (`keys`), or gives the terminal back (null): while it has it, what it prints is
   * drawn on a terminal's screen in place of the last lines, the lines there as it starts; given back, what its screen
   * holds is lines again, the cursor's row the line under way.
   */
  keys(keys: Keys | null) {
    if (!!keys === !!this.#screen) { if (keys && this.#screen) this.#screen.screen.newline = keys.newline; return; }
    if (keys) {
      const screen = new Screen(keys.cols, keys.rows, (row) => this.#scrolledOff(row), keys.reply);
      screen.newline = true;
      // The last lines, and the line under way, on its screen as they stand, colours and all.
      const lines = this.#done.split('\n').slice(0, -1);
      const took = lines.slice(-(keys.rows - 1));
      let at = this.#done.length;
      for (const l of took) at -= l.length + 1;
      const said = this.#said(at, this.#done.length) + this.#lineSaid();
      this.#cut(at);
      this.#line.clear();
      screen.write(said);
      screen.newline = keys.newline;
      this.#screen = {screen, view: new ScreenView(screen)};
      this.#whole = true;
    } else {
      const {screen} = this.#screen!;
      this.#screen = null;
      // What is on its main screen is lines again: down to its cursor's row (the line under way), and what is written
      // under it.
      const {rows, y} = screen.main;
      let last = rows.length - 1;
      while (last > y && !rows[last].chars.join('').trim()) last--;
      const said = rows.slice(0, last + 1).map((r, i) => this.#rowSaid(r, screen) + (i < last ? '\r\n' : '')).join('');
      this.#whole = true;
      this.#line.write(said.replace(/\r\n/g, '\n'));
    }
    this.#painting ||= requestAnimationFrame(() => this.#draw());
  }

  /** Whether a whole-screen program has the terminal. */
  get screenShown(): boolean { return !!this.#screen; }
  /** As the program with the terminal asked: its arrows sent as an application's, a paste bracketed. */
  get appCursor(): boolean { return !!this.#screen?.screen.appCursor; }
  get bracketed(): boolean { return !!this.#screen?.screen.bracketed; }

  /** A line ended: kept, with its styles, to be drawn. */
  #ended(rs: Run[]) {
    for (const r of rs) { push(this.#spans, r.text.length, r.st); push(this.#freshSpans, r.text.length, r.st); }
    push(this.#spans, 1, 0);
    push(this.#freshSpans, 1, 0);
    const text = `${rs.map((r) => r.text).join('')}\n`;
    this.#done += text;
    this.#fresh += text;
  }

  /** A row scrolled off a whole-screen program's main screen: a line ended above it. */
  #scrolledOff(row: Row) {
    const chars = row.chars.filter((c) => c !== '');
    let end = chars.length;
    while (end > 0 && chars[end - 1] === ' ' && row.st[end - 1] === 0) end--;
    const st = row.st.filter((_, x) => row.chars[x] !== '');
    this.#ended(runsOf(chars.slice(0, end), st.slice(0, end)));
  }

  /** The kept text from `from` to `to` said again with its styles (SGR), as a screen is given it. */
  #said(from: number, to: number): string {
    let out = '', at = 0;
    for (const s of this.#spans) {
      const a = Math.max(at, from), b = Math.min(at + s.n, to);
      if (a < b) out += (s.st ? sgrOf(this.#line.styles.of(s.st)) : '\x1b[0m') + this.#done.slice(a, b).replace(/\n/g, '\r\n');
      at += s.n;
      if (at >= to) break;
    }
    return out;
  }

  /** The line under way said again with its styles. */
  #lineSaid(): string {
    return `${this.#line.runs.map((r) => (r.st ? sgrOf(this.#line.styles.of(r.st)) : '\x1b[0m') + r.text).join('')}\x1b[0m`;
  }

  /** A screen's row said again with its styles, its blank end left off. */
  #rowSaid(row: Row, screen: Screen): string {
    const chars: string[] = [], st: number[] = [];
    row.chars.forEach((c, x) => { if (c !== '') { chars.push(c); st.push(row.st[x]); } });
    let end = chars.length;
    while (end > 0 && chars[end - 1] === ' ' && st[end - 1] === 0) end--;
    return `${runsOf(chars.slice(0, end), st.slice(0, end)).map((r) => (r.st ? sgrOf(screen.styles.of(r.st)) : '\x1b[0m') + r.text).join('')}\x1b[0m`;
  }

  /** The kept text from `at` on taken away (drawn again whole). */
  #cut(at: number) {
    this.#done = this.#done.slice(0, at);
    const kept: Span[] = [];
    let n = 0;
    for (const s of this.#spans) { if (n >= at) break; push(kept, Math.min(s.n, at - n), s.st); n += s.n; }
    this.#spans = kept;
    this.#fresh = '';
    this.#freshSpans = [];
    this.#whole = true;
  }

  /** Only the last `n` letters (whole lines) of the kept text kept. */
  #keepLast(n: number) {
    const nl = this.#done.indexOf('\n', this.#done.length - n);
    const cut = nl < 0 ? Math.max(0, this.#done.length - n) : nl + 1;
    this.#done = this.#done.slice(cut);
    let left = cut;
    while (left > 0 && this.#spans.length) {
      const s = this.#spans[0];
      if (s.n <= left) { left -= s.n; this.#spans.shift(); } else { s.n -= left; left = 0; }
    }
    this.#fresh = '';
    this.#freshSpans = [];
    this.#whole = true;
  }

  /** Cleared: what was on the screen goes, as in a terminal; what comes after the clearing stays (returned). */
  #cleared(s: string): string {
    let cleared = -1;
    for (const m of s.matchAll(CLEARS)) cleared = m.index + m[0].length;
    if (cleared < 0) return s;
    this.#cut(0);
    this.#line.clear();
    return s.slice(cleared);
  }

  /**
   * NO_TTY may come in pieces; it goes once whole (before anything after it is drawn). True while what came may still
   * become it.
   */
  #noTty(): boolean {
    if (this.#ttySaid) return false;
    if (this.#done.includes(NO_TTY)) {
      const at = this.#done.indexOf(NO_TTY);
      this.#done = this.#done.slice(0, at) + this.#done.slice(at + NO_TTY.length);
      this.#spans = [{n: this.#done.length, st: 0}];
      this.#ttySaid = true;
      this.#fresh = '';
      this.#freshSpans = [];
      this.#whole = true;
      return false;
    }
    // Until then, what may still become it is not drawn: never a frame of it on the screen.
    const all = this.#done + this.#line.text;
    return !!all && NO_TTY.startsWith(all);
  }

  /**
   * Put back into the box, the Prompt is read afresh from its line: what it printed so far is folded away (`.earlier`),
   * so up next time the screen holds the prompt line it waits at and what comes after it. The pane, the same lines
   * seen there, still lists every line run; pressed, one is read there with all it printed (forge/reference.ts).
   */
  fold() {
    for (let n = this.element.firstChild; n; n = n.nextSibling) {
      if (n === this.#live || n === this.#endLine || n === this.#screen?.view.element) continue;
      if (!(n instanceof HTMLElement)) {
        if (!n.textContent) continue;
        const held = h('span', {});
        n.replaceWith(held);
        held.append(n);
        n = held;
      }
      (n as HTMLElement).classList.add('earlier');
    }
  }

  /** How the Prompt ended, the last thing at the foot of its output (in its place, said again in another language). */
  ended(line: HTMLElement) {
    if (this.#endLine?.isConnected) this.#endLine.replaceWith(line); else this.element.append(line);
    this.#endLine = line;
    this.element.scrollTop = this.element.scrollHeight;
  }

  /**
   * What came since the last frame, at the foot: a few lines come in a line after another, so a run is seen coming
   * rather than appearing; a lot at once is added whole, in blocks (BLOCK), never drawing again what was there; the
   * start cut away (cleared) is drawn whole. The line under way is drawn again where it changed. Past KEEP_MOST the
   * oldest lines go from the top.
   */
  #draw() {
    this.#painting = 0;
    const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const view = this.#screen?.view;
    const foot = view?.element ?? this.#live;
    let added = false;
    if (this.#whole) {
      const nodes = this.#blocks(this.#done);
      this.element.replaceChildren(...nodes, ...(view ? [view.element] : []), this.#live, ...(this.#endLine ? [this.#endLine] : []));
      this.#paint(nodes, this.#spans);
      this.#liveDrawn = '\0';
    } else if (this.#fresh) {
      if (!foot.isConnected) this.element.append(foot);
      const nodes = this.#fresh.length < 4000 && moving && !view ? this.#comeIn(this.#fresh) : this.#blocks(this.#fresh);
      foot.before(...nodes);
      this.#paint(nodes, this.#freshSpans);
      added = true;
    } else if (!this.#live.isConnected) this.element.append(this.#live);
    view?.draw();
    // The line under way, drawn again where it is not as drawn.
    const live = this.#line.text, rs = this.#line.runs, look = rs.map((r) => `${r.st}:${r.text}`).join('\u0000');
    if (look !== this.#liveDrawn) {
      this.#live.replaceChildren(...styled(rs, this.#line.styles));
      this.#liveDrawn = look;
      added ||= !!live;
    }
    this.#livePlain = live;
    const waits = waitsAt(live);
    if (waits) this.#prompts.add(waits);
    this.#live.classList.toggle('ps', !!waits);
    this.#live.classList.toggle('waits', !!waits);
    this.#echo = '';
    this.#fresh = '';
    this.#freshSpans = [];
    this.#whole = false;
    this.#drawnLength = this.#done.length;
    this.#trim();
    // Full, what comes in scrolls the rest up, smoothly, as a terminal's screen does (at once when much came at once).
    const out = this.element, far = out.scrollHeight - out.clientHeight - out.scrollTop;
    const smooth = added && far < out.clientHeight && moving;
    out.scrollTo({top: out.scrollHeight, behavior: smooth ? 'smooth' : 'auto'});
  }

  /** `nodes` just drawn from kept text, coloured as `spans` say (in the order their text is drawn). */
  #paint(nodes: Node[], spans: Span[]) {
    if (spans.every((s) => !s.st)) return;
    let i = 0, left = spans[0]?.n ?? 0;
    const texts: Text[] = [];
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) { texts.push(node as Text); continue; }
      const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) texts.push(walk.currentNode as Text);
    }
    for (const t of texts) {
      const pieces: Run[] = [];
      for (let at = 0; at < t.length;) {
        while (left === 0 && i < spans.length - 1) left = spans[++i].n;
        const n = Math.min(left || t.length - at, t.length - at);
        pieces.push({text: t.data.slice(at, at + n), st: spans[i]?.st ?? 0});
        at += n;
        left -= n;
      }
      if (pieces.some((p) => p.st)) t.replaceWith(...pieces.map((p) => {
        const look = p.st ? css(this.#line.styles.of(p.st)) : '';
        return look ? h('span', {style: look}, p.text) : document.createTextNode(p.text);
      }));
    }
  }

  /** A few lines, come in a line after another after the line run. */
  #comeIn(add: string) {
    const lines = add.split(/(?<=\n)/).filter(Boolean);
    const out: Node[] = [];
    // The line just sent is the line written moved up a line, as a terminal's is: it does not come in again, its prompt
    // line and the line run told apart. Sent from elsewhere (a line pressed, Git), the same.
    const first = lines[0] ?? '', ps = [...this.#prompts].find((p) => first.startsWith(p)), seen = this.#livePlain;
    if (ps) { out.push(h('span', {class: 'ps'}, ps), ...command(first.slice(ps.length))); lines.shift(); }
    else if (this.#echo && first === this.#echo) { out.push(...command(first)); lines.shift(); }
    else if (seen && first.startsWith(seen)) {
      // The line under way, ended: what was seen of it stays as it was, what came after it comes in (the line sent).
      const rest = first.slice(seen.length);
      out.push(document.createTextNode(seen), ...(rest === this.#echo ? command(rest) : oneByOne([rest])));
      lines.shift();
    }
    out.push(...oneByOne(lines));
    // Its last line under way: what comes after (the prompt line) follows it in.
    this.#settles = lines.length ? performance.now() + Math.min(lines.length - 1, ONE_BY_ONE) * STAGGER + FADE / 2 : 0;
    return out;
  }

  /** Past KEEP_MOST, the oldest lines go from the top of the screen (whole lines, down to KEEP_LEAST), as from the text. */
  #trim() {
    if (this.#drawnLength <= KEEP_MOST) return;
    const nl = this.#done.indexOf('\n', this.#done.length - KEEP_LEAST);
    let left = nl < 0 ? this.#done.length - KEEP_LEAST : nl + 1;
    const cut = left;
    while (left > 0 && this.element.firstChild && this.element.firstChild !== this.#live && this.element.firstChild !== this.#screen?.view.element) {
      const node = this.element.firstChild;
      const n = node.textContent?.length ?? 0;
      if (n <= left || node.childNodes.length > 1) { node.remove(); left -= n; continue; }
      // Within a block (or a text): its first lines go, the rest of it stays where it is.
      const text = (node.nodeType === Node.TEXT_NODE ? node : node.firstChild) as Text;
      text.deleteData(0, left);
      left = 0;
    }
    this.#done = this.#done.slice(cut);
    let drop = cut;
    while (drop > 0 && this.#spans.length) {
      const s = this.#spans[0];
      if (s.n <= drop) { drop -= s.n; this.#spans.shift(); } else { s.n -= drop; drop = 0; }
    }
    this.#drawnLength = this.#done.length;
  }

  /**
   * Lines ended, as nodes to add at the screen's foot: whole lines in blocks (a prompt line the shell waited at, in a
   * span of its own between them, as `.ps`, the line run after it).
   */
  #blocks(text: string): Node[] {
    const out: Node[] = [];
    let at = 0, block = '';
    const close = () => { if (block) out.push(h('div', {class: 'term-lines'}, block)); block = ''; };
    const prompts = [...this.#prompts];
    while (at < text.length) {
      const nl = text.indexOf('\n', at);
      const end = nl < 0 ? text.length : nl + 1;
      const line = text.slice(at, end);
      at = end;
      const ps = prompts.length ? prompts.find((p) => line.startsWith(p)) : undefined;
      if (ps) { close(); out.push(h('span', {class: 'ps'}, ps), ...command(line.slice(ps.length))); continue; }
      block += line;
      if (block.length >= BLOCK) close();
    }
    close();
    return out;
  }
}
