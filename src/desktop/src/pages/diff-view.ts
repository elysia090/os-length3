import {h} from '../dom.ts';
import type {FileDiff} from '../history.ts';
import {t, tn} from '../i18n.ts';

/** Files of a diff, each its name and its lines; a name opens the file when `reveal` is given. */
export function diffFiles(files: FileDiff[], reveal?: (path: string) => void): HTMLElement[] {
  return files.map((f) => {
    const name = h('button', {type: 'button', class: 'hit-file'}, f.path);
    if (reveal && f.status !== 'removed') name.addEventListener('click', () => reveal(f.path));
    else name.setAttribute('disabled', '');
    const lines = f.binary ? [h('p', {class: 'muted small'}, t('Binary'))] : f.lines.filter((l, k) => k > 0 || l.kind !== 'hunk').map((l) =>
      // Between two parts of a file, a quiet "…" (with the function git names, if any).
      h('div', {class: `diff-line ${l.kind}`}, l.kind === 'hunk' ? l.text.replace(/^@@ [^@]* @@ ?/, '') || '…' : l.text || ' '));
    if (f.more) lines.push(h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', f.more)));
    return h('div', {class: 'hit-group'}, name, h('div', {class: 'diff'}, ...lines));
  });
}
