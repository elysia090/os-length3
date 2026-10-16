import {bytes, h} from '../dom.ts';
import {inRepo, list, ORIGIN_LABEL, type SystemEntry} from '../system.ts';

// The File tree of "/", the whole system. It lies over the left edge of the
// page and opens while the pointer is on it (or keyboard focus is in it), so
// the center and the right never move. A folder's triangle comes before its
// name: ▷ closed, ▽ open.

/** Open folders by absolute path, kept across page switches. */
const open = new Set<string>(['/root']);

export interface TreeEvents {
  /** A repo or a path inside one was chosen; path '' is the repo itself. */
  choose(repo: string, path: string): void;
}

/** One outlined triangle pointing down; CSS turns it to point right while closed. */
function triangle(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 3.5h8L6 9.5z');
  svg.append(path);
  return svg;
}

const note = (text: string, depth: number) => h('li', {class: 'tree-note muted', style: `--depth:${depth}`}, text);

export function tree(current: string | null, events: TreeEvents): HTMLElement {
  const root = h('ul', {class: 'tree-children', role: 'tree', 'aria-label': '/'});
  const panel = h('div', {class: 'tree-panel'}, h('p', {class: 'tree-root'}, '/'), root);
  const pane = h('nav', {class: 'tree', 'aria-label': 'ファイル（/）'},
    h('span', {class: 'tree-handle', 'aria-hidden': 'true'}, '/'), panel);

  const add = (e: SystemEntry, into: HTMLElement, depth: number) => {
    const at = inRepo(e.path);
    const isRepo = at !== null && at.path === '';
    const row = h('div', {class: 'tree-row', style: `--depth:${depth}`});
    const item = h('li', {role: 'treeitem', class: isRepo ? 'tree-repo' : e.kind === 'dir' ? 'tree-dir' : 'tree-file'}, row);
    const meta = e.origin ? ORIGIN_LABEL[e.origin] : e.kind === 'file' && e.size ? bytes(e.size) : '';

    if (e.kind !== 'dir') {
      const text = e.kind === 'link' ? `${e.name} → ${e.target}` : e.name;
      row.append(h('span', {class: 'tree-spacer', 'aria-hidden': 'true'}));
      if (at) {
        const name = h('button', {class: 'tree-name', type: 'button'}, text);
        name.addEventListener('click', () => events.choose(at.repo, at.path));
        row.append(name);
      } else {
        row.append(h('span', {class: 'tree-name plain'}, text));
      }
      if (meta) row.append(h('span', {class: 'tree-meta'}, meta));
      into.append(item);
      return;
    }

    let expanded = open.has(e.path);
    const toggle = h('button', {class: 'tree-toggle', type: 'button'}) as HTMLButtonElement;
    toggle.append(triangle());
    const name = h('button', {class: 'tree-name', type: 'button'}, e.name);
    if (isRepo && at.repo === current) name.setAttribute('aria-current', 'page');
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
      for (const c of entries) add(c, children, depth + 1);
      if (!entries.length) children.append(note(e.path === '/root' ? 'repoはまだありません' : '空', depth + 1));
    };
    const show = (now: boolean) => {
      expanded = now;
      if (now) open.add(e.path); else open.delete(e.path);
      toggle.setAttribute('aria-expanded', String(now));
      toggle.setAttribute('aria-label', `${e.name}を${now ? '閉じる' : '開く'}`);
      item.setAttribute('aria-expanded', String(now));
      children.hidden = !now;
      if (now) void fill();
    };
    toggle.addEventListener('click', () => show(!expanded));
    // Inside a repo the name also shows the place in the center; elsewhere it
    // only opens and closes, like the triangle.
    name.addEventListener('click', () => {
      if (!at) { show(!expanded); return; }
      if (!expanded) show(true);
      events.choose(at.repo, at.path);
    });
    show(expanded);
    into.append(item);
  };

  void list('/').then((top) => { for (const e of top) add(e, root, 0); });
  return pane;
}
