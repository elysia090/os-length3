import {css, runs, type Run, type Screen, type Styles} from './vt.ts';

function element(tag: 'div' | 'span', className = ''): HTMLElement {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

// A terminal's screen (vt.ts) drawn: a row an element, each run of one style a span, the cursor a block over its cell.
// Only the rows that changed since the last drawing are drawn again.

/** `rs` as nodes: plain text as it is, a styled run a span of its style. */
export function styled(rs: readonly Run[], styles: Styles): Node[] {
  return rs.map((r) => {
    const look = r.st ? css(styles.of(r.st)) : '';
    if (!look) return document.createTextNode(r.text);
    const span = element('span');
    span.style.cssText = look;
    span.textContent = r.text;
    return span;
  });
}

export class ScreenView {
  readonly element = element('div', 'vt-screen');
  readonly screen: Screen;
  readonly #rows: HTMLElement[] = [];
  #cursor = {x: -1, y: -1};

  constructor(screen: Screen) {
    this.screen = screen;
    this.element.setAttribute('aria-live', 'polite');
    for (let y = 0; y < screen.rows; y++) screen.dirty.add(y);
  }

  /** The rows that changed drawn again, and the cursor where it is. */
  draw() {
    const s = this.screen;
    while (this.#rows.length < s.rows) { const r = element('div', 'vt-row'); this.#rows.push(r); this.element.append(r); s.dirty.add(this.#rows.length - 1); }
    while (this.#rows.length > s.rows) this.#rows.pop()!.remove();
    const at = s.cursorShown ? {x: s.x, y: s.y} : {x: -1, y: -1};
    if (at.x !== this.#cursor.x || at.y !== this.#cursor.y) {
      if (this.#cursor.y >= 0) s.dirty.add(this.#cursor.y);
      if (at.y >= 0) s.dirty.add(at.y);
    }
    for (const y of s.dirty) if (y < s.rows) this.#row(y, y === at.y ? at.x : -1);
    s.dirty.clear();
    this.#cursor = at;
  }

  #row(y: number, cursor: number) {
    const s = this.screen, row = s.lines[y];
    // A wide letter's second cell is drawn by the first.
    const chars: string[] = [], st: number[] = [];
    let cursorAt = -1;
    row.chars.forEach((c, x) => {
      if (c === '') return;
      if (x === cursor) cursorAt = chars.length;
      chars.push(c);
      st.push(row.st[x]);
    });
    if (cursorAt < 0) { this.#rows[y].replaceChildren(...styled(runs(chars, st), s.styles)); return; }
    const before = styled(runs(chars.slice(0, cursorAt), st.slice(0, cursorAt)), s.styles);
    const after = styled(runs(chars.slice(cursorAt + 1), st.slice(cursorAt + 1)), s.styles);
    const caret = element('span', 'vt-cursor');
    caret.textContent = chars[cursorAt] ?? ' ';
    this.#rows[y].replaceChildren(...before, caret, ...after);
  }
}
