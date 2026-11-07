// A terminal's screen as programs speak to it (VT100 and xterm's additions): what a program writes, escape sequences
// and all, kept as a grid of letters, each with its colours and weight, a cursor, an alternate screen for whole-screen
// programs (vi, less, top), and the main screen's lines that scroll off its top. Drawn by vt-view.ts; the Prompt's own
// lines (output.ts) use the same reading of colours for a line at a time (LineState).

/** How a letter is drawn: its colours (-1 the terminal's own; 0 to 255 the palette; 0x1000000 and up a colour given
 * as red, green and blue), and its weight and marks (the F bits). */
export interface Style { fg: number; bg: number; flags: number }
export const F = {bold: 1, dim: 2, italic: 4, under: 8, inverse: 16, strike: 32, hidden: 64} as const;
export const PLAIN: Style = {fg: -1, bg: -1, flags: 0};
const RGB = 0x1000000;

/** Styles as small numbers, the same style the same number (0 is plain), so a line keeps one number a letter. */
export class Styles {
  readonly #all: Style[] = [PLAIN];
  readonly #ids = new Map<string, number>([['-1,-1,0', 0]]);
  id(s: Style): number {
    const key = `${s.fg},${s.bg},${s.flags}`;
    let n = this.#ids.get(key);
    if (n === undefined) { n = this.#all.length; this.#all.push({...s}); this.#ids.set(key, n); }
    return n;
  }
  of(id: number): Style { return this.#all[id] ?? PLAIN; }
}

/** `s` changed by an SGR's parameters (`ps`, each a list: 38:2::r:g:b comes as one), as xterm reads them. */
export function sgr(s: Style, ps: number[][]): Style {
  let {fg, bg, flags} = s;
  const colour = (p: number[], i: number, rest: number[][]): [number, number] => {
    // 38;5;n and 38;2;r;g;b, or with colons as one parameter (38:5:n, 38:2::r:g:b, 38:2:r:g:b).
    const sub = p.length > 1 ? p.slice(1) : rest.slice(i + 1).map((q) => q[0] ?? 0);
    if (sub[0] === 5) return [sub[1] ?? 0, p.length > 1 ? 0 : 2];
    if (sub[0] === 2) {
      const c = p.length > 1 && sub.length >= 5 ? sub.slice(2, 5) : sub.slice(1, 4);
      return [RGB | ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255), p.length > 1 ? 0 : 4];
    }
    return [-1, p.length > 1 ? 0 : sub.length];
  };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], n = p[0] ?? 0;
    if (n === 0) { fg = -1; bg = -1; flags = 0; }
    else if (n === 1) flags |= F.bold;
    else if (n === 2) flags |= F.dim;
    else if (n === 3) flags |= F.italic;
    else if (n === 4) flags = p[1] === 0 ? flags & ~F.under : flags | F.under;
    else if (n === 7) flags |= F.inverse;
    else if (n === 8) flags |= F.hidden;
    else if (n === 9) flags |= F.strike;
    else if (n === 21) flags |= F.under;
    else if (n === 22) flags &= ~(F.bold | F.dim);
    else if (n === 23) flags &= ~F.italic;
    else if (n === 24) flags &= ~F.under;
    else if (n === 27) flags &= ~F.inverse;
    else if (n === 28) flags &= ~F.hidden;
    else if (n === 29) flags &= ~F.strike;
    else if (n >= 30 && n <= 37) fg = n - 30;
    else if (n === 38) { const [c, skip] = colour(p, i, ps); fg = c; i += skip; }
    else if (n === 39) fg = -1;
    else if (n >= 40 && n <= 47) bg = n - 40;
    else if (n === 48) { const [c, skip] = colour(p, i, ps); bg = c; i += skip; }
    else if (n === 49) bg = -1;
    else if (n >= 90 && n <= 97) fg = n - 90 + 8;
    else if (n >= 100 && n <= 107) bg = n - 100 + 8;
  }
  return {fg, bg, flags};
}

/** How many cells a letter takes: two for the wide ones of East Asian scripts and emoji, none for a mark joined to the
 * letter before it. */
export function width(cp: number): number {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20d7 || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** A row of the screen: a letter a cell (a wide letter's second cell is ''), each with its style; `wrapped`: it goes on
 * into the next row (a line longer than the screen is wide). */
export interface Row { chars: string[]; st: number[]; wrapped: boolean }
const blankRow = (cols: number, st = 0): Row => ({chars: Array<string>(cols).fill(' '), st: Array<number>(cols).fill(st), wrapped: false});

/** The DEC special graphics a program asks for with ESC ( 0: line drawing. */
const DRAWING: Record<string, string> = {j: '┘', k: '┐', l: '┌', m: '└', n: '┼', q: '─', t: '├', u: '┤', v: '┴', w: '┬', x: '│',
  a: '▒', '`': '◆', f: '°', g: '±', '~': '·', o: '⎺', p: '⎻', r: '⎼', s: '⎽', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£'};

/** What a parser hands what it reads to. */
export interface Reader {
  print(text: string): void; control(c: string): void; esc(c: string, inter: string): void;
  csi(ps: number[][], mark: string, final: string, inter: string): void; osc(text: string): void; charset(slot: string, set: string): void;
  /** Whole lines of letters, each ended by a line feed and nothing else in them, told at once in place of a print and
   * a line feed for each (a reader that takes them so: LineState), right after a line feed. */
  lines?(text: string): void;
}

/** Whether the letter (UTF-16 unit) `c` is read otherwise than as a letter: C0, DEL, C1. */
const special = (c: number) => c < 0x20 || (c >= 0x7f && c < 0xa0);

/**
 * Escape sequences read a letter at a time, as a terminal reads them: what is printed goes to `print`, a control letter
 * to `control`, ESC and a letter to `esc`, a CSI to `csi` (its parameters, each with its colon-joined parts; a private
 * mark such as ? or >; the final letter), an OSC's text to `osc`. Pieces may cut a sequence anywhere.
 */
export class Parser {
  #state: 'ground' | 'esc' | 'csi' | 'osc' | 'charset' | 'string' = 'ground';
  #params = '';
  #inter = '';
  #osc = '';
  #charsetFor = '';
  readonly to: Reader;
  constructor(to: Reader) { this.to = to; }

  write(text: string) {
    const n = text.length;
    for (let i = 0; i < n;) {
      if (this.#state === 'ground') {
        // Letters up to the next control or escape, as one run (a letter at a time, a flood spent most of its time here).
        let j = i;
        while (j < n && !special(text.charCodeAt(j))) j++;
        if (j > i) this.to.print(text.slice(i, j));
        if (j >= n) return;
        const c = text.charCodeAt(j);
        i = j + 1;
        if (c === 0x1b) { this.#state = 'esc'; this.#inter = ''; }
        else if (c === 0x0a) {
          this.to.control('\n');
          if (!this.to.lines) continue;
          // The whole lines of letters after it, at once.
          let k = i, last = -1;
          for (; k < n; k++) { const d = text.charCodeAt(k); if (d === 0x0a) last = k; else if (special(d)) break; }
          if (last >= i) { this.to.lines(text.slice(i, last + 1)); i = last + 1; }
        } else if (c < 0x20) this.to.control(text[j]);
        else if (c === 0x9b) { this.#state = 'csi'; this.#params = ''; this.#inter = ''; }
        else if (c === 0x9d) { this.#state = 'osc'; this.#osc = ''; }
        continue;
      }
      const c = text.codePointAt(i)!, ch = String.fromCodePoint(c);
      i += ch.length;
      switch (this.#state) {
        case 'esc':
          if (c === 0x5b) { this.#state = 'csi'; this.#params = ''; this.#inter = ''; }
          else if (c === 0x5d) { this.#state = 'osc'; this.#osc = ''; }
          else if (c === 0x28 || c === 0x29 || c === 0x2a || c === 0x2b) { this.#state = 'charset'; this.#charsetFor = ch; }
          else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) { this.#state = 'string'; }
          else if (c >= 0x20 && c <= 0x2f) this.#inter += ch;
          else if (c === 0x1b) this.#inter = '';
          else { this.#state = 'ground'; if (c >= 0x30 && c <= 0x7e) this.to.esc(ch, this.#inter); }
          break;
        case 'charset':
          this.#state = 'ground';
          this.to.charset(this.#charsetFor, ch);
          break;
        case 'csi':
          if ((c >= 0x30 && c <= 0x3f)) this.#params += ch;
          else if (c >= 0x20 && c <= 0x2f) this.#inter += ch;
          else if (c >= 0x40 && c <= 0x7e) {
            this.#state = 'ground';
            const raw = this.#params, mark = /^[<=>?]/.test(raw) ? raw[0] : '';
            const ps = (mark ? raw.slice(1) : raw).split(';').map((p) => (p === '' ? [] : p.split(':').map((q) => (q === '' ? 0 : Number(q) || 0))));
            this.to.csi(raw === '' ? [] : ps, mark, ch, this.#inter);
          } else if (c === 0x1b) { this.#state = 'esc'; this.#inter = ''; }
          else if (c < 0x20) this.to.control(ch);
          else this.#state = 'ground';
          break;
        case 'osc':
          if (c === 0x07 || c === 0x9c) { this.#state = 'ground'; this.to.osc(this.#osc); }
          else if (c === 0x1b) { this.#state = 'esc'; this.to.osc(this.#osc); }
          else if (this.#osc.length < 4096) this.#osc += ch;
          break;
        case 'string':
          if (c === 0x07 || c === 0x9c) this.#state = 'ground';
          else if (c === 0x1b) this.#state = 'esc';
          break;
      }
    }
  }
}

/** One screen's rows and where its cursor is. */
interface Buffer { rows: Row[]; x: number; y: number }

/**
 * A terminal's screen, `cols` by `rows`. What scrolls off the main screen's top is handed to `scrolled`; what the
 * program asks of the terminal (where the cursor is, what it is) is answered through `reply`.
 */
export class Screen {
  readonly styles = new Styles();
  cols: number;
  rows: number;
  /** The rows changed since the last drawing, to draw again; a scroll draws them all. */
  readonly dirty = new Set<number>();
  /** What the program set: the arrow keys sent as an application's (ESC O A), the cursor seen, the alternate screen,
   * pasting bracketed, a line feed also a carriage return (as the terminal's output is set, ONLCR). */
  appCursor = false;
  cursorShown = true;
  bracketed = false;
  newline = true;
  /** A program asked for the pointer's presses (it is a whole-screen program that reads them). */
  mouse = false;
  #main: Buffer;
  #alt: Buffer | null = null;
  #style: Style = PLAIN;
  #st = 0;
  #wrapNext = false;
  #autowrap = true;
  #insert = false;
  #top = 0;
  #bottom: number;
  #saved: {x: number; y: number; style: Style; g0: string; g1: string} | null = null;
  #g0 = 'B';
  #g1 = 'B';
  #shifted = false;
  #last = ' ';
  readonly #parser: Parser;

  readonly scrolled: (row: Row) => void;
  readonly reply: (text: string) => void;

  constructor(cols: number, rows: number, scrolled: (row: Row) => void = () => {}, reply: (text: string) => void = () => {}) {
    this.scrolled = scrolled;
    this.reply = reply;
    this.cols = cols;
    this.rows = rows;
    this.#bottom = rows - 1;
    this.#main = {rows: Array.from({length: rows}, () => blankRow(cols)), x: 0, y: 0};
    this.#parser = new Parser({
      print: (t) => this.#print(t),
      control: (c) => this.#control(c),
      esc: (c, inter) => this.#esc(c, inter),
      csi: (ps, mark, final, inter) => this.#csi(ps, mark, final, inter),
      osc: () => {},
      charset: (slot, set) => { if (slot === '(') this.#g0 = set; else if (slot === ')') this.#g1 = set; },
    });
    this.#all();
  }

  get #buf(): Buffer { return this.#alt ?? this.#main; }
  /** The rows as they stand now (the alternate screen's while a program has it). */
  get lines(): readonly Row[] { return this.#buf.rows; }
  get x(): number { return this.#buf.x; }
  get y(): number { return this.#buf.y; }
  /** Whether a whole-screen program has the alternate screen. */
  get alternate(): boolean { return this.#alt !== null; }
  /** The main screen's rows and its cursor's row, whichever screen is shown. */
  get main(): {rows: readonly Row[]; y: number} { return {rows: this.#main.rows, y: this.#main.y}; }

  write(text: string) { this.#parser.write(text); }

  /** As wide and as tall as `cols` by `rows`, what is there kept (cut, or blank where it grows). */
  resize(cols: number, rows: number) {
    for (const b of [this.#main, this.#alt]) {
      if (!b) continue;
      for (const r of b.rows) {
        if (r.chars.length > cols) { r.chars.length = cols; r.st.length = cols; }
        while (r.chars.length < cols) { r.chars.push(' '); r.st.push(0); }
      }
      while (b.rows.length > rows) {
        // The main screen loses its top rows to what scrolled off (the cursor's row stays), the alternate its bottom.
        if (b === this.#main && b.y > 0) { this.scrolled(b.rows.shift()!); b.y--; } else b.rows.pop();
      }
      while (b.rows.length < rows) b.rows.push(blankRow(cols));
      b.x = Math.min(b.x, cols - 1);
      b.y = Math.min(b.y, rows - 1);
    }
    this.cols = cols;
    this.rows = rows;
    this.#top = 0;
    this.#bottom = rows - 1;
    this.#wrapNext = false;
    this.#all();
  }

  /** The rows as text, their ends trimmed (what a test or a copy reads). */
  text(): string { return this.lines.map((r) => r.chars.join('').replace(/\s+$/, '')).join('\n').replace(/\n+$/, ''); }

  #all() { for (let i = 0; i < this.rows; i++) this.dirty.add(i); }

  #print(text: string) {
    const b = this.#buf;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const set = this.#shifted ? this.#g1 : this.#g0;
      const shown = set === '0' ? DRAWING[ch] ?? ch : ch;
      const w = width(cp);
      if (w === 0) {
        // A joining mark goes onto the letter before it.
        const x = Math.max(0, this.#wrapNext ? b.x : b.x - 1);
        b.rows[b.y].chars[x] += shown;
        this.dirty.add(b.y);
        continue;
      }
      if (this.#wrapNext && this.#autowrap) {
        b.rows[b.y].wrapped = true;
        b.x = 0;
        this.#lineFeed();
      }
      this.#wrapNext = false;
      if (b.x + w > this.cols) {
        if (this.#autowrap) { b.rows[b.y].wrapped = true; b.x = 0; this.#lineFeed(); } else b.x = this.cols - w;
      }
      const row = b.rows[b.y];
      if (this.#insert) {
        row.chars.splice(b.x, 0, ...Array<string>(w).fill(' '));
        row.st.splice(b.x, 0, ...Array<number>(w).fill(this.#st));
        row.chars.length = this.cols;
        row.st.length = this.cols;
      }
      // A wide letter half overwritten loses its other half.
      if (row.chars[b.x] === '' && b.x > 0) row.chars[b.x - 1] = ' ';
      if (w === 1 && row.chars[b.x + 1] === '') row.chars[b.x + 1] = ' ';
      row.chars[b.x] = shown;
      row.st[b.x] = this.#st;
      if (w === 2) { row.chars[b.x + 1] = ''; row.st[b.x + 1] = this.#st; }
      this.#last = shown;
      this.dirty.add(b.y);
      if (b.x + w >= this.cols) { b.x = this.cols - 1; this.#wrapNext = true; } else b.x += w;
    }
  }

  #control(c: string) {
    const b = this.#buf;
    switch (c) {
      case '\r': b.x = 0; this.#wrapNext = false; break;
      case '\n': case '\v': case '\f': if (this.newline) b.x = 0; this.#lineFeed(); break;
      case '\b': if (b.x > 0) b.x -= this.#wrapNext ? 0 : 1; this.#wrapNext = false; break;
      case '\t': b.x = Math.min(this.cols - 1, (Math.floor(b.x / 8) + 1) * 8); this.#wrapNext = false; break;
      case '\x0e': this.#shifted = true; break;
      case '\x0f': this.#shifted = false; break;
    }
  }

  #esc(c: string, inter: string) {
    const b = this.#buf;
    if (inter === '#' && c === '8') {
      // DECALN: the screen filled with E, as a terminal tests itself.
      for (let y = 0; y < this.rows; y++) b.rows[y] = {chars: Array<string>(this.cols).fill('E'), st: Array<number>(this.cols).fill(0), wrapped: false};
      this.#all();
      return;
    }
    if (inter) return;
    switch (c) {
      case '7': this.#save(); break;
      case '8': this.#restore(); break;
      case 'D': this.#lineFeed(); break;
      case 'E': b.x = 0; this.#lineFeed(); break;
      case 'M': this.#reverseFeed(); break;
      case 'c': this.#reset(); break;
    }
  }

  #csi(ps: number[][], mark: string, final: string, inter: string) {
    const b = this.#buf;
    const n = (i: number, d = 1) => { const v = ps[i]?.[0]; return v === undefined || v === 0 ? d : v; };
    const at = (i: number) => ps[i]?.[0] ?? 0;
    this.#wrapNext = false;
    if (mark === '?' && (final === 'h' || final === 'l')) { for (const p of ps) this.#mode(p[0] ?? 0, final === 'h', true); return; }
    if (mark || inter) {
      // ESC [ > c (what kind of terminal it is): an xterm, as a VT220 answers.
      if (mark === '>' && final === 'c') this.reply('\x1b[>0;10;1c');
      return;
    }
    switch (final) {
      case '@': this.#insertCells(n(0)); break;
      case 'A': b.y = Math.max(b.y >= this.#top ? this.#top : 0, b.y - n(0)); break;
      case 'B': case 'e': b.y = Math.min(b.y <= this.#bottom ? this.#bottom : this.rows - 1, b.y + n(0)); break;
      case 'C': case 'a': b.x = Math.min(this.cols - 1, b.x + n(0)); break;
      case 'D': b.x = Math.max(0, b.x - n(0)); break;
      case 'E': b.x = 0; b.y = Math.min(this.#bottom, b.y + n(0)); break;
      case 'F': b.x = 0; b.y = Math.max(this.#top, b.y - n(0)); break;
      case 'G': case '`': b.x = Math.min(this.cols - 1, n(0) - 1); break;
      case 'H': case 'f': b.y = Math.min(this.rows - 1, n(0) - 1); b.x = Math.min(this.cols - 1, n(1) - 1); break;
      case 'J': this.#eraseScreen(at(0)); break;
      case 'K': this.#eraseLine(at(0)); break;
      case 'L': if (b.y >= this.#top && b.y <= this.#bottom) this.#scrollDown(n(0), b.y); break;
      case 'M': if (b.y >= this.#top && b.y <= this.#bottom) this.#scrollUp(n(0), b.y); break;
      case 'P': this.#deleteCells(n(0)); break;
      case 'S': this.#scrollUp(n(0), this.#top); break;
      case 'T': this.#scrollDown(n(0), this.#top); break;
      case 'X': { const row = b.rows[b.y]; for (let x = b.x; x < Math.min(this.cols, b.x + n(0)); x++) { row.chars[x] = ' '; row.st[x] = this.#blank(); } this.dirty.add(b.y); break; }
      case 'b': this.#print(this.#last.repeat(Math.min(n(0), this.cols * this.rows))); break;
      case 'd': b.y = Math.min(this.rows - 1, n(0) - 1); break;
      case 'm': this.#style = sgr(this.#style, ps.length ? ps : [[0]]); this.#st = this.styles.id(this.#style); break;
      case 'n': if (at(0) === 6) this.reply(`\x1b[${b.y + 1};${b.x + 1}R`); else if (at(0) === 5) this.reply('\x1b[0n'); break;
      case 'c': if (at(0) === 0) this.reply('\x1b[?1;2c'); break;
      case 'r': {
        const top = n(0) - 1, bottom = Math.min(this.rows, n(1, this.rows)) - 1;
        if (top < bottom) { this.#top = top; this.#bottom = bottom; b.x = 0; b.y = 0; }
        break;
      }
      case 's': this.#save(); break;
      case 'u': this.#restore(); break;
      case 'h': case 'l': for (const p of ps) this.#mode(p[0] ?? 0, final === 'h', false); break;
    }
  }

  #mode(m: number, on: boolean, priv: boolean) {
    if (!priv) {
      if (m === 4) this.#insert = on;
      else if (m === 20) this.newline = on;
      return;
    }
    switch (m) {
      case 1: this.appCursor = on; break;
      case 7: this.#autowrap = on; break;
      case 25: this.cursorShown = on; this.dirty.add(this.#buf.y); break;
      case 1000: case 1002: case 1003: case 1006: this.mouse = on; break;
      case 2004: this.bracketed = on; break;
      case 47: case 1047: case 1049: {
        if (on === (this.#alt !== null)) break;
        if (on) {
          if (m === 1049) this.#save();
          this.#alt = {rows: Array.from({length: this.rows}, () => blankRow(this.cols)), x: this.#main.x, y: this.#main.y};
        } else {
          this.#alt = null;
          if (m === 1049) this.#restore();
        }
        this.#top = 0;
        this.#bottom = this.rows - 1;
        this.#all();
        break;
      }
    }
  }

  /** The style an erased cell takes: the background in use, nothing else (as xterm erases). */
  #blank(): number { return this.#style.bg === -1 ? 0 : this.styles.id({fg: -1, bg: this.#style.bg, flags: 0}); }

  #lineFeed() {
    const b = this.#buf;
    if (b.y === this.#bottom) this.#scrollUp(1, this.#top);
    else if (b.y < this.rows - 1) b.y++;
  }

  #reverseFeed() {
    const b = this.#buf;
    if (b.y === this.#top) this.#scrollDown(1, this.#top);
    else if (b.y > 0) b.y--;
  }

  /** `n` rows from `from` to the region's foot go up, blank ones coming in at its foot; off the main screen's top, the
   * rows that leave are kept (scrolled). */
  #scrollUp(n: number, from: number) {
    const b = this.#buf;
    n = Math.min(n, this.#bottom - from + 1);
    for (let i = 0; i < n; i++) {
      const [gone] = b.rows.splice(from, 1);
      if (b === this.#main && from === 0) this.scrolled(gone);
      b.rows.splice(this.#bottom, 0, blankRow(this.cols, this.#blank()));
    }
    for (let y = from; y <= this.#bottom; y++) this.dirty.add(y);
  }

  #scrollDown(n: number, from: number) {
    const b = this.#buf;
    n = Math.min(n, this.#bottom - from + 1);
    for (let i = 0; i < n; i++) {
      b.rows.splice(this.#bottom, 1);
      b.rows.splice(from, 0, blankRow(this.cols, this.#blank()));
    }
    for (let y = from; y <= this.#bottom; y++) this.dirty.add(y);
  }

  #eraseLine(how: number) {
    const b = this.#buf, row = b.rows[b.y], st = this.#blank();
    const [from, to] = how === 0 ? [b.x, this.cols] : how === 1 ? [0, b.x + 1] : [0, this.cols];
    for (let x = from; x < to; x++) { row.chars[x] = ' '; row.st[x] = st; }
    if (how !== 1) row.wrapped = false;
    this.dirty.add(b.y);
  }

  #eraseScreen(how: number) {
    const b = this.#buf, st = this.#blank();
    if (how === 3) return;
    if (how === 0) { this.#eraseLine(0); for (let y = b.y + 1; y < this.rows; y++) b.rows[y] = blankRow(this.cols, st); }
    else if (how === 1) { this.#eraseLine(1); for (let y = 0; y < b.y; y++) b.rows[y] = blankRow(this.cols, st); }
    else for (let y = 0; y < this.rows; y++) b.rows[y] = blankRow(this.cols, st);
    this.#all();
  }

  #insertCells(n: number) {
    const b = this.#buf, row = b.rows[b.y];
    n = Math.min(n, this.cols - b.x);
    row.chars.splice(b.x, 0, ...Array<string>(n).fill(' '));
    row.st.splice(b.x, 0, ...Array<number>(n).fill(this.#blank()));
    row.chars.length = this.cols;
    row.st.length = this.cols;
    this.dirty.add(b.y);
  }

  #deleteCells(n: number) {
    const b = this.#buf, row = b.rows[b.y];
    n = Math.min(n, this.cols - b.x);
    row.chars.splice(b.x, n);
    row.st.splice(b.x, n);
    while (row.chars.length < this.cols) { row.chars.push(' '); row.st.push(this.#blank()); }
    this.dirty.add(b.y);
  }

  #save() { const b = this.#buf; this.#saved = {x: b.x, y: b.y, style: this.#style, g0: this.#g0, g1: this.#g1}; }
  #restore() {
    const b = this.#buf, s = this.#saved;
    if (!s) { b.x = 0; b.y = 0; return; }
    b.x = Math.min(s.x, this.cols - 1);
    b.y = Math.min(s.y, this.rows - 1);
    this.#style = s.style;
    this.#st = this.styles.id(s.style);
    this.#g0 = s.g0;
    this.#g1 = s.g1;
  }

  #reset() {
    this.#alt = null;
    this.#main = {rows: Array.from({length: this.rows}, () => blankRow(this.cols)), x: 0, y: 0};
    this.#style = PLAIN;
    this.#st = 0;
    this.#top = 0;
    this.#bottom = this.rows - 1;
    this.#autowrap = true;
    this.#insert = false;
    this.appCursor = false;
    this.cursorShown = true;
    this.bracketed = false;
    this.mouse = false;
    this.#g0 = this.#g1 = 'B';
    this.#all();
  }
}

/** A run of letters in one style. */
export interface Run { text: string; st: number }

/**
 * A line at a time, as the Prompt shows what a shell prints (output.ts): letters with their colours, the line under way
 * rewritten as a terminal rewrites it (a carriage return goes back to its start, a backspace a letter back, erasing to
 * its end, going sideways), each line ended handed on with its runs. What moves between lines (up, to a place) is
 * not a line's, and is let go of.
 */
export class LineState {
  readonly styles = new Styles();
  #chars: string[] = [];
  #st: number[] = [];
  /** Letters added at the line's end in one style (`#tailSt`), not yet read into #chars: most lines are only that, and
   * are handed on as they came, never a letter at a time. */
  #tail = '';
  #tailSt = 0;
  #x = 0;
  #style: Style = PLAIN;
  #id = 0;
  /** Changed otherwise than by letters added at its end since `rewritten` was last asked. */
  #rewrote = false;
  readonly #parser: Parser;
  readonly ended: (runs: Run[]) => void;
  /** Whole lines in one style, each with its line feed (`text`), handed on at once where they come so (a flood). */
  readonly endedLines: (text: string, st: number) => void;

  constructor(ended: (runs: Run[]) => void, endedLines?: (text: string, st: number) => void) {
    this.ended = ended;
    this.endedLines = endedLines ?? ((text, st) => { for (const line of text.slice(0, -1).split('\n')) ended(line ? [{text: line, st}] : []); });
    this.#parser = new Parser({
      print: (t) => this.#print(t),
      control: (c) => this.#control(c),
      esc: () => {},
      csi: (ps, mark, final) => this.#csi(ps, mark, final),
      osc: () => {},
      charset: () => {},
      lines: (t) => this.endedLines(t, this.#id),
    });
  }

  write(text: string) { this.#parser.write(text); }

  /** The line under way, as runs. */
  get runs(): Run[] {
    const rs = runs(this.#chars, this.#st);
    if (!this.#tail) return rs;
    const last = rs.at(-1);
    if (last && last.st === this.#tailSt) last.text += this.#tail; else rs.push({text: this.#tail, st: this.#tailSt});
    return rs;
  }
  /** The line under way, as plain text. */
  get text(): string { return this.#chars.join('') + this.#tail; }
  /** Whether the line under way was rewritten (not only added to) since last asked. */
  rewritten(): boolean { const r = this.#rewrote; this.#rewrote = false; return r; }
  /** The line under way let go of (taken back, cleared). */
  clear() { this.#chars = []; this.#st = []; this.#tail = ''; this.#x = 0; this.#rewrote = true; }

  /** The letters added at the end read into the line's, before anything else is done to it. */
  #settle() {
    for (const ch of this.#tail) { this.#chars.push(ch); this.#st.push(this.#tailSt); }
    this.#tail = '';
  }

  #print(text: string) {
    // At the line's end (where nearly every letter is written): added as it came.
    if (this.#x === this.#chars.length + this.#tail.length && !/[\ud800-\udfff]/.test(text)) {
      if (this.#tail && this.#tailSt !== this.#id) this.#settle();
      this.#tail += text;
      this.#tailSt = this.#id;
      this.#x += text.length;
      return;
    }
    this.#settle();
    for (const ch of text) {
      if (this.#x < this.#chars.length) this.#rewrote = true;
      while (this.#chars.length < this.#x) { this.#chars.push(' '); this.#st.push(0); }
      this.#chars[this.#x] = ch;
      this.#st[this.#x] = this.#id;
      this.#x++;
    }
  }

  #control(c: string) {
    if (c === '\n') {
      this.ended(this.runs);
      this.#chars = []; this.#st = []; this.#tail = ''; this.#x = 0;
      return;
    }
    this.#settle();
    if (c === '\r') this.#x = 0;
    else if (c === '\b') this.#x = Math.max(0, this.#x - 1);
    else if (c === '\t') this.#print(' '.repeat(8 - (this.#x % 8)));
  }

  #csi(ps: number[][], mark: string, final: string) {
    if (mark) return;
    const n = (ps[0]?.[0] ?? 0) || 1;
    if (final !== 'm') this.#settle();
    if (final === 'm') { this.#style = sgr(this.#style, ps.length ? ps : [[0]]); this.#id = this.styles.id(this.#style); }
    else if (final === 'K') {
      const how = ps[0]?.[0] ?? 0;
      if (how === 0) { this.#chars.length = Math.min(this.#chars.length, this.#x); this.#st.length = this.#chars.length; }
      else for (let x = 0; x < (how === 1 ? Math.min(this.#x + 1, this.#chars.length) : this.#chars.length); x++) this.#chars[x] = ' ';
      if (how === 2) { this.#chars = []; this.#st = []; }
      this.#rewrote = true;
    } else if (final === 'C') this.#x += n;
    else if (final === 'D') this.#x = Math.max(0, this.#x - n);
    else if (final === 'G') this.#x = n - 1;
  }
}

/** Letters and their styles as runs, one style each. */
export function runs(chars: readonly string[], st: readonly number[]): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = out.at(-1);
    if (last && last.st === st[i]) last.text += chars[i]; else out.push({text: chars[i], st: st[i] ?? 0});
  }
  return out;
}

/** The SGR that sets `s` from plain: a style said again where letters are written again (a line handed back). */
export function sgrOf(s: Style): string {
  const ps: string[] = [];
  const c = (base: number, v: number) => (v < 0 ? '' : v < 8 ? String(base + v) : v < 16 ? String(base + 60 + v - 8) : v < RGB ? `${base + 8};5;${v}` : `${base + 8};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`);
  const bits: [number, string][] = [[F.bold, '1'], [F.dim, '2'], [F.italic, '3'], [F.under, '4'], [F.inverse, '7'], [F.hidden, '8'], [F.strike, '9']];
  for (const [bit, code] of bits) if (s.flags & bit) ps.push(code);
  if (c(30, s.fg)) ps.push(c(30, s.fg));
  if (c(40, s.bg)) ps.push(c(40, s.bg));
  return `\x1b[0${ps.length ? `;${ps.join(';')}` : ''}m`;
}

/** The colours of the palette's first sixteen, as the Prompt draws them (names of the page's own colours), and the
 * rest of xterm's 256 as it has them. */
export function colour(c: number): string {
  if (c < 0) return '';
  if (c >= RGB) return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
  if (c < 16) return `var(--ansi-${c})`;
  if (c < 232) {
    const i = c - 16, v = (k: number) => (k ? 55 + k * 40 : 0);
    return `rgb(${v(Math.floor(i / 36))}, ${v(Math.floor(i / 6) % 6)}, ${v(i % 6)})`;
  }
  const g = 8 + (c - 232) * 10;
  return `rgb(${g}, ${g}, ${g})`;
}

/** A style as CSS (its colours swapped where it is inverse), empty for plain. */
export function css(s: Style): string {
  if (s === PLAIN || (s.fg === -1 && s.bg === -1 && !s.flags)) return '';
  let fg = s.fg, bg = s.bg;
  // Bold in one of the eight is drawn in its bright one, as terminals have it.
  if (s.flags & F.bold && fg >= 0 && fg < 8) fg += 8;
  const parts: string[] = [];
  if (s.flags & F.inverse) {
    parts.push(`color: ${bg === -1 ? 'var(--vt-bg, var(--paper))' : colour(bg)}`, `background: ${fg === -1 ? 'var(--vt-fg, var(--ink))' : colour(fg)}`);
  } else {
    if (fg !== -1) parts.push(`color: ${colour(fg)}`);
    if (bg !== -1) parts.push(`background: ${colour(bg)}`);
  }
  if (s.flags & F.bold) parts.push('font-weight: 600');
  if (s.flags & F.dim) parts.push('opacity: .62');
  if (s.flags & F.italic) parts.push('font-style: italic');
  const lines = [s.flags & F.under ? 'underline' : '', s.flags & F.strike ? 'line-through' : ''].filter(Boolean);
  if (lines.length) parts.push(`text-decoration: ${lines.join(' ')}`);
  if (s.flags & F.hidden) parts.push('visibility: hidden');
  return parts.join('; ');
}
