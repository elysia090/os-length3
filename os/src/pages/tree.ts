import {bytes, h} from '../ui/dom.ts';
import {closeUp, keepOut, nudge, putAway, unfold} from '../ui/glide.ts';
import {t} from '../i18n.ts';
import {mark} from '../ui/icons.ts';
import {bring, remoteOnly} from '../remote/lifecycle.ts';
import {plainPart, renamed, store} from '../repos/repos.ts';
import {shownName} from '../repos/issues.ts';
import {inRepo, list, ORIGIN_LABEL, type SystemEntry} from '../prompt/system.ts';
import {answers, askFoot, SETTLE} from './common.ts';
import {errorText} from '../app/errors.ts';

// File is an operation, not a page: the tree of "/", the whole system, as a
// card laid over whatever page is showing, right beside the rail and only as
// tall as what is in it. It opens when the
// pointer rests on the File icon or on the tree, or when File is pressed;
// once out it stays for LINGER after the pointer leaves, so reaching across
// the page and back does not lose it; while a name is being written in it or
// it asks something (or the keyboard is in it), it stays however far the
// pointer goes, until that is done. A press outside or Escape closes it at
// once, whatever has the keyboard. Nothing under it moves. A folder's
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
// (the repo's own row too) takes a new file or folder; a file or folder
// takes a new name or is deleted. A row pressed becomes the field or the ask
// in its place; a new file is the one to work on, so the tree goes and the
// caret is in it.

/** How long the pointer rests on File before the tree comes out: passing over the rail does not bring it out. */
const OPEN_DELAY = 300;
/**
 * How long it stays once the pointer has gone: brushed past on the icon alone, a moment; gone from the tree itself,
 * a little longer, for a reach back to it. Brought out by a press, it stays until a press elsewhere or Escape.
 */
const LINGER_PASSED = 450;
const LINGER = 1200;

/** Open folders by absolute path, kept while the app runs; System (the rest of /) by a name no path has. */
const expandedPaths = new Set<string>(['/root']);
const SYSTEM = '/:system';

export interface FileTreeEvents {
  /** A repo or a path inside one was chosen; path '' is the repo itself. `file` when it is a file. */
  choose(repo: string, path: string, file: boolean): void;
  /** The repo Forge shows, marked in the tree. */
  current(): string | null;
  /** The file Forge is reading in that repo, marked too. */
  currentFile(): string | null;
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
const joined = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export class FileTree {
  readonly element: HTMLElement;
  private root: HTMLElement;
  private events: FileTreeEvents;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  /** The menu of one row, while it is out, and the row's name to go back to. */
  private pop: {element: HTMLElement; name: HTMLElement; more: HTMLElement} | null = null;
  /** Each folder's way to be read again, open, by its row. */
  private folders = new WeakMap<HTMLElement, () => Promise<void>>();
  /** Whether the pointer is over the tree or File, so a hold let go knows to start the linger. */
  private over = false;
  /** When it last came out. */
  /** The tree was out when the pointer came onto the File button, or a press there brought it out: pressed now, it goes. */
  private outBefore = false;
  /** Brought out by a press: it stays until put away (a press elsewhere, Escape, File again), not when the pointer goes. */
  private pinned = false;
  /** The pointer has been in the tree since it came out. */
  private visited = false;

  constructor(events: FileTreeEvents) {
    this.events = events;
    this.root = h('ul', {class: 'tree-children', role: 'tree', 'aria-label': '/'});
    // No "/" label of its own: the rows are what is in "/".
    this.element = h('nav', {class: 'tree', id: 'file-tree', 'aria-label': 'File（/）'}, this.root);
    this.element.addEventListener('pointerenter', () => { this.visited = true; this.enter(); });
    this.element.addEventListener('pointerleave', () => this.leave());
    // Escape closes it from anywhere while it is out, before what has the keyboard
    // hears it (so the text being written keeps its caret); the keyboard goes back
    // to File only when it was in the tree or on File.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing || !this.isOpen) return;
      event.preventDefault();
      event.stopPropagation();
      // The topmost first: a row's menu goes, and the keyboard back to its row.
      if (this.pop) { const back = this.pop.name; this.unpop(); back.focus(); return; }
      const at = document.activeElement;
      const back = !!at && (this.element.contains(at) || at === this.trigger);
      this.close();
      if (back) this.trigger?.focus();
    }, true);
    this.element.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if (to && !this.element.contains(to) && to !== this.trigger) this.close();
    });
    this.element.addEventListener('keydown', (event) => this.step(event));
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.element.contains(at) && !this.trigger?.contains(at)) this.close();
      else if (this.pop && !this.pop.element.contains(at) && !this.pop.more.contains(at)) this.unpop();
    });
  }

  get isOpen() { return this.element.classList.contains('open'); }

  /** The rail's File button: hovering it opens the tree, pressing it opens it at once. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'file-tree');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerenter', () => { this.outBefore = this.isOpen; this.enter(); });
    button.addEventListener('pointerleave', () => this.leave());
    // A press never closes what this same reach's hover opened, however long the press took to come: it keeps it
    // out. Pressed again, or pressed while it was out before the pointer came, it closes, as the plug and the
    // person's icon do (issue #45). From the keyboard (detail 0) it toggles and moves focus in.
    button.addEventListener('click', (event) => {
      const keyboard = event.detail === 0;
      if (this.isOpen && (keyboard || this.outBefore)) { this.close(); return; }
      this.open(keyboard);
      this.outBefore = true;
      this.pinned = true;
    });
    // → from File goes into the tree, out at its right (brought out first if it was not): ↓ and ↑ stay the rail's.
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!this.isOpen) { this.open(true); this.pinned = true; return; }
      [...this.root.querySelectorAll<HTMLElement>('.tree-name')].find((b) => b.getClientRects().length > 0)?.focus();
    });
  }

  enter() { this.over = true; this.later(true, this.isOpen ? 0 : OPEN_DELAY); }
  leave() {
    this.over = false;
    // A name being written, an ask, or the keyboard in the tree: it stays until that is done.
    if (this.isOpen && (this.pinned || this.holding())) { clearTimeout(this.timer); return; }
    this.later(false, this.visited ? LINGER : LINGER_PASSED);
  }

  /** Something in the tree that the pointer going away must not put away: a field or an ask in a row's menu, or the keyboard. */
  private holding(): boolean {
    return !!this.pop?.element.querySelector('.pop-field, .pop-ask') || !!this.element.querySelector(':focus-visible');
  }

  /** The pointer on another place on the rail: the tree a rest brought out, not pressed nor held, goes at once. */
  passedBy() { if (this.isOpen && !this.pinned && !this.holding()) this.close(); }

  /** What held the tree is done: with the pointer away, it goes after the linger as it would have. */
  private letGo() { if (this.isOpen && !this.over && !this.pinned && !this.holding()) this.later(false, this.visited ? LINGER : LINGER_PASSED); }

  open(focus = false) {
    clearTimeout(this.timer);
    if (!this.isOpen) {
      // Its first row sits level with the File icon.
      const at = this.trigger?.getBoundingClientRect();
      if (at) {
        const pad = parseFloat(getComputedStyle(this.element).paddingTop) || 0;
        const row = parseFloat(getComputedStyle(this.element).getPropertyValue('--h-row')) || 32;
        this.element.style.setProperty('--tree-top', `${Math.max(0, at.top + at.height / 2 - pad - row / 2)}px`);
      }
      this.build(focus);
    }
    this.element.classList.add('open');
    this.trigger?.setAttribute('aria-expanded', 'true');
  }

  close() {
    clearTimeout(this.timer);
    this.unpop();
    this.outBefore = false;
    this.pinned = false;
    this.visited = false;
    this.element.classList.remove('open');
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  /**
   * The tree out at `path` in `repo` (its folders opened down to it; '' is the repo itself) with that row's menu
   * open: what can be done to it, as its own ⌄ gives (issue #49). Nothing is done until a deed is chosen there.
   */
  async actOn(repo: string, path: string) {
    const at = path ? `/root/${repo}/${path}` : `/root/${repo}`;
    const parts = at.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) expandedPaths.add(`/${parts.slice(0, i).join('/')}`);
    this.close();
    this.open(false);
    // Drawn as its folders are read: waited for a moment, not for good.
    for (let i = 0; i < 60; i++) {
      const name = this.nameAt(at);
      const more = name?.closest('.tree-row')?.querySelector<HTMLButtonElement>(':scope > .tree-more');
      if (name && more) {
        name.scrollIntoView({block: 'nearest'});
        more.click();
        return;
      }
      await new Promise((go) => setTimeout(go, 50));
    }
  }

  /** Mark the repo Forge shows. */
  mark(repo: string | null) {
    for (const b of this.root.querySelectorAll<HTMLElement>('.tree-name[data-repo]')) {
      if (b.dataset.repo === repo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
  }

  /** Mark the file Forge is reading in `repo`. */
  markFile(repo: string | null, path: string | null) {
    for (const b of this.root.querySelectorAll<HTMLElement>('.tree-name[data-file]')) {
      if (b.dataset.in === repo && b.dataset.file === path) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current');
    }
  }

  /** The keyboard along the tree: only the names it shows, in order. */
  private step(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const names = [...this.root.querySelectorAll<HTMLElement>('.tree-name')].filter((b) => b.getClientRects().length > 0);
    const at = names.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const name = names[at];
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

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (open ? this.open() : this.close()), after);
  }

  /**
   * Read the tree afresh each time it comes out, so new repos are there. On top, /root with the person's repos open
   * in it; the rest of / (the kernel's, the distribution's, what is empty here), wanted now and then, put away under
   * one quiet row at its foot, System, opened as a folder is and kept open once it is.
   */
  private build(focus: boolean) {
    void list('/').then((top) => {
      this.root.replaceChildren();
      const rest = top.filter((e) => e.origin !== 'repos');
      for (const e of top) if (e.origin === 'repos') this.add(e, this.root, 0);
      if (rest.length) this.root.append(this.system(rest));
      if (focus) this.root.querySelector<HTMLElement>('.tree-name')?.focus();
    });
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
      meta.textContent = t('Bringing it…');
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
    const meta = e.origin ? t(ORIGIN_LABEL[e.origin]) : e.kind === 'file' && e.size ? bytes(e.size) : '';

    if (e.kind !== 'dir') {
      // A link is shown by its name only: /bin/ls is a command, whatever it points to.
      row.append(h('span', {class: 'tree-spacer', 'aria-hidden': 'true'}));
      if (at) {
        const name = h('button', {class: 'tree-name', type: 'button', 'data-in': at.repo, 'data-file': at.path, 'data-path': e.path}, called);
        if (at.repo === this.events.current() && at.path === this.events.currentFile()) name.setAttribute('aria-current', 'location');
        name.addEventListener('click', () => this.events.choose(at.repo, at.path, true));
        row.append(name);
        if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
        this.deeds(row, name, e, at, false);
      } else {
        row.append(h('span', {class: 'tree-name plain'}, e.name));
        if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
      }
      into.append(item);
      return;
    }

    let expanded = expandedPaths.has(e.path);
    // The pointer's way to open a folder; from the keyboard → and ← do it on the name.
    const toggle = h('button', {class: 'tree-toggle', type: 'button', tabindex: '-1'}) as HTMLButtonElement;
    toggle.append(triangle());
    const name = h('button', {class: 'tree-name', type: 'button', 'data-path': e.path}, e.name);
    if (isRepo) {
      name.dataset.repo = at.repo;
      if (at.repo === this.events.current()) name.setAttribute('aria-current', 'page');
    }
    const children = h('ul', {class: 'tree-children', role: 'group'});
    row.append(toggle, name);
    if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
    if (at) this.deeds(row, name, e, at, true);
    item.append(children);

    const fill = async () => {
      // Read again (a row made, renamed or taken away in it), its rows stay until what it holds now is read: no blink of “…”.
      if (!children.querySelector(':scope > [role=treeitem]')) children.replaceChildren(note('…', depth + 1));
      let entries: SystemEntry[];
      try { entries = await list(e.path); } catch (err) {
        children.replaceChildren(note(errorText(err), depth + 1));
        return;
      }
      children.replaceChildren();
      for (const c of entries) this.add(c, children, depth + 1);
      // A repo only on the Remote is a line too: choosing it fetches it, as opening it from Home does.
      if (e.path === '/root') for (const r of remoteOnly()) if (!entries.some((c) => c.name === r.name)) children.append(this.away(r.name, depth + 1));
      if (!children.childElementCount) children.append(note(e.path === '/root' ? t('No repos yet') : t('empty'), depth + 1));
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
    toggle.addEventListener('click', () => void show(!expanded));
    // Inside a repo the name also opens that place in Forge; elsewhere it
    // only opens and closes, like the triangle.
    name.addEventListener('click', () => {
      if (!at) { void show(!expanded); return; }
      if (!expanded) void show(true);
      this.events.choose(at.repo, at.path, false);
    });
    void show(expanded);
    into.append(item);
  }

  /**
   * What can be done to a row inside a repo, at its right end: pressed (or a
   * right press on the row, or the menu key on its name), its menu.
   */
  private deeds(row: HTMLElement, name: HTMLElement, e: SystemEntry, at: {repo: string; path: string}, dir: boolean) {
    const more = h('button', {type: 'button', class: 'tree-more', tabindex: '-1', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-label': t('What to do with {name}', {name: e.name})}, mark('down'));
    row.append(more);
    const open = (focus: boolean) => { if (this.pop?.more === more) this.unpop(); else this.menu(row, name, more, e, at, dir, focus); };
    more.addEventListener('click', (event) => open(event.detail === 0));
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); if (this.pop?.more !== more) open(false); });
    name.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); open(true); }
    });
  }

  /** Put the row's menu away, if one is out. */
  private unpop() {
    if (!this.pop) return;
    this.pop.more.setAttribute('aria-expanded', 'false');
    const gone = this.pop.element;
    putAway(gone, () => gone.remove());
    this.pop = null;
    this.letGo();
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
    if (item) await this.folders.get(item)?.();
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
  private menu(row: HTMLElement, name: HTMLElement, more: HTMLElement, e: SystemEntry, at: {repo: string; path: string}, dir: boolean, focus: boolean) {
    this.unpop();
    const item = row.closest('li') as HTMLElement;
    const parent = item.parentElement?.closest('li') as HTMLElement | null;
    const folder = at.path.includes('/') ? at.path.slice(0, at.path.lastIndexOf('/')) : '';
    const pop = h('div', {class: 'pop tree-pop', role: 'menu', 'aria-label': e.name});
    const entry = (label: string, then: (b: HTMLButtonElement) => void) => {
      const b = h('button', {type: 'button', class: 'pop-item', role: 'menuitem'}, label) as HTMLButtonElement;
      b.addEventListener('click', () => then(b));
      return b;
    };
    /**
     * A name written in the row's place, with Not now and the deed at its foot, as every ask has:
     * the deed or Enter makes it; Not now (or Escape) puts it back. A name it cannot be is said
     * under it and keeps the keyboard in it, to be put right there.
     */
    const field = (b: HTMLElement, label: string, value: string, deed: string, go: (name: string) => Promise<void>) => {
      const input = h('input', {class: 'line-in mono', placeholder: label, 'aria-label': label, autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
      input.value = value;
      const error = h('p', {class: 'error small', role: 'alert'});
      const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
      const yes = h('button', {type: 'button', class: 'button small-button primary'}, deed) as HTMLButtonElement;
      const make = async () => {
        const v = input.value.trim();
        if (!v || input.disabled) return;
        error.textContent = '';
        if (!plainPart(v)) { error.textContent = t('A name has no “/” and does not start with “.”'); input.focus(); nudge(input); return; }
        input.disabled = yes.disabled = true;
        try { await go(v); } catch (err) { input.disabled = yes.disabled = false; error.textContent = errorText(err); input.focus(); nudge(input); }
      };
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        void make();
      });
      yes.addEventListener('click', () => void make());
      const box = h('div', {class: 'pop-field'}, input, error, answers(no, yes));
      no.addEventListener('click', () => { box.replaceWith(b); b.focus(); this.letGo(); });
      b.replaceWith(box);
      input.focus();
      // A new name is written over the old one's stem, its ending kept.
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 && !dir ? dot : value.length);
    };
    /** Whether `child` is in the folder `inside` already (asked of the store, not of what the tree last showed). */
    const there = async (inside: string, child: string) => (await store.tree(at.repo, inside)).some((x) => x.name === child);
    const taken = (child: string) => new Error(t('{name} is there already', {name: child}));
    const rows: HTMLElement[] = [];
    if (dir) {
      rows.push(entry(t('New file'), (b) => field(b, t('File name'), '', t('Create'), async (n) => {
        if (await there(at.path, n)) throw taken(n);
        // The new file is the one to work on: the tree goes and the caret is in it. Out again, it shows the file
        // (its folder open from now, not once the file is written: a row drawn meanwhile is drawn open).
        expandedPaths.add(e.path);
        await store.add(at.repo, at.path, n, '');
        this.unpop();
        this.events.choose(at.repo, joined(at.path, n), true);
      })));
      rows.push(entry(t('New folder'), (b) => field(b, t('Folder name'), '', t('Create'), async (n) => {
        if (await there(at.path, n)) throw taken(n);
        expandedPaths.add(e.path);
        await store.mkdir(at.repo, joined(at.path, n));
        this.unpop();
        await this.again(item);
        this.settle(this.nameAt(`${e.path}/${n}`));
        this.landed(`${e.path}/${n}`);
      })));
    }
    if (at.path !== '') {
      rows.push(entry(t('Rename'), (b) => field(b, t('New name'), e.name, t('Rename'), async (n) => {
        if (n !== e.name) {
          if (await there(folder, n)) throw taken(n);
          await store.rename(at.repo, at.path, n);
          // An open folder stays open under its new name.
          for (const p of [...expandedPaths]) {
            if (p === e.path || p.startsWith(`${e.path}/`)) { expandedPaths.delete(p); expandedPaths.add(renamed(e.path, n) + p.slice(e.path.length)); }
          }
        }
        this.unpop();
        await this.again(parent);
        this.settle(this.nameAt(renamed(e.path, n)));
        if (n !== e.name) this.landed(renamed(e.path, n));
      })));
      rows.push(entry(t('Delete'), (b) => {
        // Asked in its place: the deed on the side it was pressed, Not now on the other.
        const foot = askFoot(b, pop);
        const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
        const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Delete')) as HTMLButtonElement;
        const error = h('p', {class: 'error small', role: 'alert'});
        const ask = h('div', {class: 'pop-ask'},
          h('p', {class: 'muted small'}, dir ? t('{name} goes, with what is in it', {name: e.name}) : t('{name} goes', {name: e.name})),
          error, foot(no, yes));
        no.addEventListener('click', () => { ask.replaceWith(b); b.focus(); this.letGo(); });
        const shown = performance.now();
        yes.addEventListener('click', async () => {
          if (performance.now() - shown < SETTLE) return;
          yes.disabled = true;
          try {
            await store.remove(at.repo, at.path);
            for (const p of [...expandedPaths]) if (p === e.path || p.startsWith(`${e.path}/`)) expandedPaths.delete(p);
            // The rows under it come up into its place, from where they stood.
            const gap = item.getBoundingClientRect().height;
            const place = [...item.parentElement?.children ?? []].indexOf(item);
            this.unpop();
            await this.again(parent);
            closeUp([...parent?.querySelector(':scope > .tree-children')?.children ?? []].slice(place), gap);
            this.settle(parent?.querySelector<HTMLElement>(':scope > .tree-row > .tree-name'));
          } catch (err) { yes.disabled = false; error.textContent = errorText(err); }
        });
        b.replaceWith(ask);
        yes.focus();
      }));
    }
    pop.append(h('div', {class: 'pop-head muted small'}, e.name), ...rows);
    // ↑ ↓ go along its rows.
    pop.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...pop.querySelectorAll<HTMLElement>('.pop-item')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      event.preventDefault();
      event.stopPropagation();
      items[(i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    });
    // Beside the tree, level with the row: out into the free space, so nothing moves under the pointer.
    const box = this.element.getBoundingClientRect(), r = row.getBoundingClientRect();
    pop.style.left = `${box.right + 8}px`;
    pop.style.top = `${r.top - 8}px`;
    this.element.append(pop);
    // A window too narrow for it beside the tree (a phone): just under the row, over the rows below.
    const wide = pop.getBoundingClientRect().right - (innerWidth - 16);
    if (wide > 0) { pop.style.left = `${Math.max(16, box.right + 8 - wide)}px`; pop.style.top = `${r.bottom + 4}px`; }
    const low = pop.getBoundingClientRect().bottom - (innerHeight - 16);
    if (low > 0) pop.style.top = `${Math.max(16, r.top - 8 - low)}px`;
    more.setAttribute('aria-expanded', 'true');
    this.pop = {element: pop, name, more};
    if (focus) pop.querySelector<HTMLElement>('.pop-item')?.focus();
  }
}

