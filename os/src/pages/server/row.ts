import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {msOf} from '../../ui/glide.ts';

// Server's boards as a row of boxes, slid as the issues are: the board on screen in full, its neighbours' edges
// showing, an edge (or ← →) the way to them. What each box holds is the view's to say (board.ts draws them).
//
// The board slid away from goes as it was, its posts and TODO with it, and is only its name once the row has
// stopped (a sheet emptied as it starts to move reads as something lost); come back to before then, it is there
// as it was left. The one slid to is drawn as the row starts, and what it reads comes in where it stands.

/** What the row needs of the view it is in. */
interface RowWays {
  /** What box `j` holds: in full when it is the one on screen (`now`), else only its name. */
  box(j: number, now: boolean): HTMLElement;
  /** Box `k` came on screen; `pressed`: by a press on an edge. */
  landed(k: number, pressed: boolean): void;
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
    // A press (not Enter or Space on the edge, whose click has no count) is told as one: the view gives a new board's
    // name the keyboard then.
    this.prev.addEventListener('click', (e) => this.go(this.k - 1, e.detail > 0));
    this.next.addEventListener('click', (e) => this.go(this.k + 1, e.detail > 0));
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

  /** Slide to box `n` (`pressed`: by a press on an edge): it is drawn in full, the others only their names. */
  go(n: number, pressed = false) {
    const count = this.track.children.length;
    if (!count) return;
    const k = this.k = Math.max(0, Math.min(count - 1, n));
    this.track.style.setProperty('--at', `${k}`);
    this.center.style.setProperty('--lead', `${count === 1 ? 0 : k === 0 ? 0 : k === count - 1 ? 2 : 1}`);
    this.element.classList.toggle('single', count === 1);
    const slots = [...this.track.children] as HTMLElement[];
    slots.forEach((slot, j) => {
      slot.setAttribute('aria-current', String(j === k));
      // Drawn in full already (come back to while it was going): kept as it was.
      if (j === k) { if (!slot.classList.contains('full')) this.fill1(slot, j, true); slot.classList.remove('leaving'); return; }
      // In full and sliding away: it goes as it was, and is only its name once the row has stopped.
      if (slot.classList.contains('full')) { slot.classList.add('leaving'); return; }
      this.fill1(slot, j, false);
    });
    clearTimeout(this.stopped);
    this.stopped = window.setTimeout(() => this.settle(), msOf(getComputedStyle(this.track).transitionDuration) + 40);
    this.prev.hidden = k === 0;
    this.next.hidden = k === count - 1;
    this.ways.landed(k, pressed);
  }

  /** Once the row has stopped. */
  private stopped = 0;

  /** The row stopped: the boards slid away from are only their names now. */
  private settle() {
    ([...this.track.children] as HTMLElement[]).forEach((slot, j) => { if (j !== this.k && slot.classList.contains('full')) this.fill1(slot, j, false); });
  }

  /** Slot `j` holds its box, in full (`now`) or only its name. */
  private fill1(slot: HTMLElement, j: number, now: boolean) {
    slot.replaceChildren(this.ways.box(j, now));
    slot.classList.toggle('full', now);
    slot.classList.remove('leaving');
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
