import {h} from '../dom.ts';
import {store, TEMPLATES, validName, type Template} from '../repos.ts';
import {pageHead} from './common.ts';
import {repoList} from './repo-list.ts';
import type {Context} from './context.ts';
import {triangle} from './tree.ts';

/**
 * +: name a repo, pick a template, see exactly what it will contain, make it,
 * and see it join the list of repos right below; from there open it in
 * Forge or make another. It speaks
 * the same language as the rest: the template is a chip like Forge's, and
 * what will be made is shown as it will look in File, under /root.
 */

interface Item { name: string; dir: boolean; children: Item[] }

/** The template's paths as a tree, directories first then names, as File lists them. */
function nest(paths: readonly string[]): Item[] {
  const root: Item = {name: '', dir: true, children: []};
  for (const p of paths) {
    const parts = p.replace(/\/$/, '').split('/');
    let at = root;
    parts.forEach((part, i) => {
      const dir = i < parts.length - 1 || p.endsWith('/');
      let next = at.children.find((c) => c.name === part);
      if (!next) { next = {name: part, dir, children: []}; at.children.push(next); }
      at = next;
    });
  }
  const sort = (n: Item) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || (a.name < b.name ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function row(name: string, depth: number, dir: boolean, extra: Partial<{meta: string; repo: boolean}> = {}): HTMLElement {
  const lead = dir ? h('span', {class: 'tree-toggle', 'aria-hidden': 'true', 'aria-expanded': 'true'}) : h('span', {class: 'tree-spacer', 'aria-hidden': 'true'});
  if (dir) lead.append(triangle());
  return h('li', {class: extra.repo ? 'tree-repo' : dir ? 'tree-dir' : 'tree-file'},
    h('div', {class: 'tree-row', style: `--depth:${depth}`}, lead,
      h('span', {class: 'tree-name plain'}, name), extra.meta ? h('span', {class: 'tree-meta'}, extra.meta) : null));
}

export function newRepo(ctx: Context): Node[] {
  const name = h('input', {id: 'repo-name', class: 'line-in', maxlength: '64', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'my-repo', 'aria-describedby': 'repo-name-rule'}) as HTMLInputElement;
  let template: Template = 'standard';
  const preview = h('ul', {class: 'tree-children'});
  const caption = h('p', {class: 'muted small tree-caption'}, 'File ではこう見えます');
  const card = h('div', {class: 'tree tree-still', 'aria-label': '作成されるもの'}, caption, preview);
  const showFiles = () => {
    const t = TEMPLATES.find((x) => x.id === template)!;
    const repo = name.value.trim() || 'my-repo';
    const items: HTMLElement[] = [row('root', 0, true, {meta: 'repo'}), row(repo, 1, true, {repo: true})];
    const walk = (nodes: Item[], depth: number) => {
      for (const n of nodes) { items.push(row(n.name, depth, n.dir)); walk(n.children, depth + 1); }
    };
    walk(nest(t.files), 2);
    preview.replaceChildren(...items);
  };
  // Templates are chips, one chosen: the same shape and states as everywhere.
  const chips = TEMPLATES.map((t) => {
    const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(t.id === template)}, t.label);
    b.addEventListener('click', () => {
      template = t.id;
      for (const c of chips) c.setAttribute('aria-checked', String(c === b));
      showFiles();
    });
    return b;
  });
  const error = h('p', {class: 'error', role: 'alert'});
  const submit = h('button', {class: 'button primary', type: 'submit'}, '作成') as HTMLButtonElement;
  const actions = h('div', {class: 'row'}, submit);

  /** Made: the page stays, and says where to go from here. */
  const made = (n: string) => {
    name.disabled = true;
    for (const c of chips) c.setAttribute('disabled', '');
    caption.textContent = `File の /root/${n} に出来ました`;
    const open = h('button', {class: 'button primary', type: 'button'}, 'Forge で開く');
    open.addEventListener('click', () => ctx.openRepo(n));
    const again = h('button', {class: 'button', type: 'button'}, '続けて作る');
    again.addEventListener('click', () => ctx.rerender());
    actions.replaceChildren(h('p', {class: 'made', role: 'status'}, `${n} を作りました`), open, again);
    open.focus({preventScroll: true});
    void list.refresh(n);
  };
  const form = h('form', {class: 'new-repo'},
    h('label', {class: 'field'}, h('span', {class: 'field-label'}, '名前'), name,
      h('span', {id: 'repo-name-rule', class: 'muted small'}, '英数字と . _ - 、64文字まで')),
    h('div', {class: 'field'}, h('span', {class: 'field-label', id: 'template-label'}, 'テンプレート'),
      h('div', {class: 'chips', role: 'radiogroup', 'aria-labelledby': 'template-label'}, ...chips)),
    card, error, actions);
  name.addEventListener('input', showFiles);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    if (!validName(n)) { error.textContent = '名前は英数字と . _ - で、先頭は . 以外にしてください'; name.focus(); return; }
    submit.disabled = true;
    try {
      await store.create(n, template);
      made(n);
    } catch (e) {
      error.textContent = `作成できませんでした: ${String(e)}`;
      submit.disabled = false;
    }
  });
  // The repos already there, right under the form; a new one joins them.
  const list = repoList(ctx, {newCard: false});
  void list.refresh();
  showFiles();
  queueMicrotask(() => name.focus());
  return [pageHead('new-repo'), h('div', {}, form),
    h('section', {class: 'section', 'aria-labelledby': 'new-repo-list'}, h('h2', {id: 'new-repo-list'}, 'repo'), list.element)];
}
