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
import {GRID} from './desk-layout.ts';
import {deskFile, renameIn, type DeskFile} from './desk-file.ts';
import {asPath, isFile, wordAt} from './term-links.ts';
import {deedsUnder, fileDeeds, renaming, split, untitled} from '../kit/file-deeds.ts';

/**
 * Forge, the place you work. The repos out to work on run as pills in a band on the top line; ⊕ brings the rest out
 * and each pill comes off with its ×. The large center is the repo's desk (desk.ts): each file opened a box on it,
 * written in where it lies, one of them in hand, the camera close to it (Escape steps back to the whole desk); one
 * box may be put beside the desk, a second screen. The Prompt stands at the desk's foot (bench.ts): the line one
 * types at, and over it, while it is up, what it printed. Each repo on the band keeps its own desk, as it was left,
 * while the app runs.
 *
 * Forge is made once and stays as it was while another page is shown, so coming back is coming back to the same
 * repo, the same box in hand, what was searched and what was half written.
 */

/** Set when Forge is opened for a repo: the path to scroll to ('' for the top), and whether to write there. */
let pending: {path: string; write: Writing; line: number; from: Element | null} | null = null;

/** Show `repo` at `path` in the Forge on screen (at `line`; the caret there with `write`); false when Forge is not showing. */
export function showInForge(repo: string, path: string, write: Writing = false, line = 0): boolean {
  if (!made?.element.isConnected) return false;
  made.show(repo, path, write, line);
  return true;
}

/**
 * Forge is next drawn for the repo just asked for, at `path` ('' for its top), at `line` of it; the keyboard goes in
 * unless it was put somewhere else (`from` is where it was when it was asked) before Forge was drawn.
 */
export function revealNext(path: string, write: Writing = false, line = 0, from: Element | null = document.activeElement) { pending = {path, write, line, from}; }

/** The terminal asked for with the repo (Home's band's >_): once Forge is drawn for it, the keyboard is in its Prompt. */
let termAsked = false;
export function termNext() { termAsked = true; }
/** The file deeds asked for with the repo (Home's band's files button): once Forge is drawn for it, out under its own. */
let deedsAsked = false;
export function deedsNext() { deedsAsked = true; }

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

/** What a repo's desk is kept as, while the app is away: its columns' keys, the one in hand, the one beside it. */
interface Kept { cols: string[][]; held: string | null; beside?: string | null }
const KEPT = 'forge.desk.';

function keptDesk(repo: string): Kept | null {
  try { const k = JSON.parse(localStorage.getItem(KEPT + repo) ?? 'null') as Kept | null; return k && Array.isArray(k.cols) ? k : null; } catch { return null; }
}

function kept(repo: string, desk: Desk) {
  try { localStorage.setItem(KEPT + repo, JSON.stringify({cols: desk.columns, held: desk.held, beside: desk.beside})); } catch { /* kept for this run only */ }
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
      besideTerm: (repo, element) => {
        // The Agent's own terminal is a box of the desk, a column of its own beside the one in hand.
        const {desk} = this.deskOf(repo);
        if (!desk.has('agent')) desk.lay('agent', {element, name: 'agent', dir: '', after: `/root/${repo}`, stays: true, focus: () => element.focus({preventScroll: true})}, undefined, desk.held ?? undefined);
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
    this.termLinks();
    new ResizeObserver(() => this.split()).observe(this.center);
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
    // A file gone (put back, removed from File, a folder of it removed): its box goes from the desk. Moved (its path,
    // or a folder over it, gone `to` another: one move, said so by the store), its box is the file where it went,
    // where the box lay. Nothing is guessed from a removal and a file made near it in time: those are two things.
    let going: {repo: string; path: string; timer: number} | null = null;
    const gone = () => { if (!going) return; clearTimeout(going.timer); this.shut(going.repo, going.path); going = null; };
    this.offChange = onChange((c) => {
      const d = this.desks.get(c.repo);
      if (!d) return;
      if (c.what === 'removed') {
        const under = [...d.files.keys()].filter((path) => path === c.path || path.startsWith(`${c.path}/`));
        if (c.to !== undefined) { for (const path of under) this.moved(c.repo, path, c.to + path.slice(c.path.length)); return; }
        // Its own path alone gone: its box waits a moment for the same path written again (a file replaced whole by
        // being removed and made, as a program in the Prompt may save it), then goes. Never taken to another path.
        if (under.length === 1 && under[0] === c.path) {
          gone();
          going = {repo: c.repo, path: c.path, timer: window.setTimeout(gone, 600)};
        } else for (const path of under) this.shut(c.repo, path);
      } else if ((c.what === 'file' || c.what === 'unread') && going && going.repo === c.repo && going.path === c.path) {
        // Written again where it was: it never went; its box stays.
        clearTimeout(going.timer);
        going = null;
      }
    });
    // Shift+N makes a new file, as a new post is begun on X: where nothing is being written (the keyboard on the desk,
    // the band, the pane), Forge on screen and nothing over it holding the page. Taken before the desk hears it (a
    // letter there goes into the box in hand).
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

  /**
   * A file named in a terminal's output on the desk (`ls`, the compiler's `count.c:7:24:`, grep's): underlined under the
   * pointer, and pressed, its box opened at that line (term-links.ts). A press that chose words chose them: nothing opens.
   */
  private termLinks() {
    let at: {repo: string; path: string; line: number} | null = null;
    let frame = 0, last = {x: 0, y: 0};
    const out = (t: EventTarget | null) => (t as Element | null)?.closest?.(':is(.desk-box, .desk-term) .term-out') ?? null;
    // (The Prompt stands at the center's foot, beside the desks' room: heard on what holds both.)
    const room = this.center.parentElement ?? this.center;
    const clear = () => { at = null; CSS.highlights?.delete('term-file'); room.classList.remove('term-linking'); };
    const look = () => {
      frame = 0;
      const repo = this.now.repo, el = out(document.elementFromPoint(last.x, last.y));
      const w = el && repo ? wordAt(last.x, last.y, el) : null;
      const named = w && repo ? asPath(w.text, repo) : null;
      if (!w || !named || !repo) { clear(); return; }
      void isFile(repo, named.path).then((yes) => {
        // (Still the word under the pointer once it is known to be a file.)
        const now = out(document.elementFromPoint(last.x, last.y)), again = now ? wordAt(last.x, last.y, now) : null;
        if (!yes || again?.text !== w.text) { if (!yes) clear(); return; }
        at = {repo, ...named};
        CSS.highlights?.set('term-file', new Highlight(again.range));
        room.classList.add('term-linking');
      });
    };
    room.addEventListener('pointermove', (e) => {
      last = {x: e.clientX, y: e.clientY};
      if (!out(e.target)) { if (at) clear(); return; }
      frame ||= requestAnimationFrame(look);
    }, {passive: true});
    room.addEventListener('pointerleave', clear);
    room.addEventListener('click', (e) => {
      if (!at || !out(e.target) || getSelection()?.toString()) return;
      const {repo, path, line} = at;
      clear();
      this.ctx.openRepo(repo, path, false, undefined, line ? line - 1 : 0);
    });
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
    // (A file made with no file in hand is made as Shift+N makes it there: at the repo's top, with no ending.)
    const pop = fileDeeds({repo, path, name: path ? split(path)[1] : repo, dir: !path, like: '', head: `/root/${repo}${path ? `/${path}` : ''}`,
      made: (made, file) => { done(); if (file) this.made(repo, made); },
      move: async (to) => {
        if (to !== path) await store.move(repo, path, to);
        done();
        this.shut(repo, path);
        this.ctx.openRepo(repo, to);
      },
      removed: () => { done(); this.shut(repo, path); },
      back: () => {}});
    // A bar dropped from under the band (forge-desk.css .band-deeds), the desk making way under it in the same move:
    // nothing on the desk is under it, and it is put back as the bar goes.
    pop.classList.add('band-deeds');
    this.deedsOut = deedsUnder(at, pop, () => { this.deedsOut = null; this.center.style.removeProperty('--push'); });
    // A band's gap under the tool, as between the band's tools.
    pop.style.top = `${at.getBoundingClientRect().bottom + 8}px`;
    const room = this.center.getBoundingClientRect();
    this.center.style.setProperty('--push', `${Math.max(0, pop.getBoundingClientRect().bottom - room.top + 8)}px`);
  }

  /** The file in hand on `repo`'s desk ('' while a terminal is: the person's, or the Agent's). */
  private fileHeld(repo: string): string {
    const d = this.desks.get(repo), held = d?.desk.held;
    return held && d.files.has(held) ? held : '';
  }

  /** Shift+N: a new file made at once beside the box in hand (at the repo's top, with no ending, beside a terminal),
   * opened under it to write in, its name written over in its head. */
  private async newFile() {
    const repo = this.now.repo;
    if (!repo) return;
    const path = this.fileHeld(repo);
    this.made(repo, await untitled(repo, path ? split(path)[0] : '', path ? split(path)[1] : ''));
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

  /** The center as the desk shown has it: one screen, or two (a box put beside the desk: the desk the left half, the
   * box the right), the halves meeting on the dots' grid so the ground is one ground. */
  private split() {
    const d = this.now.repo ? this.desks.get(this.now.repo) : undefined;
    this.center.classList.toggle('split', !!d?.desk.beside);
    this.center.style.setProperty('--split', `${Math.round(this.center.clientWidth / 2 / GRID) * GRID}px`);
    for (const o of this.desks.values()) o.desk.side.hidden = o !== d || !o.desk.beside;
  }

  /** `repo`'s desk, made the first time. */
  private deskOf(repo: string): Laid {
    let d = this.desks.get(repo);
    if (!d) {
      const files = new Map<string, DeskFile>();
      let restoring = true;
      const desk = new Desk(t('Files in {name}', {name: repo}), repo, (key) => this.shut(repo, key), () => {
        if (this.now.repo === repo) this.split();
        if (restoring) return;
        kept(repo, desk);
        // The file in hand is the one Forge works on: File marks it (told once each time it is another).
        if (this.now.repo === repo && desk.held && desk.held !== 'agent' && desk.held !== this.told) {
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
      // As it was left: the boxes where they lay, the one in hand.
      const was = keptDesk(repo);
      // (The Agent's terminal is born again when it is asked again; a desk kept has none. One kept from when the
      // Prompt was a box of the desk has it too: left out, its column closed up.)
      const cols = (was?.cols ?? []).map((col) => col.filter((key) => key !== 'term' && key !== 'agent')).filter((col) => col.length);
      cols.forEach((col, c) => { for (const key of col) this.layFile(repo, d!, key, c); });
      if (was?.beside && desk.has(was.beside)) desk.putBeside(was.beside);
      if (was?.held && desk.has(was.held)) desk.take(was.held, false);
      // A desk never worked at: its README, to be read first.
      if (!was) {
        const laid = d;
        void store.read(repo, 'README.md').then((c) => {
          if (c.text === null || laid.files.has('README.md')) return;
          this.layFile(repo, laid, 'README.md', 0);
          if (!desk.held) desk.take('README.md', false);
        }).catch(() => {});
      }
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
    if (!d) return;
    d.files.get(key)?.drop();
    d.files.delete(key);
    d.desk.lift(key);
  }

  /** `path` of the repo worked on, a box on its desk (laid now if it was not), in hand; at `line`, the keyboard in it
   * (unless not `keyboard`). A file just made (`made`) is laid under the box in hand, as a new post goes under the one
   * before it. */
  private open(path: string, line = 0, made = false, keyboard = true) {
    const repo = this.now.repo;
    if (!repo || !path) return;
    const d = this.deskOf(repo);
    // Chosen from the band's search while its sheet is down, the desk out of sight under it: the camera is put where
    // the box is meanwhile, unseen, and the desk comes back already there as the sheet goes up.
    const unseen = !!this.element.querySelector('.band-tools > .search-box:is(:focus-within, .reading):not(.idle, .leaving)');
    // A file laid for the first time goes under the box in hand.
    const f = d.files.get(path) ?? this.layFile(repo, d, path, undefined, {slide: !unseen});
    // Made, it is not gone into yet: in hand, its name to be written, at the size it is read at (the camera does not
    // step back for it: stepped back, its words were some 10 px tall); Enter goes in.
    if (made) { d.desk.take(path, false, !unseen); return; }
    d.desk.take(path, keyboard, !unseen);
    if (keyboard) f.at(line);
  }

  /** `path` of the repo worked on, a box on its desk, laid if it was not, the hand left where it is. */
  private place(path: string): boolean {
    const repo = this.now.repo;
    if (!repo || !path) return false;
    const d = this.deskOf(repo);
    if (!d.files.has(path)) this.layFile(repo, d, path);
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
  show(name: string, path = '', write: Writing = false, line = 0, keyboard = true) {
    this.band.put(name);
    const d = this.deskOf(name);
    if (this.now.repo !== name) {
      this.now.repo = name;
      this.known = name;
      this.ctx.remember(name);
      this.work.setRepo(name);
      // Every desk stays in the page, those not worked at hidden: a text taken out of the page loses its Undo.
      this.center.querySelector('.desk-none')?.remove();
      if (!d.desk.element.isConnected) this.center.append(d.desk.element, d.desk.side);
      for (const o of this.desks.values()) o.desk.element.hidden = o !== d;
      this.split();
    }
    this.band.paint();
    if (path) {
      this.open(path, line, write === 'name', keyboard);
      if (write === 'name') d.desk.name(path);
    } else d.desk.relayout();
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
    if (d) { for (const f of d.files.values()) f.drop(); d.desk.element.remove(); d.desk.side.remove(); this.desks.delete(name); }
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
    for (const o of this.desks.values()) o.desk.element.hidden = o.desk.side.hidden = true;
    this.center.classList.remove('split');
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
    for (const name of [...this.desks.keys()]) if (!all.includes(name)) { const gone = this.desks.get(name)!.desk; gone.element.remove(); gone.side.remove(); this.desks.delete(name); }
    const asked = pending;
    pending = null;
    const chosen = ctx.repo !== this.known;
    this.known = ctx.repo;
    if (ctx.repo && all.includes(ctx.repo) && (asked || chosen)) {
      const at = asked ?? {path: '', write: false, line: 0, from: null};
      // Put on the rail or in a field while Forge was being drawn, the keyboard is left there: the repo is shown, not
      // gone into (where it was asked from is gone or still has it; the page, or nothing, has it on the way here).
      const now = document.activeElement;
      const elsewhere = !!asked && !!now && now !== asked.from && now !== document.body && !this.element.contains(now) && !now.contains(this.element);
      this.show(ctx.repo, at.path, at.write, at.line, !elsewhere && !termAsked);
      if (termAsked && !elsewhere) this.work.toPrompt();
      // Out under Forge's own files button once the page has come to rest (measured where it stands, not on the way).
      if (deedsAsked && !elsewhere) {
        const acts = this.work.tools?.querySelector<HTMLElement>('.band-acts'), root = document.documentElement;
        const out = () => { if (root.classList.contains('panning')) requestAnimationFrame(out); else if (acts) this.deeds(acts); };
        requestAnimationFrame(out);
      }
      termAsked = deedsAsked = false;
      return;
    }
    const open = this.now.repo && all.includes(this.now.repo) ? this.now.repo
      : ctx.repo && band.names.includes(ctx.repo) ? ctx.repo : band.names[0];
    if (open) this.show(open); else this.none();
  }
}

