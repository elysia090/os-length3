import {bytes, h} from '../dom.ts';
import {t} from '../i18n.ts';
import {remoteOnly} from '../lifecycle.ts';
import {plainPart, renamed, store, templateFiles, validName, type Template} from '../repos.ts';
import {pageHead} from './common.ts';
import {repoList} from './repo-list.ts';
import type {Context} from './context.ts';
import {triangle} from './tree.ts';
import {ORIGIN_LABEL} from '../system.ts';
import {errorText} from '../errors.ts';
import {morph, nudge, where} from '../glide.ts';

/**
 * +: the repo's name on the first line; under it, in a large box, what it
 * is for, and beside that the one scaffold every repo starts from, shown
 * exactly as File will show it, its files' names written in place (a name
 * and its extension changed there, nothing else: what a file says is never
 * turned into another language). Make it, and see it join the list of repos
 * right below; from there open it in Forge or make another. What it is for
 * is the repo's own: it goes into its README, under the title.
 *
 * What is written here before Create stays while other pages are looked at,
 * and goes once the repo is made (Make another is a fresh form).
 */

/**
 * The scaffold (shared/templates.json's `standard`, as `l3 repo new` makes
 * it): a README, with docs/ and issue/, in no language of its own. There is
 * no choosing; its file is named in the box instead.
 */
const SCAFFOLD: Template = 'standard';

/** What is written before Create: kept while the app runs, as a half-written issue is. */
interface Draft { name: string; summary: string; names: Record<string, string> }
let draft: Draft = {name: '', summary: '', names: {}};
const fresh = (): Draft => ({name: '', summary: '', names: {}});

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Where each of the scaffold's files will be, its last part named as written
 * (an empty name is the scaffold's own), and the first that cannot be: a name
 * not allowed, or one met twice in a folder. What one file says about
 * another's path follows it there; nothing else in it changes.
 */
function laidFiles(scaffold: Map<string, string | null>, names: Record<string, string>):
  {files: {from: string; to: string; text: string}[]; problem: {path: string; why: string} | null} {
  const files: {from: string; to: string; text: string}[] = [];
  let problem: {path: string; why: string} | null = null;
  const taken = new Map<string, string>();
  for (const [p, text] of scaffold) if (text === null) taken.set(p, p);
  for (const [p, text] of scaffold) {
    if (text === null) continue;
    const name = names[p]?.trim() || base(p);
    const to = renamed(p, name);
    if (!problem && !plainPart(name)) problem = {path: p, why: t('A name has no “/” and does not start with “.”')};
    else if (!problem && taken.has(to)) problem = {path: p, why: t('{name} is there already', {name})};
    taken.set(to, p);
    files.push({from: p, to, text});
  }
  for (const f of files) for (const g of files) if (g.from !== g.to) f.text = f.text.split(g.from).join(g.to);
  return {files, problem};
}

interface Item { name: string; path: string; dir: boolean; children: Item[] }

/** The scaffold's paths as a tree, directories first then names, as File lists them. */
function nest(scaffold: Map<string, string | null>): Item[] {
  const root: Item = {name: '', path: '', dir: true, children: []};
  for (const [p, text] of scaffold) {
    const parts = p.split('/');
    let at = root;
    parts.forEach((part, i) => {
      const dir = i < parts.length - 1 || text === null;
      let next = at.children.find((c) => c.name === part);
      if (!next) { next = {name: part, path: parts.slice(0, i + 1).join('/'), dir, children: []}; at.children.push(next); }
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

function row(name: Node | string, depth: number, dir: boolean, extra: Partial<{meta: Node | string; repo: boolean; shut: boolean}> = {}): HTMLElement {
  // A folder with nothing in it yet is shut, as File shows one: an open triangle over nothing says there is something.
  const lead = dir ? h('span', {class: 'tree-toggle', 'aria-hidden': 'true', 'aria-expanded': String(!extra.shut)}) : h('span', {class: 'tree-spacer', 'aria-hidden': 'true'});
  if (dir) lead.append(triangle());
  return h('li', {class: extra.repo ? 'tree-repo' : dir ? 'tree-dir' : 'tree-file'},
    h('div', {class: 'tree-row', style: `--depth:${depth}`}, lead,
      typeof name === 'string' ? h('span', {class: 'tree-name plain'}, name) : name,
      typeof extra.meta === 'string' ? h('span', {class: 'tree-meta'}, extra.meta) : extra.meta ?? null));
}

export function newRepo(ctx: Context): Node[] {
  const name = h('input', {id: 'repo-name', class: 'line-in', maxlength: '64', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'my-repo', 'aria-describedby': 'repo-name-rule'}) as HTMLInputElement;
  name.value = draft.name;
  const scaffold = templateFiles('{name}', SCAFFOLD);
  // The scaffold in File's order (folders first, then names), each file's name a field; the order stays put while a name is written.
  const inputs = new Map<string, HTMLInputElement>();
  // As File will show it: /root (repo), and in it the repo, the one in hand, filled as File fills the repo worked on.
  const repoRow = row('my-repo', 1, true, {repo: true});
  const items: HTMLElement[] = [row('root', 0, true, {meta: t(ORIGIN_LABEL.repos)}), repoRow];
  // The README's size as File gives a file's, of what it will say: it follows the name and what it is for.
  const readmeSize = h('span', {class: 'tree-meta'});
  // Under the README's row, what it will say: its title the repo's name, then what it is for, as written beside.
  const peek = h('li', {class: 'readme-peek', 'aria-hidden': 'true'});
  const walk = (nodes: Item[], depth: number) => {
    for (const n of nodes) {
      if (n.dir) { items.push(row(n.name, depth, true, {shut: !n.children.length})); walk(n.children, depth + 1); continue; }
      const field = h('input', {class: 'tree-name-in', autocapitalize: 'off', spellcheck: 'false', maxlength: '255',
        placeholder: n.name, 'aria-label': t('Name of {path}', {path: n.path})}) as HTMLInputElement;
      field.value = draft.names[n.path] ?? n.name;
      inputs.set(n.path, field);
      items.push(row(field, depth, false, n.path === 'README.md' ? {meta: readmeSize} : {}));
      if (n.path === 'README.md') { peek.style.setProperty('--depth', String(depth)); items.push(peek); }
    }
  };
  walk(nest(scaffold), 2);
  const preview = h('ul', {class: 'tree-children'}, ...items);
  // What the card is goes to the ear: the eye sees it is File's tree.
  const caption = h('p', {class: 'sr-only'}, t('How it will look in File'));
  const card = h('div', {class: 'tree tree-still', 'aria-label': t('What will be made')}, caption, preview);
  // What cannot be made as named is said under the box, where it is put right.
  const filesError = h('p', {class: 'error', role: 'alert', hidden: ''});
  const keep = () => {
    draft = {name: name.value, summary: summary.value, names: Object.fromEntries([...inputs].filter(([p, i]) => i.value !== base(p)).map(([p, i]) => [p, i.value]))};
  };
  const laid = () => laidFiles(scaffold, draft.names);
  const showFiles = () => {
    repoRow.querySelector('.tree-name')!.textContent = name.value.trim() || 'my-repo';
    const {problem} = laid();
    for (const [p, i] of inputs) i.toggleAttribute('aria-invalid', problem?.path === p);
    filesError.textContent = problem ? problem.why : '';
    filesError.hidden = !problem;
  };
  for (const i of inputs.values()) {
    i.addEventListener('input', () => { keep(); showFiles(); });
    // Enter puts the name down, as in File; it never makes the repo from inside the box.
    i.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); i.blur(); } });
  }
  // What it is for, in a raised box as Home's TODO is: the words written straight in it, the box the field.
  const summary = h('textarea', {id: 'repo-summary', class: 'todo-detail', maxlength: '2000',
    placeholder: t('What this repo is for'), 'aria-labelledby': 'repo-summary-label'}) as HTMLTextAreaElement;
  summary.value = draft.summary;
  const summaryBox = h('div', {class: 'summary-box'}, summary);
  /** The README as it will be written, a few lines of it, numbered as Forge numbers them. */
  const paintPeek = () => {
    const about = summary.value.trim();
    const n = name.value.trim() || 'my-repo';
    const lines = [`# ${n}`, ...(about ? ['', ...about.split('\n')] : [])];
    // Written as Create writes it: under the title what it is for, or the scaffold's own README.
    const text = about ? `# ${n}\n\n${about}\n` : templateFiles(n, SCAFFOLD).get('README.md') ?? '';
    readmeSize.textContent = bytes(new TextEncoder().encode(text).length);
    peek.replaceChildren(...lines.slice(0, 6).map((l, i) => h('span', {class: 'peek-line'}, h('span', {class: 'peek-no'}, String(i + 1)), h('span', {}, l || ' '))),
      ...(lines.length > 6 ? [h('span', {class: 'peek-line'}, h('span'), h('span', {}, '…'))] : []));
  };
  // The whole box is the field, as the TODO's is.
  summaryBox.addEventListener('pointerdown', (event) => { if (event.target === summaryBox) { event.preventDefault(); summary.focus(); } });
  summary.addEventListener('input', () => { keep(); paintPeek(); });
  // Said where it is to be put right: under the name.
  const error = h('p', {class: 'error', role: 'alert'});
  const submit = h('button', {class: 'button primary', type: 'submit'}, t('Create')) as HTMLButtonElement;
  const actions = h('div', {class: 'answers'}, h('span', {class: 'grow'}), submit);

  /** Made: the page stays, and says where to go from here; what was written goes with it. */
  const made = (n: string) => {
    draft = fresh();
    name.disabled = true;
    summary.disabled = true;
    for (const i of inputs.values()) i.disabled = true;
    caption.textContent = t('Made at /root/{name} in File', {name: n});
    const open = h('button', {class: 'button primary', type: 'button'}, t('Open in Forge'));
    open.addEventListener('click', () => ctx.openRepo(n));
    const again = h('button', {class: 'button', type: 'button'}, t('Make another'));
    again.addEventListener('click', () => { draft = fresh(); ctx.rerender(); });
    actions.replaceChildren(h('p', {class: 'made', role: 'status'}, t('Made {name}', {name: n})), h('span', {class: 'grow'}), again, open);
    open.focus({preventScroll: true});
    // What was written becomes the repo's card: an outline goes from the summary down to where it joins the others.
    const from = where(summaryBox)!;
    void list.refresh(n).then(() => morph(from, () => list.element.querySelector<HTMLElement>(`.card.repo[data-repo="${CSS.escape(n)}"]`), 420));
  };
  // The name alone on the first line; under it, what it is for, and beside that the scaffold with what it will make.
  const form = h('form', {class: 'new-repo'},
    h('div', {class: 'field name-field'}, h('label', {class: 'field-label', for: 'repo-name'}, t('Name')), name,
      // The rule for a name is heard with the field and seen only when it is broken (the error under it).
      h('span', {id: 'repo-name-rule', class: 'sr-only'}, t('Letters, digits and . _ -, up to 64 characters')), error),
    h('div', {class: 'field summary-field'}, h('span', {class: 'field-label', id: 'repo-summary-label'}, t('Summary')), summaryBox),
    h('div', {class: 'field scaffold-field'}, h('span', {class: 'field-label'}, t('What will be made')), card, filesError),
    actions);
  name.addEventListener('input', () => { error.textContent = ''; keep(); showFiles(); paintPeek(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    if (!validName(n)) { error.textContent = t('Use letters, digits and . _ -, and do not start with .'); name.focus(); nudge(name); return; }
    // A name taken is the name's to change, as a name not allowed is: the keyboard goes back to it, as written.
    // One the Remote keeps and this device does not hold yet is taken too: it is the same repo, not another of that name.
    if ((await store.list()).some((r) => r.name === n) || remoteOnly().some((r) => r.name === n)) { error.textContent = t('There is a repo named {name} already', {name: n}); name.focus(); nudge(name); return; }
    // A file that cannot be named so is the box's to change: the keyboard goes to it.
    const {problem} = laid();
    if (problem) { inputs.get(problem.path)?.focus(); return; }
    submit.disabled = true;
    try {
      await store.create(n, SCAFFOLD);
    } catch (e) {
      error.textContent = t('Could not create: {message}', {message: errorText(e)});
      submit.disabled = false;
      submit.focus();
      return;
    }
    // Named as written in the box: each file renamed, and what another says of its path said anew.
    const about = summary.value.trim();
    const real = laidFiles(templateFiles(n, SCAFFOLD), draft.names).files;
    const unwritten: string[] = [];
    for (const f of real) {
      if (f.from === f.to) continue;
      try { await store.rename(n, f.from, base(f.to)); } catch (e) { f.to = f.from; unwritten.push(t('{what} could not be written ({why})', {what: `${n}/${f.to}`, why: errorText(e)})); }
    }
    const original = templateFiles(n, SCAFFOLD);
    for (const f of real) {
      // What it is for goes into the README (named as it was written), under its title.
      const readme = f.from === 'README.md' && about;
      const text = readme ? `# ${n}\n\n${about}\n` : f.text;
      if (text === original.get(f.from)) continue;
      try { await store.write(n, f.to, text); } catch (e) { unwritten.push(t('{what} could not be written ({why})', {what: `${n}/${f.to}`, why: errorText(e)})); }
    }
    // Made, it is gone into at once: what was written becomes its README, the summary's sheet growing into that box
    // in Forge, the caret in it. Only what could not be written keeps the page, to say so.
    if (!unwritten.length) {
      draft = fresh();
      ctx.openRepo(n, real.find((f) => f.from === 'README.md')?.to ?? '', 'end', summaryBox);
      return;
    }
    made(n);
    error.textContent = unwritten.join(' ');
  });
  // The repos already there, right under the form; a new one joins them.
  const list = repoList(ctx, {newCard: false});
  void list.refresh();
  showFiles();
  paintPeek();
  queueMicrotask(() => name.focus());
  return [pageHead('new-repo'), h('div', {class: 'new-repo-wrap'}, form),
    h('section', {class: 'section', 'aria-labelledby': 'new-repo-list'}, h('h2', {id: 'new-repo-list'}, t('Repos')), list.element)];
}
