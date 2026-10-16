import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {readIssues, type Issue} from '../issues.ts';
import {onChange, store} from '../repos.ts';
import {bench} from './bench.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {gitWork} from './git-work.ts';
import {issueForm} from './issue-form.ts';

/**
 * Git: what happens between a repo and the outside, in the issues' terms.
 * Issues are the unit of work and talk, read straight from each repo's
 * issue/ (nothing is kept twice) and named by kind and title. Choosing one
 * makes it current: it shows in full on the right, and the sections under
 * the list (git-work.ts) turn to its work: Work on it in its own copy,
 * Commit, Push, Submit change; and the changes handed in, which the
 * receiver reviews and settles by Merge or Reject, never Close, which is
 * for issues only.
 */

const ALL = '';
let filter = ALL;

export function git(ctx: Context): Node[] {
  const chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  const count = h('small', {});
  const write = h('button', {class: 'button', type: 'button'}, t('Write an issue')) as HTMLButtonElement;
  const list = h('div', {class: 'issue-rows'}, h('p', {class: 'muted'}, t('Reading…')));
  let repos: string[] = [];
  let missing: string[] = [];
  let current: Issue | null = null;
  let at: string | null = null;

  const work = gitWork({
    open: (repo, path) => ctx.openRepo(repo, path),
    review: (head, actions, files, folder) => workbench.reference.showChange(head, actions, files, folder ?? null),
    // The repo shows another work's copy: what File, Forge and the issues read is that copy now.
    moved: (repo) => { if (repo === at) { void paint(); work.refresh(); } },
  });
  const form = issueForm({done: (repo) => { write.hidden = false; if (repo) void paint(); }});

  /** Point the sections, the reference and the Prompt at `repo`. */
  const look = (repo: string | null) => {
    at = repo;
    if (repo) workbench.setRepo(repo);
    work.show(repo, current && current.repo === repo ? current : null);
  };

  const paintChips = () => {
    chips.replaceChildren(...[ALL, ...repos].map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(filter === r)}, r || t('All'));
      b.addEventListener('click', () => {
        filter = r;
        if (r && current?.repo !== r) current = null;
        paintChips();
        if (r) look(r);
        void paint();
      });
      return b;
    }));
  };

  const row = (i: Issue) => {
    const b = h('button', {type: 'button', class: 'issue-row'},
      h('span', {class: 'issue-head'}, i.kind ? h('span', {class: 'issue-kind'}, `${i.kind}：`) : null, i.title),
      h('span', {class: 'issue-where'}, `${i.repo} · issue/${i.file}`),
      i.detail ? h('span', {class: 'issue-detail'}, i.detail.split('\n')[0]) : null);
    if (current && current.repo === i.repo && current.file === i.file) b.setAttribute('aria-current', 'true');
    // Pressing a row makes it current: in full on the right, its work below.
    // Pressing it again lets it go.
    b.addEventListener('click', () => {
      const again = b.hasAttribute('aria-current');
      for (const r of list.querySelectorAll('.issue-row[aria-current]')) r.removeAttribute('aria-current');
      current = again ? null : i;
      if (current) {
        b.setAttribute('aria-current', 'true');
        workbench.reference.showIssue(i, () => ctx.openRepo(i.repo, `issue/${i.file}`));
      }
      look(i.repo);
    });
    return b;
  };

  const paint = async () => {
    const all = await Promise.all(repos.map((r) => readIssues(store, r)));
    missing = repos.filter((_, k) => all[k] === null);
    const issues = all.flatMap((x, k) => (!filter || repos[k] === filter ? x ?? [] : []));
    // The current issue may have been removed meanwhile.
    if (current && !issues.some((i) => i.repo === current!.repo && i.file === current!.file)) { current = null; look(at); }
    count.textContent = issues.length ? `${issues.length}` : '';
    if (!repos.length) { list.replaceChildren(h('div', {class: 'empty'}, t('No repos yet'))); return; }
    list.replaceChildren(...(issues.length ? issues.map(row) : [h('div', {class: 'empty'}, t('No issues yet'))]));
  };

  write.addEventListener('click', () => {
    const takers = repos.filter((r) => !missing.includes(r));
    if (!takers.length) { list.prepend(h('p', {class: 'error'}, t('No repo has an issue/ folder'))); return; }
    write.hidden = true;
    form.open(repos, takers, filter || at || takers[0]);
  });

  void store.list().then((r) => {
    repos = r.map((x) => x.name);
    if (filter && !repos.includes(filter)) filter = ALL;
    write.disabled = !repos.length;
    look(filter || (ctx.repo && repos.includes(ctx.repo) ? ctx.repo : repos[0] ?? null));
    paintChips();
    void paint();
  });

  const main = h('section', {class: 'flow git-flow', tabindex: '0', 'aria-label': 'Git'},
    pageHead('git'),
    h('div', {class: 'git-filter'}, chips),
    h('section', {class: 'section', 'aria-labelledby': 'issues-title'},
      h('h2', {id: 'issues-title'}, h('span', {}, t('Issues'), ' ', count), write), form.element, list),
    ...work.sections);
  const workbench = bench({main, reveal: (path) => { if (at) ctx.openRepo(at, path); }});
  // Issues written anywhere (here, in the shell, with l3 in the Prompt) show
  // up at once, and any change in the repo looked at is read again.
  const stop = onChange((c) => {
    if (!workbench.element.isConnected) { stop(); return; }
    if (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/')) void paint();
    if (c.what === 'repo' || c.repo === at) work.refresh();
  });
  const back = () => { if (!workbench.element.isConnected) { removeEventListener('focus', back); return; } work.refresh(); };
  addEventListener('focus', back);
  return [workbench.element];
}
