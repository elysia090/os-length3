import type {Context} from '../context.ts';
import type {Writing} from './reader.ts';
import type {Row} from './columns.ts';

// Where the center is read is kept for its repo at each scroll, and the
// file being read is said to File, which marks it.

/** Where one is in Forge's center: the file read, where in it, and where each place that scrolls was left. */
export class Place {
  /** The file read now, as last said to File (the band's first button opens at it). */
  reading: string | null = null;
  /** The file last gone to in this repo: the one read while it is in view, wherever the keyboard goes (reader.ts). */
  private landed: string | null = null;
  private quiet = 0;
  /** The file read now is to be said with where in it one is (track's `place`). */
  private placing = false;
  /** When the hand last moved the page (a wheel, a touch, a key). */
  private handAt = 0;
  /** Taken off the screen and put back, a place that scrolls starts at its top again: each comes back where it was. */
  private restoring = false;
  /** A path was asked for since Forge came back on screen (File, Git, a search): that wins over where it was. */
  private revealing = false;
  private tops = new Map<Element, number>();
  private work: HTMLElement;
  private row: Row;
  private ctx: Context;

  /** Kept for the boxes of `row`, in the bench `work`; said to File and Home through `ctx`. */
  constructor(work: HTMLElement, row: Row, ctx: Context) {
    this.work = work; this.row = row; this.ctx = ctx;
    // Where one is is what one did: written in a file, the caret put or moved in it, the page scrolled by hand. A box
    // coming in (one beside closed, the row sliding to it), a page put back where it was, a button pressed is not, so
    // Home's Lately never quotes the top of a page that only came back into view.
    for (const e of ['wheel', 'touchmove', 'keydown']) work.addEventListener(e, () => { this.handAt = performance.now(); }, {capture: true, passive: true});
    const inText = (event: Event) => { const el = event.target as Element; return !!el.closest?.('.flow') && !el.closest('button, .path, .col-head'); };
    for (const e of ['input', 'keyup', 'pointerup']) work.addEventListener(e, (event) => { if (row.view() && inText(event)) this.track(); }, true);
    work.addEventListener('scroll', (event) => this.scrolled(event.target as Element), true);
  }

  /** `path` is the file read now: said to File, unless it already was. */
  told(path: string | null) { if (path !== this.reading) { this.reading = path; this.ctx.reading(path); } }

  /** The file read now, said to File and the band; with `place`, also where in it one is (for Home's Lately). */
  track(place = true) {
    clearTimeout(this.quiet);
    this.placing ||= place;
    this.quiet = window.setTimeout(() => {
      const v = this.row.view(), was = this.placing;
      this.placing = false;
      if (!v || !v.flow.isConnected) return;
      const path = v.reader.reading(this.landed);
      this.told(path);
      // Where in it, to come back to (Home's Lately): the caret, or the line read.
      if (was && path) this.ctx.leftAt(v.reader.repo, path, v.reader.place(path));
    }, 120);
  }

  /**
   * Gone to `path` in the page worked on (at `line`; with `write`, the caret there): a place asked for is where the
   * center goes, and coming back does not put it back where it was. With no path, come to the page as it was.
   */
  goTo(path: string, line: number, write: Writing) {
    this.landed = path;
    // Gone to, it is the file read from now (File marks it, the band's first button opens at it), not only once the
    // center has settled on it a moment later.
    if (path) this.told(path);
    if (path) { this.revealing = true; void this.row.view()?.reader.reveal(path, line, write).then(() => this.track()); }
    else this.track(false);
  }

  /** Back on the screen: each repo's page where it was read (unless a place is asked for meanwhile), and each place that scrolls. */
  back() {
    this.restoring = true;
    this.revealing = false;
    requestAnimationFrame(() => {
      if (!this.revealing) for (const n of this.row.shown) { const v = this.row.views.get(n); if (v) v.flow.scrollTop = v.top; }
      for (const [el, top] of this.tops) { if (el.isConnected) el.scrollTop = top; else this.tops.delete(el); }
      this.restoring = false;
    });
  }

  /** `el` scrolled: a repo's page keeps where it is (said, when the hand moved it), any other place too. */
  private scrolled(el: Element) {
    if (this.restoring || !this.work.isConnected) return;
    const v = el.classList.contains('flow') ? [...this.row.views.values()].find((w) => w.flow === el) : undefined;
    if (v) { v.top = el.scrollTop; if (v === this.row.view() && performance.now() - this.handAt < 800) this.track(); } else this.tops.set(el, el.scrollTop);
  }
}
