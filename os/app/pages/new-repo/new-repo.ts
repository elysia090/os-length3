import {bytes, h} from '../../ui/dom.ts';
import {t, tn} from '../../i18n/i18n.ts';
import {connection} from '../../remote/connection.ts';
import {plan} from '../../remote/plan.ts';
import {goToPlan} from '../kit/plan-gate.ts';
import {remoteOnly} from '../../remote/lifecycle.ts';
import {isIssues, ISSUES, plainPath, store, templateFiles, validName, type Template} from '../../repos/repos.ts';
import {onTheGround} from '../home/home.ts';
import type {Context} from '../kit/context.ts';
import {triangle} from '../file/tree.ts';
import {errorText} from '../../host/errors.ts';
import {mark} from '../../ui/icons.ts';
import {liftLine, nudge, putAway, textAt, unfold} from '../../ui/glide.ts';
import {fitSize} from '../../ui/optical.ts';

/**
 * +: the repo's name on the first line; under it, in a large box, what it
 * is for, and beside that what will be made in it: the repo alone, as File
 * will show it (nothing else of the device's), from the one scaffold every
 * repo starts from, and there its files are made, renamed and left out before
 * it is, as File makes, renames and deletes them. Make it, and it is gone into
 * in Forge. What it is for is the repo's own: it goes into its README, under
 * the title (and wherever the README is renamed to).
 *
 * What is written here before Create stays while other pages are looked at,
 * and goes once the repo is made (Make another is a fresh form).
 */

/**
 * The scaffold (shared/templates.json's `standard`, as `l3 repo new` makes
 * it): a README, with docs/, in no language of its own. There is no
 * choosing; what is made from it is changed here, file by file.
 */
const SCAFFOLD: Template = 'standard';

/** One thing to be made in the repo: a folder or a file, by its path; the README's words are what it is for. */
interface Made { path: string; dir: boolean; readme?: true }
/** What is written before Create, the files to be made among it: kept while the app runs, as a half-written issue is. */
interface Draft { name: string; summary: string; made: Made[] }
const scaffold = (): Made[] => [...templateFiles('{name}', SCAFFOLD)].map(([path, text]) => ({path, dir: text === null, ...(path === 'README.md' ? {readme: true as const} : {})}));
const fresh = (): Draft => ({name: '', summary: '', made: scaffold()});
let draft: Draft = fresh();

interface Item { name: string; path: string; dir: boolean; readme: boolean; children: Item[] }
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** What will be made as a tree, folders first then names, as File lists them (a folder only named by a path too). */
function nest(made: readonly Made[]): Item[] {
  const root: Item = {name: '', path: '', dir: true, readme: false, children: []};
  for (const m of made) {
    const parts = m.path.split('/');
    let at = root;
    parts.forEach((part, i) => {
      const dir = i < parts.length - 1 || m.dir;
      let next = at.children.find((c) => c.name === part);
      if (!next) { next = {name: part, path: parts.slice(0, i + 1).join('/'), dir, readme: false, children: []}; at.children.push(next); }
      if (i === parts.length - 1 && m.readme) next.readme = true;
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

function row(name: string | Node[] | HTMLElement, depth: number, dir: boolean, extra: Partial<{meta: Node | string; kind: string; shut: boolean; tail: Node}> = {}): HTMLElement {
  // A folder with nothing in it yet is shut, as File shows one: an open triangle over nothing says there is something.
  const lead = dir ? h('span', {class: 'tree-toggle', 'aria-hidden': 'true', 'aria-expanded': String(!extra.shut)}) : h('span', {class: 'tree-spacer', 'aria-hidden': 'true'});
  if (dir) lead.append(triangle());
  const named = name instanceof HTMLElement ? name : h('span', {class: 'tree-name plain'}, ...(typeof name === 'string' ? [name] : name));
  return h('li', {class: extra.kind ?? (dir ? 'tree-dir' : 'tree-file')},
    h('div', {class: 'tree-row', style: `--depth:${depth}`}, lead, named,
      typeof extra.meta === 'string' ? h('span', {class: 'tree-meta'}, extra.meta) : extra.meta ?? null, extra.tail ?? null));
}

/** A small deed on a row, its mark alone, named for the ear and the pointer's rest. */
const rowDeed = (m: 'pen' | 'close', said: string, act: () => void) => {
  const b = h('button', {type: 'button', class: 'tree-deed', 'aria-label': said, title: said}, mark(m)) as HTMLButtonElement;
  b.addEventListener('click', act);
  return b;
};

export function newRepo(ctx: Context): Node[] {
  // No example in it: one there reads as a name already given (and the row it would draw, as the repo to be made).
  const name = h('input', {id: 'repo-name', class: 'nr-name', maxlength: '64', autocapitalize: 'off', spellcheck: 'false', required: '',
    'aria-describedby': 'repo-name-rule'}) as HTMLInputElement;
  name.value = draft.name;
  // The README's size as File gives a file's, of what it will say: it follows the name and what it is for.
  const readmeSize = h('span', {class: 'tree-meta'});
  /**
   * Why the name cannot be, as it is written: not a name (a letter no name has, or a dot first), or one taken here
   * or on the Remote; '' when it can be, or nothing is written yet (said only once Create is pressed).
   */
  const why = (n: string): string => !n ? '' : !validName(n) ? t('Use letters, digits, and . _ - (cannot start with .)')
    : others.includes(n) || remoteOnly().some((r) => r.name === n) ? t('A repo named "{name}" already exists', {name: n}) : '';
  /** The name as it will stand in File, each letter a name cannot have marked where it is (a dot first, too). */
  const marked = (n: string): Node[] => [...n].map((c, i) => (/[A-Za-z0-9_-]/.test(c) || (c === '.' && i > 0) ? document.createTextNode(c)
    // A space is seen as one, or it would be nothing between two letters.
    : h('mark', {class: 'bad-char'}, /\s/.test(c) ? '␣' : c)));
  /** What will be made, as written here (kept with the draft); the path being renamed, if one is. */
  let made: Made[] = draft.made.map((m) => ({...m}));
  let renaming: string | null = null;
  /** Why what was written over a name cannot be, under the card; '' while nothing is wrong. */
  const fileError = h('p', {class: 'error small', role: 'alert'});
  /** The repos here already: a name of theirs is taken (said under the name, as it is written). */
  let others: string[] = [];
  const preview = h('ul', {class: 'tree-children'});
  /** The path `name` comes to in the folder `dir`, or the first of name-2, name-3… not made there yet. */
  const free = (dir: string, name: string) => {
    const at = (n: string) => (dir ? `${dir}/${n}` : n);
    const dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
    let n = name;
    for (let k = 2; made.some((m) => m.path === at(n)); k++) n = `${name.slice(0, dot)}-${k}${name.slice(dot)}`;
    return at(n);
  };
  /**
   * The repo to be made, alone: its row (filled as File fills the repo in hand; nothing named yet, a quiet dashed
   * place for its name), and what will be made in it, folders first, each to be renamed or left out where it stands.
   */
  const showFiles = (came: string | null = null) => {
    const n = name.value.trim(), bad = !!why(n);
    const rows = [row(n ? marked(n) : t('Name'), 0, true, {kind: `tree-repo tree-new${bad ? ' tree-bad' : ''}${n ? '' : ' tree-unnamed'}`})];
    const walk = (nodes: Item[], depth: number) => {
      for (const it of nodes) {
        const named = renaming === it.path ? field(it.path) : h('button', {type: 'button', class: 'tree-name', title: t('Rename {name}', {name: it.name})}, it.name);
        if (named instanceof HTMLButtonElement) named.addEventListener('click', () => rename(it.path));
        const li = row(named, depth, it.dir, {kind: `${it.dir ? 'tree-dir' : 'tree-file'} tree-ours`, shut: it.dir && !it.children.length,
          meta: it.readme ? readmeSize : undefined,
          tail: h('span', {class: 'tree-deeds'}, rowDeed('pen', t('Rename {name}', {name: it.name}), () => rename(it.path)),
            rowDeed('close', t('Leave out {name}', {name: it.name}), () => leaveOut(it.path, li)))});
        li.dataset.path = it.path;
        rows.push(li);
        if (it.dir) walk(it.children, depth + 1);
      }
    };
    walk(nest(made), 1);
    preview.replaceChildren(...rows);
    const come = came ? preview.querySelector<HTMLElement>(`li[data-path="${CSS.escape(came)}"]`) : null;
    if (come) unfold(come, 200);
    const editing = preview.querySelector<HTMLInputElement>('.tree-rename');
    if (editing) {
      editing.focus({preventScroll: true});
      // A file's name without its ending is chosen, as Forge's New file and File's Rename choose it.
      const dot = editing.value.lastIndexOf('.');
      editing.setSelectionRange(0, dot > 0 ? dot : editing.value.length);
    }
  };
  /** The name of `path` as a field to write over: Enter or leaving it takes what is written, Escape what was. */
  const field = (path: string): HTMLInputElement => {
    const f = h('input', {class: 'tree-rename', 'aria-label': t('New name'), spellcheck: 'false', autocapitalize: 'off', value: baseOf(path)}) as HTMLInputElement;
    f.style.width = `${Math.max(8, baseOf(path).length + 2)}ch`;
    f.addEventListener('input', () => { f.style.width = `${Math.max(8, f.value.length + 2)}ch`; fileError.textContent = ''; });
    let done = false;
    const end = (take: boolean) => {
      if (done) return;
      const said = take ? moved(path, f.value) : '';
      if (said) { fileError.textContent = said; nudge(f); f.focus(); return; }
      done = true;
      renaming = null;
      keep();
      showFiles();
    };
    f.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fileError.textContent = ''; end(false); }
    });
    f.addEventListener('blur', () => { if (!done && !fileError.textContent) end(true); });
    return f;
  };
  /**
   * `path` given the name `written` (a path from its folder moves it there: notes/plan.md, its folders made with it),
   * and all in it with it; '' when done, else why it cannot be.
   */
  const moved = (path: string, written: string): string => {
    const to = written.trim().replace(/^\/+|\/+$/g, '');
    if (!to || to === baseOf(path)) return '';
    const dir = parentOf(path), full = dir ? `${dir}/${to}` : to;
    if (!plainPath(full)) return t('Paths joined by "/", segments cannot start with "."');
    if (isIssues(full)) return t('"{name}" is where the repo\'s issues are kept', {name: ISSUES});
    if (made.some((m) => m.path === full || m.path.startsWith(`${full}/`))) return t('"{name}" already exists', {name: to});
    made = made.map((m) => (m.path === path || m.path.startsWith(`${path}/`) ? {...m, path: full + m.path.slice(path.length)} : m));
    // The folders a path written goes into are made with it.
    for (let up = parentOf(full); up && up !== dir; up = parentOf(up)) if (!made.some((m) => m.path === up)) made.push({path: up, dir: true});
    return '';
  };
  const rename = (path: string) => { fileError.textContent = ''; renaming = path; showFiles(); };
  /** `path` and all in it not made: its row folds away and the rows under it close up. */
  const leaveOut = (path: string, li: HTMLElement) => {
    fileError.textContent = '';
    made = made.filter((m) => m.path !== path && !m.path.startsWith(`${path}/`));
    keep();
    putAway(li, () => showFiles(), {fold: true, ms: 180});
  };
  /** A new file or folder at the repo's top, named as nothing there yet is, its name at once a field to write over. */
  const add = (dir: boolean) => {
    const path = free('', dir ? t('folder') : 'untitled.md');
    made.push({path, dir});
    keep();
    renaming = path;
    showFiles(path);
  };
  const newFile = h('button', {type: 'button', class: 'tree-make'}, mark('new-file'), h('span', {}, t('New file')));
  const newFolder = h('button', {type: 'button', class: 'tree-make'}, mark('new-folder'), h('span', {}, t('New folder')));
  newFile.addEventListener('click', () => add(false));
  newFolder.addEventListener('click', () => add(true));
  void store.names().then((names) => { others = names.sort((a, b) => a.localeCompare(b)); showFiles(); judge(); }, () => {});
  // What the card is goes to the ear: the eye sees it is File's tree, the repo's own.
  const caption = h('p', {class: 'sr-only'}, t('Preview in File'));
  const card = h('div', {class: 'tree tree-still', 'aria-label': t('Items to create')}, caption, preview,
    h('div', {class: 'tree-makes'}, newFile, newFolder), fileError);
  // Where it will stand, said over its box as a file's place is over a box on the desk: ~/ and the name as written.
  const place = h('span', {class: 'nr-where'});
  const placed = () => { place.textContent = name.value.trim(); };
  const keep = () => { draft = {name: name.value, summary: summary.value, made: made.map((m) => ({...m}))}; };
  // What it is for, under the name in the box, the words written straight in it, the box the field.
  const summary = h('textarea', {id: 'repo-summary', class: 'todo-detail', maxlength: '2000', rows: '1',
    placeholder: t('Description / Purpose'), 'aria-labelledby': 'repo-summary-label'}) as HTMLTextAreaElement;
  summary.value = draft.summary;
  const summaryBox = h('div', {class: 'summary-box'}, summary);
  /** The README as Create writes it: under the title what it is for, or the scaffold's own README. */
  const readme = (n: string) => {
    const about = summary.value.trim();
    return about ? `# ${n}\n\n${about}\n` : templateFiles(n, SCAFFOLD).get('README.md') ?? '';
  };
  const sized = () => { readmeSize.textContent = bytes(new TextEncoder().encode(readme(name.value.trim())).length); };
  // The whole box is the field, as the TODO's is.
  summaryBox.addEventListener('pointerdown', (event) => { if (event.target === summaryBox) { event.preventDefault(); summary.focus(); } });
  // As tall as what is written in it, a line to begin with: the box grows with the words, never a field's empty room.
  const grow = () => { summary.style.height = 'auto'; summary.style.height = `${summary.scrollHeight}px`; };
  summary.addEventListener('input', () => { keep(); sized(); grow(); });
  // Narrowed or widened, the words fold again: as tall as they are at that width (not when it grows itself).
  let wide = 0;
  new ResizeObserver(() => { if (summary.clientWidth !== wide) { wide = summary.clientWidth; grow(); } }).observe(summary);
  // Said where it is to be put right: under the name.
  const error = h('p', {class: 'error', role: 'alert'});
  const submit = h('button', {class: 'button primary', type: 'submit'}, t('Create'), h('kbd', {'aria-hidden': 'true'}, '↵')) as HTMLButtonElement;
  // The plan full (signed in, on a Remote that has one): said before Create, not found out after. It is made all the
  // same, and stays on this device until there is room on the Remote.
  const full = h('p', {class: 'muted small plan-full', role: 'note', hidden: ''});
  const actions = h('div', {class: 'answers'}, full, h('span', {class: 'grow'}), submit);
  if (connection()) void plan().then((p) => {
    const of = p.allowance?.repos ?? null;
    if (of === null || (p.usage?.repos ?? 0) < of) return;
    const see = h('button', {type: 'button', class: 'link'}, t('View plan'));
    see.addEventListener('click', () => goToPlan(ctx));
    full.replaceChildren(tn('Your plan allows {n} repo on Remote. This repo stays local until space is freed.',
      'Your plan allows {n} repos on Remote. This repo stays local until space is freed.', of), ' ', see);
    full.hidden = false;
  }, () => {});

  /** Made, but what it is for could not be written: the page stays, says so, and where to go from here. */
  const madeIt = (n: string) => {
    draft = fresh();
    name.disabled = true;
    summary.disabled = true;
    caption.textContent = t('Created at /root/{name} in File', {name: n});
    const open = h('button', {class: 'button primary', type: 'button'}, t('Open in Forge'));
    open.addEventListener('click', () => ctx.openRepo(n));
    const again = h('button', {class: 'button', type: 'button'}, t('Create another'));
    again.addEventListener('click', () => { draft = fresh(); ctx.rerender(); });
    actions.replaceChildren(h('p', {class: 'made', role: 'status'}, t('Created {name}', {name: n})), h('span', {class: 'grow'}), again, open);
    open.focus({preventScroll: true});
  };
  // One box being born where Forge will lay the repo's README: the name its first line, as large as Home's name; under
  // it what it is for (its README's words); Create at its foot. Why a name cannot be is said over the box, after where
  // it will stand, as a desk box says its place. Beside it, a box narrower than it, what will be made with it, as File
  // will show it (as Home's repos stand beside its TODO).
  const box = h('div', {class: 'nr-box', 'data-empty': t('name')},
    h('label', {class: 'sr-only', for: 'repo-name'}, t('Name')), name,
    // The rule for a name is heard with the field and seen only when it is broken (said over the box).
    h('span', {id: 'repo-name-rule', class: 'sr-only'}, t('Letters, digits, and . _ - (up to 64 chars)')),
    h('span', {class: 'sr-only', id: 'repo-summary-label'}, t('Summary')), summaryBox, actions);
  // The page says why a name cannot be, in its own words, never the browser's bubble for a field left empty.
  const label = h('div', {class: 'nr-label'}, h('span', {class: 'nr-path'}, '~/', place), h('span', {class: 'nr-kind'}, t('New repo')), error);
  // The files' box says over it, as the name's does, where it shows them: File's tree (heard with the tree, as its caption).
  const filesLabel = h('div', {class: 'nr-label nr-files-label', 'aria-hidden': 'true'}, h('span', {class: 'nr-path'}, t('File')));
  const form = h('form', {class: 'new-repo', novalidate: ''}, label, box, filesLabel, card);
  // The name on its one line as large as the box lets it be: 104 px while it is short, smaller as it grows longer (never
  // under 28, where it goes on past the box's edge as a field's words do), never cut at the edge before that; nothing
  // written, the word for it the same way.
  const fitted = () => {
    const cs = getComputedStyle(name), room = name.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4;
    const fits = fitSize(name, name.value || t('name'), room, -.04, fitted);
    if (fits) box.style.setProperty('--nr-name', `${Math.floor(Math.max(28, Math.min(104, fits)))}px`);
  };
  let across = 0;
  new ResizeObserver(() => { if (box.clientWidth !== across) { across = box.clientWidth; fitted(); } }).observe(box);
  // Said as it is written, not only once Create is pressed: why it cannot be, under the name, and where in it.
  const judge = () => {
    const said = why(name.value.trim());
    if (error.textContent !== said) error.textContent = said;
    if (said) name.setAttribute('aria-invalid', 'true'); else name.removeAttribute('aria-invalid');
  };
  name.addEventListener('input', () => { keep(); showFiles(); sized(); judge(); placed(); fitted(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    // Nothing written yet is not a name broken: what is wanted is said, under the field it goes in.
    if (!validName(n)) { error.textContent = n ? t('Use letters, digits, and . _ - (cannot start with .)') : t('Please enter a name first'); name.focus(); nudge(name); return; }
    // A name taken is the name's to change, as a name not allowed is: the keyboard goes back to it, as written.
    // One the Remote keeps and this device does not hold yet is taken too: it is the same repo, not another of that name.
    if ((await store.names()).includes(n) || remoteOnly().some((r) => r.name === n)) { error.textContent = t('A repo named "{name}" already exists', {name: n}); name.focus(); nudge(name); return; }
    submit.disabled = true;
    try {
      await store.create(n, 'empty');
    } catch (e) {
      error.textContent = t('Failed to create: {message}', {message: errorText(e)});
      submit.disabled = false;
      submit.focus();
      return;
    }
    // What was laid out here is what is made, as it is: its folders, then its files (the README's words what it is
    // for, wherever it was renamed to; a file made here, empty), and the minimal scaffold's README gone if it was left out.
    const readmeAt = made.find((m) => m.readme && !m.dir)?.path ?? null;
    let at = '';
    try {
      for (const m of made.filter((x) => x.dir).sort((a, b) => a.path.split('/').length - b.path.split('/').length)) { at = m.path; await store.mkdir(n, m.path); }
      for (const m of made.filter((x) => !x.dir)) {
        at = m.path;
        const text = m.readme ? readme(n) : '';
        if (m.path === 'README.md') await store.write(n, m.path, text); else await store.add(n, parentOf(m.path), baseOf(m.path), text);
      }
      if (!made.some((m) => m.path === 'README.md' && !m.dir)) { at = 'README.md'; await store.remove(n, 'README.md'); }
    } catch (e) {
      madeIt(n);
      error.textContent = t('Failed to write {what} ({why})', {what: `${n}/${at}`, why: errorText(e)});
      return;
    }
    // Made, it is gone into at once: what was written becomes its README, the summary's sheet growing into that box
    // in Forge, the caret in it, and its words going with it onto their line there (under the title and a line left
    // empty: readme), never a sheet gone empty on its way and the words come back after.
    draft = fresh();
    const words = summary.value.trim() && readmeAt ? liftLine(summary) : null;
    // The box it was written in grows into the README's box, standing where that is laid.
    ctx.openRepo(n, readmeAt ?? '', readmeAt ? 'end' : false, box, 0, words ? {lifted: words, to: (into) => {
      const area = into.querySelector<HTMLTextAreaElement>('textarea.code-edit');
      return area ? textAt(area, 2) : null;
    }} : undefined);
  });
  showFiles();
  sized();
  placed();
  queueMicrotask(() => name.focus({preventScroll: true}));
  // On the ground with Home's and Forge's band and pane: the rail goes between the three as a camera over one desk.
  return [onTheGround(h('div', {class: 'home-main new-repo-main', 'aria-label': t('New repo')}, form), ctx, store.list().catch(() => null))];
}
