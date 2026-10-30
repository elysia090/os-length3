import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {after, paced, still} from '../../ui/glide.ts';
import type {Issue} from '../../repos/issues.ts';

// Git's issues not merged yet, as large boxes side by side: one in full, its neighbours' edges showing at both
// sides. An edge is the way to the box beside (hover lifts it; ← → and a finger's swipe do the same), and the track
// slides there. The keyboard stays on the same part of the box as one goes along the row.

/** What the row needs of the page it is in. */
interface RowWays {
  /** Issue `i` came on screen; `moved`: gone to by the person, with an edge or an arrow. */
  landed(i: Issue, moved: boolean): void;
  /** What issue `x`'s slot holds: in full when it is on screen (`now`), else only its head. */
  slot(x: Issue, now: boolean): HTMLElement[];
  /**
   * The row slid to its `lead` (0 at the first box, 2 at the last, 1 between), `single` when there is one box;
   * `drawn` when it was drawn again rather than gone along (its edges then ease to where they are).
   */
  slid(lead: number, single: boolean, drawn: boolean): void;
}

/** The part of a box that has the keyboard: told by its kind and its words. */
type Part = {kind: string; words: string};

export class IssueRow {
  /** The row and its edges, in the issues' column. */
  readonly column: HTMLElement;
  readonly stage: HTMLElement;
  /** Put the keyboard on the new issue's words once it is drawn. */
  land = false;
  private readonly track = h('div', {class: 'issue-track'});
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private shown: Issue[] = [];
  private k = 0;
  /** The box in full before the last move (-1 once drawn anew). */
  private was = -1;
  /** The neighbours' cards are as tall as the current one, so the row reads as one line of boxes. */
  private readonly sized = new ResizeObserver(([e]) => this.track.style.setProperty('--card-h', `${(e.target as HTMLElement).offsetHeight}px`));
  private readonly ways: RowWays;

  constructor(ways: RowWays) {
    this.ways = ways;
    // The edges over the neighbours: clear, lifted on hover like any place.
    this.prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous issue')}) as HTMLButtonElement;
    this.next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next issue')}) as HTMLButtonElement;
    this.stage = h('div', {class: 'issue-stage', tabindex: '0', 'aria-label': t('Issues'), 'aria-roledescription': 'carousel'}, this.track, this.prev, this.next);
    this.column = h('div', {class: 'issue-column'}, this.stage);
    this.prev.addEventListener('click', () => this.go(this.k - 1, true));
    this.next.addEventListener('click', () => this.go(this.k + 1, true));
    // A finger swiped along the row (sideways more than down, and far enough) goes to the box beside, as its edge
    // pressed does: on a phone the edges are a sliver, and a swipe is what a hand tries first.
    let from: {x: number; y: number; id: number} | null = null;
    this.stage.addEventListener('pointerdown', (e) => { from = e.pointerType === 'touch' ? {x: e.clientX, y: e.clientY, id: e.pointerId} : null; });
    this.stage.addEventListener('pointercancel', () => { from = null; });
    this.stage.addEventListener('pointerup', (e) => {
      if (!from || e.pointerId !== from.id) return;
      const dx = e.clientX - from.x, dy = e.clientY - from.y;
      from = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) this.go(this.k + (dx < 0 ? 1 : -1), true);
    });
    this.stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.k - 1, true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.k + 1, true); }
    });
  }

  /**
   * The issues `shown`, a box each, the `at`th in full; the keyboard on the same part of a box as it was. Drawn again
   * (a deed done, an issue come or gone), the row does not slide as if gone along: the box in full stays where it
   * was, and its edges ease to where they now are (one box left, it widens to the column's edges).
   */
  fill(shown: Issue[], at: number, from = -1) {
    const slide = from >= 0 && from !== at && from < shown.length && !still();
    if (!slide) this.settle();
    this.shown = shown;
    this.stage.hidden = false;
    this.column.classList.toggle('single', shown.length === 1);
    // The keyboard goes back to the same part of its box, if its box is still shown. Its box gone (closed, merged),
    // it goes to the row, never to that part of another box: drawn again before the row went aside (a slow Remote),
    // the box closed under Close handed it to the next box's Close, and a second Enter closed that one too.
    const under = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.issue-slot')?.dataset.issue;
    const was = this.part();
    const had = was && shown.some((i) => `${i.repo}/${i.file}` === under) ? was : null;
    if (was && !had) this.stage.focus({preventScroll: true});
    this.track.replaceChildren(...shown.map((i) => h('div', {class: 'issue-slot', 'data-issue': `${i.repo}/${i.file}`})));
    this.was = -1;
    if (!slide) { this.go(at, false, had); return; }
    // Gone to as it is drawn (an issue reopened, one just written): from the box that was in full, the row slides to
    // it, and only it is given the keyboard.
    const land = this.land;
    this.land = false;
    this.column.classList.add('settling');
    this.go(from, false, had);
    void this.track.offsetWidth;
    this.column.classList.remove('settling');
    this.land = land;
    this.go(at, true);
  }

  /** The box of `key` is going (closed): the row goes to the box beside it, the one after or else the one before. */
  aside(key: string): Promise<void> {
    const j = this.shown.findIndex((i) => `${i.repo}/${i.file}` === key);
    if (j !== this.k || this.shown.length < 2) return Promise.resolve();
    // The keyboard was on its Close: it goes to the row, never to the next box's Close (a second Enter would close it).
    const had = this.track.children[j]?.contains(document.activeElement);
    this.go(j + 1 < this.shown.length ? j + 1 : j - 1, true, null);
    if (had) this.stage.focus({preventScroll: true});
    return still() ? Promise.resolve() : new Promise((done) => after(450, done));
  }

  /** The row's edges easing to where a drawing put them (styles.css .settling), for as long as a move takes. */
  private settle() {
    if (still()) return;
    this.settling?.cancel();
    this.column.classList.add('settling');
    this.settling = after(280, () => { this.column.classList.remove('settling'); this.settling = null; });
  }
  private settling: Animation | null = null;

  /** The issue in full: its card and how tall it is, for a drawing to go on from. */
  current(): {key: string; card: HTMLElement; height: number} | null {
    const i = this.shown[this.k];
    const card = this.stage.hidden ? null : this.track.children[this.k]?.querySelector<HTMLElement>('.issue-card');
    return i && card ? {key: `${i.repo}/${i.file}`, card, height: card.getBoundingClientRect().height} : null;
  }

  /** None to show: the row stands aside. */
  none() {
    this.shown = [];
    this.track.replaceChildren();
    this.stage.hidden = true;
  }

  /**
   * Slide to the `n`th box: it gets the whole box, the others only their heads. Gone along by the person (`moved`),
   * the box left keeps what it holds as it slides away, fading only as it reaches the edge, and becomes its head once
   * it is there: never an empty sheet going by.
   */
  private go(n: number, moved = false, had = this.part()) {
    if (!this.shown.length) return;
    const k = this.k = Math.max(0, Math.min(this.shown.length - 1, n));
    const was = this.was;
    this.was = k;
    this.ways.landed(this.shown[k], moved);
    this.track.style.setProperty('--at', `${k}`);
    // The first box starts at the column's edge and the last ends at it; between, both neighbours show.
    const lead = k === 0 ? 0 : k === this.shown.length - 1 ? 2 : 1;
    this.column.style.setProperty('--row-lead', `${lead}`);
    this.ways.slid(lead, this.shown.length === 1, !moved);
    [...this.track.children].forEach((slot, j) => {
      slot.setAttribute('aria-current', String(j === k));
      if (moved && j === was && was !== k && !still()) { this.leave(slot as HTMLElement, this.shown[j]); return; }
      slot.classList.remove('leaving');
      (slot as HTMLElement).inert = false;
      slot.removeAttribute('aria-hidden');
      slot.replaceChildren(...this.ways.slot(this.shown[j], j === k));
    });
    const card = this.track.children[k]?.querySelector<HTMLElement>('.issue-card');
    this.sized.disconnect();
    if (card) this.sized.observe(card);
    const edge = document.activeElement === this.prev || document.activeElement === this.next;
    this.prev.hidden = k === 0;
    this.next.hidden = k === this.shown.length - 1;
    this.focus(this.track.children[k] as HTMLElement | undefined, had, edge);
  }

  /** The box gone from: as it was while it slides out (out of the keyboard's way), its head once it is at the edge. */
  private leave(slot: HTMLElement, x: Issue) {
    slot.classList.add('leaving');
    slot.inert = true;
    slot.setAttribute('aria-hidden', 'true');
    for (const part of slot.querySelectorAll<HTMLElement>(':scope > .issue-card > *, :scope > :not(.issue-card)')) {
      part.animate([{opacity: 1}, {opacity: 1, offset: .55}, {opacity: 0}], {duration: paced(450), fill: 'forwards'});
    }
    after(450, () => {
      if (!slot.isConnected || slot.getAttribute('aria-current') === 'true') return;
      slot.classList.remove('leaving');
      slot.inert = false;
      slot.removeAttribute('aria-hidden');
      slot.replaceChildren(...this.ways.slot(x, false));
      for (const part of slot.children) part.animate([{opacity: 0}, {opacity: 1}], {duration: paced(120), easing: 'ease-out'});
    });
  }

  /** The keyboard, after the row slid to `slot`: on a new issue's words, back on the part it was on, or on the row. */
  private focus(slot: HTMLElement | undefined, had: Part | null, edge: boolean) {
    if (this.land) { this.land = false; slot?.querySelector<HTMLElement>('.issue-words')?.focus({preventScroll: true}); return; }
    if (had) (sameDeed(slot, had) ?? this.stage).focus({preventScroll: true});
    // An edge pressed that is gone now (the first or last box reached): the keyboard stays on the row.
    else if (edge && (document.activeElement as HTMLElement | null)?.hidden) this.stage.focus({preventScroll: true});
  }

  /** The part of the box that has the keyboard (its words, a button), so the box gone to or drawn again gives it back. */
  // Told by its kind and its words: every button in a box is a .button, and the first of them is Close, so a box
  // drawn again under the keyboard on Start must not hand it to Close (the next Enter would close the issue).
  private part(): Part | null {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !this.track.contains(a)) return null;
    const kind = a.className.split(' ')[0];
    return kind ? {kind, words: a.textContent?.trim() ?? ''} : null;
  }
}

const sameDeed = (slot: HTMLElement | undefined, had: Part) => {
  const all = [...(slot?.querySelectorAll<HTMLElement>(`.${had.kind}`) ?? [])];
  return all.find((e) => (e.textContent?.trim() ?? '') === had.words) ?? (all.length === 1 && had.kind !== 'button' ? all[0] : null);
};
