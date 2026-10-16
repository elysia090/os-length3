import {h} from '../dom.ts';
import {issueText, nextIssueName, parseIssue, type Issue} from '../issues.ts';
import {onChange, store} from '../repos.ts';
import {kindOf} from '../todo.ts';
import {ago} from '../dom.ts';
import * as gitops from '../git.ts';
import {bench} from './bench.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';

/**
 * Git: what happens between a repo and the outside, in the issues' terms.
 * Issues are the unit of work and talk, read straight from each repo's
 * issue/ (nothing is kept twice) and named by kind and title. Under an issue
 * the person cuts their work into history (区切る: a commit named after the
 * issue), sees its cuts and the changes not yet cut, folder by folder, and
 * hands a cut out (提出) once there is a Remote; whoever receives it settles it
 * by Merge or Reject, never Close, which is for issues only. Nothing is shown
 * that is not there.
 */

const ALL = '';
let filter = ALL;

async function readIssues(repo: string): Promise<Issue[] | null> {
  let entries;
  try { entries = await store.tree(repo, 'issue'); } catch { return null; }
  const out: Issue[] = [];
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const c = await store.read(repo, `issue/${e.name}`).catch(() => null);
    if (c?.text != null) out.push(parseIssue(repo, e.name, c.text));
  }
  // The newest written first: files are numbered in the order they were written.
  return out.sort((a, b) => (a.file < b.file ? 1 : -1));
}

export function git(ctx: Context): Node[] {
  const chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  const count = h('small', {});
  const write = h('button', {class: 'button', type: 'button'}, 'Issue を書く') as HTMLButtonElement;
  const form = h('div', {class: 'issue-form', hidden: ''});
  const list = h('div', {class: 'issue-rows'}, h('p', {class: 'muted'}, '読み込み中…'));
  let repos: string[] = [];
  let missing: string[] = [];

  const paintChips = () => {
    chips.replaceChildren(...[ALL, ...repos].map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(filter === r)}, r || 'すべて');
      b.addEventListener('click', () => { filter = r; paintChips(); if (r) work.setRepo(r); void paint(); });
      return b;
    }));
  };

  const cutRow = (repo: string, c: gitops.Commit) => h('div', {class: 'cut-row'},
    h('span', {class: 'issue-head'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
    h('span', {class: 'issue-where muted'}, `${c.id} · ${c.author} · ${ago(c.time)} · ${c.files} ファイル +${c.added} −${c.removed}`),
    h('span', {class: 'cut-places muted'}, c.folders.map((f) => (f ? `${f}/` : `${repo}/`)).join(' ')));

  /** Folder by folder, what is not cut yet; the folder first, so a reader enters from their area. */
  const changeList = (repo: string, c: gitops.Changes) => h('div', {class: 'change-folders'}, ...c.folders.map((f) =>
    h('div', {class: 'change-folder'},
      h('div', {class: 'change-folder-head'}, h('b', {}, f.folder ? `${f.folder}/` : `${repo}/`), h('span', {class: 'muted'}, `+${f.added} −${f.removed}`)),
      ...f.files.map((x) => {
        const b = h('button', {type: 'button', class: 'change-file'},
          h('span', {class: 'change-word'}, gitops.STATUS_WORD[x.status]), h('span', {class: 'mono'}, f.folder ? x.path.slice(f.folder.length + 1) : x.path),
          h('span', {class: 'muted'}, x.binary ? 'バイナリ' : `+${x.added} −${x.removed}`));
        b.addEventListener('click', () => ctx.openRepo(repo, x.path));
        return b;
      }))));

  /** What one does under an issue: its cuts, the changes not cut yet, cutting, handing out. */
  const issueWork = (i: Issue): HTMLElement => {
    const box = h('div', {class: 'issue-work'}, h('p', {class: 'muted small'}, '読み込み中…'));
    if (!gitops.hasGit) {
      box.replaceChildren(h('p', {class: 'muted small'}, '区切り・提出はデスクトップ版で、その repo の git で行います（このブラウザには git がありません）。'));
      return box;
    }
    const paintWork = async () => {
      let changes: gitops.Changes, cuts: gitops.Commit[];
      try { [changes, cuts] = await Promise.all([gitops.changes(i.repo), gitops.log(i.repo)]); } catch (e) {
        box.replaceChildren(h('p', {class: 'error'}, `git を読めませんでした: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      if (!changes.git) { box.replaceChildren(h('p', {class: 'muted small'}, `${i.repo} には .git がありません。`)); return; }
      const mine = cuts.filter((c) => c.issue === `issue/${i.file}`);
      const note = h('input', {class: 'line-in', placeholder: 'メモ（なくてもよい）', 'aria-label': '区切りのメモ', maxlength: '400'}) as HTMLInputElement;
      const error = h('p', {class: 'error', role: 'alert'});
      const doCut = h('button', {class: 'button primary', type: 'button'}, 'この Issue として区切る') as HTMLButtonElement;
      doCut.disabled = changes.files === 0;
      doCut.addEventListener('click', async () => {
        doCut.disabled = true;
        try { await gitops.cut(i.repo, i.file, '', note.value); } catch (e) {
          error.textContent = `区切れませんでした: ${e instanceof Error ? e.message : String(e)}`;
          doCut.disabled = false;
          return;
        }
        await paintWork();
      });
      const hand = h('button', {class: 'button', type: 'button', disabled: '', title: 'Remote がまだありません'}, '提出');
      box.replaceChildren(
        h('h3', {}, 'この Issue の区切り', h('small', {}, mine.length ? `${mine.length} 件` : '')),
        mine.length ? h('div', {class: 'cut-rows'}, ...mine.map((c) => cutRow(i.repo, c)))
          : h('p', {class: 'muted small'}, 'まだありません。変更をこの Issue として区切ると、ここに並びます。'),
        h('h3', {}, 'まだ区切っていない変更', h('small', {}, changes.files ? `${changes.files} ファイル +${changes.added} −${changes.removed}` : '')),
        changes.files ? changeList(i.repo, changes) : h('p', {class: 'muted small'}, `${i.repo} に、まだ区切っていない変更はありません。`),
        ...(changes.files ? [note] : []), error,
        h('div', {class: 'row'}, doCut, hand),
        h('p', {class: 'muted small'}, '区切ると、件名がこの Issue の「' + (i.kind ? `${i.kind}：` : '') + i.title + '」になります。提出は Remote とつながると使えます（受け取る側が Merge か Reject で決めます）。'));
    };
    void paintWork();
    return box;
  };

  const row = (i: Issue) => {
    const b = h('button', {type: 'button', class: 'issue-row'},
      h('span', {class: 'issue-head'}, i.kind ? h('span', {class: 'issue-kind'}, `${i.kind}：`) : null, i.title),
      h('span', {class: 'issue-where muted'}, `${i.repo} · issue/${i.file}`),
      i.detail ? h('span', {class: 'issue-detail muted'}, i.detail.split('\n')[0]) : null);
    // Pressing a row shows it in full on the right; its file opens from there.
    const item = h('div', {class: 'issue-item'}, b);
    b.addEventListener('click', () => {
      const open = b.hasAttribute('aria-current');
      for (const r of list.querySelectorAll('.issue-row[aria-current]')) { r.removeAttribute('aria-current'); r.removeAttribute('aria-expanded'); }
      for (const w of list.querySelectorAll('.issue-work')) w.remove();
      for (const o of list.querySelectorAll('.issue-item.open')) o.classList.remove('open');
      if (open) return;
      item.classList.add('open');
      b.setAttribute('aria-current', 'true');
      b.setAttribute('aria-expanded', 'true');
      item.append(issueWork(i));
      work.setRepo(i.repo);
      work.reference.showIssue(i, () => ctx.openRepo(i.repo, `issue/${i.file}`));
    });
    return item;
  };

  const paint = async () => {
    const all = await Promise.all(repos.map(readIssues));
    missing = repos.filter((_, k) => all[k] === null);
    // Grouped by repo in the list's order, the newest written first in each.
    const issues = all.flatMap((x, k) => (!filter || repos[k] === filter ? x ?? [] : []));
    count.textContent = issues.length ? `${issues.length} 件` : '';
    if (!repos.length) { list.replaceChildren(h('div', {class: 'empty'}, 'repoがまだありません。+ から作ると、その issue/ がここに並びます。')); return; }
    const gone = missing.filter((r) => !filter || r === filter);
    const note = gone.length ? h('p', {class: 'muted small'}, `issue/ がないrepo: ${gone.join(', ')}`) : null;
    if (!issues.length) {
      list.replaceChildren(h('div', {class: 'empty'}, 'Issue はまだありません。「Issue を書く」で、repo の issue/ に1件1fileで書けます。'), ...(note ? [note] : []));
      return;
    }
    list.replaceChildren(...issues.map(row), ...(note ? [note] : []));
  };

  /** Write a new issue as a file in the chosen repo's issue/. */
  const openForm = () => {
    // Only repos with an issue/ can take one; the others say why.
    const targets = repos.filter((r) => !missing.includes(r));
    if (!targets.length) { list.prepend(h('p', {class: 'error'}, 'issue/ のあるrepoがありません')); return; }
    let target = filter && targets.includes(filter) ? filter : targets[0];
    const pick = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': '書くrepo'}, ...repos.map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(r === target),
        title: targets.includes(r) ? '' : 'issue/ がありません'}, r) as HTMLButtonElement;
      b.disabled = !targets.includes(r);
      b.addEventListener('click', () => { target = r; for (const c of pick.children) c.setAttribute('aria-checked', String(c === b)); });
      return b;
    }));
    const first = h('input', {class: 'line-in', placeholder: 'Fix：再起動すると保存内容が消える', 'aria-label': '1行目に 種別：件名',
      maxlength: '200', spellcheck: 'false'}) as HTMLInputElement;
    const detail = h('textarea', {class: 'line-in issue-text', rows: '4', 'aria-label': '詳細', placeholder: '詳細（なくてもよい）'}) as HTMLTextAreaElement;
    first.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); detail.focus(); } });
    const error = h('p', {class: 'error', role: 'alert'});
    const make = h('button', {class: 'button primary', type: 'button'}, '作成');
    const cancel = h('button', {class: 'button', type: 'button'}, 'やめる');
    cancel.addEventListener('click', () => { form.hidden = true; write.hidden = false; });
    make.addEventListener('click', async () => {
      const {kind, title} = kindOf(first.value);
      if (!title.trim()) { error.textContent = '1行目に件名を書いてください'; first.focus(); return; }
      try {
        const names = (await store.tree(target, 'issue')).map((e) => e.name);
        await store.add(target, 'issue', nextIssueName(names), issueText(kind, title, detail.value));
      } catch (e) {
        error.textContent = `書けませんでした: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
      form.hidden = true;
      write.hidden = false;
      await paint();
    });
    form.replaceChildren(pick, first, detail, error, h('div', {class: 'row'}, make, cancel));
    form.hidden = false;
    write.hidden = true;
    first.focus();
  };
  write.addEventListener('click', openForm);

  void store.list().then((r) => {
    repos = r.map((x) => x.name);
    if (filter && !repos.includes(filter)) filter = ALL;
    write.disabled = !repos.length;
    const first = filter || (ctx.repo && repos.includes(ctx.repo) ? ctx.repo : repos[0]);
    if (first) work.setRepo(first);
    paintChips();
    void paint();
  });

  const main = h('section', {class: 'flow git-flow', tabindex: '0', 'aria-label': 'Git'},
    pageHead('git'),
    h('div', {class: 'git-filter'}, chips),
    h('section', {class: 'section', 'aria-labelledby': 'issues-title'},
      h('h2', {id: 'issues-title'}, h('span', {}, 'Issue ', count), write), form, list),
    h('section', {class: 'section', 'aria-labelledby': 'changes-title'},
      h('h2', {id: 'changes-title'}, '提出された変更'),
      h('div', {class: 'empty'}, 'まだ届いた変更はありません。Remote とつながると、提出された変更がここに並びます。')));
  const work = bench({main, reveal: () => {}});
  // Issues written anywhere (here, in the shell, with l3 in the Prompt) show up at once.
  const stop = onChange((c) => {
    if (!work.element.isConnected) { stop(); return; }
    if (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/')) void paint();
  });
  return [work.element];
}
