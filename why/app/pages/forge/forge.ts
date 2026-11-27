import {currentLang, t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';
import {onChange, onRenamed, store} from '../../../repo/repos.ts';
import {bring, remoteOnly} from '../../../shipto/lifecycle.ts';
import type {Context} from '../kit/context.ts';
import {bench, type Bench} from '../bench/bench.ts';
import {openNext as openConversation} from '../kit/next.ts';
import type {Writing} from '../kit/context.ts';
import {showIssue} from '../git/git.ts';
import {Drag} from './drag.ts';
import {takeFiles} from './files-in.ts';
import {Desk} from './desk.ts';
import {deskFile, renameIn, type DeskFile} from './desk-file.ts';
import {asPath, isFile, wordAt} from './term-links.ts';
import {deedsUnder, fileDeeds, moveFile, renaming, split, untitled} from '../kit/file-deeds.ts';
import {openFolder} from './open-folder.ts';
import {deskSearch, workPlaces, type ForgePlace} from '../kit/places.ts';
import {pointerMenu, type BesideOption} from './document-menu.ts';
import {PromptPaper} from './prompt-paper.ts';
import '../../styles/forge-prompt.css';

/**
 * Forge owns each repo's retained document desk. Files and Prompt take a separate slot without changing
 * the document row; search and the shell's other routes are brought out only when asked for.
 * A repo is chosen explicitly, or restored if it is still available on this device.
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
/** A peer picked from Git's Places, for the next entry to the existing Forge desk. */
let placeAsked: ForgePlace | null = null;
export function placeNext(place: ForgePlace) { placeAsked = place; }
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

// A repo renamed (from its gear on Home or Runtime): its desk keeps its pieces, under the new name.
onRenamed((from, to) => {
  made?.renamed(from, to);
  try {
    const was = localStorage.getItem(KEPT + from);
    if (was !== null) { localStorage.setItem(KEPT + to, was); localStorage.removeItem(KEPT + from); }
  } catch { /* kept for this run only */ }
});

/** Forge's page: made once (again in another language), and come back to as it was left. */
export function forge(ctx: Context): Node[] {
  if (madeIn !== currentLang()) { made?.drop(); made = null; madeIn = currentLang(); }
  made ??= new Forge(ctx);
  made.enter();
  return [made.element];
}

export function closeFiles() { made?.filesClosed(); }
export function takeFilesPane() { made?.filesTaken(); }
export function leaveForge() { made?.away(); }
/** Files already opened in this workspace, with the one in hand first. */
export function searchPaths(repo: string): string[] { return made?.searchPaths(repo) ?? []; }

/** What a repo's desk is kept as, while the app is away: its files along the row (each a column of one: kept so since
 * the desk had columns), and the one in hand. */
interface Kept { cols: string[][]; held: string | null }
const KEPT = 'forge.desk.';

function keptDesk(repo: string): Kept | null {
  try { const k = JSON.parse(localStorage.getItem(KEPT + repo) ?? 'null') as Kept | null; return k && Array.isArray(k.cols) ? k : null; } catch { return null; }
}

function kept(repo: string, {desk, beside}: Laid) {
  const files = desk.row.filter((key) => key !== TERM && key !== AGENT && key !== BESIDE);
  const held = desk.held === BESIDE ? beside?.path ?? null : desk.held;
  try { localStorage.setItem(KEPT + repo, JSON.stringify({cols: files.map((key) => [key]), held})); } catch { /* kept for this run only */ }
}

/** The terminal's key on a desk, and the Agent's own terminal's. */
const TERM = 'term', AGENT = 'agent', BESIDE = '\0beside';

/** A repo's desk, and the files lying on it. */
interface Twin { path: string; file: DeskFile; closing: Promise<boolean> | null }
interface Laid { desk: Desk; files: Map<string, DeskFile>; beside: Twin | null }
interface PaperReturn {
  editor: HTMLTextAreaElement;
  value: string;
  from: number;
  to: number;
  direction: 'forward'|'backward'|'none';
  top: number;
  left: number;
  port: HTMLElement | null;
  scroll: number;
  desk: HTMLElement | null;
  turned: number;
}

function returnTo(editor: HTMLTextAreaElement): PaperReturn {
  const port=editor.closest<HTMLElement>('.desk-file'), desk=editor.closest<HTMLElement>('.desk');
  return {editor,value:editor.value,from:editor.selectionStart,to:editor.selectionEnd,direction:editor.selectionDirection,
    top:editor.scrollTop,left:editor.scrollLeft,port,scroll:port?.scrollTop??0,desk,turned:desk?.scrollLeft??0};
}

/** The page, its parts put together: the desk of each repo worked on here, and the one on screen. */
class Forge {
  readonly element: HTMLElement;
  private work: Bench;
  /** The repo worked on (the Prompt's, the desk on screen). */
  private now: {repo: string | null} = {repo: null};
  private readonly switcher: ReturnType<typeof workPlaces>;
  private readonly promptPaper: PromptPaper;
  private get prompt() { return this.promptPaper.element; }
  private lastEditor: HTMLTextAreaElement | null = null;
  private paperReturn: PaperReturn | null = null;
  private paperMoved = false;
  private placeInHand: ForgePlace = 'Forge';
  private folderOut: (() => void) | null = null;
  private startOut: (() => void) | null = null;
  private readonly listening = new AbortController();
  private visits = 0;
  private desks = new Map<string, Laid>();
  private center: HTMLElement;
  /** The files button's deeds while they are out: the way to put them away. */
  private deedsOut: (() => void) | null = null;
  /** The repo worked on as Forge last knew it: chosen anew elsewhere (Git, Home, File), Forge follows. */
  private known: string | null;
  private offChange: () => void;
  private offKeys: () => void;
  /** The file last told as the one Forge works on. */
  private told: string | null = null;
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.center = h('div', {class: 'desk-room'});
    this.work = bench({main: this.center, desk: true, reveal: (path, line, write) => this.revealAt(path, line, write),
      place: (path) => this.place(path), frame: (keys) => { if (this.now.repo) this.deskOf(this.now.repo).desk.frame(keys); },
      revealPrompt: () => this.promptWindow(true, false),
      promptVisible: () => !this.prompt.hidden && this.center.dataset.hand === 'Prompt',
      termAway: () => {
        if (this.prompt.hidden) return false;
        this.promptWindow(false, true); return true;
      },
      word: (a) => { openConversation(a); void ctx.go('inbox'); },
      besideTerm: (repo, element) => {
        // The Agent's own terminal is a piece of the desk, laid after the one in hand.
        const {desk} = this.deskOf(repo);
        if (!desk.has(AGENT)) desk.lay(AGENT, {element, name: 'agent', dir: '', after: `/root/${repo}`, kind: 'agent', focus: () => element.focus({preventScroll: true})});
      },
      went: (repo, to) => {
        if (to !== 'todo' && 'file' in to) { ctx.openRepo(repo, to.file); return; }
        if (to !== 'todo') showIssue(repo, to.issue);
        void ctx.go(to === 'todo' ? 'home' : 'git');
      }});
    this.element = this.work.element;
    this.element.classList.add('forge-layout');
    this.element.prepend(h('h1', {class: 'forge-title'}));
    this.switcher = workPlaces(this.element, (place) => {
      if (place === 'Git') void ctx.go('git');
      else if (place === 'Prompt') this.promptWindow(!!this.prompt.hidden,true);
      else this.selectPlace(place);
    }, () => ctx.placeCommands?.(['forge']) ?? [], deskSearch(ctx, () => this.now.repo));
    this.switcher.set('Forge', false);
    this.promptPaper = new PromptPaper(this.center,this.work,()=>this.promptWindow(false,true));
    this.prompt.addEventListener('focusin', () => this.hand('Prompt'));
    this.prompt.addEventListener('pointerdown', () => this.hand('Prompt'));
    this.center.addEventListener('focusin', (e) => {
      if ((e.target as Element | null)?.closest('.desk-file')) {
        this.hand('Forge');
        if (e.target instanceof HTMLTextAreaElement) this.lastEditor = e.target;
      }
    });
    // A body-mounted menu can borrow and return focus without changing a document's place.
    // Only actually working in a paper updates where the tool returns.
    const moved = (event: Event) => {
      if (!this.prompt.hidden && event.target instanceof Element && event.target.closest('.desk-file'))
        this.paperMoved = true;
    };
    this.center.addEventListener('input', moved);
    this.center.addEventListener('wheel', moved, {passive: true});
    this.center.addEventListener('pointerdown', (e) => { if (e.button === 0) moved(e); });
    this.center.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) moved(e);
    });
    this.center.addEventListener('focusout', (e) => {
      if (this.paperMoved && !this.prompt.hidden && e.target instanceof HTMLTextAreaElement && e.target.closest('.desk-file')) {
        this.paperReturn = returnTo(e.target);
        this.paperMoved = false;
      }
    });
    const drag = new Drag(this.center);
    this.termLinks();
    // Files from the desktop let go over a piece: into its folder (none written over), the first opened.
    takeFiles(this.center, drag, (repo, path) => this.show(repo, path));
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
  }

  /**
   * A file named in a terminal's output on the desk (`ls`, the compiler's `count.c:7:24:`, grep's): underlined under the
   * pointer, and pressed, its box opened at that line (term-links.ts). A press that chose words chose them: nothing opens.
   */
  private termLinks() {
    let at: {repo: string; path: string; line: number; output: Element; text: string} | null = null;
    let frame = 0, last = {x: 0, y: 0};
    const out = (t: EventTarget | null) => (t as Element | null)?.closest?.(':is(.desk-box, .desk-term) .term-out') ?? null;
    // The Prompt and its document targets share the center but not its scrolling row.
    const room = this.center.parentElement ?? this.center;
    const clear = () => { at = null; CSS.highlights?.delete('term-file'); room.classList.remove('term-linking'); };
    const look = () => {
      frame = 0;
      const repo = this.now.repo, el = out(document.elementFromPoint(last.x, last.y));
      const w = el && repo ? wordAt(last.x, last.y, el) : null;
      const named = w && repo ? asPath(w.text, repo) : null;
      if (!w || !named || !repo || !el || this.prompt.hidden) { clear(); return; }
      void isFile(repo, named.path).then((yes) => {
        // (Still the word under the pointer once it is known to be a file.)
        const now = out(document.elementFromPoint(last.x, last.y)), again = now ? wordAt(last.x, last.y, now) : null;
        if (!yes || this.now.repo !== repo || this.prompt.hidden || now !== el || again?.text !== w.text) return;
        at = {repo, ...named, output: el, text: w.text};
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
      if (!at || at.repo !== this.now.repo || this.prompt.hidden || out(e.target) !== at.output || getSelection()?.toString()) return;
      if (wordAt(e.clientX, e.clientY, at.output)?.text !== at.text) { clear(); return; }
      const {repo, path, line} = at;
      clear();
      this.ctx.openRepo(repo, path, false, undefined, line ? line - 1 : 0);
    });
  }

  /** Made again (another language): it no longer follows the store or the Remote. */
  drop() {
    this.away();
    this.promptPaper.drop(); this.work.drop();
    this.listening.abort();
    this.switcher.drop();
    this.offChange();
    this.offKeys();
    for (const d of this.desks.values()) {
      d.beside?.file.drop();
      for (const f of d.files.values()) f.drop();
    }
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
        await moveFile(repo, path, to);
        done();
        this.shut(repo, path);
        this.ctx.openRepo(repo, to);
      },
      removed: () => { done(); this.shut(repo, path); },
      reverted: done,
      back: () => {}});
    this.deedsOut = deedsUnder(at, pop, () => { this.deedsOut = null; });
  }

  /** The file in hand on `repo`'s desk ('' while a terminal is: the person's, or the Agent's). */
  private fileHeld(repo: string): string {
    const d = this.desks.get(repo), held = d?.desk.held;
    return held === BESIDE ? d?.beside?.path ?? '' : held && d?.files.has(held) ? held : '';
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
    if (d.beside?.path === from) this.forgetBeside(d);
    const f = this.layFile(repo, d, to, {instead: from});
    d.files.get(from)?.drop();
    d.files.delete(from);
    return f;
  }

  searchPaths(repo: string): string[] {
    const laid = this.desks.get(repo);
    if (!laid) return [];
    const {desk, beside, files} = laid;
    const held = desk.held === BESIDE ? beside?.path : desk.held;
    return [...new Set([...(held ? [held] : []), ...desk.row])].filter(path => files.has(path));
  }

  private visible() { return this.element.isConnected && !this.element.closest('[hidden]'); }

  private hand(place: ForgePlace) {
    this.center.dataset.hand = place;
    this.prompt.classList.toggle('held', place === 'Prompt');
  }

  /** Prompt expands the tool, not a new place, and takes no command when opened. */
  private promptWindow(open: boolean, focus: boolean) {
    const repo=this.now.repo;
    if(!repo)return;
    if(open) {
      if(this.prompt.hidden) {
        if(this.placeInHand==='Files')this.selectPlace('Forge',false);
        const field=this.lastEditor;
        this.paperReturn=field?.isConnected&&!field.closest('[hidden]')?returnTo(field):null;
        this.paperMoved=false;
        this.promptPaper.show();
      }
      this.hand('Prompt');
      if(focus){
        this.work.showPrompt();
        if(!this.prompt.contains(document.activeElement))this.prompt.querySelector<HTMLElement>('.desk-term:not([hidden]) .term-end .power')?.focus({preventScroll:true});
      }
      return;
    }
    if(this.prompt.hidden)return;
    const active = document.activeElement;
    const saved = this.paperMoved && active instanceof HTMLTextAreaElement && active.closest('.desk-file') ? returnTo(active) : this.paperReturn;
    this.paperReturn=null;this.paperMoved=false;this.promptPaper.hide();this.hand(this.placeInHand);
    if(!focus)return;
    if(saved?.editor.isConnected && !saved.editor.closest('[hidden]')) {
      const {editor}=saved;
      editor.focus({preventScroll:true});
      if(editor.value===saved.value)editor.setSelectionRange(saved.from,saved.to,saved.direction);
      editor.scrollTop=saved.top;editor.scrollLeft=saved.left;
      const desk = this.desks.get(repo)?.desk;
      if (desk?.element === saved.desk) desk.restoreTurn(saved.turned);
      if (saved.port) saved.port.scrollTop = saved.scroll;
    } else this.deskOf(repo).desk.focusHeld();
  }

  private selectPlace(place: ForgePlace, focus = true) {
    const repo=this.now.repo;
    if(!repo)return;
    if(place==='Prompt'){this.promptWindow(true,focus);return;}
    if(place==='Files')this.promptWindow(false,false);
    this.placeInHand=place;
    this.center.dataset.place=place;
    this.switcher.set(place,true);
    this.hand(place);
    this.ctx.forgeFiles?.(place==='Files'?repo:null,focus);
    if(focus&&place==='Forge')this.deskOf(repo).desk.focusHeld();
  }

  private closeStart() {
    this.startOut?.(); this.startOut = null;
  }

  private folders(anchor: HTMLElement) {
    this.folderOut?.();
    const repo = this.now.repo, visit = this.visits;
    const allowed = () => this.visible() && this.now.repo === repo && this.visits === visit;
    this.folderOut = openFolder({anchor, root: document.body,
      storeNames: () => store.names(), remoteNames: () => remoteOnly().map((r) => r.name), bring,
      open: (name) => {
        this.ctx.openRepo(name);
        if (this.now.repo !== name) return false;
        this.selectPlace('Files');
        return true;
      },
      create: () => void this.ctx.go('new-repo'), allowed,
    });
  }

  filesClosed() { if (this.placeInHand === 'Files') this.selectPlace('Forge'); }
  filesTaken() { if (this.placeInHand === 'Files') this.hand('Files'); }

  away() {
    this.promptPaper.dismiss(); this.work.rememberTerminal();
    ++this.visits;
    this.closeStart(); this.folderOut?.(); this.folderOut = null;
    this.deedsOut?.();
    this.switcher.close();
    this.ctx.forgeFiles?.(null);
  }

  /** `repo`'s desk, made the first time. */
  private deskOf(repo: string): Laid {
    let d = this.desks.get(repo);
    if (!d) {
      const files = new Map<string, DeskFile>();
      let restoring = true;
      const name = () => desk.element.dataset.repo!;
      const desk = new Desk(t('Files in {name}', {name: repo}), repo, (key) => void this.closeFile(name(), key), () => {
        if (restoring) return;
        const current = name(), laid = this.desks.get(current);
        if (!laid) return;
        kept(current, laid);
        const path = this.fileHeld(current);
        // The file in hand is the one Forge works on: File marks it (told once each time it is another).
        if (this.now.repo === current && path && path !== this.told) {
          this.told = path;
          this.ctx.reading(path);
          this.ctx.leftAt(current, path, 0);
        }
      });
      d = {desk, files, beside: null};
      this.desks.set(repo, d);
      // Written in a box: where the person left off (Home says the line) is where its caret is.
      desk.element.addEventListener('input', (e) => {
        const area = e.target as HTMLTextAreaElement;
        const path = area.closest<HTMLElement>('.desk-file')?.dataset.path;
        if (path && area.selectionStart !== undefined) this.ctx.leftAt(name(), path, area.selectionStart);
      });
      // As it was left: the files along the row, the one in hand.
      const was = keptDesk(repo);
      // (The terminal is the bench's own, laid as the desk comes on screen; the Agent's is born again when it is asked
      // again. A desk kept in columns is laid as a row, column by column.)
      for (const key of (was?.cols ?? []).flat()) if (key !== TERM && key !== AGENT && key !== BESIDE && !d.files.has(key)) this.layFile(repo, d, key, {at: Infinity});
      if (was?.held && desk.has(was.held)) desk.take(was.held, false);
      // A desk never worked at: its README, to be read first.
      if (!was) {
        const laid = d;
        void store.read(repo, 'README.md').then((c) => {
          if (c.text === null || laid.files.has('README.md')) return;
          this.layFile(repo, laid, 'README.md', {at: Infinity});
          if (!desk.held) desk.take('README.md', false);
        }).catch(() => {});
      }
      restoring = false;
    }
    return d;
  }

  /** `path` of `repo` laid on its desk `d` as a sheet (after the piece in hand, unless `how` says where). */
  private layFile(repo: string, d: Laid, path: string, how: {at?: number; instead?: string} = {}): DeskFile {
    const f = deskFile(repo, path, () => d.desk.relayout(), (name) => renameIn(name, path, async (from, written) => {
      const repo = d.desk.element.dataset.repo!;
      const to = await renaming(repo, from, written);
      if (to === from) return;
      await moveFile(repo, from, to);
      // Named, it is written in: the box where it lay, the keyboard going on from its name into it, at its end.
      this.moved(repo, from, to)?.toEnd();
    }, () => f.toEnd()), {
      beside: () => this.besideOption(d, path),
      readOnly: () => { if (d.beside?.path === path) this.forgetBeside(d); },
    });
    d.files.set(path, f);
    d.desk.lay(path, f, how);
    return f;
  }

  private besideOption(d: Laid, path: string): BesideOption | null {
    if (this.placeInHand !== 'Forge' || this.now.repo === null || this.desks.get(this.now.repo) !== d
      || d.desk.row.find((key) => d.files.has(key)) !== path) return null;
    return {checked: d.beside?.path === path, toggle: (ownsFocus) => this.toggleBeside(d, path, ownsFocus)};
  }

  private async toggleBeside(d: Laid, path: string, ownsFocus: () => boolean): Promise<boolean> {
    const first = d.files.get(path);
    if (!first || !this.besideOption(d, path)) return false;
    const open = d.beside;
    if (open) {
      if (open.path !== path) return false;
      return open.closing ??= (async () => {
        try {
          if (!await first.flush()) return false;
          if (d.beside !== open) return true;
          const back = ownsFocus() && this.visible() && this.besideOption(d, path) !== null;
          this.forgetBeside(d);
          if (back) d.desk.take(path, true, false, true);
          return true;
        } finally { open.closing = null; }
      })();
    }
    const twin = first.beside(() => d.desk.relayout());
    if (!twin) return false;
    d.beside = {path, file: twin, closing: null};
    d.desk.lay(BESIDE, {...twin, companion: true}, {after: path});
    // Wide: the original paper does not move. Narrow: the same desk looks along to the second paper.
    d.desk.take(BESIDE, true, false, true);
    return true;
  }

  private forgetBeside(d: Laid) {
    const view = d.beside;
    if (!view) return;
    d.beside = null;
    view.file.drop();
    d.desk.lift(BESIDE, false);
  }

  private async closeFile(repo: string, key: string) {
    const file = this.desks.get(repo)?.files.get(key);
    if (file && await file.flush() && this.desks.get(repo)?.files.get(key) === file) {
      this.shut(repo, key, this.now.repo === repo && this.visible() && this.placeInHand === 'Forge');
    }
  }

  /** A file's box taken off the desk (its close, or the file gone); the Prompt's stays. */
  private shut(repo: string, key: string, focus = true) {
    const d = this.desks.get(repo);
    if (!d) return;
    if (d.beside?.path === key) this.forgetBeside(d);
    d.files.get(key)?.drop();
    d.files.delete(key);
    d.desk.lift(key, focus);
  }

  /** `path` of the repo worked on, a box on its desk (laid now if it was not), in hand; at `line`, the keyboard in it
   * (unless not `keyboard`). A file just made (`made`) is laid under the box in hand, as a new post goes under the one
   * before it. */
  private open(path: string, line = 0, write: Writing = false, keyboard = true) {
    const repo = this.now.repo;
    if (!repo || !path) return;
    const d = this.deskOf(repo);
    const kept = d.files.get(path);
    // Files takes the paper back into the hand, not to the top of a paper already being worked on.
    const resume = this.placeInHand === 'Files' && write === true && line === 0 && kept?.hasEditor;
    if (this.placeInHand !== 'Forge' && matchMedia('(max-width: 1000px)').matches) this.selectPlace('Forge', false);
    else if (keyboard) this.hand('Forge');
    // Chosen from the band's search while its sheet is down, the desk out of sight under it: the camera is put where
    // the box is meanwhile, unseen, and the desk comes back already there as the sheet goes up.
    const unseen = !!this.element.querySelector('.band-tools > .search-box:is(:focus-within, .reading):not(.idle, .leaving)');
    // A file laid for the first time goes under the box in hand.
    const f = kept ?? this.layFile(repo, d, path);
    // Made, it is not gone into yet: in hand, its name to be written, at the size it is read at (the camera does not
    // step back for it: stepped back, its words were some 10 px tall); Enter goes in.
    if (write === 'name') { d.desk.take(path, false, !unseen); return; }
    d.desk.take(path, keyboard, !unseen);
    if (!keyboard || resume) return;
    if (typeof write === 'object') {
      f.toOffset(write.at);
      this.ctx.leftAt(repo, path, write.at);
    } else if (write === 'end') f.toEnd();
    else f.at(line);
  }

  /** `path` of the repo worked on, a box on its desk, laid if it was not, the hand left where it is. */
  private place(path: string): boolean {
    const repo = this.now.repo;
    if (!repo || !path) return false;
    const d = this.deskOf(repo);
    if (!d.files.has(path)) this.layFile(repo, d, path);
    return true;
  }

  /** Renamed: its desk under its new name. */
  renamed(from: string, to: string) {
    const d = this.desks.get(from);
    if (d) {
      this.desks.delete(from);
      this.desks.set(to, d);
      d.desk.renamed(t('Files in {name}', {name: to}), to);
      for (const f of d.files.values()) f.renameRepo(to);
      d.beside?.file.renameRepo(to);
    }
    if (this.now.repo === from) {
      this.now.repo = to;
      this.work.setRepo(to);
      this.promptPaper.refresh();
    }
    if (this.known === from) this.known = to;
  }

  /** Show `name`'s desk in the center; at `path` if given (a sheet for it, at `line`; a
   * file just made, `write` 'name', its name written over first). */
  show(name: string, path = '', write: Writing = false, line = 0, keyboard = true) {
    const d = this.deskOf(name);
    if (this.now.repo !== name) {
      this.promptWindow(false,false);
      this.lastEditor=null;
      ++this.visits;
      this.now.repo = name;
      this.placeInHand = 'Forge';
      this.known = name;
      this.ctx.remember(name);
      this.work.setRepo(name);
      this.promptPaper.refresh();
      // Every desk stays in the page, those not worked at hidden: a text taken out of the page loses its Undo.
      this.center.querySelector('.desk-none')?.remove();
      if (!d.desk.element.isConnected) this.center.append(d.desk.element);
      for (const o of this.desks.values()) o.desk.element.hidden = o !== d;
    }
    this.closeStart();
    this.selectPlace(this.placeInHand, false);
    if (path) {
      this.open(path, line, write, keyboard);
      if (write === 'name') d.desk.name(path);
    } else d.desk.relayout();
  }

  /** A place asked for in the repo worked on: its file's box, in hand, at `line`. */
  private revealAt(path: string, line = 0, _write: Writing = false) {
    if (this.now.repo) this.open(path, line);
  }

  /** No selected repo: a visible first move and the same action from the bare desk. */
  private none() {
    this.now.repo = null;
    this.work.setRepo(null);
    this.promptPaper.hide();
    this.center.dataset.place = 'Forge';
    this.hand('Forge');
    this.switcher.set('Forge', false);
    this.ctx.forgeFiles?.(null);
    for (const o of this.desks.values()) o.desk.element.hidden = true;
    if (this.center.querySelector('.desk-none')) return;
    const first = h('button', {type: 'button', class: 'forge-open-folder'}, t('Open Folder')) as HTMLButtonElement;
    const empty = h('div', {class: 'desk-none forge-empty'}, first);
    first.addEventListener('click', () => { this.closeStart(); this.folders(first); });
    const start = (left: number, top: number) => {
      this.closeStart();
      this.startOut = pointerMenu({x: left, y: top}, t('Workspace'), () => !this.now.repo && empty.isConnected && this.visible(),
        () => first.focus({preventScroll: true}), (menu) => {
          menu.item(t('Open Folder'), () => { this.closeStart(); this.folders(first); });
        }, {firstFocus: true});
    };
    empty.addEventListener('contextmenu', (e) => { e.preventDefault(); start(e.clientX, e.clientY); });
    first.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault(); const r = first.getBoundingClientRect(); start(r.left, r.bottom);
    });
    this.center.append(empty);
  }

  /** Come back to the same opened repo; do not silently choose another on a bare desk. */
  enter() {
    this.work.settle();
    const visit = ++this.visits, place = placeAsked;
    placeAsked = null;
    void store.names().then((repos) => { if (visit === this.visits) this.choose(repos, place); }, () => {
      if (visit === this.visits && !this.now.repo) this.none();
    });
  }

  /** The repos here are `all`: the desks of those still here are kept, and one of them is worked on. */
  private choose(all: string[], place: ForgePlace | null) {
    const {ctx} = this;
    for (const name of [...this.desks.keys()]) if (!all.includes(name)) {
      const gone = this.desks.get(name)!;
      gone.beside?.file.drop();
      for (const f of gone.files.values()) f.drop();
      gone.desk.element.remove();
      this.desks.delete(name);
      if (this.now.repo === name) this.now.repo = null;
    }
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
      if (place) this.selectPlace(place, !elsewhere);
      else if (termAsked && !elsewhere) this.work.toPrompt();
      // Out under Forge's own files button once the page has come to rest (measured where it stands, not on the way).
      if (deedsAsked && !elsewhere) {
        const root = document.documentElement, visit = this.visits, repo = ctx.repo;
        const out = () => {
          if (visit !== this.visits || this.now.repo !== repo || !this.visible()) return;
          if (root.classList.contains('panning')) requestAnimationFrame(out); else this.deeds(this.switcher.key);
        };
        requestAnimationFrame(out);
      }
      termAsked = deedsAsked = false;
      return;
    }
    const open = this.now.repo && all.includes(this.now.repo) ? this.now.repo : ctx.repo && all.includes(ctx.repo) ? ctx.repo : undefined;
    if (!open) { this.none(); return; }
    this.show(open);
    if (place) this.selectPlace(place);
  }
}

