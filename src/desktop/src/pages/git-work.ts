import {ago, h} from '../dom.ts';
import * as gitops from '../git.ts';
import type {Issue} from '../issues.ts';
import {named} from '../text.ts';

// The two sections under the issues on the Git page, for one repo at a time:
// the changes not cut yet, folder by folder, with 区切る under the current
// issue; and the cuts so far (the current issue's only, when one is chosen).
// Both are cards of rows, like the File tree. A section with nothing in it
// is not shown, and git is only on the desktop.

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
  const changes = h('section', {class: 'section', 'aria-labelledby': 'changes-title', hidden: ''},
    h('h2', {id: 'changes-title'}, h('span', {}, '変更', changesSmall)), changesBody);
  const cuts = h('section', {class: 'section', 'aria-labelledby': 'cuts-title', hidden: ''},
    h('h2', {id: 'cuts-title'}, h('span', {}, '区切り', cutsSmall)), cutsBody);
  let repo: string | null = null;
  let issue: Issue | null = null;
  let run = 0;
  let timer = 0;

  const changeRows = (at: string, c: gitops.Changes) => h('div', {class: 'rows'}, ...c.folders.flatMap((f) => [
    h('div', {class: 'row-item row-head'}, h('span', {class: 'mono row-name'}, f.folder ? `${f.folder}/` : `${at}/`)),
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
    h('div', {class: 'row-item', title: c.id},
      h('span', {class: 'row-name'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
      h('span', {class: 'row-meta'}, c.folders.map((f) => (f ? `${f}/` : `${at}/`)).join(' ')),
      h('span', {class: 'row-meta'}, ago(c.time)))));

  /** With an issue current: a note and 区切る, which names the cut after it. */
  const cutAction = (at: string, under: Issue) => {
    const note = h('input', {class: 'line-in', placeholder: 'メモ', 'aria-label': '区切りのメモ', maxlength: '400'}) as HTMLInputElement;
    const error = h('p', {class: 'error', role: 'alert'});
    const cut = h('button', {class: 'button primary', type: 'button', title: named(under.kind, under.title)}, '区切る') as HTMLButtonElement;
    const go = async () => {
      cut.disabled = true;
      try { await gitops.cut(at, under.file, '', note.value); } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        cut.disabled = false;
        return;
      }
      paint();
    };
    cut.addEventListener('click', () => void go());
    note.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing && !cut.disabled) void go(); });
    return [h('div', {class: 'row work-act'}, note, cut), error];
  };

  const paint = () => {
    const at = repo;
    const mine = ++run;
    if (!at || !gitops.hasGit) { changes.hidden = cuts.hidden = true; return; }
    void Promise.all([gitops.changes(at), gitops.log(at)]).then(([c, log]) => {
      if (mine !== run) return;
      changes.hidden = !c.files;
      changesSmall.textContent = c.files ? `${c.files}` : '';
      changesBody.replaceChildren(changeRows(at, c), ...(issue ? cutAction(at, issue) : []));
      const shown = issue ? log.filter((x) => x.issue === `issue/${issue!.file}`) : log;
      cuts.hidden = !shown.length;
      cutsSmall.textContent = `${shown.length}`;
      cutsBody.replaceChildren(cutRows(at, shown));
    }, (e) => {
      if (mine !== run) return;
      changes.hidden = false;
      cuts.hidden = true;
      changesBody.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e)));
    });
  };

  return {
    sections: [changes, cuts],
    show(r, i) { repo = r; issue = i; paint(); },
    refresh() { clearTimeout(timer); timer = window.setTimeout(paint, 250); },
  };
}
