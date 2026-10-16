import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {issueText, nextIssueName} from '../issues.ts';
import {store} from '../repos.ts';
import {kindOf} from '../text.ts';

// Writing an issue: which repo it goes in (chips; a repo without issue/
// cannot take one and says so), its first line named like a TODO item
// ("Fix：件名"), then the detail. It becomes the next numbered file in that
// repo's issue/.

export interface IssueForm {
  element: HTMLElement;
  /** Open the form for `repos`, the chosen one first if it can take an issue. */
  open(repos: readonly string[], takers: readonly string[], chosen: string): void;
}

export function issueForm(events: {done(repo: string | null): void}): IssueForm {
  const element = h('div', {class: 'issue-form', hidden: ''});
  const close = (repo: string | null) => { element.hidden = true; element.replaceChildren(); events.done(repo); };

  const open = (repos: readonly string[], takers: readonly string[], chosen: string) => {
    let target = takers.includes(chosen) ? chosen : takers[0];
    const pick = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': t('Repo to write in')}, ...repos.map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(r === target),
        title: takers.includes(r) ? '' : t('No issue/ here')}, r) as HTMLButtonElement;
      b.disabled = !takers.includes(r);
      b.addEventListener('click', () => { target = r; for (const c of pick.children) c.setAttribute('aria-checked', String(c === b)); });
      return b;
    }));
    const first = h('input', {class: 'line-in', placeholder: t('Fix: Saved work is gone after a restart'), 'aria-label': t('First line as Kind: title'),
      maxlength: '200', spellcheck: 'false'}) as HTMLInputElement;
    const detail = h('textarea', {class: 'line-in issue-text', rows: '4', 'aria-label': t('Detail'), placeholder: t('Detail (optional)')}) as HTMLTextAreaElement;
    first.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); detail.focus(); } });
    const error = h('p', {class: 'error', role: 'alert'});
    const make = h('button', {class: 'button primary', type: 'button'}, t('Create')) as HTMLButtonElement;
    const cancel = h('button', {class: 'button', type: 'button'}, t('Not now'));
    cancel.addEventListener('click', () => close(null));
    make.addEventListener('click', async () => {
      const {kind, title} = kindOf(first.value);
      if (!title.trim()) { error.textContent = t('Write a title on the first line'); first.focus(); return; }
      make.disabled = true;
      try {
        const names = (await store.tree(target, 'issue')).map((e) => e.name);
        await store.add(target, 'issue', nextIssueName(names), issueText(kind, title, detail.value));
      } catch (e) {
        error.textContent = t('Could not write: {message}', {message: e instanceof Error ? e.message : String(e)});
        make.disabled = false;
        return;
      }
      close(target);
    });
    element.replaceChildren(pick, first, detail, error, h('div', {class: 'row'}, make, cancel));
    element.hidden = false;
    first.focus();
  };
  return {element, open};
}
