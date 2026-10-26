import {closeBeside, moveTo, openBeside, removeFromBand, showIn} from '../../home/band.ts';
import {currentLang, t} from '../../i18n.ts';
import {h} from '../../ui/dom.ts';
import {onSync} from '../../remote/lifecycle.ts';
import {store} from '../../repos/repos.ts';
import type {Context} from '../context.ts';
import {bench, type Bench} from '../bench/bench.ts';
import {openNext as openConversation} from '../inbox.ts';
import type {Writing} from './reader.ts';
import {startIssue} from '../git/issue-form.ts';
import {showIssue} from '../git/git.ts';
import {panAcross, still} from '../../ui/glide.ts';
import {fileOf, keyOf, narrow, repoOf, Row, shrink} from './columns.ts';
import {Band} from './pills.ts';
import {Drag, dropInto} from './drag.ts';
import {takeFiles} from './files-in.ts';
import {keysAlong, swipeAlong} from './along.ts';
import {Place} from './place.ts';

/**
 * Forge, the place you work. The repos out to work on run as pills in a band
 * on the top line; ⊕ brings the rest out and each
 * pill comes off with its ×. The large center is the open repo's files one
 * after another, an endless page you scroll through and edit in place,
 * opened at the file chosen in File; there are no tabs. Up to three repos
 * stand side by side in it, each its own page, tiled: one is opened beside
 * the others by dragging its pill into the center (where it is let go is
 * where it stands), by Ctrl+click on its pill, or Ctrl+\ (the next on the
 * band); the one worked on (the prompt, the search and File follow it) is
 * the one last pressed in, drawn in ink. A prompt box sits at
 * the bottom of the center. The narrow right pane holds the search box and a
 * reference switched freely on top and the Prompt below; using the prompt
 * box sends the Prompt up over the center, just above the box, and the
 * reference grows down into the room it leaves.
 *
 * Forge is made once and stays as it was while another page is shown, so
 * coming back is coming back to the same repo, where it was read, what was
 * searched and what was half written. Each repo on the band keeps its own
 * place the same way: going to another repo and back is going back to where
 * one was in it.
 *
 * Its parts, each in a file of its own here: the band (pills.ts), the row of
 * boxes in the center (columns.ts), a repo dragged (drag.ts) and files dragged
 * in from the desktop (files-in.ts), going along the row (along.ts), and where
 * one is in it (place.ts); this file puts them together and says which repo
 * stands where.
 */

/** Set when Forge is opened for a repo: the path to scroll to ('' for the top), and whether to write there. */
let pending: {path: string; write: Writing; line: number} | null = null;

/** Show `repo` at `path` in the Forge on screen (at `line`; the caret there with `write`); false when Forge is not showing. */
export function showInForge(repo: string, path: string, write: Writing = false, line = 0): boolean {
  if (!made?.element.isConnected) return false;
  made.show(repo, path, write, line);
  return true;
}

/** Forge is next drawn for the repo just asked for, at `path` ('' for its top), at `line` of it. */
export function revealNext(path: string, write: Writing = false, line = 0) { pending = {path, write, line}; }

/** The Forge made, which File can move in place while it is on screen. */
let made: Forge | null = null;

/**
 * Forge's element once made, which the page keeps in the document (hidden) while
 * another page is shown: a text box taken out of the document loses what Undo
 * would take back, so nothing written in Forge is ever taken out to show something else.
 */
export const keptForge = (): HTMLElement | null => (madeIn === currentLang() ? made?.element ?? null : null);
/** The language Forge was made in: another chosen since, it is made again, so none of its words stay in the last one. */
let madeIn: string | null = null;

/** Forge's page: made once (again in another language), and come back to as it was left. */
export function forge(ctx: Context): Node[] {
  if (madeIn !== currentLang()) { made?.drop(); made = null; madeIn = currentLang(); }
  made ??= new Forge(ctx);
  made.enter();
  return [made.element];
}

/** The page, its parts put together: which repos are on the band, which stand in the row, and the one worked on. */
class Forge {
  readonly element: HTMLElement;
  private work: Bench;
  private row: Row;
  private band: Band;
  private place: Place;
  /** The repo worked on as Forge last knew it: chosen anew elsewhere (Git, Home, File), Forge follows. */
  private known: string | null;
  private offChange: () => void;
  private offSync: () => void;
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
    const cols = h('div', {class: 'columns'});
    this.work = bench({strip, main: cols, reveal: (path, line, write) => this.revealAt(path, line, write),
      word: (a) => { openConversation(a); void ctx.go('inbox'); },
      went: (repo, to) => { if (to !== 'todo') showIssue(repo, to.issue); void ctx.go(to === 'todo' ? 'home' : 'git'); }});
    this.element = this.work.element;
    const drag = new Drag(cols);
    this.row = new Row(cols, this.element, drag, {activate: (key) => this.activate(key), close: (key) => this.closeCol(key),
      beside: (key) => this.beside(key), act: (repo, path) => ctx.actOn(repo, path), make: () => void ctx.go('new-repo')});
    // The Issue view with none open begins one for this repo on Git; Not now there comes back here.
    this.work.reference.writeIssue = (r) => { startIssue(r); ctx.go('git'); };
    this.band = new Band(strip, this.row, drag, {show: (name) => this.show(name), beside: (name) => this.beside(name),
      takeOff: (name) => this.takeOff(name), act: () => { if (this.row.repo) ctx.actOn(repoOf(this.row.repo), this.place.reading ?? ''); }});
    dropInto(this.row, drag, (name, at, instead) => this.land(name, at, instead));
    takeFiles(cols, drag, (repo, path) => this.show(repo, path));
    swipeAlong(this.row, (key) => this.activate(key));
    keysAlong(this.element, this.row, this.band, {beside: (name) => this.beside(name), activate: (key) => this.activate(key)});
    this.place = new Place(this.element, this.row, ctx);
    this.offChange = this.row.follow();
    // What the Remote holds is learnt a moment after: ⊕ counts it once it is. The pills stay as they
    // are (and the one with the keyboard keeps it): what the Remote holds does not change the band.
    this.offSync = onSync(() => this.band.paintAdd());
    this.known = ctx.repo;
    // Forge's head is its band; its name is still the page's heading, for those who hear the page.
    this.element.prepend(h('h1', {class: 'sr-only'}, t('Forge')));
  }

  /** Made again (another language): it no longer follows the store or the Remote. */
  drop() { this.offChange(); this.offSync(); }

  /**
   * `name`, shown, is the one worked on: the prompt, the search and File follow it, the row as it is. `anew`, it is
   * laid out and said again even if it already was.
   */
  private activate(name: string, anew = false) {
    const {row} = this;
    if (anew) row.repo = null;
    if (name === row.repo || !row.shown.includes(name)) return;
    row.repo = name;
    this.known = repoOf(name);
    this.ctx.remember(repoOf(name));
    this.work.setRepo(repoOf(name));
    row.layout();
    this.band.paint();
    // Only come to (pressed, or come in as another closed): what it reads is said, not taken as where one left off.
    this.place.track(false);
  }

  /** Show `name` in the band, the center and the terminal, in place; at `path` if given, ready to write with `write`. */
  show(name: string, path = '', write: Writing = false, line = 0, pan = true) {
    const {row, band} = this;
    band.put(name);
    const from = row.repo;
    const switching = from !== name || !row.shown.includes(name);
    // Coming into a box another stood in, the camera pans along the band to it: from the side its pill is on. Come
    // from another page (a repo made, opened from File or Home), the camera is already going down the rail to Forge:
    // it arrives with the repo in its box, not panning sideways as well (the neighbour beside it passing through).
    const across = pan && switching && !!from && !row.shown.includes(name) ? Math.sign(band.names.indexOf(name) - band.names.indexOf(repoOf(from!))) : 0;
    const go = () => {
      if (switching) {
        row.keep(from ?? '');
        row.shown = showIn(row.shown.filter((n) => row.views.has(n) || n === name), name, from);
        const v = row.viewOf(name);
        this.activate(name, true);
        v.flow.scrollTop = v.top;
      }
      band.paint();
      if (path) row.landing();
      this.place.goTo(path, line, write);
    };
    if (across) panAcross(row.element, across, go); else go();
  }

  // A place asked for in another file than the one a box beside holds is read in the repo's page, which comes in
  // where that box stood (or is gone to, standing in the row already).
  private revealAt(path: string, line = 0, write: Writing = false) {
    const {row} = this;
    const file = row.repo ? fileOf(row.repo) : null;
    // A file standing in a box of its own is read there, not in the page where it is only its head.
    const own = row.repo ? keyOf(repoOf(row.repo), path) : '';
    if (row.repo && own !== row.repo && row.shown.includes(own)) {
      this.activate(own, true);
      this.band.paint();
    } else if (row.repo && file !== null && file !== path) {
      const page = repoOf(row.repo);
      if (!row.shown.includes(page)) { row.shown = showIn(row.shown, page, row.repo); row.viewOf(page); }
      this.activate(page, true);
      this.band.paint();
    }
    void row.view()?.reader.reveal(path, line, write).then(() => this.place.track());
  }

  /** `name` opened beside what is shown (at `at`, an index among the boxes), and worked on. */
  private beside(name: string, at?: number) {
    if (narrow()) { this.show(repoOf(name), fileOf(name) ?? ''); return; }
    const {row} = this;
    this.band.put(repoOf(name));
    const before = row.shown;
    row.shown = openBeside(row.shown, name, row.repo, at);
    const v = row.viewOf(name);
    const fresh = !before.includes(name);
    for (const gone of before.filter((n) => !row.shown.includes(n))) row.keep(gone);
    // Come in, it opens from no width where it stands as the row slides to it, so it pushes in from its side.
    const opening = fresh && row.shown.length > 1 && !still();
    if (opening) {
      v.col.classList.add('nothing');
      // It stands in the row where the row is now, before the row moves to it: drawn first at the row's present place,
      // it then goes with the others on their curve, not at once to where they are only on their way to.
      row.layout();
      void row.element.offsetWidth;
    }
    this.activate(name, true);
    v.flow.scrollTop = v.top;
    // The keyboard goes with it: what opened it (a file's head, now only peeking) is no longer the place to hold it,
    // and given back to the box it was in, that box would be the one worked on again.
    v.flow.focus({preventScroll: true});
    if (opening) requestAnimationFrame(() => v.col.classList.remove('nothing'));
  }

  /** `name`'s box closed (the repo stays on the band); the last one stays. */
  private closeCol(name: string) {
    const {row} = this;
    if (row.shown.length < 2 || !row.shown.includes(name)) return;
    const v = row.views.get(name);
    const c = closeBeside(row.shown, name, row.repo);
    const done = () => row.slide(c.shown, () => {
      row.shown = c.shown;
      if (c.active && c.active !== row.repo) this.activate(c.active, true); else { row.layout(); this.band.paint(); }
    });
    if (!v) { done(); return; }
    v.top = v.flow.scrollTop;
    v.col.classList.add('going');
    // The one worked on closed, the one taking its place comes in as it goes (the row sliding to it), the keyboard
    // with it: never an empty row while the closed one closes.
    const next = c.active && c.active !== row.repo ? row.views.get(c.active) : undefined;
    if (next && c.active) { this.activate(c.active); next.flow.focus({preventScroll: true}); }
    void shrink(v.col).then(() => { v.col.classList.remove('going', 'nothing'); done(); });
  }

  /** `name` let go in the center: to stand at `at` among the boxes, or (`instead`) in the place of the box there. */
  private land(name: string, at: number, instead: boolean) {
    const {row} = this;
    const there = row.shown[at] ?? null;
    if (row.shown.includes(name)) {
      // A box dragged along the row: it stands where it is let go (in a box's middle, the two change places).
      row.shown = instead && there ? row.shown.map((n) => (n === name ? there : n === there ? name : n)) : moveTo(row.shown, name, at);
      this.activate(name, true);
      row.layout();
      return;
    }
    if (instead && there) { row.repo = there; this.show(name); } else this.beside(name, at);
  }

  /** `name` off the band, and its boxes from the row. */
  private takeOff(name: string) {
    const {row, band} = this;
    const r = removeFromBand(band.names, name, row.repo && repoOf(row.repo));
    band.names = r.band;
    band.save();
    // Off the band, its boxes go from the row too (its page, and any file of it beside); their place is not kept:
    // brought out again, it opens at its top.
    let c: {shown: string[]; active: string | null} = {shown: row.shown, active: row.repo};
    for (const k of [...row.views.keys()].filter((k) => repoOf(k) === name)) {
      c = closeBeside(c.shown, k, c.active);
      row.forget(k);
    }
    row.shown = c.shown;
    if (!r.active) { this.none(); return; }
    const next = c.active && band.names.includes(repoOf(c.active)) ? c.active : r.active;
    if (!row.shown.includes(next)) this.show(repoOf(next));
    else if (next !== row.repo) this.activate(next, true);
    else { row.layout(); band.paint(); }
  }

  /** Nothing on the band: the center says how to bring a repo out (Server is laid over any page, not kept here). */
  private none() {
    this.row.repo = null;
    this.row.shown = [];
    this.work.setRepo(null);
    this.row.layout();
    this.place.told(null);
    this.band.paint();
  }

  /** Come to (back) on the screen: each place where it was, then the repo asked for, chosen elsewhere, or as it was. */
  enter() {
    this.work.settle();
    this.place.back();
    void store.list().then((repos) => this.choose(repos.map((r) => r.name)));
  }

  /** The repos here are `all`: the band and the row keep those still here, and one of them is worked on. */
  private choose(all: string[]) {
    const {row, band, ctx} = this;
    band.known(all, ctx.repo);
    row.known(all.length > 0);
    for (const name of [...row.views.keys()]) if (!all.includes(repoOf(name))) row.forget(name);
    // What stood side by side, as far as it is still on the band.
    row.shown = row.shown.filter((n) => band.names.includes(repoOf(n)));
    for (const n of row.shown) row.viewOf(n);
    const asked = pending;
    pending = null;
    const chosen = ctx.repo !== this.known;
    this.known = ctx.repo;
    // Opened for a repo (from File, Home or a new repo), or one chosen to work on elsewhere: it goes on the band.
    if (ctx.repo && all.includes(ctx.repo) && (asked || chosen)) {
      const at = asked ?? {path: '', write: false, line: 0};
      this.show(ctx.repo, at.path, at.write, at.line, false);
      return;
    }
    this.goOn(all);
  }

  /** Nothing asked for: the box worked on as it was, else the repo chosen, the first beside or the first on the band. */
  private goOn(all: string[]) {
    const {row, band, ctx} = this;
    if (row.repo && all.includes(repoOf(row.repo)) && row.shown.includes(row.repo)) { row.layout(); band.paint(); this.place.track(false); return; }
    row.repo = null;
    const open = ctx.repo && band.names.includes(ctx.repo) ? ctx.repo : row.shown[0] ?? band.names[0];
    if (open && fileOf(open) !== null) { this.activate(open); band.paint(); this.place.track(false); } else if (open) this.show(open); else this.none();
  }
}
