import {t} from '../../i18n.ts';
import {h} from '../../ui/dom.ts';
import {narrow, type Row} from './columns.ts';

// A repo dragged on Forge: its pill along the band (pills.ts) or into the center, or a box's head along the row.
// Into the center, it shows where it would stand: over a box's left or right third, beside it on that side; over its
// middle, in its place. Let go, it stands there.

/** What a drag of a repo carries: its name, for the band and the center of this page alone. */
const DRAGGED = 'application/x-length3-repo';

/** What is being dragged on the page, and the hint over the center of where it would go. */
export class Drag {
  /** The repo or box being dragged, while one is (its name, or name:path for a file beside). */
  name: string | null = null;
  private hint = h('div', {class: 'drop-hint', 'aria-hidden': 'true'});
  private cols: HTMLElement;

  /** The hint is drawn over `cols`, the center's row. */
  constructor(cols: HTMLElement) { this.cols = cols; }

  /** `el` dragged carries `name`; a pill (`lifts`) is lifted off the band while it is. */
  from(el: HTMLElement, name: string, lifts = false) {
    el.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DRAGGED, name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      this.name = name;
      if (lifts) requestAnimationFrame(() => el.classList.add('lifted'));
    });
    el.addEventListener('dragend', () => {
      this.name = null;
      if (lifts) el.classList.remove('lifted');
      this.unhint();
    });
  }

  /** The repo or box a drop carries, if it carries one. */
  carried(event: DragEvent) { return event.dataTransfer?.getData(DRAGGED) || this.name; }

  /** Over the center from `left`, `width` wide: what letting go there does (`how`), said in `words`. */
  hintAt(left: number, width: number, how: string, words: string) {
    Object.assign(this.hint.style, {left: `${left}px`, width: `${width}px`});
    this.hint.dataset.how = how;
    this.hint.textContent = words;
    if (!this.hint.isConnected) { this.cols.append(this.hint); this.cols.classList.add('dropping'); }
  }

  unhint() { this.hint.remove(); this.cols.classList.remove('dropping'); }
}

/** Where a repo let go at x would stand: an index among the shown, and whether it takes that box's place. */
function dropAt(row: Row, x: number): {at: number; instead: boolean; over: HTMLElement | null} {
  const boxes = row.shown.map((n) => row.views.get(n)?.col).filter((c): c is HTMLElement => !!c);
  for (const [i, c] of boxes.entries()) {
    const r = c.getBoundingClientRect();
    if (x > r.right) continue;
    const third = (x - r.left) / r.width;
    if (third < 1 / 3) return {at: i, instead: false, over: c};
    if (third > 2 / 3) return {at: i + 1, instead: false, over: c};
    return {at: i, instead: true, over: c};
  }
  return {at: boxes.length, instead: false, over: boxes.at(-1) ?? null};
}

/**
 * The center takes a pill (or a box's head) dragged into it: shown where it would stand while it is over the row,
 * and let go, given to `land` with its place among the boxes (`at`), and whether it takes the place of the box there.
 */
export function dropInto(row: Row, drag: Drag, land: (name: string, at: number, instead: boolean) => void) {
  const cols = row.element;
  cols.addEventListener('dragover', (event) => {
    if (!drag.name || narrow()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const d = dropAt(row, event.clientX);
    const box = cols.getBoundingClientRect();
    const r = d.over?.getBoundingClientRect() ?? box;
    const left = d.instead ? r.left : d.at <= row.shown.indexOf(d.over?.dataset.key ?? '') ? r.left : r.left + r.width / 2;
    const width = d.instead ? r.width : r.width / 2;
    drag.hintAt(left - box.left, width, d.instead ? 'instead' : 'beside', d.instead ? t('Open here') : t('Open beside'));
  });
  cols.addEventListener('dragleave', (event) => { if (!cols.contains(event.relatedTarget as Node)) drag.unhint(); });
  cols.addEventListener('drop', (event) => {
    const name = drag.carried(event);
    drag.unhint();
    if (!name) return;
    event.preventDefault();
    const d = dropAt(row, event.clientX);
    land(name, d.at, d.instead);
  });
}
