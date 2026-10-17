import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {remoteOnly} from '../lifecycle.ts';
import {store, TEMPLATES, validName, type Template} from '../repos.ts';
import {answers, pageHead} from './common.ts';
import {repoList} from './repo-list.ts';
import type {Context} from './context.ts';
import {triangle} from './tree.ts';

/**
 * +: the repo's name on the first line; under it, in a large box, what it
 * is for, and beside that the template and exactly what it will contain. Make it, and see it join the list of repos right below; from
 * there open it in Forge or make another. It speaks the same language as the
 * rest: the template is a chip like Forge's, what it is for is written in a
 * box as Home's TODO is, and what will be made is shown as it will look in
 * File, under /root. What it is for is the repo's own: it goes into its
 * README.md, under the title.
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
  const caption = h('p', {class: 'muted small tree-caption'}, t('How it will look in File'));
  const card = h('div', {class: 'tree tree-still', 'aria-label': t('What will be made')}, caption, preview);
  const showFiles = () => {
    const tpl = TEMPLATES.find((x) => x.id === template)!;
    const repo = name.value.trim() || 'my-repo';
    const items: HTMLElement[] = [row('root', 0, true, {meta: 'repo'}), row(repo, 1, true, {repo: true})];
    const walk = (nodes: Item[], depth: number) => {
      for (const n of nodes) { items.push(row(n.name, depth, n.dir)); walk(n.children, depth + 1); }
    };
    walk(nest(tpl.files), 2);
    preview.replaceChildren(...items);
  };
  // Templates are chips, one chosen: the same shape and states as everywhere.
  const chips = TEMPLATES.map((tpl) => {
    const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(tpl.id === template)}, t(tpl.label));
    b.addEventListener('click', () => {
      template = tpl.id;
      for (const c of chips) c.setAttribute('aria-checked', String(c === b));
      showFiles();
    });
    return b;
  });
  // What it is for, in a raised box as Home's TODO is, as tall as the template and its files beside it: the words written straight in it, the box the field.
  const summary = h('textarea', {id: 'repo-summary', class: 'todo-detail', maxlength: '2000',
    placeholder: t('What this repo is for'), 'aria-labelledby': 'repo-summary-label'}) as HTMLTextAreaElement;
  const summaryBox = h('div', {class: 'summary-box'}, summary);
  // The whole box is the field, as the TODO's is.
  summaryBox.addEventListener('pointerdown', (event) => { if (event.target === summaryBox) { event.preventDefault(); summary.focus(); } });
  // Said where it is to be put right: under the name.
  const error = h('p', {class: 'error', role: 'alert'});
  const submit = h('button', {class: 'button primary', type: 'submit'}, t('Create')) as HTMLButtonElement;
  const actions = answers(null, submit);

  /** Made: the page stays, and says where to go from here. */
  const made = (n: string) => {
    name.disabled = true;
    summary.disabled = true;
    for (const c of chips) c.setAttribute('disabled', '');
    caption.textContent = t('Made at /root/{name} in File', {name: n});
    const open = h('button', {class: 'button primary', type: 'button'}, t('Open in Forge'));
    open.addEventListener('click', () => ctx.openRepo(n));
    const again = h('button', {class: 'button', type: 'button'}, t('Make another'));
    again.addEventListener('click', () => ctx.rerender());
    actions.replaceChildren(h('p', {class: 'made', role: 'status'}, t('Made {name}', {name: n})), h('span', {class: 'grow'}), again, open);
    open.focus({preventScroll: true});
    void list.refresh(n);
  };
  // The name alone on the first line; under it, what it is for, and beside that the template with what it will make.
  const form = h('form', {class: 'new-repo'},
    h('div', {class: 'field name-field'}, h('label', {class: 'field-label', for: 'repo-name'}, t('Name')), name,
      h('span', {id: 'repo-name-rule', class: 'muted small'}, t('Letters, digits and . _ -, up to 64 characters')), error),
    h('div', {class: 'field summary-field'}, h('span', {class: 'field-label', id: 'repo-summary-label'}, t('Summary')), summaryBox),
    // The chips say what they are by themselves: no label over them, so they stand level with the summary's.
    h('div', {class: 'field template-field'},
      h('div', {class: 'chips', role: 'radiogroup', 'aria-label': t('Template')}, ...chips), card),
    actions);
  name.addEventListener('input', () => { error.textContent = ''; showFiles(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    if (!validName(n)) { error.textContent = t('Use letters, digits and . _ -, and do not start with .'); name.focus(); return; }
    // A name taken is the name's to change, as a name not allowed is: the keyboard goes back to it, as written.
    // One the Remote keeps and this device does not hold yet is taken too: it is the same repo, not another of that name.
    if ((await store.list()).some((r) => r.name === n) || remoteOnly().some((r) => r.name === n)) { error.textContent = t('There is a repo named {name} already', {name: n}); name.focus(); return; }
    submit.disabled = true;
    try {
      await store.create(n, template);
    } catch (e) {
      error.textContent = t('Could not create: {message}', {message: String(e)});
      submit.disabled = false;
      submit.focus();
      return;
    }
    const about = summary.value.trim();
    let unwritten = '';
    // Every template begins its README.md with the title; what it is for goes under it.
    if (about && TEMPLATES.find((x) => x.id === template)!.files.includes('README.md')) {
      try { await store.write(n, 'README.md', `# ${n}\n\n${about}\n`); } catch (e) { unwritten = String(e); }
    }
    made(n);
    if (unwritten) error.textContent = t('{what} could not be written ({why})', {what: `${n}/README.md`, why: unwritten});
  });
  // The repos already there, right under the form; a new one joins them.
  const list = repoList(ctx, {newCard: false});
  void list.refresh();
  showFiles();
  queueMicrotask(() => name.focus());
  return [pageHead('new-repo'), h('div', {}, form),
    h('section', {class: 'section', 'aria-labelledby': 'new-repo-list'}, h('h2', {id: 'new-repo-list'}, t('Repos')), list.element)];
}
