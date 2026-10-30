import {h} from '../../ui/dom.ts';
import {kindColon, mark as todoMark} from '../todo-list.ts';
import {waitsAt} from './prompt-line.ts';

// What a Prompt shows of what its shell wrote (terminal.ts): plain lines at the foot of its screen, drawn once a
// frame, a run's lines coming in one after another, the prompt lines it waited at told apart from what the lines run
// printed, and in the pane only the tail of what each line printed. Lines of the box's own (an issue written, a TODO
// added) stand among them as they came.

/** What clears a terminal's screen (clear, Ctrl+L): the output before it goes. */
const CLEARS = /\x1b\[H\x1b\[[23]?J|\x1b\[[23]J|\x1bc/g;
/** Escape sequences are dropped; the console is plain lines for now. */
export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
/** sh -i says this once because the console is not a terminal; it means nothing here. */
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
/** In the pane, what a line printed is its last this many lines (styles.css .term-home .above, .cut): none, the pane
 * tells what was run and the screen holds what it printed. */
const TAIL = 0;

/**
 * A line of the box's own in the Prompt's flow (an issue written, a TODO added from the box), marked at its start
 * (an invisible separator) so a drawing of it all from the text knows it again; what each goes to when pressed, by
 * its words.
 */
const SAID = '⁣';
const goes = new Map<string, (row: HTMLElement) => void>();

/**
 * A line of the box's own, as it stands in the flow: its head as the box's pill said it (#3 in ink, TODO with its
 * circle) and its words, which are a person's, not the shell's; pressed, it opens where it stands.
 */
function ownLine(line: string): HTMLElement {
  const words = line.slice(SAID.length, -1), cut = words.indexOf(' ');
  const head = cut < 0 ? words : words.slice(0, cut), todo = head === 'TODO';
  // Its Kind's colon set as everywhere (todo-list.ts kindWords), the words as they were.
  // A TODO's kind may be written with the narrow colon (Buy: …), an issue's is the wide one (Fix：…): either is its kind.
  const said = words.slice(head.length), kind = /^(\s*(?:[^\s：:]+(?=：)|[A-Za-z][A-Za-z0-9-]{0,15}(?=:(?!\/\/))))([：:])/.exec(said);
  const b = h('button', {type: 'button', class: 'term-said-go'}, h('b', {}, ...(todo ? [todoMark(false)] : []), head),
    h('span', {class: 'said-words'}, ...(kind ? [h('b', {class: 'said-kind'}, kind[1], kind[2] === '：' ? kindColon() : ':'), said.slice(kind[0].length)] : [said])));
  b.addEventListener('click', () => goes.get(line)?.(b));
  return h('span', {class: `term-said ${todo ? 'said-todo' : 'said-issue'}`}, SAID, b, '\n');
}

/** A line sent, after the prompt line it was written at: its words an element of their own, its line break after. */
function command(line: string): Node[] {
  // Its end of line is its own: in the pane the line run is a block beside its prompt line's pill (it goes on under
  // itself), and the end of a block is not one more line.
  return [h('span', {class: 'cmd'}, line)];
}

/**
 * Lines a run printed, each a beat after the one above it, the first ONE_BY_ONE; the rest (a run printing hundreds a
 * frame) all together with the last of those, as one block, not hundreds of lines each coming in on its own.
 */
function oneByOne(lines: string[]): HTMLElement[] {
  const one = lines.slice(0, ONE_BY_ONE), rest = lines.slice(ONE_BY_ONE).join('');
  const end = rest.lastIndexOf('\n') + 1;
  const fresh = [...one.map((line) => h('span', {class: 'fresh'}, line)),
    ...(end ? [h('div', {class: 'fresh term-lines'}, rest.slice(0, end))] : []), ...(end < rest.length ? [h('span', {class: 'fresh'}, rest.slice(end))] : [])];
  fresh.forEach((s, i) => { s.style.animationDelay = `${Math.min(i, ONE_BY_ONE) * STAGGER}ms`; });
  return fresh;
}

/**
 * The pane refers, it does not hold: of what each line run printed, its last TAIL lines are shown there (none: the
 * line run alone, a notification of it, pressed to see what it printed). From the foot
 * back, each piece of a run's output past them is marked above (not shown in the pane), the one they start in cut to
 * its last lines with a fade where more is above. Up as the screen, the marks mean nothing: all of it is there. Only
 * the runs just drawn are walked (the last two: one ended and the next started in the same frame); drawn whole, all.
 */
function tails(out: HTMLElement, all: boolean) {
  let left = TAIL, top: HTMLElement | null = null, starts = 0;
  for (let n = out.lastChild; n; n = n.previousSibling) {
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

/** A Prompt's screen: what its shell wrote, as plain lines, and the lines of the box's own among them. */
export class Output {
  readonly element = h('pre', {class: 'term-out', 'aria-live': 'polite'});
  /** All the shell wrote that is kept, as plain text. */
  #text = '';
  #ttySaid = false;
  #painting = 0;
  /** What came since the last frame drew the screen, to add at its foot; or the whole of it is drawn again (cleared). */
  #fresh = '';
  #whole = false;
  /** How much of the text is on the screen, and its last line (a line not ended yet, or '' when it ends one). */
  #drawnLength = 0;
  #drawnLast = '';
  /** The last line of all the shell wrote: where the prompt line it waits at is. */
  #lastLine = '';
  /** The line just sent, until it is drawn. */
  #echo = '';
  /** When what was printed last has all come in (performance.now()). */
  #settles = 0;
  /** The prompt line the output ends with, in a span of its own: up over the center, the box's line says it instead
   * (bench.ts), so it is not said twice. Once something follows it, it is a prompt line among the output (`.ps`),
   * which the screen tells from what the lines run printed. Its words are what came last; they do not come in again. */
  #tail: HTMLElement | null = null;
  /** Every prompt line the shell has waited at, to tell them again in output drawn whole. */
  #prompts = new Set<string>();
  /** How the Prompt ended, at the foot of its output. */
  #endLine: HTMLElement | null = null;

  /** The last line of all the shell wrote: where the prompt line it waits at is. */
  get lastLine(): string { return this.#lastLine; }

  /** How long until what was printed last has all come in, in ms: what comes after it (the prompt line) waits that long. */
  settlesIn(): number { return Math.max(0, this.#settles - performance.now()); }

  /** `lines` sent from the box, echoed as a terminal does: drawn as the line written moved up a line. */
  sent(lines: string) {
    this.#echo = lines;
    this.print(lines);
  }

  /**
   * What the shell wrote goes on the screen at the next frame. Nothing here looks at all that came before (a run
   * printing a megabyte comes a kilobyte at a time): what came since the last frame is kept apart (`fresh`), and the
   * last line (where the prompt line comes) is followed as each piece comes.
   */
  print(s: string) {
    s = this.#cleared(s);
    const plain = strip(s);
    this.#text += plain;
    this.#fresh += plain;
    const nl = plain.lastIndexOf('\n');
    this.#lastLine = nl < 0 ? this.#lastLine + plain : plain.slice(nl + 1);
    if (this.#noTty()) return;
    // Far more than is kept on the screen came before a frame could draw it: only the last of it is kept.
    if (this.#fresh.length > 4 * KEEP_MOST) { this.#text = this.#text.slice(-KEEP_LEAST); this.#whole = true; }
    // Drawn once a frame, however many pieces came in it. Output comes a stdio buffer (about 1 KB) at a time,
    // and drawing up to 200k characters and scrolling to them for each piece measured about 22 ms a piece in
    // Chromium: 1 MB of output held the page for 22 s; drawn once for every 17 pieces, 1.3 s.
    this.#painting ||= requestAnimationFrame(() => this.#draw());
  }

  /** Cleared: what was on the screen goes, as in a terminal; what comes after the clearing stays (returned). */
  #cleared(s: string): string {
    let cleared = -1;
    for (const m of s.matchAll(CLEARS)) cleared = m.index + m[0].length;
    if (cleared < 0) return s;
    this.#text = '';
    this.#fresh = '';
    this.#whole = true;
    this.#lastLine = '';
    return s.slice(cleared);
  }

  /**
   * NO_TTY may come in pieces; it goes once whole (before anything after it is drawn). True while what came may still
   * become it.
   */
  #noTty(): boolean {
    if (this.#ttySaid) return false;
    if (this.#text.includes(NO_TTY)) {
      this.#text = this.#text.replace(NO_TTY, '');
      this.#ttySaid = true;
      this.#whole = true;
      this.#lastLine = this.#text.slice(this.#text.lastIndexOf('\n') + 1);
      return false;
    }
    // Until then, what may still become it is not drawn: never a frame of it on the screen.
    return !!this.#text && NO_TTY.startsWith(this.#text);
  }

  /**
   * Something the box did that is not the shell's (an issue written, a TODO added: `head` and its words), in the
   * Prompt's flow as it came: a line of its own before the prompt line the shell waits at (after a line being
   * printed, under it), pressed to `go` to it (told the line pressed: a drawing of it all from the text draws it anew).
   * Its line is returned, there now, for what lands on it.
   */
  note(head: string, words: string, go: (row: HTMLElement) => void): HTMLElement {
    // What waits for the next frame is drawn first: the line goes after all that came before it.
    if (this.#painting) { cancelAnimationFrame(this.#painting); this.#draw(); }
    const line = `${SAID}${head} ${words.replace(/\s+/g, ' ').trim()}\n`;
    goes.set(line, go);
    const row = ownLine(line);
    const tail = this.#tail?.isConnected && waitsAt(this.#lastLine) ? this.#tail : null;
    if (tail) {
      this.#text = this.#text.slice(0, this.#text.length - this.#lastLine.length) + line + this.#lastLine;
      this.element.insertBefore(row, tail);
    } else {
      const under = this.#lastLine ? '\n' : '';
      this.#text += under + line;
      this.element.append(under, row);
      this.#lastLine = '';
      this.#drawnLast = '';
    }
    this.#drawnLength = this.#text.length;
    this.#trim();
    this.element.scrollTo({top: this.element.scrollHeight});
    return row.querySelector('button')!;
  }

  /**
   * Put back into the box, the Prompt is read afresh from its line: what it printed so far is folded away (`.earlier`),
   * there to be opened again, so up next time the screen holds the prompt line it waits at and what comes after it.
   * The pane, which only tells, still lists the lines run. How many lines run (and lines of the box's own) are folded.
   */
  fold(): number {
    for (let n = this.element.firstChild; n; n = n.nextSibling) {
      if (n === this.#tail || n === this.#endLine) continue;
      if (!(n instanceof HTMLElement)) {
        if (!n.textContent) continue;
        const held = h('span', {});
        n.replaceWith(held);
        held.append(n);
        n = held;
      }
      (n as HTMLElement).classList.add('earlier');
    }
    this.element.classList.remove('unfolded');
    return this.element.querySelectorAll(':scope > .earlier:is(.ps, .term-said)').length;
  }

  /** What was folded away, opened again where it stood. */
  unfold() {
    this.element.classList.add('unfolded');
  }

  /** How the Prompt ended, the last thing at the foot of its output (in its place, said again in another language). */
  ended(line: HTMLElement) {
    if (this.#endLine?.isConnected) this.#endLine.replaceWith(line); else this.element.append(line);
    this.#endLine = line;
    this.element.scrollTop = this.element.scrollHeight;
  }

  /**
   * What came since the last frame, at the foot: a few lines come in a line after another, so a run is seen
   * coming rather than appearing; a lot at once is added whole, in blocks (BLOCK), never drawing again what was
   * there; the start cut away (cleared) is drawn whole. Past KEEP_MOST the oldest lines go from the top.
   */
  #draw() {
    this.#painting = 0;
    if (!this.#fresh && !this.#whole) return;
    // The prompt line it waited at stays a prompt line, seen once something follows it.
    this.#tail?.classList.remove('waits');
    this.#tail = null;
    const add = this.#whole || !this.#drawnLength ? null : this.#fresh;
    const moving = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (add !== null && add.length < 4000 && moving) this.#comeIn(add);
    else if (add !== null) this.element.append(...this.#blocks(add, this.#drawnLast === ''));
    else this.element.replaceChildren(...this.#blocks(this.#text, true));
    this.#echo = '';
    this.#fresh = '';
    this.#whole = false;
    this.#drawnLength = this.#text.length;
    this.#drawnLast = this.#lastLine;
    this.#trim();
    this.#markTail();
    tails(this.element, add === null);
    // Full, what comes in scrolls the rest up, smoothly, as a terminal's screen does (at once when much came at once).
    const out = this.element, far = out.scrollHeight - out.clientHeight - out.scrollTop;
    const smooth = add !== null && far < out.clientHeight && moving;
    out.scrollTo({top: out.scrollHeight, behavior: smooth ? 'smooth' : 'auto'});
  }

  /** A few lines, come in a line after another after the line run. */
  #comeIn(add: string) {
    // The line just sent is the line written moved up a line, as a terminal's is: it does not come in again.
    // Sent from elsewhere (a line pressed, Git), what goes on after the prompt line is the line run all the same.
    const nl = add.indexOf('\n') + 1;
    const echo = this.#echo && add.startsWith(this.#echo) ? this.#echo : nl && this.#prompts.has(this.#drawnLast) ? add.slice(0, nl) : '';
    if (echo) this.element.append(...command(echo));
    const lines = add.slice(echo.length).split(/(?<=\n)/).filter(Boolean);
    this.element.append(...oneByOne(lines));
    // Its last line under way: what comes after (the prompt line) follows it in.
    this.#settles = lines.length ? performance.now() + Math.min(lines.length - 1, ONE_BY_ONE) * STAGGER + FADE / 2 : 0;
  }

  /** Past KEEP_MOST, the oldest lines go from the top of the screen (whole lines, down to KEEP_LEAST), as from the text. */
  #trim() {
    if (this.#drawnLength <= KEEP_MOST) return;
    const nl = this.#text.indexOf('\n', this.#text.length - KEEP_LEAST);
    let left = nl < 0 ? this.#text.length - KEEP_LEAST : nl + 1;
    let cut = 0;
    while (left > 0 && this.element.firstChild) {
      const node = this.element.firstChild;
      const n = node.textContent?.length ?? 0;
      if (n <= left || node.childNodes.length > 1) { node.remove(); left -= n; cut += n; continue; }
      // Within a block (or a text): its first lines go, the rest of it stays where it is.
      const text = (node.nodeType === Node.TEXT_NODE ? node : node.firstChild) as Text;
      text.deleteData(0, left);
      cut += left;
      left = 0;
    }
    this.#text = this.#text.slice(cut);
    this.#drawnLength = this.#text.length;
  }

  /**
   * `text` as nodes to add at the screen's foot (`fresh`: it starts a line): the rest of the line it continues as it
   * is, whole lines in blocks (a prompt line the shell waited at, at a line's start, in a span of its own between
   * them, as `.ps`), and a line not ended yet (the prompt line it waits at, a line half printed) as it is, after.
   */
  #blocks(text: string, fresh: boolean): Node[] {
    const out: Node[] = [];
    let at = 0;
    if (!fresh) {
      const nl = text.indexOf('\n');
      at = nl < 0 ? text.length : nl + 1;
      // After the prompt line it waited at, what goes on that line is what was run.
      if (at) out.push(...(this.#prompts.has(this.#drawnLast) ? command(text.slice(0, at)) : [document.createTextNode(text.slice(0, at))]));
    }
    const end = text.lastIndexOf('\n') + 1;
    let block = '';
    const close = () => { if (block) out.push(h('div', {class: 'term-lines'}, block)); block = ''; };
    const prompts = [...this.#prompts];
    while (at < end) {
      const nl = text.indexOf('\n', at) + 1;
      const line = text.slice(at, nl);
      at = nl;
      if (line.startsWith(SAID)) { close(); out.push(ownLine(line)); continue; }
      const ps = prompts.length ? prompts.find((p) => line.startsWith(p)) : undefined;
      if (ps) { close(); out.push(h('span', {class: 'ps'}, ps), ...command(line.slice(ps.length))); continue; }
      block += line;
      if (block.length >= BLOCK) close();
    }
    close();
    if (at < text.length) out.push(document.createTextNode(text.slice(at)));
    return out;
  }

  /** The prompt line the output ends with, if it ends with one, taken into a span of its own (`tail`). */
  #markTail() {
    const waits = waitsAt(this.#lastLine);
    let left = waits.length;
    if (!left) return;
    this.#prompts.add(waits);
    // From the end back to where the prompt line starts, through what was drawn whole or a line after another.
    let node: Node | null = this.element.lastChild;
    while (node?.lastChild) node = node.lastChild;
    const walk = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
    if (node) walk.currentNode = node;
    for (let at = node?.nodeType === Node.TEXT_NODE ? node as Text : walk.previousNode() as Text | null; at; at = walk.previousNode() as Text | null) {
      if (at.length < left) { left -= at.length; continue; }
      const r = document.createRange();
      r.setStart(at, at.length - left);
      r.setEnd(this.element, this.element.childNodes.length);
      const tail = h('span', {class: 'ps waits'});
      tail.append(r.extractContents());
      for (const f of tail.querySelectorAll('.fresh')) f.classList.remove('fresh');
      this.element.append(tail);
      this.#tail = tail;
      return;
    }
  }
}
