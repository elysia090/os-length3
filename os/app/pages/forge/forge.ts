import {removeFromBand} from '../../home/band.ts';
import {currentLang, t} from '../../i18n/i18n.ts';
import {h} from '../../ui/dom.ts';
import {icon} from '../../ui/icons.ts';
import {onSync} from '../../remote/lifecycle.ts';
import {onChange, onRenamed, store} from '../../repos/repos.ts';
import type {Context} from '../kit/context.ts';
import {bench, type Bench} from '../bench/bench.ts';
import {openNext as openConversation} from '../kit/next.ts';
import type {Writing} from '../kit/context.ts';
import {startIssue} from '../git/issue-form.ts';
import {showIssue} from '../git/git.ts';
import {Band, bandRenamed} from './pills.ts';
import {Drag} from './drag.ts';
import {takeFiles} from './files-in.ts';
import {Desk} from './desk.ts';
import {deskFile, renameIn, type DeskFile} from './desk-file.ts';
import {deedsUnder, fileDeeds, renaming, split, untitled} from '../kit/file-deeds.ts';

/**
 * Forge, the place you work. The repos out to work on run as pills in a band on the top line; ⊕ brings the rest out
 * and each pill comes off with its ×. The large center is the repo's desk (desk.ts): its Prompt a box of its own, the
 * line one types at under what it printed, its pill saying what that line does (Run, Issue, TODO, Agent); each file
 * opened a box beside it, written in where it lies. One box is in hand and the camera works close to it; Escape steps
 * back to the whole desk. Each repo on the band keeps its own desk, as it was left, while the app runs.
 *
 * Forge is made once and stays as it was while another page is shown, so coming back is coming back to the same
 * repo, the same box in hand, what was searched and what was half written.
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

// A repo renamed (from its gear on Home or Runtime): its pill keeps its place on the band and its desk its boxes,
// under the new name; Forge not made yet in this visit, the band is kept so.
onRenamed((from, to) => {
  if (made) { made.renamed(from, to); return; }
  bandRenamed(from, to);
});

/** Forge's page: made once (again in another language), and come back to as it was left. */
export function forge(ctx: Context): Node[] {
  if (madeIn !== currentLang()) { made?.drop(); made = null; madeIn = currentLang(); }
  made ??= new Forge(ctx);
  made.enter();
  return [made.element];
}

/** What a repo's desk is kept as, while the app is away: its columns' keys and the one in hand. */
interface Kept { cols: string[][]; held: string | null }
const KEPT = 'forge.desk.';

function keptDesk(repo: string): Kept | null {
  try { const k = JSON.parse(localStorage.getItem(KEPT + repo) ?? 'null') as Kept | null; return k && Array.isArray(k.cols) ? k : null; } catch { return null; }
}

function kept(repo: string, desk: Desk) {
  try { localStorage.setItem(KEPT + repo, JSON.stringify({cols: desk.columns, held: desk.held})); } catch { /* kept for this run only */ }
}

/** A repo's desk, and the files lying on it. */
interface Laid { desk: Desk; files: Map<string, DeskFile> }

/** The page, its parts put together: which repos are on the band, the desk of each, and the one worked on. */
class Forge {
  readonly element: HTMLElement;
  private work: Bench;
  private band: Band;
  /** The repo worked on (the band's ink, the Prompt's, the desk on screen). */
  private now: {repo: string | null} = {repo: null};
  private desks = new Map<string, Laid>();
  private center: HTMLElement;
  /** The files button's deeds while they are out: the way to put them away. */
  private deedsOut: (() => void) | null = null;
  /** The repo worked on as Forge last knew it: chosen anew elsewhere (Git, Home, File), Forge follows. */
  private known: string | null;
  private offSync: () => void;
  private offChange: () => void;
  private offKeys: () => void;
  /** The file last told as the one Forge works on. */
  private told: string | null = null;
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
    this.center = h('div', {class: 'desk-room'});
    this.work = bench({strip, main: this.center, desk: true, reveal: (path, line, write) => this.revealAt(path, line, write),
      place: (path) => this.place(path), frame: (keys) => { if (this.now.repo) this.deskOf(this.now.repo).desk.frame(keys); },
      word: (a) => { openConversation(a); void ctx.go('inbox'); },
      toTerm: () => { if (this.now.repo) this.deskOf(this.now.repo).desk.take('term'); },
      besideTerm: (repo, element) => {
        const {desk} = this.deskOf(repo);
        if (!desk.has('agent')) desk.lay('agent', {element, name: 'agent', dir: '', after: `/root/${repo}`, focus: () => element.focus({preventScroll: true})}, undefined, 'term');
      },
      went: (repo, to) => {
        if (to !== 'todo' && 'file' in to) { ctx.openRepo(repo, to.file); return; }
        if (to !== 'todo') showIssue(repo, to.issue);
        void ctx.go(to === 'todo' ? 'home' : 'git');
      }});
    this.element = this.work.element;
    // The Issue view with none open begins one for this repo on Git; Not now there comes back here.
    this.work.reference.writeIssue = (r) => { startIssue(r); ctx.go('git'); };
    const drag = new Drag(this.center);
    this.band = new Band(strip, this.now, drag, {show: (name) => this.show(name), beside: (name) => this.show(name),
      takeOff: (name) => this.takeOff(name), act: (at) => this.deeds(at)}, this.work.tools);
    // Files from the desktop let go over a box: into its folder (none written over), the first opened.
    takeFiles(this.center, drag, (repo, path) => this.show(repo, path));
    // What the Remote holds is learnt a moment after: ⊕ counts it once it is.
    this.offSync = onSync(() => this.band.paintAdd());
    // Something on the desk scrolled into view (the keyboard going to it, a find): the desk's camera goes there instead.
    this.element.addEventListener('scroll', (e) => {
      const desk = this.now.repo ? this.desks.get(this.now.repo)?.desk : undefined;
      const at = e.target as HTMLElement;
      if (desk && at instanceof HTMLElement && at !== desk.element && at.contains(desk.element)) desk.scrolled(at);
    }, true);
    // A file gone (put back, removed from File, a folder of it removed): its box goes from the desk; moved (gone, and
    // a file made a moment after), its box is the file where it went, where the box lay.
    let going: {repo: string; path: string; timer: number} | null = null;
    this.offChange = onChange((c) => {
      const d = this.desks.get(c.repo);
      if (!d) return;
      if (c.what === 'removed') {
        const gone = [...d.files.keys()].filter((path) => path === c.path || path.startsWith(`${c.path}/`));
        if (gone.length === 1 && gone[0] === c.path) {
          if (going) { clearTimeout(going.timer); this.shut(going.repo, going.path); }
          going = {repo: c.repo, path: c.path, timer: window.setTimeout(() => { if (going) this.shut(going.repo, going.path); going = null; }, 600)};
        } else for (const path of gone) this.shut(c.repo, path);
      } else if (c.what === 'file' && going && going.repo === c.repo && going.path === c.path) {
        // Written again where it was (a file replaced whole, as the Agent writes one): it never went; its box stays.
        clearTimeout(going.timer);
        going = null;
      } else if (c.what === 'file' && going && going.repo === c.repo && !d.files.has(c.path)) {
        clearTimeout(going.timer);
        const from = going.path;
        going = null;
        this.moved(c.repo, from, c.path);
      }
    });
    // Shift+N makes a new file, as a new post is begun on X: where nothing is being written (the finger on a box, the
    // band, the pane), Forge on screen and nothing over it holding the page. Taken before the desk hears it (a letter
    // there goes into the box under the finger).
    const keys = (e: KeyboardEvent) => {
      if (e.key !== 'N' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
      if (!this.element.isConnected || this.element.closest('[hidden]') || document.getElementById('page')?.hasAttribute('inert')) return;
      const at = e.target as HTMLElement | null;
      if (at?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-raw]')) return;
      e.preventDefault();
      e.stopPropagation();
      void this.newFile();
    };
    document.addEventListener('keydown', keys, true);
    this.offKeys = () => document.removeEventListener('keydown', keys, true);
    this.known = ctx.repo;
    // Forge's head is its band; its name is still the page's heading, for those who hear the page.
    this.element.prepend(h('h1', {class: 'sr-only'}, t('Forge')));
  }

  /** Made again (another language): it no longer follows the store or the Remote. */
  drop() {
    this.offSync();
    this.offChange();
    this.offKeys();
    for (const d of this.desks.values()) for (const f of d.files.values()) f.drop();
  }

  /**
   * The deeds for the file in hand (the repo's own, with none), out under the band's files button: done here, where
   * one works. Made, a new file is a box to write in; renamed or moved, the box says where it went.
   */
  private deeds(at: HTMLElement) {
    const repo = this.now.repo;
    if (!repo || this.deedsOut) return;
    const path = this.fileHeld(repo);
    const done = () => this.deedsOut?.();
    const pop = fileDeeds({repo, path, name: path ? split(path)[1] : repo, dir: !path,
      made: (made, file) => { done(); if (file) this.made(repo, made); },
      move: async (to) => {
        if (to !== path) await store.move(repo, path, to);
        done();
        this.shut(repo, path);
        this.ctx.openRepo(repo, to);
      },
      removed: () => { done(); this.shut(repo, path); },
      back: () => {}});
    this.deedsOut = deedsUnder(at, pop, () => { this.deedsOut = null; });
  }

  /** The file in hand on `repo`'s desk ('' while a terminal is: the person's, or the Agent's). */
  private fileHeld(repo: string): string {
    const d = this.desks.get(repo), held = d?.desk.held;
    return held && d.files.has(held) ? held : '';
  }

  /** Shift+N: a new file made at once beside the file in hand (at the repo's top beside none), opened to write in, its
   * name written over in its head. */
  private async newFile() {
    const repo = this.now.repo;
    if (!repo) return;
    const path = this.fileHeld(repo);
    this.made(repo, await untitled(repo, path ? split(path)[0] : '', path ? split(path)[1] : undefined));
  }

  /** A file just made: its box, come out from under the one above it, in hand, its name written over at once (the stem
   * chosen); named, the keyboard goes on into it. */
  private made(repo: string, path: string) {
    this.ctx.openRepo(repo, path, 'name');
  }

  /** `from` of `repo` moved to `to` (renamed here or elsewhere): its box is the file where it went, where it lay, as it
   * was, in hand if it was. */
  private moved(repo: string, from: string, to: string): DeskFile | null {
    const d = this.desks.get(repo);
    if (!d) return null;
    const there = d.files.get(to);
    if (there) return there;
    if (!d.files.has(from)) return null;
    const f = this.layFile(repo, d, to, undefined, {instead: from});
    d.files.get(from)?.drop();
    d.files.delete(from);
    return f;
  }

  /** `repo`'s desk, made the first time: its Prompt the first box. */
  private deskOf(repo: string): Laid {
    let d = this.desks.get(repo);
    if (!d) {
      const files = new Map<string, DeskFile>();
      let restoring = true;
      const desk = new Desk(t('Files in {name}', {name: repo}), repo, (key) => this.shut(repo, key), () => {
        if (restoring) return;
        kept(repo, desk);
        // The file in hand is the one Forge works on: File marks it (told once each time it is another).
        if (this.now.repo === repo && desk.held && desk.held !== 'term' && desk.held !== this.told) {
          this.told = desk.held;
          this.ctx.reading(desk.held);
          // Where the person left off (Home says it): the file in hand.
          this.ctx.leftAt(repo, desk.held, 0);
        }
      });
      d = {desk, files};
      this.desks.set(repo, d);
      // Written in a box: where the person left off (Home says the line) is where its caret is.
      desk.element.addEventListener('input', (e) => {
        const area = e.target as HTMLTextAreaElement;
        const path = area.closest<HTMLElement>('.desk-file')?.dataset.path;
        if (path && area.selectionStart !== undefined) this.ctx.leftAt(repo, path, area.selectionStart);
      });
      const term = this.work.terminal!;
      desk.lay('term', {element: h('div', {class: 'desk-term-home'}), name: 'sh', dir: '', after: `/root/${repo}`,
        focus: () => term.querySelector<HTMLTextAreaElement>('.prompt-in')?.focus({preventScroll: true})}, 0);
      // As it was left: the boxes where they lay, the one in hand.
      const was = keptDesk(repo);
      // (The Agent's terminal is born again when it is asked again; a desk kept has none.)
      was?.cols.forEach((col, c) => { for (const key of col) if (key !== 'term' && key !== 'agent') this.layFile(repo, d!, key, c); });
      if (was?.held && desk.has(was.held)) desk.take(was.held, false);
      // A desk never worked at: its README beside the Prompt, to be read first.
      if (!was) { const laid = d; void store.read(repo, 'README.md').then((c) => { if (c.text !== null && !laid.files.has('README.md')) this.layFile(repo, laid, 'README.md', 1); }).catch(() => {}); }
      restoring = false;
    }
    return d;
  }

  /** `path` of `repo` laid on its desk `d` as a box (in column `col`, or under the box in hand). */
  private layFile(repo: string, d: Laid, path: string, col?: number, how: {slide?: boolean; instead?: string} = {}): DeskFile {
    const f = deskFile(repo, path, () => d.desk.relayout(), (name) => renameIn(name, path, async (from, written) => {
      const to = await renaming(repo, from, written);
      if (to === from) return;
      await store.move(repo, from, to);
      // Named, it is written in: the box where it lay, the keyboard going on from its name into it, at its end.
      this.moved(repo, from, to)?.toEnd();
    }, () => f.toEnd()));
    d.files.set(path, f);
    d.desk.lay(path, f, col, undefined, how);
    return f;
  }

  /** A file's box taken off the desk (its close, or the file gone); the Prompt's stays. */
  private shut(repo: string, key: string) {
    const d = this.desks.get(repo);
    if (!d || key === 'term') return;
    d.files.get(key)?.drop();
    d.files.delete(key);
    d.desk.lift(key);
  }

  /** `path` of the repo worked on, a box on its desk (laid now, under the box in hand, if it was not), in hand; at `line`. */
  private open(path: string, line = 0) {
    const repo = this.now.repo;
    if (!repo || !path) return;
    const d = this.deskOf(repo);
    // Chosen from the band's search while its sheet is down, the desk out of sight under it: the camera is put where
    // the box is meanwhile, unseen, and the desk comes back already there as the sheet goes up.
    const unseen = !!this.element.querySelector('.band-tools > .search-box:is(:focus-within, .reading):not(.idle, .leaving)');
    // A file laid for the first time goes in the column beside the Prompt's, under the last there.
    const f = d.files.get(path) ?? this.layFile(repo, d, path, d.desk.held === 'term' || !d.desk.held ? 1 : undefined, {slide: !unseen});
    d.desk.take(path, true, !unseen);
    f.at(line);
  }

  /** `path` of the repo worked on, a box on its desk, laid if it was not (beside the Prompt), the hand left where it is. */
  private place(path: string): boolean {
    const repo = this.now.repo;
    if (!repo || !path) return false;
    const d = this.deskOf(repo);
    if (!d.files.has(path)) this.layFile(repo, d, path, 1);
    return true;
  }

  /** Renamed: on the band and on its desk under its new name. */
  renamed(from: string, to: string) {
    this.band.renamed(from, to);
    const d = this.desks.get(from);
    if (d) { this.desks.delete(from); this.desks.set(to, d); }
    if (this.now.repo === from) this.now.repo = to;
    if (this.known === from) this.known = to;
  }

  /** Show `name` in the band and the center, its desk; at `path` if given (a box for it, at `line`; a file just made,
   * `write` 'name', its name written over first). */
  show(name: string, path = '', write: Writing = false, line = 0) {
    this.band.put(name);
    const d = this.deskOf(name);
    if (this.now.repo !== name) {
      this.now.repo = name;
      this.known = name;
      this.ctx.remember(name);
      this.work.setRepo(name);
      // Every desk stays in the page, those not worked at hidden: a text taken out of the page loses its Undo.
      this.center.querySelector('.desk-none')?.remove();
      if (!d.desk.element.isConnected) this.center.append(d.desk.element);
      for (const o of this.desks.values()) o.desk.element.hidden = o !== d;
    }
    // The Prompt's own box is the one terminal of the bench: it lies on the desk shown.
    d.desk.element.querySelector('.desk-box[data-key="term"] .desk-term-home')?.replaceChildren(this.work.terminal!);
    this.band.paint();
    if (path) {
      this.open(path, line);
      if (write === 'name') d.desk.name(path);
    } else if (!d.desk.held) d.desk.take('term', false);
    else d.desk.relayout();
  }

  /** A place asked for in the repo worked on: its file's box, in hand, at `line`. */
  private revealAt(path: string, line = 0, _write: Writing = false) {
    if (this.now.repo) this.open(path, line);
  }

  /** `name` off the band, and its desk with it. */
  private takeOff(name: string) {
    const {band} = this;
    const r = removeFromBand(band.names, name, this.now.repo);
    band.names = r.band;
    band.save();
    const d = this.desks.get(name);
    if (d) { for (const f of d.files.values()) f.drop(); d.desk.element.remove(); this.desks.delete(name); }
    if (this.now.repo === name) this.now.repo = null;
    if (!r.active) { this.none(); return; }
    this.show(r.active);
  }

  /** Nothing on the band: the center is empty, the Prompt with no repo. */
  private none() {
    this.now.repo = null;
    this.work.setRepo(null);
    // With none at all, the way to the first, where the desk would be.
    const first = h('button', {type: 'button', class: 'card new forge-first'}, icon('new-repo'), h('span', {}, t('Create your first repo')),
      h('small', {class: 'muted'}, t('A personal Git repository: compatible with Forge, Git, and Prompt.')));
    first.addEventListener('click', () => void this.ctx.go('new-repo'));
    for (const o of this.desks.values()) o.desk.element.hidden = true;
    this.center.querySelector('.desk-none')?.remove();
    this.center.append(h('div', {class: 'desk-none'}, first));
    this.band.paint();
  }

  /** Come to (back) on the screen: the repo asked for, chosen elsewhere, or as it was. */
  enter() {
    this.work.settle();
    void store.list().then((repos) => this.choose(repos.map((r) => r.name)));
  }

  /** The repos here are `all`: the band keeps those still here, and one of them is worked on. */
  private choose(all: string[]) {
    const {band, ctx} = this;
    band.known(all, ctx.repo);
    for (const name of [...this.desks.keys()]) if (!all.includes(name)) { this.desks.get(name)!.desk.element.remove(); this.desks.delete(name); }
    const asked = pending;
    pending = null;
    const chosen = ctx.repo !== this.known;
    this.known = ctx.repo;
    if (ctx.repo && all.includes(ctx.repo) && (asked || chosen)) {
      const at = asked ?? {path: '', write: false, line: 0};
      this.show(ctx.repo, at.path, at.write, at.line);
      return;
    }
    const open = this.now.repo && all.includes(this.now.repo) ? this.now.repo
      : ctx.repo && band.names.includes(ctx.repo) ? ctx.repo : band.names[0];
    if (open) this.show(open); else this.none();
  }
}

