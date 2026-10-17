import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {saveIssue, writeIssue, type Issue} from '../issues.ts';
import {store} from '../repos.ts';
import {kindOf, named} from '../text.ts';

// Writing an issue: which repo it goes in (chips), its first line named like
// a TODO item ("Fix：件名"), then the detail. It takes the repo's next
// number; how it is kept is not the writer's concern. Its words are changed
// the same way, in its own box.

export interface IssueForm {
  element: HTMLElement;
  /** Open the form for `repos`, `chosen` picked. */
  open(repos: readonly string[], chosen: string): void;
}

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
async function writing(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>): Promise<boolean> {
  b.disabled = true;
  try { await f(); return true; } catch (e) {
    error.textContent = t('Could not write: {message}', {message: e instanceof Error ? e.message : String(e)});
    b.disabled = false;
    return false;
  }
}

export function issueForm(events: {done(repo: string | null): void}): IssueForm {
  const element = h('div', {class: 'issue-form', hidden: ''});
  const close = (repo: string | null) => { element.hidden = true; element.replaceChildren(); events.done(repo); };

  const open = (repos: readonly string[], chosen: string) => {
    let target = repos.includes(chosen) ? chosen : repos[0];
    const pick = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': t('Repo to write in')}, ...repos.map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(r === target)}, r) as HTMLButtonElement;
      b.addEventListener('click', () => { target = r; for (const c of pick.children) c.setAttribute('aria-checked', String(c === b)); });
      return b;
    }));
    const f = fields(null, '', '');
    const error = h('p', {class: 'error', role: 'alert'});
    const make = h('button', {class: 'button primary', type: 'button'}, t('Create')) as HTMLButtonElement;
    const cancel = h('button', {class: 'button', type: 'button'}, t('Not now'));
    cancel.addEventListener('click', () => close(null));
    make.addEventListener('click', async () => {
      const {kind, title, detail} = f.read();
      if (!title.trim()) { error.textContent = t('Write a title on the first line'); f.first.focus(); return; }
      if (await writing(make, error, () => writeIssue(store, target, kind, title, detail))) close(target);
    });
    element.replaceChildren(pick, f.first, f.body, error, h('div', {class: 'row'}, make, cancel));
    element.hidden = false;
    f.first.focus();
  };
  return {element, open};
}

/** An issue's words, changed in its own box: Save writes them, Not now puts the box back. */
export function issueEditor(issue: Issue, done: (saved: boolean) => void): HTMLElement {
  const f = fields(issue.kind, issue.title, issue.detail);
  const error = h('p', {class: 'error', role: 'alert'});
  const save = h('button', {class: 'button primary', type: 'button'}, t('Save')) as HTMLButtonElement;
  const cancel = h('button', {class: 'button', type: 'button'}, t('Not now'));
  cancel.addEventListener('click', () => done(false));
  save.addEventListener('click', async () => {
    const {kind, title, detail} = f.read();
    if (!title.trim()) { error.textContent = t('Write a title on the first line'); f.first.focus(); return; }
    if (await writing(save, error, () => saveIssue(store, issue, kind, title, detail))) done(true);
  });
  const el = h('div', {class: 'issue-form issue-edit'}, f.first, f.body, error, h('div', {class: 'row'}, save, cancel));
  queueMicrotask(() => f.first.focus());
  return el;
}
