import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {msOf} from '../../ui/glide.ts';

/** How long the hand rests on an edge before the box it goes to is read ahead (passing over it reads nothing). */
const AHEAD_AFTER = 120;

// Server's boards as a row of boxes, slid as the issues are: the board on screen in full, its neighbours' edges
// showing, an edge (or ← →) the way to them. What each box holds is the view's to say (board.ts draws them).
//
// The board slid away from goes as it was, its posts and TODO with it, and is only its name once the row has
// stopped (a sheet emptied as it starts to move reads as something lost); come back to before then, it is there
// as it was left. The one slid to is drawn as the row starts, and what it reads comes in where it stands; read ahead
// while the hand rests on its edge (or, pressed along, the next one the same way), it comes in with it all there.
// A box read ahead stays its edge to look at until it is slid to (styles.css).

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
    // The hand resting on an edge a moment: the box it goes to is read ahead.
    for (const [hit, by] of [[this.prev, -1], [this.next, 1]] as const) {
      hit.addEventListener('pointerenter', () => { clearTimeout(this.resting); this.resting = window.setTimeout(() => this.ahead(this.k + by), AHEAD_AFTER); });
      hit.addEventListener('pointerleave', () => clearTimeout(this.resting));
    }
    stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.k - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.k + 1); }
    });
  }

  /** `count` boxes, the `at`th on screen. */
  fill(count: number, at: number) {
    this.track.replaceChildren(...Array.from({length: count}, () => h('div', {class: 'slide'})));
    this.was = at;
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
    const by = Math.sign(k - this.was);
    this.was = k;
    this.stopped = window.setTimeout(() => this.settle(pressed ? by : 0), msOf(getComputedStyle(this.track).transitionDuration) + 40);
    this.prev.hidden = k === 0;
    this.next.hidden = k === count - 1;
    this.ways.landed(k, pressed);
  }

  /** Once the row has stopped. */
  private stopped = 0;
  /** The box on screen before the last slide, to tell which way it went. */
  private was = 0;
  /** A rest on an edge, before the box it goes to is read ahead. */
  private resting = 0;

  /** The row stopped: the boards slid away from are only their names now; pressed along (`by`), the next that way is read ahead. */
  private settle(by: number) {
    ([...this.track.children] as HTMLElement[]).forEach((slot, j) => { if (j !== this.k && slot.classList.contains('full')) this.fill1(slot, j, false); });
    if (by) this.ahead(this.k + by);
  }

  /** Box `j`, beside the one on screen, drawn in full ahead of being slid to (what it holds read now, unseen). */
  private ahead(j: number) {
    const slot = this.track.children[j] as HTMLElement | undefined;
    if (!slot || j === this.k || Math.abs(j - this.k) !== 1 || slot.classList.contains('full')) return;
    this.fill1(slot, j, true);
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
