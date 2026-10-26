import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import type {Issue} from '../../repos/issues.ts';

// Git's issues not merged yet, as large boxes side by side: one in full, its neighbours' edges showing at both
// sides. An edge is the way to the box beside (hover lifts it; ← → do the same), and the track slides there. The
// keyboard stays on the same part of the box as one goes along the row.

/** What the row needs of the page it is in. */
interface RowWays {
  /** Issue `i` came on screen; `moved`: gone to by the person, with an edge or an arrow. */
  landed(i: Issue, moved: boolean): void;
  /** What issue `x`'s slot holds: in full when it is on screen (`now`), else only its head. */
  slot(x: Issue, now: boolean): HTMLElement[];
  /** The row slid to its `lead` (0 at the first box, 2 at the last, 1 between), `single` when there is one box. */
  slid(lead: number, single: boolean): void;
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
    this.stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.k - 1, true); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.k + 1, true); }
    });
  }

  /** The issues `shown`, a box each, the `at`th in full; the keyboard on the same part of a box as it was. */
  fill(shown: Issue[], at: number) {
    this.shown = shown;
    this.stage.hidden = false;
    this.column.classList.toggle('single', shown.length === 1);
    const had = this.part();
    this.track.replaceChildren(...shown.map(() => h('div', {class: 'issue-slot'})));
    this.go(at, false, had);
  }

  /** None to show: the row stands aside. */
  none() {
    this.shown = [];
    this.track.replaceChildren();
    this.stage.hidden = true;
  }

  /** Slide to the `n`th box: it gets the whole box, the others only their heads. */
  private go(n: number, moved = false, had = this.part()) {
    if (!this.shown.length) return;
    const k = this.k = Math.max(0, Math.min(this.shown.length - 1, n));
    this.ways.landed(this.shown[k], moved);
    this.track.style.setProperty('--at', `${k}`);
    // The first box starts at the column's edge and the last ends at it; between, both neighbours show.
    const lead = k === 0 ? 0 : k === this.shown.length - 1 ? 2 : 1;
    this.column.style.setProperty('--lead', `${lead}`);
    this.ways.slid(lead, this.shown.length === 1);
    [...this.track.children].forEach((slot, j) => {
      slot.setAttribute('aria-current', String(j === k));
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
