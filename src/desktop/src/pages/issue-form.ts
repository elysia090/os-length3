import {h} from '../dom.ts';
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
    const pick = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': '書くrepo'}, ...repos.map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(r === target),
        title: takers.includes(r) ? '' : 'issue/ がありません'}, r) as HTMLButtonElement;
      b.disabled = !takers.includes(r);
      b.addEventListener('click', () => { target = r; for (const c of pick.children) c.setAttribute('aria-checked', String(c === b)); });
      return b;
    }));
    const first = h('input', {class: 'line-in', placeholder: 'Fix：再起動すると保存内容が消える', 'aria-label': '1行目に 種別：件名',
      maxlength: '200', spellcheck: 'false'}) as HTMLInputElement;
    const detail = h('textarea', {class: 'line-in issue-text', rows: '4', 'aria-label': '詳細', placeholder: '詳細（なくてもよい）'}) as HTMLTextAreaElement;
    first.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); detail.focus(); } });
    const error = h('p', {class: 'error', role: 'alert'});
    const make = h('button', {class: 'button primary', type: 'button'}, '作成') as HTMLButtonElement;
    const cancel = h('button', {class: 'button', type: 'button'}, 'やめる');
    cancel.addEventListener('click', () => close(null));
    make.addEventListener('click', async () => {
      const {kind, title} = kindOf(first.value);
      if (!title.trim()) { error.textContent = '1行目に件名を書いてください'; first.focus(); return; }
      make.disabled = true;
      try {
        const names = (await store.tree(target, 'issue')).map((e) => e.name);
        await store.add(target, 'issue', nextIssueName(names), issueText(kind, title, detail.value));
      } catch (e) {
        error.textContent = `書けませんでした: ${e instanceof Error ? e.message : String(e)}`;
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
