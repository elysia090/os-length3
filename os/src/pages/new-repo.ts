import {bytes, h} from '../ui/dom.ts';
import {t} from '../i18n.ts';
import {remoteOnly} from '../remote/lifecycle.ts';
import {store, templateFiles, validName, type Template} from '../repos/repos.ts';
import {pageHead} from './common.ts';
import {repoList} from './repo-list.ts';
import type {Context} from './context.ts';
import {triangle} from './tree.ts';
import {ORIGIN_LABEL} from '../prompt/system.ts';
import {errorText} from '../app/errors.ts';
import {LAND, morph, nudge, paced, still, where} from '../ui/glide.ts';

/**
 * +: the repo's name on the first line; under it, in a large box, what it
 * is for, and beside that what will be made, shown exactly as File will show
 * it: /root, the repos already there, and among them, in its place by name,
 * the new one with the one scaffold every repo starts from. Make it, and it is
 * gone into in Forge. What it is for is the repo's own: it goes into its
 * README, under the title. Its files are named and laid out in File, where
 * every repo's are.
 *
 * What is written here before Create stays while other pages are looked at,
 * and goes once the repo is made (Make another is a fresh form).
 */

/**
 * The scaffold (shared/templates.json's `standard`, as `l3 repo new` makes
 * it): a README, with docs/ and issue/, in no language of its own. There is
 * no choosing.
 */
const SCAFFOLD: Template = 'standard';

/** What is written before Create: kept while the app runs, as a half-written issue is. */
interface Draft { name: string; summary: string }
let draft: Draft = {name: '', summary: ''};
const fresh = (): Draft => ({name: '', summary: ''});

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

function row(name: string | Node[], depth: number, dir: boolean, extra: Partial<{meta: Node | string; kind: string; shut: boolean}> = {}): HTMLElement {
  // A folder with nothing in it yet is shut, as File shows one: an open triangle over nothing says there is something.
  const lead = dir ? h('span', {class: 'tree-toggle', 'aria-hidden': 'true', 'aria-expanded': String(!extra.shut)}) : h('span', {class: 'tree-spacer', 'aria-hidden': 'true'});
  if (dir) lead.append(triangle());
  return h('li', {class: extra.kind ?? (dir ? 'tree-dir' : 'tree-file')},
    h('div', {class: 'tree-row', style: `--depth:${depth}`}, lead, h('span', {class: 'tree-name plain'}, ...(typeof name === 'string' ? [name] : name)),
      typeof extra.meta === 'string' ? h('span', {class: 'tree-meta'}, extra.meta) : extra.meta ?? null));
}

export function newRepo(ctx: Context): Node[] {
  const name = h('input', {id: 'repo-name', class: 'line-in', maxlength: '64', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'my-repo', 'aria-describedby': 'repo-name-rule'}) as HTMLInputElement;
  name.value = draft.name;
  const scaffold = nest(templateFiles('{name}', SCAFFOLD));
  // The README's size as File gives a file's, of what it will say: it follows the name and what it is for.
  const readmeSize = h('span', {class: 'tree-meta'});
  /**
   * Why the name cannot be, as it is written: not a name (a letter no name has, or a dot first), or one taken here
   * or on the Remote; '' when it can be (or nothing is written yet, the example standing for it).
   */
  const why = (n: string): string => !n ? '' : !validName(n) ? t('Use letters, digits and . _ -, and do not start with .')
    : others.includes(n) || remoteOnly().some((r) => r.name === n) ? t('There is a repo named {name} already', {name: n}) : '';
  /** The name as it will stand in File, each letter a name cannot have marked where it is (a dot first, too). */
  const marked = (n: string): Node[] => [...n].map((c, i) => (/[A-Za-z0-9_-]/.test(c) || (c === '.' && i > 0) ? document.createTextNode(c)
    // A space is seen as one, or it would be nothing between two letters.
    : h('mark', {class: 'bad-char'}, /\s/.test(c) ? '␣' : c)));
  /** The new repo's own rows: it, filled as File fills the repo in hand, and its scaffold, folders first. */
  const ours = (): HTMLElement[] => {
    const n = name.value.trim(), bad = !!why(n);
    const rows = [row(n ? marked(n) : 'my-repo', 1, true, {kind: `tree-repo tree-new${bad ? ' tree-bad' : ''}`})];
    const walk = (nodes: Item[], depth: number) => {
      for (const n of nodes) {
        rows.push(row(n.name, depth, n.dir, {kind: `${n.dir ? 'tree-dir' : 'tree-file'} tree-ours`, shut: n.dir && !n.children.length,
          meta: n.path === 'README.md' ? readmeSize : undefined}));
        if (n.dir) walk(n.children, depth + 1);
      }
    };
    walk(scaffold, 2);
    return rows;
  };
  // The repos here already, shut, quieter than the new one; it stands among them where its name puts it.
  let others: string[] = [];
  const preview = h('ul', {class: 'tree-children'});
  const showFiles = () => {
    const mine = name.value.trim() || 'my-repo';
    const before = others.filter((o) => o.localeCompare(mine) < 0), after = others.filter((o) => o.localeCompare(mine) >= 0);
    // One of the same name is the one it would be taken for: marked where it stands.
    const other = (o: string) => { const r = row(o, 1, true, {kind: `tree-repo tree-other${o === mine && name.value.trim() ? ' tree-clash' : ''}`, shut: true}); r.dataset.key = `o ${o}`; return r; };
    // Its name moved past another's, the rows go to their new places on their curve, not swapped in one frame: each
    // from where it was seen (mid-way, if it was still going), the new repo's rows as one with it.
    const was = new Map<string, number>();
    for (const li of preview.children as HTMLCollectionOf<HTMLElement>) if (li.dataset.key) was.set(li.dataset.key, li.getBoundingClientRect().top);
    const mineRows = ours();
    mineRows.forEach((r, i) => { r.dataset.key = `n ${i}`; });
    preview.replaceChildren(row('root', 0, true, {meta: t(ORIGIN_LABEL.repos)}), ...before.map(other), ...mineRows, ...after.map(other));
    if (still() || !was.size) return;
    for (const li of preview.children as HTMLCollectionOf<HTMLElement>) {
      const from = li.dataset.key ? was.get(li.dataset.key) : undefined;
      const by = from === undefined ? 0 : from - li.getBoundingClientRect().top;
      if (Math.abs(by) > .5) li.animate([{translate: `0 ${by}px`}, {translate: '0 0'}], {duration: paced(260), easing: LAND});
    }
  };
  void store.list().then((list) => { others = list.map((r) => r.name).sort((a, b) => a.localeCompare(b)); showFiles(); judge(); }, () => {});
  // What the card is goes to the ear: the eye sees it is File's tree.
  const caption = h('p', {class: 'sr-only'}, t('How it will look in File'));
  const card = h('div', {class: 'tree tree-still', 'aria-label': t('What will be made')}, caption, preview);
  const keep = () => { draft = {name: name.value, summary: summary.value}; };
  // What it is for, in a raised box as Home's TODO is: the words written straight in it, the box the field.
  const summary = h('textarea', {id: 'repo-summary', class: 'todo-detail', maxlength: '2000',
    placeholder: t('What this repo is for'), 'aria-labelledby': 'repo-summary-label'}) as HTMLTextAreaElement;
  summary.value = draft.summary;
  const summaryBox = h('div', {class: 'summary-box'}, summary);
  /** The README as Create writes it: under the title what it is for, or the scaffold's own README. */
  const readme = (n: string) => {
    const about = summary.value.trim();
    return about ? `# ${n}\n\n${about}\n` : templateFiles(n, SCAFFOLD).get('README.md') ?? '';
  };
  const sized = () => { readmeSize.textContent = bytes(new TextEncoder().encode(readme(name.value.trim() || 'my-repo')).length); };
  // The whole box is the field, as the TODO's is.
  summaryBox.addEventListener('pointerdown', (event) => { if (event.target === summaryBox) { event.preventDefault(); summary.focus(); } });
  summary.addEventListener('input', () => { keep(); sized(); });
  // Said where it is to be put right: under the name.
  const error = h('p', {class: 'error', role: 'alert'});
  const submit = h('button', {class: 'button primary', type: 'submit'}, t('Create')) as HTMLButtonElement;
  const actions = h('div', {class: 'answers'}, h('span', {class: 'grow'}), submit);

  /** Made, but what it is for could not be written: the page stays, says so, and where to go from here. */
  const made = (n: string) => {
    draft = fresh();
    name.disabled = true;
    summary.disabled = true;
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
  // The name alone on the first line; under it, what it is for, and beside that what will be made.
  const form = h('form', {class: 'new-repo'},
    h('div', {class: 'field name-field'}, h('label', {class: 'field-label', for: 'repo-name'}, t('Name')), name,
      // The rule for a name is heard with the field and seen only when it is broken (the error under it).
      h('span', {id: 'repo-name-rule', class: 'sr-only'}, t('Letters, digits and . _ -, up to 64 characters')), error),
    h('div', {class: 'field summary-field'}, h('span', {class: 'field-label', id: 'repo-summary-label'}, t('Summary')), summaryBox),
    h('div', {class: 'field scaffold-field'}, h('span', {class: 'field-label'}, t('What will be made')), card),
    actions);
  // Said as it is written, not only once Create is pressed: why it cannot be, under the name, and where in it.
  const judge = () => {
    const said = why(name.value.trim());
    if (error.textContent !== said) error.textContent = said;
    if (said) name.setAttribute('aria-invalid', 'true'); else name.removeAttribute('aria-invalid');
  };
  name.addEventListener('input', () => { keep(); showFiles(); sized(); judge(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    if (!validName(n)) { error.textContent = t('Use letters, digits and . _ -, and do not start with .'); name.focus(); nudge(name); return; }
    // A name taken is the name's to change, as a name not allowed is: the keyboard goes back to it, as written.
    // One the Remote keeps and this device does not hold yet is taken too: it is the same repo, not another of that name.
    if ((await store.list()).some((r) => r.name === n) || remoteOnly().some((r) => r.name === n)) { error.textContent = t('There is a repo named {name} already', {name: n}); name.focus(); nudge(name); return; }
    submit.disabled = true;
    try {
      await store.create(n, SCAFFOLD);
    } catch (e) {
      error.textContent = t('Could not create: {message}', {message: errorText(e)});
      submit.disabled = false;
      submit.focus();
      return;
    }
    // What it is for goes into the README, under its title.
    if (summary.value.trim()) {
      try { await store.write(n, 'README.md', readme(n)); } catch (e) {
        made(n);
        error.textContent = t('{what} could not be written ({why})', {what: `${n}/README.md`, why: errorText(e)});
        return;
      }
    }
    // Made, it is gone into at once: what was written becomes its README, the summary's sheet growing into that box
    // in Forge, the caret in it.
    draft = fresh();
    ctx.openRepo(n, 'README.md', 'end', summaryBox);
  });
  // The repos already there, right under the form; a new one joins them.
  const list = repoList(ctx, {newCard: false});
  void list.refresh();
  showFiles();
  sized();
  queueMicrotask(() => name.focus());
  return [pageHead('new-repo'), h('div', {class: 'new-repo-wrap'}, form),
    h('section', {class: 'section', 'aria-labelledby': 'new-repo-list'}, h('h2', {id: 'new-repo-list'}, t('Repos')), list.element)];
}
