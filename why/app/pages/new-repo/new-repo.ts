import {h} from '../../ui/dom.ts';
import {bytes} from '../../../text/format.ts';
import {t, tn} from '../../../text/i18n.ts';
import {connection} from '../../../shipto/connection.ts';
import {plan} from '../../../shipto/plan.ts';
import {goToPlan} from '../kit/plan-gate.ts';
import {remoteOnly} from '../../../shipto/lifecycle.ts';
import {isIssues, ISSUES, plainPath, store, templateFiles, validName, type Template} from '../../../repo/repos.ts';
import type {Context} from '../kit/context.ts';
import {errorText} from '../../../api/errors.ts';
import {mark} from '../../ui/icons.ts';
import {menuItem} from '../kit/common.ts';
import {deedsUnder} from '../kit/file-deeds.ts';
import {deskSearch, placesMenu} from '../kit/places.ts';
import {liftLine, nudge, putAway, textAt} from '../../ui/glide.ts';
import {caretIn} from '../../ui/caret.ts';
import {wholeCells} from '../../ui/row.ts';
import {cut as record} from '../../../repo/history.ts';

/**
 * +: one piece at the desk's edge, the hand's (DESIGN §10): the repo's name on
 * its first line; under it what it is for; under a rule what will be made in
 * it: the repo alone, as File will show it (nothing else of the device's), from the one scaffold every
 * repo starts from, and there its files are made, renamed and left out before
 * it is, as File makes, renames and deletes them. Make it, and it is gone into
 * in Forge. What it is for is the repo's own: it goes into its README, under
 * the title (and wherever the README is renamed to).
 *
 * What is written here before Create stays while other pages are looked at,
 * and goes once the repo is made (Make another is a fresh form).
 */

/**
 * The scaffold (why/repo/templates.json's `standard`, as `why repo new` makes
 * it): a README, with docs/, in no language of its own. There is no
 * choosing; what is made from it is changed here, file by file.
 */
const SCAFFOLD: Template = 'standard';

/** One thing to be made in the repo: a folder or a file, by its path; the README's words are what it is for. */
interface Made { path: string; dir: boolean; readme?: true }
type WritingAt = {field: 'name' | 'summary' | 'file'; start: number; end: number; direction: 'forward' | 'backward' | 'none'; x: number};
interface Naming { path: string; value: string; pending?: Made; scroll: number }
/** The draft is private to this live window; Back can put the hand back where it left off. */
interface Draft { name: string; summary: string; made: Made[]; naming?: Naming; at?: WritingAt }
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

function row(item: Item, name: HTMLElement, depth: number, meta?: HTMLElement, tail?: HTMLElement): HTMLElement {
  // The slash is part of the written folder name, not a column of its own.
  if (item.dir && name instanceof HTMLButtonElement)
    name.append(h('span', {class: 'tree-slash', 'aria-hidden': 'true'}, '/'));
  return h('li', {class: `${item.dir ? 'tree-dir' : 'tree-file'} tree-ours`, 'data-path': item.path},
    h('div', {class: 'tree-row', style: `--depth:${depth}`}, name, meta ?? null, tail ?? null));
}

/**
 * What can be done to a row, called by its one mark at its right end (DESIGN §5: a chevron, everywhere), always there
 * and quiet: Rename and Leave out, in a menu laid under it.
 */
function rowDeeds(name: string, rename: () => void, leaveOut: () => void): HTMLButtonElement {
  const said = t('Actions for {name}', {name});
  const more = h('button', {type: 'button', class: 'tree-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': said}, mark('down')) as HTMLButtonElement;
  more.addEventListener('click', () => {
    if (more.getAttribute('aria-expanded') === 'true') return;
    const again = menuItem(t('Rename'), 'pen'), out = menuItem(t('Leave out {name}', {name}), 'close');
    const pop = h('div', {class: 'pop tree-pop', role: 'menu', 'aria-label': said}, again, out);
    const away = deedsUnder(more, pop, () => {});
    again.addEventListener('click', () => { away(); rename(); });
    out.addEventListener('click', () => { away(); leaveOut(); });
  });
  return more;
}

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
  let naming = draft.naming && {...draft.naming};
  let finishName: ((accept: boolean) => boolean) | undefined;
  let finished = false;
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
   * What will be made in the repo, folders first, each to be renamed or left out where it stands. The repo itself is
   * the sheet, its name its title, said once: its row is not drawn again under it (DESIGN §10).
   */
  const showFiles = () => {
    const rows: HTMLElement[] = [];
    finishName = undefined;
    const walk = (nodes: Item[], depth: number) => {
      for (const it of nodes) {
        const edit = naming?.path === it.path ? naming : undefined;
        const named = edit ? field(edit) : h('button', {type: 'button', class: 'tree-name'}, it.name);
        if (named instanceof HTMLButtonElement) named.addEventListener('click', () => rename(it.path));
        const li = row(it, named, depth, it.readme ? readmeSize : undefined,
          edit?.pending ? undefined : rowDeeds(it.name, () => rename(it.path), () => leaveOut(it.path, li)));
        rows.push(li);
        if (it.dir) walk(it.children, depth + 1);
      }
    };
    walk(nest(naming?.pending ? [...made, naming.pending] : made), 0);
    preview.replaceChildren(...rows);
    summaryBox.hidden = !made.some((m) => m.readme && !m.dir);
  };
  const editing = () => preview.querySelector<HTMLInputElement>('.tree-rename');
  const startName = () => {
    showFiles();
    const f = editing();
    if (!f) return;
    f.focus({preventScroll: true});
    const dir = naming?.pending?.dir ?? made.find((item) => item.path === naming?.path)?.dir;
    const dot = dir ? -1 : f.value.lastIndexOf('.');
    f.setSelectionRange(0, dot > 0 ? dot : f.value.length);
    f.scrollIntoView({block: 'nearest', inline: 'nearest'});
  };
  // A new row is a proposal until there is a name. Escape takes it away; the prior order and names are unchanged.
  const field = (edit: Naming): HTMLInputElement => {
    const f = h('input', {class: 'tree-rename', 'aria-label': t('New name'), enterkeyhint: 'done', spellcheck: 'false', autocapitalize: 'off', value: edit.value}) as HTMLInputElement;
    const width = () => { f.style.width = `${Math.max(8, f.value.length + 2)}ch`; };
    width();
    f.addEventListener('input', () => { edit.value = f.value; keep(); width(); f.removeAttribute('aria-invalid'); fileError.textContent = ''; });
    remember(f, 'file');
    const end = (take: boolean) => {
      if (naming !== edit) return true;
      const affirm = take && (!edit.pending || Boolean(f.value.trim()));
      const result = affirm ? moved(edit, f.value) : {path: edit.path};
      if ('error' in result) { f.setAttribute('aria-invalid', 'true'); fileError.textContent = result.error; f.focus(); nudge(f); return false; }
      const keyboard = document.activeElement === f;
      const back = edit.pending?.dir ? newFolder : newFile;
      naming = undefined;
      if (draft.at?.field === 'file') delete draft.at;
      keep();
      showFiles();
      if (keyboard) {
        const anchor = (edit.pending && !affirm) ? back : preview.querySelector<HTMLElement>(`li[data-path="${CSS.escape(result.path)}"] .tree-name`);
        anchor?.focus({preventScroll: true});
        if (!affirm) window.scrollTo({top: edit.scroll, behavior: 'instant'});
      }
      return true;
    };
    finishName = end;
    f.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fileError.textContent = ''; end(false); }
    });
    f.addEventListener('blur', (e) => {
      // The next row's own click must run before rebuilding the row list. Search and Places borrow the hand only.
      const to = e.relatedTarget;
      if (to instanceof Node && form.contains(to) && !preview.contains(to) && !fileError.textContent)
        end(!edit.pending || f.value !== baseOf(edit.path));
    });
    return f;
  };
  /** Move a finished name and its children together; a draft row never enters the plan on a failed check. */
  const moved = (edit: Naming, written: string): {path: string} | {error: string} => {
    const {path, pending} = edit;
    const to = written.trim().replace(/^\/+|\/+$/g, '');
    if (!pending && (!to || to === baseOf(path))) return {path};
    const dir = parentOf(path), full = dir ? `${dir}/${to}` : to;
    if (!plainPath(full)) return {error: t('Paths joined by "/", segments cannot start with "."')};
    if (isIssues(full)) return {error: t('"{name}" is where the repo\'s issues are kept', {name: ISSUES})};
    const under = (p: string) => p === path || p.startsWith(`${path}/`);
    if (full.startsWith(`${path}/`) || made.some((m) => !under(m.path)
      && (m.path === full || m.path.startsWith(`${full}/`) || (!m.dir && full.startsWith(`${m.path}/`)))))
      return {error: t('"{name}" already exists', {name: to})};
    const planned = pending ? [...made, pending] : made;
    made = planned.map((m) => under(m.path) ? {...m, path: full + m.path.slice(path.length)} : m);
    for (let up = parentOf(full); up && up !== dir; up = parentOf(up)) if (!made.some((m) => m.path === up)) made.push({path: up, dir: true});
    return {path: full};
  };
  const rename = (path: string) => {
    if (naming && !finishName?.(true)) return;
    fileError.textContent = '';
    naming = {path, value: baseOf(path), scroll: window.scrollY};
    keep();
    startName();
  };
  /** `path` and all in it not made: its row folds away and the rows under it close up. */
  const leaveOut = (path: string, li: HTMLElement) => {
    fileError.textContent = '';
    if (naming && (naming.path === path || naming.path.startsWith(`${path}/`))) {
      naming = undefined;
      if (draft.at?.field === 'file') delete draft.at;
    }
    made = made.filter((m) => m.path !== path && !m.path.startsWith(`${path}/`));
    keep();
    putAway(li, () => showFiles(), {fold: true, ms: 180});
  };
  /** A new file or folder at the repo's top, named as nothing there yet is, its name at once a field to write over. */
  const add = (dir: boolean) => {
    if (naming && !finishName?.(true)) return;
    const path = free('', dir ? t('folder') : 'untitled.md');
    naming = {path, value: baseOf(path), pending: {path, dir}, scroll: window.scrollY};
    keep();
    startName();
  };
  const newFile = h('button', {type: 'button', class: 'tree-make'}, t('New file'));
  const newFolder = h('button', {type: 'button', class: 'tree-make'}, t('New folder'));
  newFile.addEventListener('click', () => add(false));
  newFolder.addEventListener('click', () => add(true));
  void store.names().then((names) => { others = names; judge(); }, () => {});
  // What the card is goes to the ear: the eye sees it is File's tree, the repo's own.
  const caption = h('p', {class: 'sr-only'}, t('Preview in File'));
  const card = h('section', {class: 'tree tree-still', 'aria-label': t('Items to create')}, caption, preview,
    h('div', {class: 'tree-makes'}, newFile, newFolder), fileError);
  // Where it will stand, said over its box as a file's place is over a box on the desk: ~/ and the name as written.
  const place = h('span', {class: 'nr-where'});
  // A letter no name can have is marked there, where it is, as the name will stand.
  const placed = () => place.replaceChildren(...marked(name.value.trim()));
  const keep = () => { if (!finished) draft = {name: name.value, summary: summary.value, made, naming, at: draft.at}; };
  function remember(field: HTMLInputElement | HTMLTextAreaElement, which: WritingAt['field']) {
    const read = () => {
      if (finished || (which === 'file' && !naming) || field.selectionStart == null || field.selectionEnd == null) return;
      draft.at = {field: which, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? 'none', x: field.scrollLeft};
    };
    for (const event of ['focus', 'blur', 'input', 'select', 'selectionchange']) field.addEventListener(event, read);
  }
  // What it is for, under the name in the box, the words written straight in it, the box the field.
  const summary = h('textarea', {id: 'repo-summary', class: 'todo-detail', maxlength: '2000', rows: '1',
    placeholder: t('Write the README…'), 'aria-labelledby': 'repo-summary-label'}) as HTMLTextAreaElement;
  summary.value = draft.summary;
  const summaryBox = h('div', {class: 'summary-box'}, summary);
  /** The README as Create writes it: under the title what it is for, or the scaffold's own README. */
  const readme = (n: string) => {
    const about = summary.value;
    return about ? `# ${n}\n\n${about}${about.endsWith('\n') ? '' : '\n'}` : templateFiles(n, SCAFFOLD).get('README.md') ?? '';
  };
  const sized = () => {
    const n = name.value.trim();
    readmeSize.hidden = !validName(n);
    if (!readmeSize.hidden) readmeSize.textContent = bytes(new TextEncoder().encode(readme(n)).length);
  };
  // The whole box is the field, as the TODO's is.
  summaryBox.addEventListener('pointerdown', (event) => { if (event.target === summaryBox) { event.preventDefault(); summary.focus(); } });
  // Two lines to begin with; the paper grows with what is written there.
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
    finished = true;
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
  // One box being born where Forge will lay the repo's README: the name its first line; under it what it is for (its
  // README's words); Create at its foot. Why a name cannot be is said over the box, after where it will stand, as a
  // desk box says its place.
  const box = h('div', {class: 'nr-box', 'data-empty': t('name')},
    h('label', {class: 'sr-only', for: 'repo-name'}, t('Name')), name,
    // The rule for a name is heard with the field and seen only when it is broken (said over the box).
    h('span', {id: 'repo-name-rule', class: 'sr-only'}, t('Letters, digits, and . _ - (up to 64 chars)')),
    // Why it cannot be, in the cell under the name, where it is put right: the sheet's top never moves for it.
    error,
    h('span', {class: 'sr-only', id: 'repo-summary-label'}, t('Summary')), summaryBox, actions);
  // The path alone sits above the paper; it has no second title to crowd it at narrow widths.
  const label = h('div', {class: 'nr-label'}, h('span', {class: 'nr-path'}, '~/', place));
  // One piece, the hand's: its place over its corner, and in it the name, what it is for, what will be made (under a
  // rule) and Create at its foot. The name stands at the size of every name (a cell's capitals), never made smaller or
  // larger for its room: one that is longer than the line goes on past it, as a field's words do.
  box.insertBefore(card, actions);
  const form = h('form', {class: 'new-repo', novalidate: ''}, label, box);
  // As tall as what is in it, to the grid's next line (as Home's note is): what is under it stays on the grid.
  wholeCells(box);
  // Said as it is written, not only once Create is pressed: why it cannot be, under the name, and where in it.
  const judge = () => {
    const said = why(name.value.trim());
    if (error.textContent !== said) error.textContent = said;
    if (said) name.setAttribute('aria-invalid', 'true'); else name.removeAttribute('aria-invalid');
  };
  name.addEventListener('input', () => { keep(); sized(); judge(); placed(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled || (naming && !finishName?.(true))) return;
    const n = name.value.trim();
    // Nothing written yet is not a name broken: what is wanted is said, under the field it goes in.
    if (!validName(n)) { error.textContent = n ? t('Use letters, digits, and . _ - (cannot start with .)') : t('Please enter a name first'); name.focus(); nudge(name); return; }
    submit.disabled = true;
    const planned = made, text = readme(n);
    try {
      // A name on this device or on the Remote is taken; focus its field so it can be put right.
      if ((await store.names()).includes(n) || remoteOnly().some((r) => r.name === n)) {
        submit.disabled = false;
        error.textContent = t('A repo named "{name}" already exists', {name: n}); name.focus(); nudge(name); return;
      }
      await store.create(n, 'empty');
    } catch (e) {
      error.textContent = t('Failed to create: {message}', {message: errorText(e)});
      submit.disabled = false;
      submit.focus();
      return;
    }
    // What was laid out here is what is made, as it is: its folders, then its files (the README's words what it is
    // for, wherever it was renamed to; a file made here, empty), and the minimal scaffold's README gone if it was left out.
    const readmeAt = planned.find((m) => m.readme && !m.dir)?.path ?? null;
    let at = '';
    try {
      for (const m of planned.filter((x) => x.dir).sort((a, b) => a.path.split('/').length - b.path.split('/').length)) { at = m.path; await store.mkdir(n, m.path); }
      for (const m of planned.filter((x) => !x.dir)) {
        at = m.path;
        const contents = m.readme ? text : '';
        if (m.path === 'README.md') await store.write(n, m.path, contents); else await store.add(n, parentOf(m.path), baseOf(m.path), contents);
      }
      if (!planned.some((m) => m.path === 'README.md' && !m.dir)) { at = 'README.md'; await store.remove(n, 'README.md'); }
    } catch (e) {
      madeIt(n);
      error.textContent = t('Failed to write {what} ({why})', {what: `${n}/${at}`, why: errorText(e)});
      return;
    }
    // Made is recorded: what was laid out here is the repo's first commit, so main holds no work of its own to commit
    // (work is done on an issue) and a file put back goes back to how it was made. (Not recorded, it is still made.)
    await record(n, null, `Feat: ${n}`, '').catch(() => {});
    // Made, it is gone into at once: what was written becomes its README, the summary's sheet growing into that box
    // in Forge, the caret in it, and its words going with it onto their line there (under the title and a line left
    // empty: readme), never a sheet gone empty on its way and the words come back after.
    finished = true;
    draft = fresh();
    const words = summary.value && readmeAt ? liftLine(summary) : null;
    // The box it was written in grows into the README's box, standing where that is laid.
    ctx.openRepo(n, readmeAt ?? '', readmeAt ? 'end' : false, box, 0, words ? {lifted: words, to: (into) => {
      const area = into.querySelector<HTMLTextAreaElement>('textarea.code-edit');
      return area ? textAt(area, 2) : null;
    }} : undefined);
  });
  showFiles();
  sized();
  placed();
  remember(name, 'name');
  remember(summary, 'summary');
  keepWritingInView(form);
  const at = draft.at;
  queueMicrotask(() => {
    if (!form.isConnected) return;
    const f = (at?.field === 'file' ? editing() : at?.field === 'summary' && !summaryBox.hidden ? summary : null) ?? name;
    f.focus({preventScroll: true});
    if (at && (f !== name || at.field === 'name')) { f.setSelectionRange(at.start, at.end, at.direction); f.scrollLeft = at.x; }
  });
  return [writingDesk(form, ctx)];
}

/** When a phone's keyboard takes space, move the paper only enough to keep the line in the hand. */
function keepWritingInView(form: HTMLElement) {
  const view = window.visualViewport;
  form.addEventListener('focusin', (event) => {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return;
    const reading = new AbortController(), {signal} = reading;
    let frame = 0, height = view?.height ?? innerHeight;
    const end = () => { reading.abort(); cancelAnimationFrame(frame); form.style.removeProperty('--nr-keyboard-inset'); };
    // Removing a focused field does not dispatch blur in every browser. The observation is only while writing.
    const page = form.closest('#page');
    if (page) {
      const left = new MutationObserver(() => { if (!field.isConnected) end(); });
      left.observe(page, {childList: true, subtree: true});
      signal.addEventListener('abort', () => left.disconnect(), {once: true});
    }
    const fit = () => {
      frame = 0;
      if (!form.isConnected || document.activeElement !== field) { end(); return; }
      const room = view?.height ?? innerHeight, old = height;
      height = room;
      if (!matchMedia('(max-width: 600px)').matches || (view && Math.abs(view.scale - 1) > .01)) return;
      const over = Math.max(0, document.documentElement.clientHeight - room);
      if (over) form.style.setProperty('--nr-keyboard-inset', `${over}px`);
      else form.style.removeProperty('--nr-keyboard-inset');
      if (room >= old) return;
      const top = view?.offsetTop ?? 0, r = field.getBoundingClientRect();
      const at = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd;
      const caret = field instanceof HTMLTextAreaElement ? caretIn(field, at ?? 0) : {y: 0, h: r.height};
      const line = r.top + caret.y, gap = 12;
      const dy = line < top + gap ? line - top - gap : Math.max(0, line + caret.h - top - room + gap);
      if (dy) window.scrollBy({top: dy, behavior: 'instant'});
    };
    const changed = () => { if (!frame) frame = requestAnimationFrame(fit); };
    field.addEventListener('blur', end, {once: true, signal});
    window.addEventListener('resize', changed, {signal});
    view?.addEventListener('resize', changed, {signal});
  });
}

/** New repo's paper is the subject. Commands for a different repo only appear when there is one to act on. */
function writingDesk(form: HTMLElement, ctx: Context) {
  const desk = h('div', {class: 'home-layout new-repo-desk'}, form);
  let repo = ctx.repo;
  void store.list().then((all) => {
    if (!all.some((r) => r.name === repo)) repo = all[0]?.name ?? null;
  }, () => {});
  const elsewhere = (at: string, ask: 'termNext' | 'deedsNext') => {
    void import('../forge/forge.ts').then((forge) => {
      if (desk.isConnected) { forge[ask](); ctx.openRepo(at); }
    });
  };
  const find = deskSearch(ctx, () => repo);
  const places = placesMenu(desk, ['New repo'], 'New repo', () => {}, () => {
    const at = repo;
    return [
      ...(ctx.placeCommands?.(['new-repo']) ?? []),
      ...(at ? [
        {label: 'Prompt', run: () => elsewhere(at, 'termNext')},
        {label: 'File actions', run: () => elsewhere(at, 'deedsNext')},
      ] : []),
    ];
  }, {find});
  function keys(event: KeyboardEvent) {
    if (!desk.isConnected) { document.removeEventListener('keydown', keys); return; }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || desk.closest('[inert]')) return;
    const key = event.key.toLowerCase();
    if (((key === 'k' || key === 'p') && !event.shiftKey) || (key === 'f' && event.shiftKey)) {
      event.preventDefault();
      places.close();
      find(document.activeElement);
    }
  }
  document.addEventListener('keydown', keys);
  return desk;
}
