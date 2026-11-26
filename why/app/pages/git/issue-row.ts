import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';
import {after, still} from '../../ui/glide.ts';
import type {Issue} from '../../../repo/issues.ts';
import {rowMap} from '../../ui/row-desk.ts';

// Issues are neighbours on the same desk. The new issue is at the end of this
// row, with one named way to its empty paper on the ground over the current one.
const issueKey = (issue: Issue) => `${issue.repo}/${issue.file}`;
/** The issue from which a repo's draft was opened, even after leaving Git. */
const origins = new Map<string, string>();

/** What the row needs of the page it is in. */
interface RowWays {
  /** Issue `i` came on screen; `moved`: gone to by the person, with an edge or an arrow. */
  landed(i: Issue, moved: boolean): void;
  /** What issue `x`'s slot holds: in full when it is on screen (`now`), else only its head. */
  slot(x: Issue, now: boolean): HTMLElement[];
  /** What the last slot, the issue not written yet, holds: the issue it will be when on screen (`now`), else its edge. */
  tail(now: boolean): HTMLElement[];
  /** The issue not written yet came on screen; `moved`: gone to by the person. */
  landedTail(moved: boolean): void;
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
  readonly stage: HTMLElement = h('div', {class: 'issue-stage', tabindex: '0', 'aria-label': t('Issues'), 'aria-roledescription': 'carousel'});
  /** Put the keyboard on the issue's words once it is drawn (gone to), or in its summary (just made, to go on writing). */
  land: boolean | 'summary' = false;
  private readonly track = h('div', {class: 'issue-track'});
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly create = h('button', {type: 'button', class: 'issue-create-word issue-create-next',
    'aria-label': t('New issue')}, `${t('New issue')} →`) as HTMLButtonElement;
  private readonly returnToIssue = h('button', {type: 'button', class: 'issue-create-word issue-create-back',
    'aria-label': t('Previous issue')}) as HTMLButtonElement;
  private readonly writingName = h('span', {class: 'issue-create-name'}, this.returnToIssue, h('span', {}, t('New issue')));
  private shown: Issue[] = [];
  private k = 0;
  /** The box in full before the last move (-1 once drawn anew). */
  private was = -1;
  /** The neighbours' cards are as tall as the current one, so the row reads as one line of boxes. */
  private readonly sized = new ResizeObserver(([e]) => {
    const card = e.target as HTMLElement;
    requestAnimationFrame(() => {
      if (!card.isConnected || card.parentElement?.getAttribute('aria-current') !== 'true') return;
      const height = `${card.offsetHeight}px`;
      if (this.track.style.getPropertyValue('--card-h') !== height) this.track.style.setProperty('--card-h', height);
    });
  });
  private readonly ways: RowWays;
  /** The row's map, at the window's foot: a bar an issue, the one in full in ink. */
  readonly map = rowMap(this.stage, () => this.pieces(), () => this.turned());

  constructor(ways: RowWays) {
    this.ways = ways;
    // The edges over the neighbours: clear, lifted on hover like any place.
    this.prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous issue')}) as HTMLButtonElement;
    this.next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next issue')}) as HTMLButtonElement;
    this.stage.append(this.track, this.prev, this.next);
    this.create.hidden = this.writingName.hidden = true;
    this.column = h('div', {class: 'issue-column'},
      h('div', {class: 'issue-create-header'}, this.writingName, this.create), this.stage, this.map.element);
    new ResizeObserver(() => this.map.paint()).observe(this.stage);
    this.prev.addEventListener('click', () => this.go(this.k - 1, true));
    this.next.addEventListener('click', () => this.go(this.k + 1, true));
    this.create.addEventListener('click', () => this.go(this.shown.length, true));
    this.returnToIssue.addEventListener('click', () => this.back());
    // A finger swiped along the row (sideways more than down, and far enough) goes to the box beside, as its edge
    // pressed does: on a phone the edges are a sliver, and a swipe is what a hand tries first.
    let from: {x: number; y: number; id: number} | null = null;
    this.stage.addEventListener('pointerdown', (e) => {
      from = e.pointerType === 'touch' && !(e.target as Element | null)?.closest('input, textarea, [contenteditable]')
        ? {x: e.clientX, y: e.clientY, id: e.pointerId} : null;
    });
    this.stage.addEventListener('pointercancel', () => { from = null; });
    this.stage.addEventListener('pointerup', (e) => {
      if (!from || e.pointerId !== from.id) return;
      const dx = e.clientX - from.x, dy = e.clientY - from.y;
      from = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > 1.5 * Math.abs(dy)) this.nudge(dx < 0 ? 1 : -1);
    });
    this.stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.nudge(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.nudge(1); }
    });
  }

  /**
   * The issues `shown`, a box each, the `at`th in full; the keyboard on the same part of a box as it was. Drawn again
   * (a deed done, an issue come or gone), the row does not slide as if gone along: the box in full stays where it
   * was, and its edges ease to where they now are (one box left, it widens to the column's edges).
   */
  fill(shown: Issue[], at: number, from = -1) {
    const slide = from >= 0 && from !== at && from < shown.length && !still();
    // Come into sight (none shown before), it is where it is at once: its edges do not ease from where they never were.
    this.quiet = !!this.stage.hidden || !this.shown.length;
    if (!slide && !this.quiet) this.settle();
    this.shown = shown;
    this.stage.hidden = false;
    this.column.classList.toggle('single', shown.length === 0);
    // The keyboard goes back to the same part of its box, if its box is still shown. Its box gone (closed, merged),
    // it goes to the row, never to that part of another box: drawn again before the row went aside (a slow Remote),
    // the box closed under Close handed it to the next box's Close, and a second Enter closed that one too.
    const under = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.issue-slot')?.dataset.issue;
    const was = this.part();
    const had = was && (under === NEW || shown.some((i) => `${i.repo}/${i.file}` === under)) ? was : null;
    if (was && !had) this.stage.focus({preventScroll: true});
    this.track.replaceChildren(...shown.map((i) => h('div', {class: 'issue-slot', 'data-issue': `${i.repo}/${i.file}`})),
      h('div', {class: 'issue-slot issue-slot-new', 'data-issue': NEW}));
    this.was = -1;
    if (!slide) { this.go(at, false, had); this.quiet = false; return; }
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
    this.quiet = false;
  }
  /** Being drawn into sight (fill): main's cards over the row are where they are at once too. */
  private quiet = false;

  /** The box of `key` is going (closed): the row goes to the box beside it, the one after or else the one before. */
  aside(key: string): Promise<void> {
    const j = this.shown.findIndex((i) => `${i.repo}/${i.file}` === key);
    if (j !== this.k) return Promise.resolve();
    // The keyboard was on its Close: it goes to the row, never to the next box's Close (a second Enter would close it).
    // (To the issue after, else the one before; to the one not written yet only when it was the last.)
    const had = this.track.children[j]?.contains(document.activeElement);
    this.go(j + 1 < this.shown.length ? j + 1 : j > 0 ? j - 1 : j + 1, true, null);
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

  /** The issue not written yet is in the hand. */
  get atTail() { return !this.stage.hidden && this.k === this.shown.length; }

  /** The keyboard on the issue not written yet's first line, if it is in the hand. */
  write() { if (this.atTail) this.track.lastElementChild?.querySelector<HTMLElement>('.issue-first')?.focus({preventScroll: true}); }

  /** Back keeps the exact issue from which this draft was taken up. */
  back() {
    if (!this.atTail || this.track.querySelector('.issue-slot-new[aria-current=true] .issue-create-form[aria-busy=true]')) return;
    const to = this.draftOrigin();
    if (to < 0) return;
    this.go(to, true, null);
    this.create.focus({preventScroll: true});
  }

  private draftOrigin(): number {
    const repo = this.track.lastElementChild?.querySelector<HTMLElement>('.issue-new-card')?.dataset.draftRepo;
    if (!repo) return -1;
    const origin = origins.get(repo);
    const was = this.shown.findIndex((i) => issueKey(i) === origin);
    return was >= 0 ? was : this.shown.findLastIndex((i) => i.repo === repo);
  }

  private nudge(by: -1 | 1) {
    if (this.atTail) { if (by < 0) this.back(); return; }
    this.go(this.k + by, true);
  }

  /** No repo to write an issue in: the row stands aside. */
  none() {
    this.shown = [];
    this.track.replaceChildren();
    this.stage.hidden = true;
    this.create.hidden = this.writingName.hidden = true;
    this.map.paint();
  }

  /**
   * Slide to the `n`th box: it gets the whole box, the others only their heads. Gone along by the person (`moved`),
   * the box left keeps what it holds as it slides away, fading only as it reaches the edge, and becomes its head once
   * it is there: never an empty sheet going by.
   */
  private go(n: number, moved = false, had = this.part()) {
    const last = this.shown.length;
    const k = this.k = Math.max(0, Math.min(last, n));
    const was = this.was;
    this.was = k;
    if (k === last) {
      const origin = this.shown[was];
      if (moved && origin) origins.set(origin.repo, issueKey(origin));
      this.ways.landedTail(moved);
    } else this.ways.landed(this.shown[k], moved);
    this.track.style.setProperty('--at', `${k}`);
    // The box in full starts at the column's edge, wherever it is along the row: the next ahead of it.
    const lead = 0;
    this.column.style.setProperty('--row-lead', `${lead}`);
    this.ways.slid(lead, last === 0, !moved && !this.quiet);
    [...this.track.children].forEach((slot, j) => {
      slot.setAttribute('aria-current', String(j === k));
      if (moved && j === was && was !== k && !still()) { this.leave(slot as HTMLElement, j); return; }
      slot.classList.remove('leaving');
      (slot as HTMLElement).inert = false;
      slot.removeAttribute('aria-hidden');
      slot.replaceChildren(...this.held(j, j === k));
    });
    const card = this.track.children[k]?.querySelector<HTMLElement>('.issue-card');
    this.sized.disconnect();
    if (card) this.sized.observe(card);
    this.create.hidden = k === last;
    this.writingName.hidden = k !== last;
    const from = k === last ? this.shown[this.draftOrigin()] : undefined;
    this.returnToIssue.hidden = !from;
    if (from) {
      this.returnToIssue.textContent = from.n === null ? '←' : `← #${from.n}`;
      this.returnToIssue.disabled = !!card?.querySelector('.issue-create-form[aria-busy=true]');
    }
    const edge = document.activeElement === this.prev || document.activeElement === this.next;
    // (Behind the box in full there is no edge to press: the ones before are out of sight, gone to by ← or the map.)
    this.prev.hidden = true;
    this.next.hidden = k >= last - 1;
    this.focus(this.track.children[k] as HTMLElement | undefined, had, edge, moved && k === last);
    this.map.paint();
  }

  /** What slot `j` holds: an issue, or (the last) the one not written yet; in full when on screen (`now`). */
  private held(j: number, now: boolean) { return j === this.shown.length ? this.ways.tail(now) : this.ways.slot(this.shown[j], now); }

  /** A box's width along the row and the gap after it, as drawn. */
  private step(): {w: number; gap: number} {
    const first = this.track.children[0] as HTMLElement | undefined;
    return {w: first?.offsetWidth ?? 0, gap: parseFloat(getComputedStyle(this.track).columnGap) || 0};
  }
  /** The row as its map says it: each issue a piece, the one in full in the hand. */
  private pieces() {
    if (this.stage.hidden || this.atTail) return [];
    const {w, gap} = this.step();
    return this.shown.map((x, j) => ({x: j * (w + gap), w, held: j === this.k,
      name: x.n === null ? x.title : `#${x.n} ${x.title}`, go: () => this.go(j, true)}));
  }
  /** How far the row is turned: to the box in full. */
  private turned() { const {w, gap} = this.step(); return this.k * (w + gap); }

  /**
   * The box gone from: as it was while it slides out (out of the keyboard's way), its head at once once it is at the
   * edge. (Faded at once by the cut, it went by as an empty sheet for the whole of the slide.)
   */
  private leave(slot: HTMLElement, j: number) {
    slot.classList.add('leaving');
    slot.inert = true;
    slot.setAttribute('aria-hidden', 'true');
    after(450, () => {
      if (!slot.isConnected || slot.getAttribute('aria-current') === 'true') return;
      slot.classList.remove('leaving');
      slot.inert = false;
      slot.removeAttribute('aria-hidden');
      slot.replaceChildren(...this.held(j, false));
    });
  }

  /** The keyboard, after the row slid to `slot`: on a new issue's words, back on the part it was on, or on the row. */
  private focus(slot: HTMLElement | undefined, had: Part | null, edge: boolean, writing = false) {
    // Gone to by the person, the issue not written yet has the keyboard on its first line.
    if (writing) { slot?.querySelector<HTMLElement>('.issue-first')?.focus({preventScroll: true}); return; }
    if (this.land) {
      const into = this.land === 'summary' ? '.issue-summary' : '.issue-words';
      this.land = false;
      slot?.querySelector<HTMLElement>(into)?.focus({preventScroll: true});
      return;
    }
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

/** The last slot's mark: the issue not written yet. */
const NEW = '+new';

const sameDeed = (slot: HTMLElement | undefined, had: Part) => {
  const all = [...(slot?.querySelectorAll<HTMLElement>(`.${had.kind}`) ?? [])];
  return all.find((e) => (e.textContent?.trim() ?? '') === had.words) ?? (all.length === 1 && had.kind !== 'button' ? all[0] : null);
};
