import {h} from '../dom.ts';
import {store, type Entry} from '../repos.ts';

// The File tree. "/" holds the person's repos and nothing else: the base
// distribution that has to be fetched is a separate thing (Runtime), not a
// folder here. The tree starts at the top of the pane. A folder's triangle
// sits on the right of its name: ◁ closed, ▽ open.

/** Open folders, kept across page switches: "repo" or "repo/path". */
const open = new Set<string>();

export interface TreeEvents {
  /** A repo or a path inside one was chosen; path '' is the repo itself. */
  choose(repo: string, path: string): void;
}

/** One outlined triangle pointing down; CSS turns it to point left while closed. */
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

function toggle(label: string, expanded: boolean): HTMLButtonElement {
  const b = h('button', {class: 'tree-toggle', type: 'button', 'aria-expanded': String(expanded),
    'aria-label': `${label}を${expanded ? '閉じる' : '開く'}`}) as HTMLButtonElement;
  b.append(triangle());
  return b;
}

export function tree(current: string | null, events: TreeEvents): HTMLElement {
  const root = h('ul', {class: 'tree-children', role: 'tree'});
  const pane = h('nav', {class: 'tree', 'aria-label': 'ファイル'},
    h('div', {class: 'tree-body'}, h('p', {class: 'tree-root'}, '/'), root));

  const folder = (repo: string, path: string, name: string, list: HTMLElement, depth: number) => {
    const key = path ? `${repo}/${path}` : repo;
    const expanded = open.has(key);
    const label = h('button', {class: 'tree-name', type: 'button', style: `--depth:${depth}`}, name);
    if (!path && repo === current) label.setAttribute('aria-current', 'page');
    label.addEventListener('click', () => events.choose(repo, path));
    const button = toggle(name, expanded);
    const children = h('ul', {class: 'tree-children', role: 'group'});
    const row = h('li', {class: path ? 'tree-dir' : 'tree-repo', role: 'treeitem', 'aria-expanded': String(expanded)},
      h('div', {class: 'tree-row'}, label, button), children);
    const fill = async () => {
      children.replaceChildren(h('li', {class: 'tree-wait muted'}, '…'));
      let entries: Entry[];
      try { entries = await store.tree(repo, path); } catch (e) { children.replaceChildren(h('li', {class: 'muted'}, String(e))); return; }
      children.replaceChildren(...entries.map((e) => {
        const p = path ? `${path}/${e.name}` : e.name;
        if (e.kind === 'dir') {
          const sub = h('ul');
          folder(repo, p, e.name, sub, depth + 1);
          return sub.firstChild as HTMLElement;
        }
        const file = h('button', {class: 'tree-name file', type: 'button', style: `--depth:${depth + 1}`}, e.name);
        file.addEventListener('click', () => events.choose(repo, p));
        return h('li', {class: 'tree-file', role: 'treeitem'}, h('div', {class: 'tree-row'}, file));
      }));
      if (!entries.length) children.replaceChildren(h('li', {class: 'tree-empty muted', style: `--depth:${depth + 1}`}, '空'));
    };
    button.addEventListener('click', () => {
      const now = !open.has(key);
      if (now) open.add(key); else open.delete(key);
      button.setAttribute('aria-expanded', String(now));
      button.setAttribute('aria-label', `${name}を${now ? '閉じる' : '開く'}`);
      row.setAttribute('aria-expanded', String(now));
      children.hidden = !now;
      if (now) void fill();
    });
    children.hidden = !expanded;
    if (expanded) void fill();
    list.append(row);
  };

  void store.list().then((repos) => {
    root.replaceChildren();
    for (const r of repos) folder(r.name, '', r.name, root, 0);
    if (!repos.length) root.append(h('li', {class: 'muted tree-empty'}, 'repoはまだありません'));
  });
  return pane;
}
