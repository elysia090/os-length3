import {t} from '../../i18n.ts';
import {h} from '../../ui/dom.ts';
import {icon, mark} from '../../ui/icons.ts';
import {after, LAND, paced, still} from '../../ui/glide.ts';
import {onChange} from '../../repos/repos.ts';
import {renamedIn} from '../../home/band.ts';
import {shownName} from '../../repos/issues.ts';
import {Reader} from './reader.ts';
import type {Drag} from './drag.ts';

// Forge's center is a row of boxes, up to three repos side by side, each its own page. Each repo's box stays in the
// row once made, those not shown hidden, and each stands where CSS `order` puts it, never moved in the document (a
// text box taken out of the document loses its Undo).

/**
 * One repo's page in the center: its box in the row (its head, and the page that scrolls), what reads it, where it
 * was scrolled to, and whether it must be read again.
 */
interface View { col: HTMLElement; flow: HTMLElement; reader: Reader; root: HTMLElement; top: number; stale: boolean }

/** The repos side by side, as last left on this device (a convenience: the band is what is kept). */
const BESIDE_KEY = 'length3.forge.beside';
const readBeside = (): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(BESIDE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []; } catch { return []; } };
const saveBeside = (shown: string[]) => { try { localStorage.setItem(BESIDE_KEY, JSON.stringify(shown)); } catch { /* a convenience */ } };
/** A repo renamed before Forge is made in this visit: what stood beside is kept under its new name. */
export const besideRenamed = (from: string, to: string) => saveBeside(renamedIn(readBeside(), from, to));
/** A box in the row is a repo's page (its name) or one file of it beside (name:path; a repo's name has no colon). */
export const repoOf = (key: string) => key.split(':')[0];
export const fileOf = (key: string) => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : null);
export const keyOf = (repo: string, path: string) => `${repo}:${path}`;
/** Narrow, the boxes are not side by side: one stands at a time, and the pane is laid over the center. */
export const narrow = () => matchMedia('(max-width: 760px)').matches;
/** How many neighbours' edges show before the box worked on at `at` of `n`: none for the first, two for the last. */
const lead = (at: number, n: number) => (at === 0 ? 0 : at === n - 1 ? 2 : 1);

/**
 * The row's lean toward a neighbour follows how far into it the pointer is: none for the first few px past the edge
 * (a hand at rest on the edge, never quite still, leaves the row be), then a little more for each px further, up to
 * a step (16 px). No line to cross, so nothing to flip back and forth on. What it follows trails the hand by a few
 * px (play): a tremor back and forth within them moves nothing, and a hand going on is followed px by px.
 */
const LEAN = {still: 1, rate: .45, most: 16, play: 3};

/** A box going from the row fades where it stands; then the row closes over its place, by the move that slides it. */
export const shrink = (col: HTMLElement) => new Promise<void>((done) => {
  if (still()) { done(); return; }
  col.classList.add('nothing');
  after(280, done);
});

/** What a box asks of the page it stands in. */
interface RowWays {
  /** Pressed into (its head, or anything in it), the box is the one worked on. */
  activate(key: string): void;
  /** Its × closes it. */
  close(key: string): void;
  /** A file's head in a repo's page opens it beside, in a box of its own. */
  beside(key: string): void;
  /** A file's name pressed in its head is written over there: `written` is where it goes. */
  rename(repo: string, path: string, written: string): Promise<void>;
  /** No repo here at all: the first made (New repo). */
  make(): void;
}

/** The row of boxes in the center: which stand, in what order, and the one worked on. */
export class Row {
  readonly views = new Map<string, View>();
  /** The repos side by side in the center, left to right; the one worked on is among them. */
  shown: string[] = readBeside();
  /** The box worked on (the prompt, the search and File follow it): a repo's name, or name:path for a file beside. */
  repo: string | null = null;
  /** What the center says with no repo out. */
  private nothing: HTMLElement;
  /** None open: what to do, as there are repos to bring out (`bring`) or none at all yet (`first`). */
  private bring: (string | Node)[];
  private first: HTMLElement;
  private any = true;
  /** The page worked on, due to be read again (the store changed it), and due to be put back where it was. */
  private again = 0;
  private putBack = 0;
  /** The row's own element, in the center of the bench (`work`). */
  readonly element: HTMLElement;
  private work: HTMLElement;
  private drag: Drag;
  private ways: RowWays;

  /** The row is `element`, the center of the bench `work`; a box's head is dragged with `drag`. */
  constructor(element: HTMLElement, work: HTMLElement, drag: Drag, ways: RowWays) {
    this.element = element; this.work = work; this.drag = drag; this.ways = ways;
    // ⊕ in the words is the band's own mark (its circle and plus, on the words' line), not a glyph of the font set high.
    this.bring = t('Bring a repo out to the band with ⊕, or open one from File').split('⊕').flatMap((part, i) => (i ? [h('span', {class: 'inline-add', 'aria-label': '⊕'}, mark('plus')), part] : [part]));
    // No repo at all (a first run): not a way to bring one out that has nothing to bring, but the first made, said
    // as what it is, the whole card the deed (as Home's New repo is).
    this.first = h('button', {type: 'button', class: 'card new forge-first'}, icon('new-repo'), h('span', {}, t('Make your first repo')),
      h('small', {class: 'muted'}, t('A folder of your own, kept as git keeps it: Forge, Git and the Prompt work in it.')));
    this.first.addEventListener('click', () => ways.make());
    this.nothing = h('div', {class: 'empty forge-none', hidden: ''}, ...this.bring);
    element.append(this.nothing);
    new ResizeObserver(() => this.room()).observe(work);
    new MutationObserver(() => this.room()).observe(work, {attributes: true, attributeFilter: ['class']});
    // Pressed into, a box is the one worked on (what was pressed goes on as pressed); its × closes it, the one
    // worked on staying as it was.
    element.addEventListener('pointerdown', (event) => this.pressed(event), true);
    element.addEventListener('focusin', (event) => this.pressed(event));
    element.addEventListener('pointermove', (event) => this.lean(event));
    element.addEventListener('pointerleave', () => this.leanTo(0, null, 0));
  }

  /**
   * The pointer on a neighbour's edge: the row leans toward it before it is pressed, as far as the pointer is into it
   * (LEAN), and the neighbour's words come up with it. Measured from where the box worked on stands unleaned: the
   * lean moves the boxes, and measured from where they are it would undo itself under a still pointer.
   */
  private lean(event: PointerEvent) {
    const active = this.shown.length > 1 && this.repo ? this.views.get(this.repo)?.col : null;
    if (!active || narrow()) { this.leanTo(0, null, 0); return; }
    const r = active.getBoundingClientRect(), by = parseFloat(getComputedStyle(active).translate) || 0;
    const x = event.clientX, into = Math.max(x - (r.right - by), (r.left - by) - x);
    const over = (event.target as Element).closest?.('.col') as HTMLElement | null;
    const side = x > r.right - by ? 'after' : 'before';
    if (into <= 0 || !over?.classList.contains(side)) { this.leanTo(0, null, 0); return; }
    const held = this.leant.over === over ? this.leant.into : 0;
    const at = Math.min(Math.max(held, into - LEAN.play), into + LEAN.play);
    if (this.leant.over === over && at === held) return;
    this.leant = {over, into: at};
    const px = Math.min(LEAN.most, Math.max(0, (at - LEAN.still) * LEAN.rate));
    this.leanTo(side === 'after' ? -px : px, over, px / LEAN.most);
  }

  /** How far into the neighbour the row leans for: the hand's way in, trailed by LEAN.play. */
  private leant: {over: HTMLElement | null; into: number} = {over: null, into: 0};

  /** The row leant by `px` (none: 0), the neighbour `lit` brought up by `by` (0 to 1). */
  private leanTo(px: number, lit: HTMLElement | null, by: number) {
    if (!lit) this.leant = {over: null, into: 0};
    this.element.style.setProperty('--lean', `${px.toFixed(1)}px`);
    for (const c of this.element.querySelectorAll<HTMLElement>(':scope > .col')) {
      if (c === lit) c.style.setProperty('--lit', by.toFixed(2)); else c.style.removeProperty('--lit');
    }
  }

  /** The page of the box worked on, if any. */
  view(): View | null { return this.repo ? this.views.get(this.repo) ?? null : null; }

  private pressed(event: Event) {
    const el = event.target as HTMLElement;
    const c = el.closest<HTMLElement>('.col');
    if (c?.dataset.key && !el.closest('.col-close')) this.ways.activate(c.dataset.key);
  }

  /** Whether there is any repo here: none, the empty center offers to make the first. */
  known(any: boolean) {
    if (any === this.any) return;
    this.any = any;
    this.nothing.classList.toggle('first', !any);
    this.nothing.replaceChildren(...(any ? this.bring : [this.first]));
  }

  /** Drawn as `shown` and `repo` say: which boxes stand, in what order, and which is worked on. */
  layout() {
    const {shown, element: cols} = this;
    // Another box worked on: the edges the lean was measured from are not where they were.
    this.leanTo(0, null, 0);
    this.nothing.hidden = shown.length > 0;
    cols.classList.toggle('split', shown.length > 1);
    cols.dataset.n = String(shown.length);
    for (const [name, v] of this.views) this.stand(name, v.col);
    this.work.classList.toggle('split-on', shown.length > 1);
    // A file in a box of its own is only its head in its repo's page.
    for (const [name, v] of this.views) {
      if (fileOf(name) === null) v.reader.fold(shown.filter((k) => repoOf(k) === name && fileOf(k) !== null).map((k) => fileOf(k)!));
      else if (shown.includes(name)) v.reader.refit();
    }
    // The row slides so the box worked on stands in it whole and its neighbours' edges show past the frame's lines.
    // A box just shown takes the row's place first (the reflow), so it slides with the rest rather than appearing.
    const at = this.at();
    cols.style.setProperty('--at', String(at));
    cols.style.setProperty('--lead', String(lead(at, shown.length)));
    cols.style.setProperty('--n', String(Math.max(1, shown.length)));
    this.room();
    saveBeside(shown);
  }

  /** Where the box worked on stands among those shown (the first, with none). */
  private at() { return this.repo ? Math.max(0, this.shown.indexOf(this.repo)) : 0; }

  /** `name`'s box as the row stands: hidden unless shown, in its place, and whether it is worked on or to which side. */
  private stand(name: string, col: HTMLElement) {
    const {shown, repo} = this;
    const at = shown.indexOf(name);
    col.hidden = at < 0;
    col.style.order = String(at);
    col.classList.toggle('active', name === repo);
    col.classList.toggle('first', at === 0);
    col.classList.toggle('last', at === shown.length - 1);
    col.classList.toggle('before', at >= 0 && repo !== null && at < shown.indexOf(repo));
    col.classList.toggle('after', at >= 0 && repo !== null && at > shown.indexOf(repo));
  }

  /**
   * How wide the row is once the pane has done moving (the bench's width, less the pane's when it is out: styles.css
   * `.work.bench`, max(280px, 25%); narrow, the pane is laid over the center), not how wide it is this frame: the row
   * and the prompt box are sent there once, as the pane is put away or brought back, and move on its curve beside its
   * edge, not after it a step behind each frame.
   */
  private room() {
    const W = this.work.clientWidth;
    if (!W) return;
    const w = narrow() || this.work.classList.contains('pane-closed') ? W : W - Math.max(280, W / 4);
    this.element.style.setProperty('--cols-w', `${w}px`);
  }

  /** What a box reads: the repo's whole page, or the one file it was opened beside for. */
  private page(name: string, flow: HTMLElement) {
    const reader = new Reader(repoOf(name), flow, {beside: (path) => this.ways.beside(keyOf(repoOf(name), path)), rename: (path, written) => this.ways.rename(repoOf(name), path, written)});
    const file = fileOf(name);
    return {reader, root: file === null ? reader.directory('') : reader.only(file)};
  }

  /** `was`'s box read again: the page it shows made anew, where it was. */
  private reread(name: string, was: View): View { return {...was, ...this.page(name, was.flow), stale: false}; }

  /** A repo's page, made the first time it is shown, or again once what it showed changed out of sight. */
  viewOf(name: string): View {
    const had = this.views.get(name);
    if (had && !had.stale) return had;
    if (had) {
      // Read again: the page it was takes its place, in the same box.
      const v = this.reread(name, had);
      had.root.replaceWith(v.root);
      this.views.set(name, v);
      return v;
    }
    const {col, flow} = this.box(name);
    this.element.append(col);
    const {reader, root} = this.page(name, flow);
    flow.append(root);
    const v = {col, flow, reader, root, top: 0, stale: false};
    this.views.set(name, v);
    return v;
  }

  /** `name`'s box in the row, hidden until it is shown: its head, and its page that scrolls. */
  private box(name: string): {col: HTMLElement; flow: HTMLElement} {
    // Its head says whose it is and closes it, side by side only; pressed, or dragged along the row, it moves.
    // A file beside says its repo quietly, then its name (its whole path when pointed at).
    const file = fileOf(name);
    const label = h('button', {type: 'button', class: 'col-name', title: file ?? name},
      ...(file === null ? [name] : [h('span', {class: 'col-repo'}, repoOf(name)), shownName(file)]));
    label.addEventListener('click', () => this.ways.activate(name));
    const close = h('button', {type: 'button', class: 'col-close', 'aria-label': t('Close {name} beside', {name})}, mark('close'));
    close.addEventListener('click', () => this.ways.close(name));
    const head = h('div', {class: 'col-head', draggable: 'true'}, label, close);
    this.drag.from(head, name);
    const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': file === null ? t('The files of {name}', {name}) : `${repoOf(name)}/${file}`});
    const col = h('div', {class: `col${file === null ? '' : ' col-file'}`, 'data-repo': repoOf(name), 'data-key': name, hidden: ''}, head, flow);
    return {col, flow};
  }

  /** Where `name`'s page is scrolled to is kept, to come back to. */
  keep(name: string) {
    const v = this.views.get(name);
    if (v) v.top = v.flow.scrollTop;
  }

  /**
   * A repo renamed: its boxes stand where they stood, under its new name (its pages, which read it by its old one,
   * are made again when shown); worked on, none is until Forge is come back to and works on it again.
   */
  renamed(from: string, to: string) {
    for (const k of [...this.views.keys()]) if (repoOf(k) === from) this.forget(k);
    this.shown = renamedIn(this.shown, from, to);
    if (this.repo && repoOf(this.repo) === from) this.repo = null;
    saveBeside(this.shown);
  }

  /** `name`'s box gone from the row, and its page with it: shown again, it opens at its top. */
  forget(name: string) {
    this.views.get(name)?.col.remove();
    this.views.delete(name);
  }

  /**
   * The boxes that stay (`stay`) go on from where they are seen while `change` lays the row out without one: the
   * closed one's place gone from the row moves them in the layout at once, so each is held where it stood and goes
   * from there to its place on the row's curve, rather than leaping by a box's width and sliding back.
   */
  slide(stay: string[], change: () => void) {
    const rest = stay.map((n) => this.views.get(n)?.col).filter((el): el is HTMLElement => !!el);
    const was = new Map(rest.map((el) => [el, el.getBoundingClientRect().left]));
    for (const el of rest) el.style.transitionProperty = 'flex-basis, opacity';
    change();
    void this.element.offsetWidth;
    for (const el of rest) {
      const dx = was.get(el)! - el.getBoundingClientRect().left;
      el.style.transitionProperty = '';
      if (Math.abs(dx) > .5 && !still()) el.animate([{translate: `${dx}px 0`}, {translate: '0 0'}], {duration: paced(450), easing: LAND});
    }
  }

  /**
   * The repo changed through the store (the shell, l3's twin in the Prompt, Git…): open files take the new text, new
   * or removed entries redraw the page where it was; a repo out of sight is read again when it is shown. Returns the
   * way to stop following.
   */
  follow(): () => void {
    return onChange((c) => {
      // Every box of the repo hears it: its page, and each file of it beside.
      for (const [key, v] of [...this.views]) {
        if (repoOf(key) !== c.repo || !v.reader.take(c)) continue;
        // Beside the one worked on, a box shown is read again as it stands; one out of sight, when it is shown.
        if (key !== this.repo) { v.stale = true; if (this.shown.includes(key)) { this.viewOf(key); this.layout(); } continue; }
        clearTimeout(this.again);
        this.again = window.setTimeout(() => this.readAgain(), 150);
      }
    });
  }

  /**
   * A place is about to be gone to in the page worked on. A file just made (from File) is read in now, so the caret
   * lands in it, not in the page about to be read again; nor does a page just read again put it back where it was,
   * over the place asked for.
   */
  landing() {
    if (this.again) { clearTimeout(this.again); this.readAgain(false); }
    cancelAnimationFrame(this.putBack);
  }

  /** The open repo's page read again where it was read; `keep` false when it is about to be scrolled elsewhere. */
  private readAgain(keep = true) {
    this.again = 0;
    if (!this.repo) return;
    const was = this.views.get(this.repo);
    if (!was) return;
    const top = was.top;
    const fresh = this.reread(this.repo, was);
    // The file being written keeps the keyboard and its caret through the page read again.
    const writing = document.activeElement instanceof HTMLTextAreaElement && was.root.contains(document.activeElement) ? document.activeElement : null;
    const at = writing?.closest<HTMLElement>('section.file')?.dataset.path;
    this.views.set(this.repo, fresh);
    was.root.replaceWith(fresh.root);
    this.layout();
    if (keep) this.putBack = requestAnimationFrame(() => { fresh.flow.scrollTop = top; });
    if (writing && at) void fresh.reader.refocus(at, writing.selectionStart, writing.selectionEnd);
  }
}
