import {h} from '../dom.ts';
import {store, TEMPLATES, validName, type Template} from '../repos.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';

/** +: name a repo, pick a template, see exactly what it will contain. */
export function newRepo(ctx: Context): Node[] {
  const name = h('input', {id: 'repo-name', maxlength: '64', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'my-repo', 'aria-describedby': 'repo-name-rule'}) as HTMLInputElement;
  let template: Template = 'standard';
  const preview = h('ul', {class: 'tree-preview', 'aria-label': '作成されるもの'});
  const showFiles = () => {
    const t = TEMPLATES.find((x) => x.id === template)!;
    const root = name.value || 'my-repo';
    preview.replaceChildren(h('li', {class: 'root'}, root + '/'), ...t.files.map((f) => h('li', {}, f)));
  };
  const choices = h('div', {class: 'choices', role: 'radiogroup', 'aria-label': 'テンプレート'},
    ...TEMPLATES.map((t) => {
      const input = h('input', {type: 'radio', name: 'template', value: t.id}) as HTMLInputElement;
      input.checked = t.id === template;
      input.addEventListener('change', () => { template = t.id; showFiles(); });
      return h('label', {class: 'choice'}, input, t.label);
    }));
  const error = h('p', {class: 'error', role: 'alert'});
  const submit = h('button', {class: 'button primary', type: 'submit'}, '作成') as HTMLButtonElement;
  const form = h('form', {class: 'new-repo'},
    h('label', {class: 'field'}, '名前', name,
      h('span', {id: 'repo-name-rule', class: 'muted small'}, '英数字と . _ - 、64文字まで')),
    h('fieldset', {}, h('legend', {}, 'テンプレート'), choices),
    preview, error, h('div', {class: 'row'}, submit));
  name.addEventListener('input', showFiles);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = name.value.trim();
    if (!validName(n)) { error.textContent = '名前は英数字と . _ - で、先頭は . 以外にしてください'; name.focus(); return; }
    submit.disabled = true;
    try {
      await store.create(n, template);
      ctx.openRepo(n);
    } catch (e) {
      error.textContent = `作成できませんでした: ${String(e)}`;
      submit.disabled = false;
    }
  });
  showFiles();
  queueMicrotask(() => name.focus());
  return [pageHead('new-repo'), h('div', {}, form)];
}
