import {h} from '../dom.ts';
import * as gitops from '../history.ts';
import {t} from '../i18n.ts';
import {readIssues, type Issue} from '../issues.ts';
import {connection} from '../remote.ts';
import {onChange, store} from '../repos.ts';
import {bench} from './bench.ts';
import {pageHead, parts} from './common.ts';
import type {Context} from './context.ts';
import {changeItem, cutRows, issueBadge, issueView, type IssueView} from './git-issue.ts';
import {issueForm} from './issue-form.ts';

/**
 * Git: what happens between a repo and the outside, in the issues' terms.
 * The page is in three parts, one shown at a time:
 *
 *   Issues    the unit of work and talk, read straight from each repo's
 *             issue/ (nothing is kept twice). Choosing one opens it large in
 *             place of the list: its text, its operations (Start, Commit,
 *             Push, Change, Reset), what is not committed, its commits and
 *             its change (git-issue.ts).
 *   Changes   what was handed to main, to review and settle by Merge or
 *             Reject (never Close, which is for issues only).
 *   History   main's commits.
 *
 * The repo chips beside the switch narrow all three.
 */

const ALL = '';
let filter = ALL;
type Part = 'issues' | 'changes' | 'history';

export function git(ctx: Context): Node[] {
  const chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  const write = h('button', {class: 'button', type: 'button'}, t('Write an issue')) as HTMLButtonElement;
  const list = h('div', {class: 'issue-rows'}, h('p', {class: 'muted'}, t('Reading…')));
  const page = parts<Part>('git', [
    {id: 'issues', label: t('Issues')}, {id: 'changes', label: t('Changes')}, {id: 'history', label: t('History')}]);
  let repos: string[] = [];
  let missing: string[] = [];
  let at: string | null = null;
  let open: {issue: Issue; view: IssueView} | null = null;

  const events = {
    open: (repo: string, path: string) => ctx.openRepo(repo, path),
    review: (head: Node, actions: Node[], files: Promise<gitops.FileDiff[]>, folder?: string | null) => workbench.reference.showChange(head, actions, files, folder ?? null),
    // The repo shows another copy: what File, Forge and the issues read is that copy now.
    moved: (repo: string) => { if (repo === at) { void paint(); open?.view.refresh(); void paintChanges(); } },
    close: () => { open = null; void paint(); },
  };
  const form = issueForm({done: (repo) => { write.hidden = false; if (repo) void paint(); }});
  const listing = h('div', {class: 'issue-list-part'},
    h('div', {class: 'part-head'}, h('span', {class: 'grow'}), write), form.element, list);
  page.panel('issues').append(listing);

  /** Point the reference and the Prompt at `repo`. */
  const look = (repo: string | null) => {
    at = repo;
    if (repo) workbench.setRepo(repo);
  };
  const shown = () => (filter ? [filter] : repos);

  const paintChips = () => {
    chips.replaceChildren(...[ALL, ...repos].map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(filter === r)}, r || t('All'));
      b.addEventListener('click', () => {
        filter = r;
        if (r && open && open.issue.repo !== r) open = null;
        paintChips();
        if (r) look(r);
        void paint(); void paintChanges(); void paintHistory();
      });
      return b;
    }));
  };

  const row = (i: Issue, badge: string) => {
    const b = h('button', {type: 'button', class: 'issue-row'},
      h('span', {class: 'issue-head'}, i.kind ? h('span', {class: 'issue-kind'}, `${i.kind}：`) : null, i.title,
        badge ? h('span', {class: 'state-chip'}, badge) : null),
      h('span', {class: 'issue-where'}, `${i.repo} · issue/${i.file}`),
      i.detail ? h('span', {class: 'issue-detail'}, i.detail.split('\n')[0]) : null);
    // Pressing a row opens the issue large in place of the list.
    b.addEventListener('click', () => { look(i.repo); show(i); });
    return b;
  };

  const show = (i: Issue) => {
    open = {issue: i, view: issueView(i, events)};
    listing.hidden = true;
    page.panel('issues').replaceChildren(listing, open.view.element);
    page.show('issues');
  };

  const paint = async () => {
    const all = await Promise.all(repos.map((r) => readIssues(store, r)));
    missing = repos.filter((_, k) => all[k] === null);
    const issues = all.flatMap((x, k) => (!filter || repos[k] === filter ? x ?? [] : []));
    page.count('issues', issues.length);
    // The open issue stays open while it is there; if it went, the list comes back.
    if (open) {
      const again = issues.find((i) => i.repo === open!.issue.repo && i.file === open!.issue.file);
      if (again) { if (again.title !== open.issue.title || again.kind !== open.issue.kind || again.detail !== open.issue.detail) show(again); return; }
      // A copy being fetched has no issues yet: keep the issue until the repo reads again.
      if (all.some((x, k) => repos[k] === open!.issue.repo && x && x.length)) open = null; else return;
    }
    listing.hidden = false;
    page.panel('issues').replaceChildren(listing);
    if (!repos.length) { list.replaceChildren(h('div', {class: 'empty'}, t('No repos yet'))); return; }
    if (!issues.length) { list.replaceChildren(h('div', {class: 'empty'}, t('No issues yet'))); return; }
    // Where each issue stands: worked on here, started, or handed in.
    const state = new Map<string, {w: gitops.Work | null; lines: gitops.Line[]; changes: gitops.Change[]}>();
    if (connection()) await Promise.all([...new Set(issues.map((i) => i.repo))].map(async (r) => {
      const [w, lines, changes] = await Promise.all([gitops.work(r).catch(() => null), gitops.lines(r).catch(() => []), gitops.changesOf(r).catch(() => [])]);
      state.set(r, {w, lines, changes});
    }));
    list.replaceChildren(...issues.map((i) => {
      const s = state.get(i.repo);
      return row(i, s ? issueBadge(`issue/${i.file}`, s.w, s.lines, s.changes) : '');
    }));
  };

  const paintChanges = async () => {
    const panel = page.panel('changes');
    if (!connection()) { panel.replaceChildren(h('div', {class: 'empty'}, t('Changes are kept on the Remote. Sign in to it to see them.'))); page.count('changes', ''); return; }
    const all = (await Promise.all(shown().map(async (r) => (await gitops.changesOf(r).catch(() => [])).map((c) => ({r, c}))))).flat()
      .sort((a, b) => b.c.updatedAt - a.c.updatedAt);
    const undecided = all.filter((x) => x.c.state === 'open').length;
    page.count('changes', undecided || '');
    panel.replaceChildren(...(all.length
      ? all.map(({r, c}) => changeItem(r, c, events, () => { void paintChanges(); open?.view.refresh(); }, !filter && repos.length > 1))
      : [h('div', {class: 'empty'}, t('No changes yet. Open an issue, Start, commit, push, and Change.'))]));
  };

  const paintHistory = async () => {
    const panel = page.panel('history');
    if (!connection()) { panel.replaceChildren(h('div', {class: 'empty'}, t('History is kept on the Remote. Sign in to it to see it.'))); return; }
    const all = (await Promise.all(shown().map(async (r) => (await gitops.logOf(r, 'main').catch(() => [])).map((c) => ({r, c}))))).flat()
      .sort((a, b) => b.c.time - a.c.time);
    page.count('history', '');
    panel.replaceChildren(...(all.length
      ? [h('div', {class: 'rows'}, ...all.map(({r, c}) => cutRows(r, [c], !filter && repos.length > 1).firstChild!))]
      : [h('div', {class: 'empty'}, t('No commits on main yet'))]));
  };

  page.onShow((k) => { if (k === 'changes') void paintChanges(); if (k === 'history') void paintHistory(); });

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
    void paint(); void paintChanges(); void paintHistory();
  });

  const main = h('section', {class: 'flow git-flow', tabindex: '0', 'aria-label': 'Git'},
    pageHead('git'),
    h('div', {class: 'part-bar'}, page.switch, chips),
    page.panel('issues'), page.panel('changes'), page.panel('history'));
  const workbench = bench({main, reveal: (path) => { if (at) ctx.openRepo(at, path); }});
  // Issues written anywhere (here, in the shell, with l3 in the Prompt) show
  // up at once, and any change in the repo looked at is read again.
  const stop = onChange((c) => {
    if (!workbench.element.isConnected) { stop(); return; }
    if (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/')) void paint();
    if (c.what === 'repo' || c.repo === at) open?.view.refresh();
  });
  const back = () => {
    if (!workbench.element.isConnected) { removeEventListener('focus', back); return; }
    open?.view.refresh();
    if (page.current() === 'changes') void paintChanges();
  };
  addEventListener('focus', back);
  return [workbench.element];
}
