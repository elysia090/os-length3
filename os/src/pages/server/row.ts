import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';

// Server's boards as a row of boxes, slid as the issues are: the board on screen in full, its neighbours' edges
// showing, an edge (or ← →) the way to them. What each box holds is the view's to say (board.ts draws them).

/** What the row needs of the view it is in. */
export interface RowWays {
  /** What box `j` holds: in full when it is the one on screen (`now`), else only its name. */
  box(j: number, now: boolean): HTMLElement;
  /** Box `k` came on screen. */
  landed(k: number): void;
}

export class Row {
  /** The row, or what is said in its place. */
  readonly element: HTMLElement;
  /** A slot for each box, side by side. */
  readonly track = h('div', {class: 'slide-track'});
  /** The box on screen. */
  k = 0;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  /** Where the row's lead is set: the center, so the box at the foot stands under the board on screen as the boards do (styles.css). */
  private readonly center: HTMLElement;
  private readonly ways: RowWays;

  constructor(center: HTMLElement, ways: RowWays) {
    this.center = center;
    this.ways = ways;
    this.prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous board')}) as HTMLButtonElement;
    this.next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next board')}) as HTMLButtonElement;
    const stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Boards'), 'aria-roledescription': 'carousel'}, this.track, this.prev, this.next);
    this.element = h('div', {class: 'slides'}, stage);
    this.prev.addEventListener('click', () => this.go(this.k - 1));
    this.next.addEventListener('click', () => this.go(this.k + 1));
    stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.k - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.k + 1); }
    });
  }

  /** `count` boxes, the `at`th on screen. */
  fill(count: number, at: number) {
    this.track.replaceChildren(...Array.from({length: count}, () => h('div', {class: 'slide'})));
    this.go(at);
  }

  /** Slide to box `n`: it is drawn in full, the others only their names. */
  go(n: number) {
    const count = this.track.children.length;
    if (!count) return;
    const k = this.k = Math.max(0, Math.min(count - 1, n));
    this.track.style.setProperty('--at', `${k}`);
    this.center.style.setProperty('--lead', `${count === 1 ? 0 : k === 0 ? 0 : k === count - 1 ? 2 : 1}`);
    this.element.classList.toggle('single', count === 1);
    [...this.track.children].forEach((slot, j) => {
      slot.setAttribute('aria-current', String(j === k));
      slot.replaceChildren(this.ways.box(j, j === k));
    });
    this.prev.hidden = k === 0;
    this.next.hidden = k === count - 1;
    this.ways.landed(k);
  }

  /** Boxes that stand still, the first on screen and no way along them: the server being made, faint. */
  stand(...slides: HTMLElement[]) {
    this.track.replaceChildren(...slides);
    this.element.classList.remove('single');
    this.center.style.setProperty('--lead', '0');
    this.track.style.setProperty('--at', '0');
    this.prev.hidden = this.next.hidden = true;
  }

  /** One box alone that says something, and no way along: an invitation that opens nothing. */
  say(slide: HTMLElement) {
    this.track.replaceChildren(slide);
    this.element.classList.add('single');
    this.prev.hidden = this.next.hidden = true;
  }

  /** In the row's place, what is said instead: the Remote out of reach, the card signing in. */
  instead(node: Node) {
    this.element.replaceChildren(node);
  }
}
