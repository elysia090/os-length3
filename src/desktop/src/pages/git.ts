import {h} from '../dom.ts';
import * as gitops from '../history.ts';
import {t, tn} from '../i18n.ts';
import {readIssues, type Issue} from '../issues.ts';
import {connection} from '../remote.ts';
import {onChange, store} from '../repos.ts';
import {bench} from './bench.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {issueBox, issueHead, mergeRow, reviewBox, unmerged, type RepoState} from './git-issue.ts';
import {issueForm} from './issue-form.ts';

/**
 * Git: what happens between a repo and the outside, in the issues' terms.
 * Under the repo chips, the issues not merged yet as large boxes side by
 * side: one in full, its neighbours' edges showing at both sides. An edge is
 * the way to the box beside (hover lifts it; ← → do the same), and the track
 * slides there. The box holds the issue's number, words and next action
 * (git-issue.ts); under it, plainly, its Diff, Review and Reply.
 *
 * Issues are read straight from each repo's issue/ (nothing is kept twice).
 */

const ALL = '';
let filter = ALL;
/** The issue shown, kept while the app runs: repo and file. */
let chosen: string | null = null;

export function git(ctx: Context): Node[] {
  const chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  const write = h('button', {class: 'button', type: 'button'}, t('Write an issue')) as HTMLButtonElement;
  const count = h('small', {});
  const track = h('div', {class: 'issue-track'});
  // The edges over the neighbours: clear, lifted on hover like any place.
  const prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous issue')}) as HTMLButtonElement;
  const next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next issue')}) as HTMLButtonElement;
  const stage = h('div', {class: 'issue-stage', tabindex: '0', 'aria-label': t('Issues'), 'aria-roledescription': 'carousel'}, track, prev, next);
  // Under the stage, the current issue's Review, a box of its own lined up with the issue's, then Merge.
  const below = h('div', {class: 'issue-below'});
  const column = h('div', {class: 'issue-column'}, stage, below);
  const empty = h('div', {});
  const form = issueForm({done: (repo) => { write.hidden = false; if (repo) void paint(); }});

  let repos: string[] = [];
  let missing: string[] = [];
  let at: string | null = null;
  let shown: Issue[] = [];
  let states = new Map<string, RepoState>();
  let k = 0;

  const key = (i: Issue) => `${i.repo}/${i.file}`;
  const events = {
    open: (repo: string, path: string) => ctx.openRepo(repo, path),
    // The repo shows another copy: what File, Forge and the issues read is that copy now.
    moved: (repo: string) => { if (repo === at) void paint(); },
  };
  const again = () => void paint();

  /** Point the reference and the Prompt at `repo`. */
  const look = (repo: string | null) => {
    at = repo;
    if (repo) workbench.setRepo(repo);
  };

  const paintChips = () => {
    chips.replaceChildren(...[ALL, ...repos].map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(filter === r)}, r || t('All'));
      b.addEventListener('click', () => { filter = r; paintChips(); if (r) look(r); void paint(); });
      return b;
    }));
  };

  /** Slide to the `n`th box: it gets the whole box, the others only their heads. */
  const go = (n: number) => {
    if (!shown.length) return;
    k = Math.max(0, Math.min(shown.length - 1, n));
    const i = shown[k];
    chosen = key(i);
    look(i.repo);
    track.style.setProperty('--at', `${k}`);
    // The first box starts at the column's edge and the last ends at it; between, both neighbours show.
    column.style.setProperty('--lead', `${k === 0 ? 0 : k === shown.length - 1 ? 2 : 1}`);
    [...track.children].forEach((slot, j) => {
      const x = shown[j];
      slot.setAttribute('aria-current', String(j === k));
      slot.replaceChildren(j === k ? issueBox(x, states.get(x.repo), events, again) : issueHead(x));
    });
    below.replaceChildren(...[reviewBox(i, states.get(i.repo), again), mergeRow(i, states.get(i.repo), events, again)].filter((x): x is HTMLElement => !!x));
    prev.hidden = k === 0;
    next.hidden = k === shown.length - 1;
  };
  prev.addEventListener('click', () => go(k - 1));
  next.addEventListener('click', () => go(k + 1));
  stage.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(k - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(k + 1); }
  });

  const paint = async () => {
    const all = await Promise.all(repos.map((r) => readIssues(store, r)));
    missing = repos.filter((_, j) => all[j] === null);
    const issues = all.flatMap((x, j) => (!filter || repos[j] === filter ? x ?? [] : []));
    // Where each repo stands: the work it shows, the issues started, the changes to main.
    const fresh = new Map<string, RepoState>();
    if (connection()) await Promise.all([...new Set(issues.map((i) => i.repo))].map(async (r) => {
      let [work, lines, changes] = await Promise.all([gitops.work(r).catch(() => null), gitops.lines(r).catch(() => []), gitops.changesOf(r).catch(() => [])]);
      // A work whose change was merged (here or on another device) is done: the repo shows main again.
      if (work && work.line !== 'main' && changes.some((c) => c.line === work!.line && c.state === 'merged')) {
        await gitops.switchWork(r, 'main').catch(() => {});
        work = await gitops.work(r).catch(() => null);
      }
      const uncommitted = work && work.line !== 'main' ? (await gitops.changes(r).catch(() => null))?.files ?? 0 : 0;
      fresh.set(r, {work, lines, changes, uncommitted});
    }));
    states = fresh;
    // Oldest first, so #1 is on the left; merged ones are done.
    shown = issues.filter((i) => unmerged(states.get(i.repo), i)).sort((a, b) => (a.repo === b.repo ? (a.file < b.file ? -1 : 1) : a.repo < b.repo ? -1 : 1));
    const done = issues.length - shown.length;
    count.textContent = shown.length ? `${shown.length}` : '';
    count.title = done ? tn('{n} merged', '{n} merged', done) : '';
    if (!shown.length) {
      track.replaceChildren();
      stage.hidden = true;
      below.replaceChildren();
      empty.replaceChildren(h('div', {class: 'empty'}, !repos.length ? t('No repos yet') : issues.length ? t('Every issue is merged.') : t('No issues yet')));
      return;
    }
    empty.replaceChildren();
    stage.hidden = false;
    column.classList.toggle('single', shown.length === 1);
    track.replaceChildren(...shown.map(() => h('div', {class: 'issue-slot'})));
    const was = shown.findIndex((i) => key(i) === chosen);
    go(was >= 0 ? was : 0);
  };

  write.addEventListener('click', () => {
    const takers = repos.filter((r) => !missing.includes(r));
    if (!takers.length) { empty.replaceChildren(h('p', {class: 'error'}, t('No repo has an issue/ folder'))); return; }
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
      h('h2', {id: 'issues-title'}, h('span', {}, t('Issues'), ' ', count), write),
      form.element, empty, column));
  const workbench = bench({main, reveal: (path) => { if (at) ctx.openRepo(at, path); }});
  // Issues written anywhere (here, in the shell, with l3 in the Prompt) show
  // up at once, and any change in the repo looked at is read again; not while
  // something is being written in the box or under it, which would be lost.
  let timer = 0;
  const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && (stage.contains(a) || below.contains(a)) && !!(a as HTMLInputElement).value; };
  const soon = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (typing()) soon(); else void paint(); }, 250); };
  const stop = onChange((c) => {
    if (!workbench.element.isConnected) { stop(); return; }
    if (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/') || c.repo === at) soon();
  });
  const back = () => { if (!workbench.element.isConnected) { removeEventListener('focus', back); return; } soon(); };
  addEventListener('focus', back);
  return [workbench.element];
}
