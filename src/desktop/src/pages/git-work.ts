import {ago, h} from '../dom.ts';
import * as gitops from '../git.ts';
import type {Issue} from '../issues.ts';
import {named} from '../text.ts';

// The two sections under the issues on the Git page, for one repo at a time:
// what is not cut yet, folder by folder, with the one action of cutting it
// under the current issue; and the cuts so far (only the current issue's
// when one is chosen). Both are cards of rows, like the File tree. Nothing
// is shown that is not there: handing a cut out (提出) arrives with a Remote.

export interface GitWork {
  sections: HTMLElement[];
  /** Look at `repo`, cutting under `issue` when one is chosen. */
  show(repo: string | null, issue: Issue | null): void;
  /** Read again: something in the repo changed. */
  refresh(): void;
}

const counts = (added: number, removed: number) => `+${added} −${removed}`;

export function gitWork(events: {open(repo: string, path: string): void}): GitWork {
  const changesSmall = h('small', {});
  const cutsSmall = h('small', {});
  const changesBody = h('div', {});
  const cutsBody = h('div', {});
  const changes = h('section', {class: 'section', 'aria-labelledby': 'changes-title'},
    h('h2', {id: 'changes-title'}, h('span', {}, 'まだ区切っていない変更', changesSmall)), changesBody);
  const cuts = h('section', {class: 'section', 'aria-labelledby': 'cuts-title'},
    h('h2', {id: 'cuts-title'}, h('span', {}, '区切り', cutsSmall)), cutsBody);
  let repo: string | null = null;
  let issue: Issue | null = null;
  let run = 0;
  let timer = 0;

  const changeRows = (at: string, c: gitops.Changes) => h('div', {class: 'rows'}, ...c.folders.flatMap((f) => [
    h('div', {class: 'row-item row-head'}, h('span', {class: 'mono row-name'}, f.folder ? `${f.folder}/` : `${at}/`), h('span', {class: 'row-meta'}, counts(f.added, f.removed))),
    ...f.files.map((x) => {
      const b = h('button', {type: 'button', class: 'row-item', style: '--depth:1'},
        h('span', {class: 'row-word'}, gitops.STATUS_WORD[x.status]),
        h('span', {class: 'mono row-name'}, f.folder ? x.path.slice(f.folder.length + 1) : x.path),
        h('span', {class: 'row-meta'}, x.binary ? 'バイナリ' : counts(x.added, x.removed))) as HTMLButtonElement;
      if (x.status !== 'removed') b.addEventListener('click', () => events.open(at, x.path));
      else b.disabled = true;
      return b;
    }),
  ]));

  const cutRows = (at: string, list: gitops.Commit[]) => h('div', {class: 'rows'}, ...list.map((c) =>
    h('div', {class: 'row-item row-cut'},
      h('span', {class: 'row-name'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
      h('span', {class: 'row-meta'}, `${c.id} · ${c.author} · ${ago(c.time)} · ${c.folders.map((f) => (f ? `${f}/` : `${at}/`)).join(' ')} ${counts(c.added, c.removed)}`))));

  /** Cutting: a note, and the one primary action, named for what it makes. */
  const cutAction = (at: string, c: gitops.Changes) => {
    if (!issue) return [h('p', {class: 'muted small work-note'}, '上の Issue を選ぶと、その Issue として区切れます。')];
    const under = issue;
    const name = named(under.kind, under.title);
    const note = h('input', {class: 'line-in', placeholder: 'メモ（なくてもよい）', 'aria-label': '区切りのメモ', maxlength: '400'}) as HTMLInputElement;
    const error = h('p', {class: 'error', role: 'alert'});
    const cut = h('button', {class: 'button primary', type: 'button'}, '区切る') as HTMLButtonElement;
    cut.disabled = c.files === 0;
    const go = async () => {
      cut.disabled = true;
      try { await gitops.cut(at, under.file, '', note.value); } catch (e) {
        error.textContent = `区切れませんでした: ${e instanceof Error ? e.message : String(e)}`;
        cut.disabled = false;
        return;
      }
      paint();
    };
    cut.addEventListener('click', () => void go());
    note.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing && !cut.disabled) void go(); });
    return [h('div', {class: 'row work-act'}, note, cut), error,
      h('p', {class: 'muted small work-note'}, `「${name}」として、issue/${under.file} に結びついて残ります。`)];
  };

  const paint = () => {
    const at = repo;
    const mine = ++run;
    changesSmall.textContent = at ?? '';
    cutsSmall.textContent = at ? (issue ? `${at} · ${named(issue.kind, issue.title)}` : at) : '';
    const say = (body: HTMLElement, text: string) => body.replaceChildren(h('div', {class: 'empty'}, text));
    if (!at) { say(changesBody, 'repoを選ぶと、そのrepoの変更が出ます。'); cutsBody.replaceChildren(); return; }
    if (!gitops.hasGit) {
      say(changesBody, '区切りはデスクトップ版で、その repo の git で行います。このブラウザには git がありません。');
      cutsBody.replaceChildren();
      return;
    }
    void Promise.all([gitops.changes(at), gitops.log(at)]).then(([c, log]) => {
      if (mine !== run) return;
      if (!c.git) { say(changesBody, `${at} には .git がありません。`); cutsBody.replaceChildren(); return; }
      changesSmall.textContent = c.files ? `${at} · ${c.files} ファイル ${counts(c.added, c.removed)}` : at;
      changesBody.replaceChildren(
        c.files ? changeRows(at, c) : h('p', {class: 'muted'}, 'すべて区切ってあります。'),
        ...(c.files ? cutAction(at, c) : []));
      const shown = issue ? log.filter((x) => x.issue === `issue/${issue!.file}`) : log;
      cutsBody.replaceChildren(shown.length ? cutRows(at, shown)
        : h('p', {class: 'muted'}, issue ? 'この Issue の区切りはまだありません。' : 'まだ区切りはありません。'));
    }, (e) => {
      if (mine === run) changesBody.replaceChildren(h('p', {class: 'error'}, `git を読めませんでした: ${e instanceof Error ? e.message : String(e)}`));
    });
  };

  return {
    sections: [changes, cuts],
    show(r, i) { repo = r; issue = i; paint(); },
    refresh() { clearTimeout(timer); timer = window.setTimeout(paint, 250); },
  };
}
