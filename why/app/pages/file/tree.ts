import {ForgeFileIndex} from './forge-index.ts';
import {keepAtRow} from '../../ui/on-grid.ts';
import {keepNear} from '../../ui/near.ts';
import {h} from '../../ui/dom.ts';
import {bytes} from '../../../text/format.ts';
import {closeUp, keepOut, nudge, putAway, unfold} from '../../ui/glide.ts';
import {t} from '../../../text/i18n.ts';
import {mark} from '../../ui/icons.ts';
import {scrollMarks} from '../../ui/scroll-marks.ts';
import {pageVeil} from '../../ui/page-veil.ts';
import {bring, remoteOnly} from '../../../shipto/lifecycle.ts';
import {onChange} from '../../../repo/repos.ts';
import {shownName} from '../../../repo/issues.ts';
import {inRepo, list, ORIGIN_LABEL, type SystemEntry} from '../../../prompt/system.ts';
import {fileDeeds, fileDeleteAsk, joined, moveFile, renaming, split, type Deeds} from '../kit/file-deeds.ts';
import type {Writing} from '../kit/context.ts';
import {errorText} from '../../../api/errors.ts';

// File is an operation, not a page: the tree of "/", the whole system, as a
// card laid over whatever page is showing, right beside the rail and only as
// tall as what is in it. It is called up in front of the world by pressing
// File, and by nothing else: a pointer over File or over the tree brings
// nothing out and puts nothing away, so it is the one thing on a phone, with
// a mouse and from the keyboard. Out, it stays until it is put away: File
// pressed again, a press outside it, or Escape, whatever has the keyboard.
// Nothing under it moves.
// (Before: a rest on File brought it out after a wait, it lingered a while
// after the pointer left, a shorter while if the pointer had not been in it,
// and a press pinned it; four states and three waits to say which.) A folder's
// triangle comes before its name: ▷ closed, ▽ open. A file chosen is the one
// to work on: the tree goes and the caret is in it. The file Forge is
// reading keeps a quiet mark, apart from what the pointer is over. From the
// keyboard it is a tree: ↑ ↓ go along the names, → opens a folder or goes
// into it, ← closes it or goes up to its folder, Enter chooses; where the
// pointer is changes none of it.
//
// Inside a repo each row has what can be done to it at its right end (shown
// on the row under the pointer or the keyboard; also a right press, or the
// menu key): a menu laid beside the tree, as the person's menu is. A folder
// (the repo's own row too) takes a new file or folder, and a file one beside
// it in its folder; a file or folder takes a new name (a path in the repo
// moves it) or is deleted. A row pressed becomes the field or the ask in its
// place; a new file is the one to work on, so the tree goes and the caret is
// in it. A row taken by the pointer and let go on a folder of its repo (or on
// the repo's own row) moves into it.

/** Open folders by absolute path, kept while the app runs; System (the rest of /) by a name no path has. */
const expandedPaths = new Set<string>(['/root']);
const SYSTEM = '/:system';

interface FileTreeEvents {
  /** A repo or a path inside one was chosen; path '' is the repo itself. `file` when it is a file (how it is written in). */
  choose(repo: string, path: string, file: Writing): void;
  /** The repo Forge shows, marked in the tree. */
  current(): string | null;
  /** The file Forge is reading in that repo, marked too. */
  currentFile(): string | null;
  closedDesk?(): void;
}

/** One outlined triangle pointing down; CSS turns it to point right while closed. */
export function triangle(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 3.5h8L6 9.5z');
  svg.append(path);
  return svg;
}

const note = (text: string, depth: number) => h('li', {class: 'tree-note muted', style: `--depth:${depth}`}, text);
/** How long a shut folder under a row being carried waits before it opens, to be gone into. */
const SPRING = 650;

export class FileTree {
  readonly element: HTMLElement;
  private root: HTMLElement;
  private events: FileTreeEvents;
  private trigger: HTMLElement | null = null;
  private calledFrom: HTMLElement | null = null;
  private deskRepo: string | null = null;
  private building = 0;
  /** The menu of one row, while it is out, and the row's name to go back to. */
  private pop: {element: HTMLElement; name: HTMLElement; more: HTMLElement; cleanup?: () => void; inline?: boolean} | null = null;
  /** Each folder's way to be read again, open, by its row. */
  private folders = new WeakMap<HTMLElement, () => Promise<void>>();
  /** A row being carried by the pointer, to be let go on a folder of its repo. */
  private carried: {repo: string; path: string} | null = null;
  /** What a move by the pointer could not do, said at the tree's foot until it comes out again. */
  private said = h('p', {class: 'error small tree-said', role: 'alert'});
  /** The page under the tree, out of focus while it is out (ui/page-veil.ts). */
  private veil = pageVeil('thin');
  /** Folders being read now, and who waits until none is. */
  private reading = 0;
  private read: (() => void)[] = [];
  private readonly index: ForgeFileIndex;
  private indexDirty = false;
  private indexRefresh = 0;
  private get onIndex() { return this.element.hasAttribute('data-forge-index'); }

  constructor(events: FileTreeEvents) {
    this.events = events;
    this.root = h('ul', {class: 'tree-children', role: 'tree', 'aria-label': '/'});
    // A sheet of paper named "/" over its corner (styles: .tree::before), as a file's sheet is named on the desk; its
    // rows are what is in "/", scrolled inside it where they are more than the window is tall.
    this.element = h('nav', {class: 'tree file-tree', id: 'file-tree', 'aria-label': 'File（/）'}, this.root, this.said);
    this.index = new ForgeFileIndex(this.root, {
      actions: (row, name, entry, at, dir, disclose) => this.deeds(row, name, entry, at, dir, disclose),
      carry: (row, at, into) => { this.carries(row, at); if (into) this.takes(row, at, into); },
      open: (name, at) => this.fileName(name, at),
      dismiss: () => this.unpop(true),
      say: text => { this.said.textContent = text; },
      replace: (contents, back) => {
        const active = document.activeElement;
        const menu = this.pop && contents.contains(this.pop.name) ? this.pop : null;
        if (back && (contents.contains(active) || menu?.element.contains(active))) back.focus({preventScroll: true});
        if (menu) this.unpop(true);
      },
    });
    const close = h('button', {type: 'button', class: 'tree-desk-close', hidden: ''}, t('Close')) as HTMLButtonElement;
    close.addEventListener('click', () => this.close());
    this.element.append(close);
    this.deskClose = close;
    scrollMarks(this.element);
    // What it holds is read while nothing else is being done, so the first press brings it out whole at once (read
    // then, it came a fifth of a second after the press, the world already going out of focus behind nothing).
    const early = () => { if (!this.root.querySelector('.tree-name')) void this.build(); };
    if ('requestIdleCallback' in window) requestIdleCallback(early, {timeout: 4000}); else setTimeout(early, 1500);
    // And read again while it is put away whenever a repo comes or goes, so it comes out as things are (not as they
    // were, a row coming in a moment after it is out).
    let again = 0;
    onChange((c) => {
      if (this.onIndex && c.repo === this.deskRepo) {
        const absolute = `/root/${c.repo}/${c.path}`;
        if (c.what === 'removed' && c.to !== undefined) this.index.moved(c.repo, c.path, c.to, false);
        // A write to a name already seen changes no row. Refresh only branches we actually read.
        if (c.what === 'repo' || this.index.sees(absolute) && (c.what === 'removed' || !this.index.knows(absolute))) {
          this.indexDirty = true;
          this.refreshIndex();
        }
      }
      if (c.what !== 'repo' || this.isOpen) return;
      clearTimeout(again);
      again = window.setTimeout(() => { if (!this.isOpen) void this.build(); }, 400);
    });
    // Escape closes it from anywhere while it is out, before what has the keyboard
    // hears it (so the text being written keeps its caret); the keyboard goes back
    // to File only when it was in the tree or on File.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing || !this.isOpen) return;
      // The docked tree does not own Escape in the document, switcher or other overlays.
      if (this.onDesk && !this.element.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      // The topmost first: a row's menu goes, and the keyboard back to its row.
      if (this.pop) {
        const reading = this.onIndex && this.pop.element.hasAttribute('data-reading-revert');
        if (this.pop.element.hasAttribute('aria-busy') && !reading) return;
        const back = this.pop.name;
        this.unpop(this.onIndex); back.focus({preventScroll: true}); return;
      }
      if (this.onIndex) { this.events.closedDesk?.(); return; }
      const at = document.activeElement, origin = this.calledFrom ?? this.trigger;
      const back = !!at && (this.element.contains(at) || at === origin);
      this.close();
      if (back && origin?.isConnected) origin.focus({preventScroll: true});
    }, true);
    this.element.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if (!this.onDesk && to && !this.element.contains(to) && to !== (this.calledFrom ?? this.trigger)) this.close();
    });
    this.element.addEventListener('keydown', (event) => this.step(event));
    keepNear(() => (!this.isOpen ? null : this.pop && !this.pop.inline ? this.pop.element : this.onDesk ? null : this.element));
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.element.contains(at) && !(this.calledFrom ?? this.trigger)?.contains(at)) {
        if (this.onDesk) this.unpop(); else this.close();
      }
      else if (this.pop && !this.pop.element.contains(at) && !this.pop.more.contains(at)) this.unpop();
    });
  }

  /** Called up and being read for the first time: out as soon as what it holds is read. */
  private coming = false;
  private deskClose: HTMLButtonElement;

  get onDesk() { return this.deskRepo !== null; }

  /** The same File owner, presented as the open repo's Files sheet, not a veil over the editor. */
  openDesk(repo: string, focus = false, index = false) {
    const focusName = () => (this.root.querySelector<HTMLElement>('.tree-name[aria-current="location"]')
      ?? this.root.querySelector<HTMLElement>('.tree-name'))?.focus({preventScroll: true});
    if (this.deskRepo === repo && index === this.onIndex && this.isOpen) {
      if (focus) focusName();
      return;
    }
    if (this.deskRepo !== repo) {
      this.close(false);
      this.deskRepo = repo;
      this.root.setAttribute('aria-label', repo);
      this.element.setAttribute('aria-label', t('Files in {name}', {name: repo}));
      this.element.classList.add('on-forge-desk', 'open', 'settled');
      this.deskClose.hidden = false;
      this.root.replaceChildren(note(t('Loading…'), 0));
    }
    this.unpop(true);
    this.element.toggleAttribute('data-forge-index', index);
    if (!index) this.index.close();
    const asking = document.activeElement;
    const drawn = this.build(), generation = this.building;
    void drawn.then(() => {
      const current = document.activeElement;
      if (focus && generation === this.building && this.deskRepo === repo && this.isOpen &&
        (current === asking || !current || current === document.body || current.closest('[hidden]') || this.element.contains(current))) focusName();
    });
  }

  closeDesk() { if (this.onDesk) this.close(false); }

  get isOpen() { return this.coming || this.element.classList.contains('open'); }

  /** File's button: pressed, the tree is out in front (the keyboard in it if a key pressed it); pressed again, it goes. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'file-tree');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (event) => {
      if (this.onDesk) { this.close(); this.open(event.detail === 0); }
      else if (this.isOpen) this.close(); else this.open(event.detail === 0);
    });
    // → from File goes into the tree, out at its right (brought out first if it was not): ↓ and ↑ stay the rail's.
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!this.isOpen) { this.open(true); return; }
      [...this.root.querySelectorAll<HTMLElement>('.tree-name')].find((b) => b.getClientRects().length > 0)?.focus();
    });
  }

  open(focus = false, from?: HTMLElement) {
    if (from && this.isOpen && this.calledFrom !== from) this.close();
    if (!this.isOpen) {
      this.calledFrom = from ?? null;
      // Its top a cell under the File icon's: its name, over its corner, starts level with the icon's place; on the
      // grid line nearest that, as every sheet's edge is (DESIGN §3, whole cells: the places stand at 6 + 48n).
      const at = (this.calledFrom ?? this.trigger)?.getBoundingClientRect();
      if (at) {
        const cell = parseFloat(getComputedStyle(this.element).getPropertyValue('--u')) || 24;
        // (And never so low that it is cut by the window's foot: at least twelve cells of it are in the window.)
        this.element.style.setProperty('--tree-top', `${Math.max(2 * cell, Math.min(cell * Math.round((at.top + cell) / cell), cell * Math.floor((innerHeight - 12 * cell) / cell)))}px`);
      }
      const built = this.build();
      // The keyboard on its first row once it is out: a repo's, once /root is read (its own row is not shown, and
      // until then the only row there is System's).
      if (focus) void built.then(() => queueMicrotask(() => { if (this.isOpen) [...this.root.querySelectorAll<HTMLElement>('.tree-name')].find((b) => b.getClientRects().length > 0)?.focus(); }));
      // There whole where it rests, as every thing called up in front is (DESIGN §8: what comes is there), the world
      // behind going out of focus from the press (the move). The first time, once what it holds is read: shown at once,
      // it was a sheet with nothing in it, its rows coming a moment later. (Before, it was drawn out of the rail as a
      // drawer is, a wipe from its left edge: a thing growing from nothing.)
      this.veil.out(true);
      this.trigger?.setAttribute('aria-expanded', 'true');
      if (!this.root.querySelector('.tree-name')) {
        this.coming = true;
        void built.then(() => { if (!this.coming) return; this.coming = false; this.element.classList.add('open', 'settled'); });
        return;
      }
    }
    this.veil.out(true);
    this.element.classList.add('open', 'settled');
    this.trigger?.setAttribute('aria-expanded', 'true');
  }

  close(notify = true) {
    const fromDesk = this.onDesk;
    if (fromDesk) {
      ++this.building;
      this.deskRepo = null;
      this.root.replaceChildren();
      this.root.setAttribute('aria-label', '/');
      this.element.setAttribute('aria-label', 'File（/）');
      this.element.classList.remove('on-forge-desk');
      this.element.removeAttribute('data-forge-index');
      this.index.close();
      clearTimeout(this.indexRefresh);
      this.indexDirty = false;
      this.deskClose.hidden = true;
    }
    this.unpop();
    this.calledFrom = null;
    this.coming = false;
    this.element.classList.remove('open', 'settled');
    this.veil.out(false);
    this.trigger?.setAttribute('aria-expanded', 'false');
    if (fromDesk && notify) this.events.closedDesk?.();
  }

  /** Mark the repo Forge shows. */
  mark(repo: string | null) {
    for (const b of this.root.querySelectorAll<HTMLElement>('.tree-name[data-repo]')) {
      if (b.dataset.repo === repo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
  }

  /** Mark the file Forge is reading in `repo`. */
  markFile(repo: string | null, path: string | null) {
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-in][data-file]')) {
      if (b.dataset.in === repo && b.dataset.file === path) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current');
    }
  }

  /** The keyboard along the tree: only the names it shows, in order. */
  private step(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const names = [...this.root.querySelectorAll<HTMLElement>(this.onIndex
      ? '.file-shelf-title, button.file-shelf-name, button.file-shelf-shortcut' : 'button.tree-name')].filter(b => b.getClientRects().length > 0);
    const at = names.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const name = names[at];
    if (this.onIndex && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const id = name.getAttribute('aria-controls');
      const expanded = name.getAttribute('aria-expanded');
      if (event.key === 'ArrowRight') {
        if (expanded === 'false') name.click();
        else if (id) document.getElementById(id)?.querySelector<HTMLElement>('.file-shelf-name')?.focus();
      } else if (expanded === 'true') name.click();
      else {
        const parent = name.closest('.file-shelf-branch');
        if (parent) this.root.querySelector<HTMLElement>(`[aria-controls="${parent.id}"]`)?.focus();
      }
      return;
    }
    const item = name.closest('li');
    const toggle = item?.querySelector<HTMLButtonElement>(':scope > .tree-row > .tree-toggle');
    const open = toggle?.getAttribute('aria-expanded') === 'true';
    if (event.key === 'ArrowDown') names[at + 1]?.focus();
    else if (event.key === 'ArrowUp') names[at - 1]?.focus();
    else if (event.key === 'Home') names[0]?.focus();
    else if (event.key === 'End') names[names.length - 1]?.focus();
    else if (event.key === 'ArrowRight') {
      if (toggle && !open) toggle.click();
      else if (open) item?.querySelector<HTMLElement>(':scope > .tree-children .tree-name')?.focus();
    } else if (toggle && open) toggle.click();
    else item?.parentElement?.closest('li')?.querySelector<HTMLElement>(':scope > .tree-row > .tree-name')?.focus();
  }

  /**
   * Read the tree afresh each time it comes out, so new repos are there. On top, /root with the person's repos open
   * in it; the rest of / (the kernel's, the distribution's, what is empty here), wanted now and then, put away under
   * one quiet row at its foot, System, opened as a folder is and kept open once it is.
   */
  /**
   * What / holds read and drawn as rows, put in the tree whole once the folders being read are (the repos' among
   * them): the rows it had stay till then. (Drawn into the tree as they were read, the repos' rows went to “…” and
   * came back a moment later every time it came out.)
   */
  private build(): Promise<void> {
    this.said.textContent = '';
    const generation = ++this.building;
    const repo = this.deskRepo;
    if (repo !== null && this.onIndex) {
      clearTimeout(this.indexRefresh);
      this.indexDirty = false;
      return this.index.draw(repo);
    }
    if (repo !== null) {
      const rows = document.createElement('ul');
      this.add({path: `/root/${repo}`, name: repo, kind: 'dir'}, rows, -1);
      const read = this.reading ? new Promise<void>((done) => this.read.push(done)) : Promise.resolve();
      return read.then(() => {
        if (generation === this.building && this.deskRepo === repo) this.root.replaceChildren(...rows.childNodes);
      });
    }
    return list('/').then(async (top) => {
      if (generation !== this.building) return;
      const rows = document.createElement('ul');
      const rest = top.filter((e) => e.origin !== 'repos');
      for (const e of top) if (e.origin === 'repos') this.add(e, rows, 0);
      if (rest.length) rows.append(this.system(rest));
      if (this.reading) await new Promise<void>((done) => this.read.push(done));
      if (generation === this.building) this.root.replaceChildren(...rows.childNodes);
    }, () => {});
  }

  /** The rest of /, under System: a folder of its own that holds what / holds besides /root. */
  private system(entries: SystemEntry[]): HTMLElement {
    const label = t('System');
    let open = expandedPaths.has(SYSTEM);
    const toggle = h('button', {class: 'tree-toggle', type: 'button', tabindex: '-1'}, triangle()) as HTMLButtonElement;
    const name = h('button', {class: 'tree-name', type: 'button'}, label);
    const children = h('ul', {class: 'tree-children', role: 'group'});
    for (const e of entries) this.add(e, children, 1);
    const item = h('li', {role: 'treeitem', class: 'tree-dir tree-sys tree-system', 'aria-label': label},
      h('div', {class: 'tree-row', style: '--depth:0'}, toggle, name, h('span', {class: 'tree-meta'}, entries.map((e) => e.name).slice(0, 3).join(' ') + ' …')),
      children);
    const show = (now: boolean) => {
      open = now;
      if (now) expandedPaths.add(SYSTEM); else expandedPaths.delete(SYSTEM);
      toggle.setAttribute('aria-expanded', String(now));
      toggle.setAttribute('aria-label', now ? t('Close {name}', {name: label}) : t('Open {name}', {name: label}));
      item.setAttribute('aria-expanded', String(now));
      if (now) { keepOut(children); const was = children.hidden; children.hidden = false; if (was) unfold(children); }
      else putAway(children, () => { children.hidden = true; }, {fold: true});
    };
    toggle.addEventListener('click', () => show(!open));
    name.addEventListener('click', () => show(!open));
    this.folders.set(item, async () => show(true));
    show(open);
    return item;
  }

  /** A repo only on the Remote: its name, and where it is. */
  private away(repo: string, depth: number): HTMLElement {
    const meta = h('span', {class: 'tree-meta'}, 'Remote');
    const name = h('button', {class: 'tree-name', type: 'button'}, repo);
    const item = h('li', {role: 'treeitem', class: 'tree-repo tree-away', 'aria-label': repo},
      h('div', {class: 'tree-row', style: `--depth:${depth}`}, h('span', {class: 'tree-spacer', 'aria-hidden': 'true'}), name, meta));
    name.addEventListener('click', async () => {
      meta.textContent = t('Fetching…');
      try {
        await bring(repo);
        // Here now: its row is a repo's, with what it holds.
        expandedPaths.add(`/root/${repo}`);
        await this.again(item.parentElement?.closest('li') ?? null);
        this.events.choose(repo, '', false);
      } catch (err) { meta.textContent = errorText(err); }
    });
    return item;
  }

  private add(e: SystemEntry, into: HTMLElement, depth: number) {
    const at = inRepo(e.path);
    const isRepo = at !== null && at.path === '';
    const row = h('div', {class: 'tree-row', style: `--depth:${depth}`});
    // Heard by its name alone, not by everything in its row (its triangle, its menu).
    // An issue's file is the issue (#3), as everywhere it is met.
    const called = at && e.kind !== 'dir' ? shownName(at.path) : e.name;
    const item = h('li', {role: 'treeitem', class: isRepo ? 'tree-repo' : e.kind === 'dir' ? 'tree-dir' : 'tree-file', 'aria-label': called}, row);
    // The system's own parts (the kernel's, the distribution's) are there to be found, quieter than the person's repos.
    if (e.origin && e.origin !== 'repos') item.classList.add('tree-sys');
    // /root itself has no row (styles: .tree-home): the repos in it are the tree's own first rows, always out.
    const home = e.path === '/root';
    if (home) item.classList.add('tree-home');
    const meta = e.origin ? t(ORIGIN_LABEL[e.origin]) : e.kind === 'file' && e.size ? bytes(e.size) : '';

    if (e.kind !== 'dir') {
      // A link is shown by its name only: /bin/ls is a command, whatever it points to.
      row.append(h('span', {class: 'tree-spacer', 'aria-hidden': 'true'}));
      if (at) {
        const name = h('button', {class: 'tree-name', type: 'button', 'data-path': e.path}, called);
        this.fileName(name, at);
        row.append(name);
        if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
        this.deeds(row, name, e, at, false);
        this.carries(row, at);
      } else {
        row.append(h('span', {class: 'tree-name plain'}, e.name));
        if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
      }
      into.append(item);
      return;
    }

    const deskRoot = isRepo && this.deskRepo === e.name && depth === -1;
    if (deskRoot) item.classList.add('tree-desk-root');
    let expanded = deskRoot || home || expandedPaths.has(e.path);
    // (The triangle is not drawn in the tree's sheet, a folder says it is one by its name's end: the name opens and
    // closes it. From the keyboard → and ← do it on the name.)
    const toggle = h('button', {class: 'tree-toggle', type: 'button', tabindex: '-1'}) as HTMLButtonElement;
    toggle.append(triangle());
    const name = h('button', {class: 'tree-name', type: 'button', 'data-path': e.path}, e.name);
    if (isRepo) {
      if (deskRoot) name.append(h('span', {class: 'tree-slash', 'aria-hidden': 'true'}, '/'));
      name.dataset.repo = at.repo;
      if (at.repo === this.events.current()) name.setAttribute('aria-current', 'page');
    }
    // A folder says it is one by the stroke after its name (not heard: its name is its name); a repo by its weight.
    if (!isRepo && !home) name.append(h('span', {class: 'tree-slash', 'aria-hidden': 'true'}, '/'));
    const children = h('ul', {class: 'tree-children', role: 'group'});
    row.append(toggle, name);
    if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
    if (at) { this.deeds(row, name, e, at, true); this.carries(row, at); }
    item.append(children);

    const fill = async () => {
      // Read again (a row made, renamed or taken away in it), its rows stay until what it holds now is read: no blink of “…”.
      if (!children.querySelector(':scope > [role=treeitem]')) children.replaceChildren(note('…', depth + 1));
      let entries: SystemEntry[];
      this.reading++;
      try {
        try { entries = await list(e.path); } catch (err) {
          children.replaceChildren(note(errorText(err), depth + 1));
          return;
        }
        children.replaceChildren();
        // (Each open folder among them starts being read now, before this one is counted read.)
        for (const c of entries) this.add(c, children, depth + 1);
        // A repo only on the Remote is a line too: choosing it fetches it, as opening it from Home does.
        if (e.path === '/root') for (const r of remoteOnly()) if (!entries.some((c) => c.name === r.name)) children.append(this.away(r.name, depth + 1));
        if (!children.childElementCount) children.append(note(e.path === '/root' ? t('No repos yet') : t('empty'), depth + 1));
      } finally { if (!--this.reading) for (const done of this.read.splice(0)) done(); }
    };
    const show = (now: boolean) => {
      expanded = now;
      if (now) expandedPaths.add(e.path); else expandedPaths.delete(e.path);
      toggle.setAttribute('aria-expanded', String(now));
      toggle.setAttribute('aria-label', now ? t('Close {name}', {name: e.name}) : t('Open {name}', {name: e.name}));
      item.setAttribute('aria-expanded', String(now));
      // Opened it unfolds, closed it folds up, what stands under it making way either way.
      if (now) { keepOut(children); const was = children.hidden; children.hidden = false; if (was) unfold(children); }
      else putAway(children, () => { children.hidden = true; }, {fold: true});
      return now ? fill() : Promise.resolve();
    };
    this.folders.set(item, () => show(true));
    if (at) this.takes(row, at, () => { if (!expanded) void show(true); });
    toggle.addEventListener('click', () => void show(!expanded));
    // The name opens and shuts it, and does nothing else: a folder (a repo's own row too) is unfolded to see what is
    // in it, and the page under the tree stays where it is. Only a file, chosen, takes Forge to it (DESIGN §14,
    // unfold). Before, a folder opened was also where Forge went, and a repo's row shut or went by which repo Forge
    // was at: one press, two deeds, the world moving behind the tree as a folder was looked into.
    name.addEventListener('click', () => void show(!expanded));
    void show(expanded);
    into.append(item);
  }

  private fileName(name: HTMLElement, at: {repo: string; path: string}) {
    name.dataset.in = at.repo;
    name.dataset.file = at.path;
    if (at.repo === this.events.current() && at.path === this.events.currentFile()) name.setAttribute('aria-current', 'location');
    name.addEventListener('click', () => this.events.choose(at.repo, at.path, this.onIndex ? 'resume' : true));
  }

  /**
   * What can be done to a row inside a repo, at its right end: pressed (or a
   * right press on the row, or the menu key on its name), its menu.
   */
  private deeds(row: HTMLElement, name: HTMLElement, e: SystemEntry, at: {repo: string; path: string}, dir: boolean, disclose = false) {
    const more = h('button', {type: 'button', class: disclose ? 'tree-more file-shelf-toggle' : 'tree-more',
      tabindex: '-1', 'aria-expanded': 'false', ...(disclose ? {} : {'aria-haspopup': 'menu',
        'aria-label': t('Actions for {name}', {name: e.name})})}, mark('down')) as HTMLButtonElement;
    if (this.onIndex) name.setAttribute('aria-keyshortcuts', 'Shift+F10');
    row.append(more);
    const open = (focus: boolean, deed?: string) => {
      if (!deed && this.pop?.more === more) this.unpop();
      else this.menu(row, name, more, e, at, dir, focus, deed);
    };
    if (this.onDesk && !this.onIndex) {
      const quick = h('span', {class: at.path ? 'tree-quick' : 'tree-quick tree-quick-root'});
      const labels = at.path ? [['Rename', 'pen'], ['Delete', 'trash']] : [['New file', 'new-file'], ['New folder', 'new-folder']];
      for (const [label, deed] of labels) {
        const button = h('button', {class: 'tree-quick-item', type: 'button', tabindex: '-1'}, t(label));
        button.addEventListener('click', () => open(true, deed));
        quick.append(button);
      }
      row.append(quick);
    }
    if (!disclose) more.addEventListener('click', event => open(event.detail === 0));
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); if (this.pop?.more !== more) open(false); });
    name.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); open(true); }
    });
    return more;
  }

  /** A row inside a repo (not the repo's own) can be taken by the pointer and carried to a folder of its repo. */
  private carries(row: HTMLElement, at: {repo: string; path: string}) {
    if (!at.path) return;
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      this.unpop();
      this.said.textContent = '';
      this.carried = at;
      event.dataTransfer?.setData('text/plain', at.path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('carried');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('carried');
      this.carried = null;
    });
  }

  /**
   * A folder's row (the repo's own too) takes a row of its repo let go on it: the row moves into it. Held over it a
   * moment while it is shut, it opens (`open`), to be gone into.
   */
  private takes(row: HTMLElement, at: {repo: string; path: string}, open: () => void) {
    let spring = 0;
    // Not into itself or what is in it, nor where it is already.
    const fits = () => {
      const c = this.carried;
      return !!c && c.repo === at.repo && at.path !== c.path && !at.path.startsWith(`${c.path}/`) && split(c.path)[0] !== at.path;
    };
    const off = () => { clearTimeout(spring); spring = 0; row.classList.remove('taking'); };
    row.addEventListener('dragover', (event) => {
      if (!fits()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      row.classList.add('taking');
      spring ||= window.setTimeout(open, SPRING);
    });
    row.addEventListener('dragleave', (event) => { if (!row.contains(event.relatedTarget as Node | null)) off(); });
    row.addEventListener('drop', (event) => {
      const c = this.carried;
      off();
      if (!c || !fits()) return;
      event.preventDefault();
      void this.moved(c.repo, c.path, joined(at.path, split(c.path)[1])).catch((err) => { this.said.textContent = errorText(err); });
    });
  }

  /**
   * `path` of `repo` moved to `to` (renamed, or carried to another folder): an open folder stays open where it went,
   * the repo is read again with every folder down to it open, and it lands lit there with the keyboard on it.
   */
  private async moved(repo: string, path: string, to: string, showing = () => true) {
    const was = `/root/${repo}/${path}`, now = `/root/${repo}/${to}`;
    if (to !== path) {
      await moveFile(repo, path, to);
      for (const p of [...expandedPaths]) if (p === was || p.startsWith(`${was}/`)) { expandedPaths.delete(p); expandedPaths.add(now + p.slice(was.length)); }
    }
    const parts = to.split('/');
    for (let i = 0; i < parts.length; i++) expandedPaths.add(`/root/${[repo, ...parts.slice(0, i)].join('/')}`);
    this.index.moved(repo, path, to, this.onIndex);
    if (!showing()) return;
    const owner = this.deskRepo;
    this.unpop();
    await this.again(this.nameAt(`/root/${repo}`)?.closest('li') ?? null);
    // Its open folders are read each by itself: it is there once the last of them is.
    if (this.reading) await new Promise<void>((done) => this.read.push(done));
    if (owner !== this.deskRepo) return;
    this.settle(this.nameAt(now));
    if (to !== path) this.landed(now);
  }

  /** Put the row's menu away, if one is out. */
  private unpop(immediately = false) {
    if (!this.pop) return;
    const {element: gone, inline, cleanup, more} = this.pop;
    this.menuExpanded(more, false);
    this.pop = null;
    cleanup?.();
    if (inline || immediately || this.onIndex) gone.remove();
    else putAway(gone, () => gone.remove());
    this.refreshIndex();
  }

  private refreshIndex() {
    if (!this.onIndex || !this.indexDirty || this.pop) return;
    clearTimeout(this.indexRefresh);
    this.indexRefresh = window.setTimeout(() => {
      if (this.onIndex && this.indexDirty && !this.pop) void this.build();
    }, 80);
  }

  /**
   * The keyboard put on the row a deed of its menu left it at (made, renamed, or the folder of one deleted): it is
   * there to go on from, but not ringed while the row is lit for the deed, until a key is pressed on it.
   */
  private settle(name: HTMLElement | null | undefined) {
    if (!name) return;
    const row = name.closest('.tree-row');
    row?.classList.add('settled');
    const off = () => { row?.classList.remove('settled'); name.removeEventListener('keydown', off); name.removeEventListener('blur', off); };
    name.addEventListener('keydown', off);
    name.addEventListener('blur', off);
    name.focus();
  }

  /** The row a deed of its menu made or renamed, landing lit where it is now: what was done is seen done. */
  private landed(path: string) {
    const row = this.nameAt(path)?.closest<HTMLElement>('.tree-row');
    if (!row) return;
    row.classList.add('landing');
    row.addEventListener('animationend', (e) => { if (e.animationName === 'line-lit') row.classList.remove('landing'); });
  }

  /** The folder row `item` read again and open. */
  private async again(item: HTMLElement | null) {
    if (this.onIndex) await this.build();
    else if (item) await this.folders.get(item)?.();
  }

  /** The name of the row at `path` (absolute), once its folder has been read again. */
  private nameAt(path: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`.tree-name[data-path="${CSS.escape(path)}"]`);
  }

  /**
   * One row's menu, beside the tree at the row's height, as the person's menu
   * is: its name over what can be done. A row pressed becomes the field or
   * the ask in its own place.
   */
  private menu(row: HTMLElement, name: HTMLElement, more: HTMLElement, e: SystemEntry, at: {repo: string; path: string}, dir: boolean, focus: boolean, deed?: string) {
    this.unpop();
    const item = row.closest('li') as HTMLElement;
    const presented = this.deskRepo;
    const owned = () => presented === null || (this.deskRepo === presented && row.isConnected && this.pop?.element === pop);
    const parent = item.parentElement?.closest('li') as HTMLElement | null;
    /** A folder of the repo as the tree knows it (its absolute path) and its row. */
    const abs = (folder: string) => `/root/${at.repo}${folder ? `/${folder}` : ''}`;
    let pop: HTMLElement;
    const askRename = () => {
      this.unpop(true);
      // The text replaces its own name. Leave the row's other slots alone so the writing does not jump.
      const input = h('input', {class: 'tree-name tree-file-name-in', type: 'text', 'aria-label': t('New name'),
        autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done'}) as HTMLInputElement;
      const error = h('p', {class: 'error small', role: 'alert'});
      const form = h('form', {class: 'tree-file-rename'}, input, error);
      const draggable = row.draggable;
      name.hidden = true;
      name.after(form);
      row.draggable = false;
      pop = form;
      this.pop = {element: form, name, more, inline: true, cleanup: () => { name.hidden = false; row.draggable = draggable; }};
      const clear = () => { error.textContent = ''; input.removeAttribute('aria-invalid'); };
      input.addEventListener('input', clear);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!owned() || input.readOnly) return;
        const written = input.value.trim();
        if (!written || e.name === written) {
          this.unpop();
          name.focus({preventScroll: true});
          return;
        }
        clear();
        input.readOnly = true;
        form.setAttribute('aria-busy', 'true');
        try {
          // An ordinary name keeps its folder; the existing explicit repo path still moves the file.
          const to = await renaming(at.repo, at.path, written.includes('/') ? written : joined(split(at.path)[0], written));
          if (owned()) await deeds.move(to);
        } catch (err) {
          if (!owned()) return;
          error.textContent = errorText(err);
          input.setAttribute('aria-invalid', 'true');
          nudge(input);
        } finally { input.readOnly = false; form.removeAttribute('aria-busy'); }
      });
      input.value = e.name;
      input.focus({preventScroll: true});
      const dot = e.name.lastIndexOf('.');
      input.setSelectionRange(0, !dir && dot > 0 ? dot : e.name.length);
    };
    const askDelete = () => {
      const ask = fileDeleteAsk(deeds, () => { this.unpop(); name.focus({preventScroll: true}); }, undefined, true);
      this.unpop();
      pop = ask.element;
      row.classList.add('tree-row-asking');
      row.append(pop);
      this.menuExpanded(more, true);
      this.pop = {element: pop, name, more, inline: true, cleanup: () => row.classList.remove('tree-row-asking')};
      ask.focus();
    };
    const deeds: Deeds = {repo: at.repo, path: at.path, name: e.name, dir,
      ...(this.onDesk ? {askRename, askDelete} : {}),
      // Made in a folder: the folder open from now, not once it is written (a row drawn meanwhile is drawn open).
      opening: (folder) => {
        expandedPaths.add(abs(folder));
        if (this.onIndex) this.index.parents(at.repo, folder);
      },
      made: async (made, file) => {
        if (!owned()) return;
        this.unpop();
        // A new file is the one to work on. The fixed index keeps it alongside the editor.
        if (file) {
          if (this.onIndex) await this.again(null);
          if (this.deskRepo === presented) this.events.choose(at.repo, made, 'name');
          return;
        }
        await this.again(dir ? item : parent);
        this.settle(this.nameAt(abs(made)));
        this.landed(abs(made));
      },
      move: (to) => this.moved(at.repo, at.path, to, owned),
      reverted: () => { if (owned()) this.unpop(); },
      removed: async () => {
        if (!owned()) return;
        for (const p of [...expandedPaths]) if (p === e.path || p.startsWith(`${e.path}/`)) expandedPaths.delete(p);
        this.index.forget(e.path);
        // The rows under it come up into its place, from where they stood.
        const gap = item.getBoundingClientRect().height;
        const siblings = [...item.parentElement?.children ?? []];
        const place = siblings.indexOf(item);
        const neighbor = (siblings[place + 1] ?? siblings[place - 1])
          ?.querySelector<HTMLElement>(':scope > .tree-row > .tree-name')?.dataset.path;
        this.unpop();
        await this.again(parent);
        if (this.deskRepo !== presented) return;
        closeUp([...parent?.querySelector(':scope > .tree-children')?.children ?? []].slice(place), gap);
        this.settle((presented && neighbor ? this.nameAt(neighbor) : null)
          ?? this.nameAt(abs(split(at.path)[0])) ?? parent?.querySelector<HTMLElement>(':scope > .tree-row > .tree-name'));
      },
      back: () => {
        // A shortcut did not open a menu for Cancel to return to.
        if (!deed || !owned()) return;
        this.unpop();
        name.focus({preventScroll: true});
      }};
    if (this.onDesk && deed === 'pen') { askRename(); return; }
    if (this.onDesk && deed === 'trash') { askDelete(); return; }
    pop = fileDeeds(deeds);
    if (this.onIndex) { this.indexMenu(pop, row, name, more, focus); return; }
    // Beside the tree, level with the row: out into the free space, so nothing moves under the pointer.
    const box = this.element.getBoundingClientRect(), r = row.getBoundingClientRect();
    // Two cells from the tree's edge (one past its shadow), its top the row's: a sheet as the tree is, the row's name
    // over its corner.
    const cell = parseFloat(getComputedStyle(this.element).getPropertyValue('--u')) || 24;
    pop.style.left = `${box.right + 2 * cell}px`;
    pop.style.top = `${r.top}px`;
    // Out of the tree's edge: the tree is drawn out whole at once if it was still coming.
    this.element.classList.add('settled');
    this.element.append(pop);
    // A window too narrow for it beside the tree (a phone): just under the row, over the rows below.
    const wide = pop.getBoundingClientRect().right - (innerWidth - 16);
    if (wide > 0) { pop.style.left = `${Math.max(16, box.right + 2 * cell - wide)}px`; pop.style.top = `${r.bottom + cell + 8}px`; }
    const low = pop.getBoundingClientRect().bottom - (innerHeight - 16);
    if (low > 0) pop.style.top = `${Math.max(2 * cell, r.top - low)}px`;
    more.setAttribute('aria-expanded', 'true');
    this.pop = {element: pop, name, more};
    if (deed) pop.querySelector<HTMLButtonElement>(`[data-deed="${deed}"]`)?.click();
    else if (focus) pop.querySelector<HTMLElement>('.pop-item')?.focus();
  }

  /** The folder's disclosure and the row's context are independent. */
  private menuExpanded(more: HTMLElement, open: boolean) {
    if (!more.classList.contains('file-shelf-toggle')) more.setAttribute('aria-expanded', String(open));
  }

  /** The narrow right pocket belongs to the row, not to the paper or the sheet grid. */
  private indexMenu(pop: HTMLElement, row: HTMLElement, name: HTMLElement, more: HTMLElement, focus: boolean) {
    pop.dataset.shelfActions = '';
    keepAtRow(pop);
    this.element.append(pop);
    const place = () => {
      const r = row.getBoundingClientRect(), edge = more.getBoundingClientRect().left;
      const gap = 4, rim = 8, w = pop.offsetWidth, h = pop.offsetHeight, low = innerHeight - rim - h;
      const x = Math.max(rim, r.left, edge - gap - w);
      const word = name.querySelector('.file-shelf-primary') ?? name;
      const text = document.createRange();
      text.selectNodeContents(word);
      const textEnd = Math.min(word.getBoundingClientRect().right, text.getBoundingClientRect().right);
      // Long words share the same x lane in the next available row instead of being covered.
      const y = x >= textEnd + 2 * gap ? Math.min(r.top, low)
        : r.bottom + gap <= low ? r.bottom + gap : Math.min(low, r.top - h - gap);
      pop.style.left = `${x}px`;
      pop.style.top = `${Math.max(rim, y)}px`;
    };
    place();
    const size = new ResizeObserver(place);
    size.observe(pop);
    size.observe(row);
    this.root.addEventListener('scroll', place, {passive: true});
    window.addEventListener('resize', place, {passive: true});
    this.menuExpanded(more, true);
    row.dataset.shelfMenuOpen = '';
    this.pop = {element: pop, name, more, cleanup: () => {
      delete row.dataset.shelfMenuOpen;
      size.disconnect(); this.root.removeEventListener('scroll', place); window.removeEventListener('resize', place);
    }};
    if (focus) pop.querySelector<HTMLElement>('.pop-item')?.focus({preventScroll: true});
    else { pop.tabIndex = -1; pop.focus({preventScroll: true}); }
  }
}

