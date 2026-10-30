import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {saveIssue, writeIssue, type Issue} from '../../repos/issues.ts';
import {kindOf, named} from '../../repos/text.ts';
import {answers} from '../common.ts';
import {errorText} from '../../app/errors.ts';
import {keepOut, putAway, still, unfold} from '../../ui/glide.ts';
import {busy} from './held.ts';
import {issueStore} from '../../repos/issue-store.ts';

// Writing an issue: its first line named like a TODO item ("Fix：件名"),
// the repo it goes in said quietly before it, then the detail. The repo is
// chosen in Git's one row of repos above the box, never in a second row
// inside it: a repo chosen there while writing is the one written in, and
// All only widens what is shown, leaving where it goes as it was. The room
// a row inside took is the detail's. It takes the repo's next number; how
// it is kept is not the writer's concern. Its words are changed the same
// way, in its own box.
//
// The new issue's box has its deed first: Create at the left, Not now at
// the right (this box only; every other one ends as common.ts `answers`).
//
// What is half written stays until it is saved or put back with Not now:
// going along the row to read another issue, or to another page, and back
// finds it as it was, in the same box. Escape puts it away as Not now does,
// but keeps what was written, folded: Write an issue opens it as it was.

export interface IssueForm {
  element: HTMLElement;
  /** Open the form for `repos`, `chosen` picked. */
  open(repos: readonly string[], chosen: string): void;
  /** Open it again as it was left half written, if it was; true when it was. Folded away with Escape, only when `asked`. */
  resume(repos: readonly string[], asked?: boolean): boolean;
  /** Write in `repo` from now on (chosen in the row above), what is written kept. */
  retarget(repo: string): void;
  /** Give the keyboard back to the line last written in (the repo chosen with the pointer took it), its caret where it was. */
  writeOn(): void;
}

/**
 * A new issue being written: where, and its two fields. `fresh` while it was
 * asked for elsewhere and not opened yet (the first line then takes the
 * keyboard); `back` the repo whose Forge asked for it, gone back to on Not now.
 */
let writing: {repo: string; first: string; detail: string; fresh?: boolean; back?: string; folded?: boolean} | null = null;
/** An issue's words being changed, by repo/file. */
const changing = new Map<string, {first: string; detail: string}>();
const keyOf = (i: Issue) => `${i.repo}/${i.file}`;

/** Begin a new issue in `repo`, asked for from Forge's reference: Git opens with it, its first line ready. */
export function startIssue(repo: string) {
  writing = {repo, first: '', detail: '', fresh: true, back: repo};
}

/** Whether `issue`'s words are being changed (its box then opens as the fields). */
export const beingChanged = (issue: Issue) => changing.has(keyOf(issue));

/**
 * The two fields an issue is written in, and reading them back. Enter on the first line goes on to the detail;
 * Ctrl+Enter (⌘ on a Mac) in either does the box's deed (`submit`: Create, Save), as it sends a comment.
 */
function fields(kind: string | null, title: string, detail: string, submit: () => void) {
  const first = h('input', {class: 'line-in', placeholder: t('Fix: The title wraps on a phone'), 'aria-label': t('First line as Kind: title'),
    maxlength: '200', spellcheck: 'false', value: title ? named(kind, title) : ''}) as HTMLInputElement;
  const body = h('textarea', {class: 'line-in issue-text', rows: '4', 'aria-label': t('Summary'), placeholder: t('Summary')}) as HTMLTextAreaElement;
  body.value = detail;
  for (const field of [first, body] as HTMLElement[]) {
    field.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); submit(); } else if (field === first) { event.preventDefault(); body.focus(); }
    });
  }
  const read = () => ({...kindOf(first.value), detail: body.value});
  return {first, body, read};
}

/** Hold `b` down while `f` writes; a failure is said in `error` and nothing closes. */
async function held(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>): Promise<boolean> {
  busy(b, true);
  try { await f(); return true; } catch (e) {
    error.textContent = t('Could not write: {message}', {message: errorText(e)});
    busy(b, false);
    return false;
  }
}

/** An issue just made: its repo and its file. */
export interface Made { repo: string; file: string }

/** `done` hears what was made, or null and the repo whose Forge asked for it (to go back to) when put back. */
export function issueForm(events: {done(made: Made | null, back: string | null): void}): IssueForm {
  // A group named as what it is for: its Summary is told from the Summary of the issue in full under it.
  const element = h('div', {class: 'issue-form issue-new', role: 'group', 'aria-label': t('Write an issue'), hidden: ''});
  let retarget: (repo: string) => void = () => {};
  /** The field last written in: the first line until the body is. */
  let typing: HTMLElement | null = null;
  const close = (made: Made | null, keep = false) => {
    const back = made ? null : writing?.back ?? null;
    // Put away with Escape, what was written is kept, folded, for Write an issue to open again (in Git: not back).
    writing = keep && writing && (writing.first.trim() || writing.detail.trim()) ? {repo: writing.repo, first: writing.first, detail: writing.detail, folded: true} : null;
    retarget = () => {};
    typing = null;
    const done = () => { element.hidden = true; element.replaceChildren(); events.done(made, back); };
    // It folds away, the issues under it rising into its room as it does (never a jump once it has gone): put back
    // with Not now, or made, as the row goes on to the new issue's box at its end (git.ts written).
    putAway(element, done, {fold: true, ms: 200});
  };

  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || element.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close(null, true);
  });

  const open = (repos: readonly string[], chosen: string, was: NonNullable<typeof writing> | null = null, asked = false) => {
    keepOut(element);
    let target = repos.includes(chosen) ? chosen : repos[0];
    const back = was?.back;
    // Where it goes, before the first line, in the words a card says its repo in.
    const where = h('span', {class: 'issue-where issue-target', id: 'issue-target', title: target}, target);
    const f = fields(null, '', '', () => make.click());
    f.first.setAttribute('aria-describedby', 'issue-target');
    if (was) { f.first.value = was.first; f.body.value = was.detail; }
    const keep = () => { writing = {repo: target, first: f.first.value, detail: f.body.value, ...(back ? {back} : {})}; };
    retarget = (r) => {
      if (!repos.includes(r)) return;
      target = r;
      where.textContent = r;
      where.title = r;
      keep();
    };
    keep();
    f.first.addEventListener('input', keep);
    f.body.addEventListener('input', keep);
    typing = f.first;
    for (const field of [f.first, f.body]) field.addEventListener('focus', () => { typing = field; });
    const error = h('p', {class: 'error', role: 'alert'});
    const make = h('button', {class: 'button primary', type: 'button'}, t('Create')) as HTMLButtonElement;
    const cancel = h('button', {class: 'button', type: 'button'}, t('Not now'));
    cancel.addEventListener('click', () => close(null));
    make.addEventListener('click', async () => {
      const {kind, title, detail} = f.read();
      if (!title.trim()) { error.textContent = t('Write a title on the first line'); f.first.focus(); return; }
      let file = '';
      // Being made, it is no longer half written: Git come to again meanwhile does not open it once more (made twice).
      const was = writing;
      writing = null;
      if (await held(make, error, async () => { file = await writeIssue(issueStore, target, kind, title, detail); })) close({repo: target, file});
      else writing = was;
    });
    element.replaceChildren(h('div', {class: 'issue-first'}, where, f.first), f.body, error,
      h('div', {class: 'answers'}, make, h('span', {class: 'grow'}), cancel));
    const shown = !element.hidden;
    element.hidden = false;
    // Opened by a press it unfolds, what stands under it making way (not pushed down at once); found open as it was
    // left (the page drawn again), it is simply there.
    // The whole box is brought into sight as it unfolds, Create with it (not only the line the keyboard is on, its
    // deed under the window's edge).
    const pressed = !shown && (!was || was.fresh || asked);
    if (pressed) {
      element.scrollIntoView({block: 'nearest', behavior: still() ? 'auto' : 'smooth'});
      unfold(element, 260);
    }
    // Opened anew (here, or asked for from Forge), the first line has the keyboard; opened again as it was left, nothing
    // takes it, unless it was pressed for (folded away, Write an issue): then the line last written in, as it was.
    if (!was || was.fresh) f.first.focus({preventScroll: pressed});
    else if (asked) (was.detail && !was.first.trim() ? f.body : f.first).focus({preventScroll: pressed});
  };
  const resume = (repos: readonly string[], asked = false) => {
    if (!writing || (writing.folded && !asked)) return false;
    open(repos, writing.repo, writing, asked);
    return true;
  };
  return {element, open, resume, retarget: (repo) => retarget(repo), writeOn: () => typing?.focus({preventScroll: true})};
}

/**
 * An issue's words, changed in its own box: Save writes them, Not now puts
 * the box back. Opened from its words, the first line has the keyboard;
 * opened again as it was left (`beingChanged`), nothing takes it.
 */
export function issueEditor(issue: Issue, done: (saved: boolean) => void): HTMLElement {
  const key = keyOf(issue);
  const was = changing.get(key);
  const f = fields(issue.kind, issue.title, issue.detail, () => save.click());
  if (was) { f.first.value = was.first; f.body.value = was.detail; }
  const keep = () => changing.set(key, {first: f.first.value, detail: f.body.value});
  keep();
  f.first.addEventListener('input', keep);
  f.body.addEventListener('input', keep);
  const error = h('p', {class: 'error', role: 'alert'});
  const save = h('button', {class: 'button primary', type: 'button'}, t('Save')) as HTMLButtonElement;
  const cancel = h('button', {class: 'button', type: 'button'}, t('Not now'));
  cancel.addEventListener('click', () => { changing.delete(key); done(false); });
  save.addEventListener('click', async () => {
    const {kind, title, detail} = f.read();
    if (!title.trim()) { error.textContent = t('Write a title on the first line'); f.first.focus(); return; }
    if (await held(save, error, () => saveIssue(issueStore, issue, kind, title, detail))) { changing.delete(key); done(true); }
  });
  const el = h('div', {class: 'issue-form issue-edit'}, f.first, f.body, error, answers(cancel, save));
  if (!was) queueMicrotask(() => f.first.focus());
  return el;
}
