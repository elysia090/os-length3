import {bytes, h} from '../dom.ts';
import {inRepo, list, ORIGIN_LABEL, type SystemEntry} from '../system.ts';

// File is an operation, not a page: the tree of "/", the whole system, as a
// card laid over whatever page is showing, right beside the rail and only as
// tall as what is in it. It opens when the
// pointer rests on the File icon or on the tree, or when File is pressed;
// once out it stays for LINGER after the pointer leaves, so reaching across
// the page and back does not lose it. A press outside or Escape closes it at
// once. Nothing under it moves. A folder's triangle comes before its name:
// ▷ closed, ▽ open.

const OPEN_DELAY = 80;
const LINGER = 8000;

/** Open folders by absolute path, kept while the app runs. */
const expandedPaths = new Set<string>(['/root']);

export interface FileTreeEvents {
  /** A repo or a path inside one was chosen; path '' is the repo itself. */
  choose(repo: string, path: string): void;
  /** The repo Forge shows, marked in the tree. */
  current(): string | null;
}

/** One outlined triangle pointing down; CSS turns it to point right while closed. */
function triangle(): SVGSVGElement {
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

export class FileTree {
  readonly element: HTMLElement;
  private root: HTMLElement;
  private events: FileTreeEvents;
  private trigger: HTMLElement | null = null;
  private timer = 0;

  constructor(events: FileTreeEvents) {
    this.events = events;
    this.root = h('ul', {class: 'tree-children', role: 'tree', 'aria-label': '/'});
    this.element = h('nav', {class: 'tree', id: 'file-tree', 'aria-label': 'File（/）'},
      h('p', {class: 'tree-root'}, '/'), this.root);
    this.element.addEventListener('pointerenter', () => this.enter());
    this.element.addEventListener('pointerleave', () => this.leave());
    this.element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.close();
      this.trigger?.focus();
    });
    this.element.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if (to && !this.element.contains(to) && to !== this.trigger) this.close();
    });
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.element.contains(at) && !this.trigger?.contains(at)) this.close();
    });
  }

  get isOpen() { return this.element.classList.contains('open'); }

  /** The rail's File button: hovering it opens the tree, pressing it opens it at once. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'file-tree');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerenter', () => this.enter());
    button.addEventListener('pointerleave', () => this.leave());
    // A press never closes what the hover just opened; from the keyboard
    // (detail 0) it toggles and moves focus into the tree.
    button.addEventListener('click', (event) => {
      const keyboard = event.detail === 0;
      if (keyboard && this.isOpen) this.close(); else this.open(keyboard);
    });
  }

  enter() { this.later(true, this.isOpen ? 0 : OPEN_DELAY); }
  leave() { this.later(false, LINGER); }

  open(focus = false) {
    clearTimeout(this.timer);
    if (!this.isOpen) {
      // Its "/" row sits level with the File icon.
      const at = this.trigger?.getBoundingClientRect();
      if (at) {
        const pad = parseFloat(getComputedStyle(this.element).paddingTop) || 0;
        const row = this.element.querySelector<HTMLElement>('.tree-root')?.offsetHeight ?? 0;
        this.element.style.setProperty('--tree-top', `${Math.max(0, at.top + at.height / 2 - pad - row / 2)}px`);
      }
      this.build(focus);
    }
    this.element.classList.add('open');
    this.trigger?.setAttribute('aria-expanded', 'true');
  }

  close() {
    clearTimeout(this.timer);
    this.element.classList.remove('open');
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  /** Mark the repo Forge shows. */
  mark(repo: string | null) {
    for (const b of this.root.querySelectorAll<HTMLElement>('.tree-name[data-repo]')) {
      if (b.dataset.repo === repo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
  }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (open ? this.open() : this.close()), after);
  }

  /** Read the tree afresh each time it comes out, so new repos are there. */
  private build(focus: boolean) {
    void list('/').then((top) => {
      this.root.replaceChildren();
      for (const e of top) this.add(e, this.root, 0);
      if (focus) this.root.querySelector<HTMLElement>('.tree-name')?.focus();
    });
  }

  private add(e: SystemEntry, into: HTMLElement, depth: number) {
    const at = inRepo(e.path);
    const isRepo = at !== null && at.path === '';
    const row = h('div', {class: 'tree-row', style: `--depth:${depth}`});
    const item = h('li', {role: 'treeitem', class: isRepo ? 'tree-repo' : e.kind === 'dir' ? 'tree-dir' : 'tree-file'}, row);
    const meta = e.origin ? ORIGIN_LABEL[e.origin] : e.kind === 'file' && e.size ? bytes(e.size) : '';

    if (e.kind !== 'dir') {
      // A link is shown by its name only: /bin/ls is a command, whatever it points to.
      row.append(h('span', {class: 'tree-spacer', 'aria-hidden': 'true'}));
      if (at) {
        const name = h('button', {class: 'tree-name', type: 'button'}, e.name);
        name.addEventListener('click', () => this.events.choose(at.repo, at.path));
        row.append(name);
      } else {
        row.append(h('span', {class: 'tree-name plain'}, e.name));
      }
      if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
      into.append(item);
      return;
    }

    let expanded = expandedPaths.has(e.path);
    const toggle = h('button', {class: 'tree-toggle', type: 'button'}) as HTMLButtonElement;
    toggle.append(triangle());
    const name = h('button', {class: 'tree-name', type: 'button'}, e.name);
    if (isRepo) {
      name.dataset.repo = at.repo;
      if (at.repo === this.events.current()) name.setAttribute('aria-current', 'page');
    }
    const children = h('ul', {class: 'tree-children', role: 'group'});
    row.append(toggle, name);
    if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
    item.append(children);

    const fill = async () => {
      children.replaceChildren(note('…', depth + 1));
      let entries: SystemEntry[];
      try { entries = await list(e.path); } catch (err) {
        children.replaceChildren(note(err instanceof Error ? err.message : String(err), depth + 1));
        return;
      }
      children.replaceChildren();
      for (const c of entries) this.add(c, children, depth + 1);
      if (!entries.length) children.append(note(e.path === '/root' ? 'repoはまだありません' : '空', depth + 1));
    };
    const show = (now: boolean) => {
      expanded = now;
      if (now) expandedPaths.add(e.path); else expandedPaths.delete(e.path);
      toggle.setAttribute('aria-expanded', String(now));
      toggle.setAttribute('aria-label', `${e.name}を${now ? '閉じる' : '開く'}`);
      item.setAttribute('aria-expanded', String(now));
      children.hidden = !now;
      if (now) void fill();
    };
    toggle.addEventListener('click', () => show(!expanded));
    // Inside a repo the name also opens that place in Forge; elsewhere it
    // only opens and closes, like the triangle.
    name.addEventListener('click', () => {
      if (!at) { show(!expanded); return; }
      if (!expanded) show(true);
      this.events.choose(at.repo, at.path);
    });
    show(expanded);
    into.append(item);
  }
}
