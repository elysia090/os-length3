import {t} from '../../i18n.ts';
import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {after, LAND, paced, still} from '../../ui/glide.ts';
import {onChange} from '../../repos/repos.ts';
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
export interface View { col: HTMLElement; flow: HTMLElement; reader: Reader; root: HTMLElement; top: number; stale: boolean }

/** The repos side by side, as last left on this device (a convenience: the band is what is kept). */
const BESIDE_KEY = 'length3.forge.beside';
const readBeside = (): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(BESIDE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []; } catch { return []; } };
const saveBeside = (shown: string[]) => { try { localStorage.setItem(BESIDE_KEY, JSON.stringify(shown)); } catch { /* a convenience */ } };
/** A box in the row is a repo's page (its name) or one file of it beside (name:path; a repo's name has no colon). */
export const repoOf = (key: string) => key.split(':')[0];
export const fileOf = (key: string) => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : null);
export const keyOf = (repo: string, path: string) => `${repo}:${path}`;
/** Narrow, the boxes are not side by side: one stands at a time, and the pane is laid over the center. */
export const narrow = () => matchMedia('(max-width: 760px)').matches;
/** How many neighbours' edges show before the box worked on at `at` of `n`: none for the first, two for the last. */
const lead = (at: number, n: number) => (at === 0 ? 0 : at === n - 1 ? 2 : 1);

/** A box going from the row fades where it stands; then the row closes over its place, by the move that slides it. */
export const shrink = (col: HTMLElement) => new Promise<void>((done) => {
  if (still()) { done(); return; }
  col.classList.add('nothing');
  after(280, done);
});

/** What a box asks of the page it stands in. */
export interface RowWays {
  /** Pressed into (its head, or anything in it), the box is the one worked on. */
  activate(key: string): void;
  /** Its × closes it. */
  close(key: string): void;
  /** A file's head in a repo's page opens it beside, in a box of its own. */
  beside(key: string): void;
  /** A file's head pressed is the file's own place in File. */
  act(repo: string, path: string): void;
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
    this.nothing = h('div', {class: 'empty forge-none', hidden: ''},
      ...t('Bring a repo out to the band with ⊕, or open one from File').split('⊕').flatMap((part, i) => (i ? [h('span', {class: 'inline-add', 'aria-label': '⊕'}, mark('plus')), part] : [part])));
    element.append(this.nothing);
    new ResizeObserver(() => this.room()).observe(work);
    new MutationObserver(() => this.room()).observe(work, {attributes: true, attributeFilter: ['class']});
    // Pressed into, a box is the one worked on (what was pressed goes on as pressed); its × closes it, the one
    // worked on staying as it was.
    element.addEventListener('pointerdown', (event) => this.pressed(event), true);
    element.addEventListener('focusin', (event) => this.pressed(event));
  }

  /** The page of the box worked on, if any. */
  view(): View | null { return this.repo ? this.views.get(this.repo) ?? null : null; }

  private pressed(event: Event) {
    const el = event.target as HTMLElement;
    const c = el.closest<HTMLElement>('.col');
    if (c?.dataset.key && !el.closest('.col-close')) this.ways.activate(c.dataset.key);
  }

  /** Drawn as `shown` and `repo` say: which boxes stand, in what order, and which is worked on. */
  layout() {
    const {shown, element: cols} = this;
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
   * The prompt box stands under the box worked on, its edges a step (s3) outside that box's: where the box will be
   * once the row has moved (styles.css: one box s5 in from the center's edges; side by side with the pane out, the
   * one worked on whole between its neighbours' edges, `--peek` and `--pad`; with the pane away, all of them whole
   * and as wide), so it moves with the row rather than after it.
   */
  private placeDock(w: number) {
    const bench = this.work;
    const n = this.shown.length, at = this.at();
    const S3 = 12, PEEK = 64;
    let left = S3, width = w - 2 * S3;
    if (n > 1 && bench.classList.contains('pane-closed')) { width = (w - 2 * S3) / n; left = S3 + at * width; }
    else if (n > 1) { width = w - 2 * PEEK - 2 * S3; left = S3 + lead(at, n) * PEEK; }
    bench.style.setProperty('--dock-l', `${left}px`);
    bench.style.setProperty('--dock-r', `${w - left - width}px`);
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
    this.placeDock(w);
  }

  /** What a box reads: the repo's whole page, or the one file it was opened beside for. */
  private page(name: string, flow: HTMLElement) {
    const reader = new Reader(repoOf(name), flow, {beside: (path) => this.ways.beside(keyOf(repoOf(name), path)), act: (path) => this.ways.act(repoOf(name), path)});
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
