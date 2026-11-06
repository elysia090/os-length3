import {h} from '../../ui/dom.ts';

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
