import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {saveIssue, writeIssue, type Issue} from '../issues.ts';
import {store} from '../repos.ts';
import {kindOf, named} from '../text.ts';
import {answers} from './common.ts';

// Writing an issue: which repo it goes in (chips), its first line named like
// a TODO item ("Fix：件名"), then the detail. It takes the repo's next
// number; how it is kept is not the writer's concern. Its words are changed
// the same way, in its own box.
//
// What is half written stays until it is saved or put back with Not now:
// going along the row to read another issue, or to another page, and back
// finds it as it was, in the same box.

export interface IssueForm {
  element: HTMLElement;
  /** Open the form for `repos`, `chosen` picked. */
  open(repos: readonly string[], chosen: string): void;
  /** Open it again as it was left half written, if it was; true when it was. */
  resume(repos: readonly string[]): boolean;
}

/** A new issue being written: where, and its two fields. */
let writing: {repo: string; first: string; detail: string} | null = null;
/** An issue's words being changed, by repo/file. */
const changing = new Map<string, {first: string; detail: string}>();
const keyOf = (i: Issue) => `${i.repo}/${i.file}`;

/** Whether `issue`'s words are being changed (its box then opens as the fields). */
export const beingChanged = (issue: Issue) => changing.has(keyOf(issue));

/** The two fields an issue is written in, and reading them back. */
function fields(kind: string | null, title: string, detail: string) {
  const first = h('input', {class: 'line-in', placeholder: t('Fix: The title wraps on a phone'), 'aria-label': t('First line as Kind: title'),
    maxlength: '200', spellcheck: 'false', value: title ? named(kind, title) : ''}) as HTMLInputElement;
  const body = h('textarea', {class: 'line-in issue-text', rows: '4', 'aria-label': t('Detail'), placeholder: t('Detail (optional)')}) as HTMLTextAreaElement;
  body.value = detail;
  first.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); body.focus(); } });
  const read = () => ({...kindOf(first.value), detail: body.value});
  return {first, body, read};
}

/** Hold `b` down while `f` writes; a failure is said in `error` and nothing closes. */
async function held(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>): Promise<boolean> {
  b.disabled = true;
  try { await f(); return true; } catch (e) {
    error.textContent = t('Could not write: {message}', {message: e instanceof Error ? e.message : String(e)});
    b.disabled = false;
    return false;
  }
}

export function issueForm(events: {done(made: {repo: string; file: string} | null): void}): IssueForm {
  const element = h('div', {class: 'issue-form', hidden: ''});
  const close = (made: {repo: string; file: string} | null) => { writing = null; element.hidden = true; element.replaceChildren(); events.done(made); };

  const open = (repos: readonly string[], chosen: string, was: {first: string; detail: string} | null = null) => {
    let target = repos.includes(chosen) ? chosen : repos[0];
    const pick = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': t('Repo to write in')}, ...repos.map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(r === target)}, r) as HTMLButtonElement;
      b.addEventListener('click', () => { target = r; keep(); for (const c of pick.children) c.setAttribute('aria-checked', String(c === b)); });
      return b;
    }));
    const f = fields(null, '', '');
    if (was) { f.first.value = was.first; f.body.value = was.detail; }
    const keep = () => { writing = {repo: target, first: f.first.value, detail: f.body.value}; };
    keep();
    f.first.addEventListener('input', keep);
    f.body.addEventListener('input', keep);
    const error = h('p', {class: 'error', role: 'alert'});
    const make = h('button', {class: 'button primary', type: 'button'}, t('Create')) as HTMLButtonElement;
    const cancel = h('button', {class: 'button', type: 'button'}, t('Not now'));
    cancel.addEventListener('click', () => close(null));
    make.addEventListener('click', async () => {
      const {kind, title, detail} = f.read();
      if (!title.trim()) { error.textContent = t('Write a title on the first line'); f.first.focus(); return; }
      let file = '';
      if (await held(make, error, async () => { file = await writeIssue(store, target, kind, title, detail); })) close({repo: target, file});
    });
    element.replaceChildren(pick, f.first, f.body, error, answers(cancel, make));
    element.hidden = false;
    // Opened anew, the first line has the keyboard; opened again as it was left, nothing takes it.
    if (!was) f.first.focus();
  };
  const resume = (repos: readonly string[]) => {
    if (!writing) return false;
    open(repos, writing.repo, writing);
    return true;
  };
  return {element, open, resume};
}

/**
 * An issue's words, changed in its own box: Save writes them, Not now puts
 * the box back. Opened from its words, the first line has the keyboard;
 * opened again as it was left (`beingChanged`), nothing takes it.
 */
export function issueEditor(issue: Issue, done: (saved: boolean) => void): HTMLElement {
  const key = keyOf(issue);
  const was = changing.get(key);
  const f = fields(issue.kind, issue.title, issue.detail);
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
    if (await held(save, error, () => saveIssue(store, issue, kind, title, detail))) { changing.delete(key); done(true); }
  });
  const el = h('div', {class: 'issue-form issue-edit'}, f.first, f.body, error, answers(cancel, save));
  if (!was) queueMicrotask(() => f.first.focus());
  return el;
}
