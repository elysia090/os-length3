import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {moveTime} from '../../ui/law.ts';
import {RowDesk} from '../../ui/row-desk.ts';

// Server's boards as the row of a desk (DESIGN §6, ui/row.ts): pieces one width, two cells apart, the desk at rest
// only with a piece at its edge, one of them in the hand. Before the boards, at the desk's edge, the room's own sheet
// (who is in it: `lead`); at the foot of the board in the hand, the box that writes in it (`foot`). What each box
// holds is the view's to say (board.ts draws them).
//
// The row shows the board in the hand alone, beside the room's sheet (as Inbox shows one conversation beside who
// wrote): a board is gone to by its line on that sheet, or along the row with ← →, and is then drawn in full; the
// desk turns only as far as shows it whole (what is pressed does not go from under the hand). The board left goes as it
// was, its posts and TODO with it, and is only its name once the row has stopped (a sheet emptied as it starts to
// move reads as something lost); come back to before then, it is there as it was left. Pressed along, the next that
// way is read ahead, so it comes into the hand with what it holds already there.

/** What the row needs of the view it is in. */
interface RowWays {
  /** What box `j` holds: in full when it is the one in the hand (`now`), else only its name. */
  box(j: number, now: boolean): HTMLElement;
  /** Box `k` came into the hand; `pressed`: by a press. */
  landed(k: number, pressed: boolean): void;
}

export class Row {
  /** The row, or what is said in its place. */
  readonly element: HTMLElement;
  /** The pieces, side by side: the room's sheet, then a slot for each box. */
  readonly track = h('div', {class: 'slide-track'});
  /** The box in the hand. */
  k = 0;
  /** The desk: what is turned along the row. */
  private readonly stage: HTMLElement;
  private readonly desk: RowDesk;
  private readonly lead: HTMLElement | null;
  private readonly foot: HTMLElement;
  private readonly ways: RowWays;

  constructor(ways: RowWays, foot: HTMLElement, lead: HTMLElement | null = null) {
    this.ways = ways;
    this.foot = foot;
    this.lead = lead;
    const stage = this.stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Boards'), 'aria-roledescription': 'carousel'}, this.track);
    this.element = h('div', {class: 'slides'}, stage);
    stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.k - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.k + 1); }
    });
    // A board not in the hand is its name on the ground: pressed, it is taken up (its line on the room's sheet does
    // the same, and is the keyboard's way to it).
    this.track.addEventListener('click', (e) => {
      const slot = (e.target as Element).closest<HTMLElement>('.slide');
      const j = slot ? this.slots().indexOf(slot) : -1;
      if (j >= 0 && j !== this.k) this.go(j, e.detail > 0);
    });
    // Turned along the row, its map at the window's foot: a piece's bar pressed goes to it (a board into the hand).
    this.desk = new RowDesk(stage, this.track, {
      name: (el) => el.getAttribute('aria-label') ?? el.querySelector('h2, h3')?.textContent ?? '',
      held: (el) => el.getAttribute('aria-current') === 'true',
      go: (el) => { const j = this.slots().indexOf(el); if (j >= 0) this.go(j, true); else this.desk.show(el); },
    }, () => this.look(false));
    this.element.append(this.desk.map.element);
  }

  /** The desk turned to the row's start, where the room's own sheet is. */
  toStart() {
    this.desk.turn(0);
  }

  /** The slots, one a box. */
  private slots(): HTMLElement[] {
    return [...this.track.children].filter((el) => el.classList.contains('slide')) as HTMLElement[];
  }

  /** `count` boxes, the `at`th in the hand. */
  fill(count: number, at: number) {
    this.track.replaceChildren(...(this.lead ? [this.lead] : []), ...Array.from({length: count}, () => h('div', {class: 'slide'})));
    this.was = at;
    this.stage.scrollLeft = 0;
    this.go(at, false, false);
  }

  /** Box `n` into the hand (`pressed`: by a press): it is drawn in full, the others only their names. */
  go(n: number, pressed = false, moving = true) {
    const slots = this.slots(), count = slots.length;
    if (!count) return;
    const k = this.k = Math.max(0, Math.min(count - 1, n));
    slots.forEach((slot, j) => {
      slot.setAttribute('aria-current', String(j === k));
      // Drawn in full already (come back to while it was going): kept as it was.
      if (j === k) {
        if (!slot.classList.contains('full')) this.fill1(slot, j, true);
        slot.classList.remove('leaving');
        slot.append(this.foot);
        return;
      }
      // In full and left: it goes as it was, and is only its name once the row has stopped.
      if (slot.classList.contains('full')) { slot.classList.add('leaving'); return; }
      this.fill1(slot, j, false);
    });
    clearTimeout(this.stopped);
    const by = Math.sign(k - this.was);
    this.was = k;
    this.stopped = window.setTimeout(() => this.settle(pressed ? by : 0), moveTime(this.stage.clientWidth, this.stage.clientWidth) + 40);
    this.look(moving);
    this.ways.landed(k, pressed);
  }

  /** Once the row has stopped. */
  private stopped = 0;
  /** The box in the hand before the last one, to tell which way it went. */
  private was = 0;
  /** The desk turned to show the board in the hand whole, or left where it is while it is (ui/row.ts). */
  private look(moving: boolean) {
    const slot = this.slots()[this.k];
    if (slot) this.desk.show(slot, moving);
    this.desk.map.paint();
  }

  /** The row stopped: the boards left are only their names now; pressed along (`by`), the next that way is read ahead. */
  private settle(by: number) {
    this.slots().forEach((slot, j) => { if (j !== this.k && slot.classList.contains('full')) this.fill1(slot, j, false); });
    if (by) this.ahead(this.k + by);
  }

  /** Box `j`, beside the one in the hand, drawn in full ahead of being gone to (what it holds read now, unseen). */
  private ahead(j: number) {
    const slot = this.slots()[j];
    if (!slot || j === this.k || Math.abs(j - this.k) !== 1 || slot.classList.contains('full')) return;
    this.fill1(slot, j, true);
  }

  /** Slot `j` holds its box, in full (`now`) or only its name. */
  private fill1(slot: HTMLElement, j: number, now: boolean) {
    slot.replaceChildren(this.ways.box(j, now));
    slot.classList.toggle('full', now);
    slot.classList.remove('leaving');
    if (j === this.k) slot.append(this.foot);
  }

  /** Boxes that stand still, the first in the hand and no way along them: the server being made, faint. */
  stand(...slides: HTMLElement[]) {
    this.track.replaceChildren(...(this.lead ? [this.lead] : []), ...slides);
    this.k = 0;
    slides[0]?.append(this.foot);
    this.stage.scrollLeft = 0;
    this.desk.map.paint();
  }

  /** One box alone that says something, and no way along: an invitation that opens nothing. */
  say(slide: HTMLElement) {
    slide.classList.add('said');
    this.track.replaceChildren(slide);
    this.stage.scrollLeft = 0;
    this.desk.map.paint();
  }

  /** In the row's place, what is said instead: the Remote out of reach, the card signing in. */
  instead(node: Node) {
    this.element.replaceChildren(node);
  }
}
