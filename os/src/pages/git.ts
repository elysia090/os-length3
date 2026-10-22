import {h} from '../dom.ts';
import * as gitops from '../history.ts';
import {t} from '../i18n.ts';
import {number, readIssues, type Issue} from '../issues.ts';
import {bring, remoteOnly} from '../lifecycle.ts';
import {connection} from '../remote.ts';
import {onChange, store} from '../repos.ts';
import {bench} from './bench.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {closedList, mainCard, mergedList} from './git-done.ts';
import {issueBox, issueHead, mergeRow, reviewBox, type RepoState} from './git-issue.ts';
import {laidOut, type Laid} from '../git-state.ts';
import {issueForm} from './issue-form.ts';
import {errorText} from '../errors.ts';

/**
 * Git: what happens between a repo and the outside, in the issues' terms.
 * The repo chips are one row that slides sideways, however many repos there
 * are, so they never push the issues down; while an issue is written, the
 * repo chosen there is the one it goes in (All leaves that as it was).
 * Under the repo chips, the issues not merged yet as large boxes side by
 * side: one in full, its neighbours' edges showing at both sides. An edge is
 * the way to the box beside (hover lifts it; ← → do the same), and the track
 * slides there. The box holds the issue's number, words and next action
 * (git-issue.ts); under it, plainly, its Diff, Review and Reply.
 *
 * Issues are read straight from each repo's issue/ (nothing is kept twice).
 *
 * The repo the bench shows is the one worked on, on every page: a chip, an
 * issue gone to with an edge or an arrow, or one just written, makes its repo
 * the one Forge opens. Coming to Git changes nothing by itself: it opens at
 * the issue last looked at in the repo worked on. The keyboard stays on the
 * same part of the box as one goes along the row.
 */

const ALL = '';
let filter = ALL;
/** The issue shown, kept while the app runs: repo and file. */
let chosen: string | null = null;
/** The issue last looked at in each repo. */
const chosenIn = new Map<string, string>();

export function git(ctx: Context): Node[] {
  const chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  const write = h('button', {class: 'button', type: 'button'}, t('Write an issue')) as HTMLButtonElement;
  const count = h('small', {});
  const track = h('div', {class: 'issue-track'});
  // The edges over the neighbours: clear, lifted on hover like any place.
  const prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous issue')}) as HTMLButtonElement;
  const next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next issue')}) as HTMLButtonElement;
  const stage = h('div', {class: 'issue-stage', tabindex: '0', 'aria-label': t('Issues'), 'aria-roledescription': 'carousel'}, track, prev, next);
  const column = h('div', {class: 'issue-column'}, stage);
  const empty = h('div', {});
  // Written: its repo is the one looked at and worked on, and the new issue is the one shown, with the keyboard on it.
  const form = issueForm({done: (made, back) => {
    write.hidden = false;
    // Asked for from Forge's reference and put back: back there, as it was.
    if (!made && back) { ctx.openRepo(back); return; }
    if (!made) { write.focus({preventScroll: true}); return; }
    if (filter && filter !== made.repo) { filter = made.repo; paintChips(); }
    chosen = `${made.repo}/${made.file}`;
    chosenIn.set(made.repo, chosen);
    look(made.repo, true);
    land = true;
    void paint();
  }});

  let repos: string[] = [];
  let at: string | null = null;
  let shown: Issue[] = [];
  let states = new Map<string, RepoState>();
  let k = 0;

  const key = (i: Issue) => `${i.repo}/${i.file}`;
  const events = {
    open: (repo: string, path: string) => ctx.openRepo(repo, path),
    // The repo shows another copy: what File, Forge and the issues read is that copy now.
    // Started, continued or back on main: that repo is the one worked on.
    moved: (repo: string) => { ctx.remember(repo); if (repo === at) void paint(); },
  };
  const again = () => void paint();

  /** Point the reference and the Prompt at `repo`; `chosen` when the person chose it, which makes it the repo worked on. */
  const look = (repo: string | null, chosen = false) => {
    at = repo;
    if (!repo) return;
    workbench.setRepo(repo);
    if (chosen) ctx.remember(repo);
  };
  /** Put the keyboard on the new issue's words once it is drawn. */
  let land = false;

  const paintChips = () => {
    // A chip pressed from the keyboard keeps it when the row is drawn again.
    const had = [...chips.children].indexOf(document.activeElement as Element);
    chips.replaceChildren(...[ALL, ...repos].map((r) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(filter === r)}, r || t('All'));
      b.addEventListener('click', () => { filter = r; paintChips(); if (r) { look(r, true); form.retarget(r); } void paint(); });
      return b;
    }));
    if (had >= 0) (chips.children[had] as HTMLElement | undefined)?.focus({preventScroll: true});
    // The chosen one is kept in view as the row slides.
    const on = chips.querySelector<HTMLElement>('[aria-checked="true"]');
    if (on && chips.scrollWidth > chips.clientWidth) {
      if (on.offsetLeft < chips.scrollLeft) chips.scrollLeft = on.offsetLeft;
      else if (on.offsetLeft + on.offsetWidth > chips.scrollLeft + chips.clientWidth) chips.scrollLeft = on.offsetLeft + on.offsetWidth - chips.clientWidth;
    }
  };

  /** Slide to the `n`th box: it gets the whole box, the others only their heads. */
  const sized = new ResizeObserver(([e]) => track.style.setProperty('--card-h', `${(e.target as HTMLElement).offsetHeight}px`));
  /** The part of the box that has the keyboard (its words, a button), so the box gone to or drawn again gives it back. */
  // Told by its kind and its words: every button in a box is a .button, and the first of them is Close, so a box
  // drawn again under the keyboard on Start must not hand it to Close (the next Enter would close the issue).
  const part = (): {kind: string; words: string} | null => {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !track.contains(a)) return null;
    const kind = a.className.split(' ')[0];
    return kind ? {kind, words: a.textContent?.trim() ?? ''} : null;
  };
  const sameDeed = (slot: HTMLElement | undefined, had: {kind: string; words: string}) => {
    const all = [...(slot?.querySelectorAll<HTMLElement>(`.${had.kind}`) ?? [])];
    return all.find((e) => (e.textContent?.trim() ?? '') === had.words) ?? (all.length === 1 && had.kind !== 'button' ? all[0] : null);
  };
  const go = (n: number, moved = false, had = part()) => {
    if (!shown.length) return;
    k = Math.max(0, Math.min(shown.length - 1, n));
    const i = shown[k];
    chosen = key(i);
    chosenIn.set(i.repo, chosen);
    look(i.repo, moved);
    track.style.setProperty('--at', `${k}`);
    // The first box starts at the column's edge and the last ends at it; between, both neighbours show.
    column.style.setProperty('--lead', `${k === 0 ? 0 : k === shown.length - 1 ? 2 : 1}`);
    [...track.children].forEach((slot, j) => {
      const x = shown[j];
      slot.setAttribute('aria-current', String(j === k));
      // Each issue is a column: its card, and once pushed, its Review and Merge
      // under it, so they slide with it. The neighbours show only their heads.
      const st = states.get(x.repo);
      slot.replaceChildren(...(j === k
        ? [h('div', {class: 'issue-card'}, issueBox(x, st, events, again)), reviewBox(x, st, again), mergeRow(x, st, events, again)].filter((n): n is HTMLElement => !!n)
        : [h('div', {class: 'issue-card'}, issueHead(x, true))]));
    });
    // The neighbours' cards are as tall as the current one, so the row reads as one line of boxes.
    const card = track.children[k]?.querySelector<HTMLElement>('.issue-card');
    sized.disconnect();
    if (card) sized.observe(card);
    const edge = document.activeElement === prev || document.activeElement === next;
    prev.hidden = k === 0;
    next.hidden = k === shown.length - 1;
    const slot = track.children[k] as HTMLElement | undefined;
    if (land) { land = false; slot?.querySelector<HTMLElement>('.issue-words')?.focus({preventScroll: true}); return; }
    if (had) (sameDeed(slot, had) ?? stage).focus({preventScroll: true});
    // An edge pressed that is gone now (the first or last box reached): the keyboard stays on the row.
    else if (edge && (document.activeElement as HTMLElement | null)?.hidden) stage.focus({preventScroll: true});
  };
  prev.addEventListener('click', () => go(k - 1, true));
  next.addEventListener('click', () => go(k + 1, true));
  stage.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(k - 1, true); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(k + 1, true); }
  });

  // One drawing at a time; asked again meanwhile, it draws once more after, from what is then true.
  let drawing: Promise<void> | null = null;
  let more = false;
  const paint = (): Promise<void> => {
    if (drawing) { more = true; return drawing; }
    drawing = draw().finally(() => { drawing = null; if (more) { more = false; void paint(); } });
    return drawing;
  };
  const draw = async () => {
    const all = await Promise.all(repos.map((r) => readIssues(store, r)));
    const issues = all.flatMap((x, j) => (!filter || repos[j] === filter ? x : []));
    // Where each repo stands: the work it shows, the issues started, the changes to main.
    const fresh = new Map<string, RepoState>();
    // Every repo looked at, issues or not: what its main has not committed shows too.
    if (connection()) await Promise.all(repos.filter((r) => !filter || r === filter).map(async (r) => {
      try {
        let {work, lines, changes} = await gitops.standing(r);
        // A work whose change was merged (here or on another device) is done: the repo shows main again.
        if (work.line !== 'main' && changes.some((c) => c.line === work.line && c.state === 'merged')) {
          await gitops.switchWork(r, 'main');
          work = await gitops.work(r);
        }
        const uncommitted = (await gitops.changes(r)).files;
        fresh.set(r, {work, lines, changes, uncommitted});
      } catch (e) {
        fresh.set(r, {work: null, lines: [], changes: [], uncommitted: 0, error: errorText(e)});
      }
    }));
    states = fresh;
    // An issue without a number (written by hand, or two devices' met under one) takes the next free one;
    // the store's change draws the page again. Not on main's behalf while a work is shown: that copy is the work's.
    const renumbered = await Promise.all([...new Set(issues.filter((i) => i.n === null).map((i) => i.repo))].map((r) => {
      const st = states.get(r);
      if (!st || st.error || (st.work && st.work.line !== 'main')) return false;
      const inUse = new Set([...st.lines.map((l) => l.issue), ...st.changes.map((c) => c.issue)]);
      return number(store, r, issues.filter((i) => i.repo === r), inUse);
    }));
    if (renumbered.some(Boolean)) return;
    // Oldest first, so #1 is on the left; merged and closed ones are done with, and listed under the issues.
    const laid = laidOut(repos.filter((r) => !filter || r === filter), issues, states);
    shown = laid.open;
    count.textContent = shown.length ? `${shown.length}` : '';
    drawDone(laid);
    if (!shown.length) {
      track.replaceChildren();
      stage.hidden = true;
      empty.replaceChildren(!repos.length && remoteOnly().length ? onlyThere()
        : h('div', {class: 'empty'}, !repos.length ? t('No repos yet') : issues.length ? t('No open issues') : t('No issues yet')));
      return;
    }
    empty.replaceChildren();
    stage.hidden = false;
    column.classList.toggle('single', shown.length === 1);
    const had = part();
    track.replaceChildren(...shown.map(() => h('div', {class: 'issue-slot'})));
    // The issue last looked at, in the repo worked on when that has one here.
    const mine = ctx.repo && shown.some((i) => i.repo === ctx.repo) && !chosen?.startsWith(`${ctx.repo}/`) ? chosenIn.get(ctx.repo) : chosen;
    let was = shown.findIndex((i) => key(i) === mine);
    if (was < 0 && ctx.repo) was = shown.findIndex((i) => i.repo === ctx.repo);
    go(was >= 0 ? was : 0, false, had);
  };

  // Under the issues: what main has not committed, then what is done with (merged, closed), each its own section.
  const heading = (id: string, text: string, n = 0) => h('h2', {id}, h('span', {}, text, ' ', h('small', {}, n ? `${n}` : '')));
  const mainPart = h('section', {class: 'section', 'aria-labelledby': 'main-title', hidden: ''});
  const mergedPart = h('section', {class: 'section', 'aria-labelledby': 'merged-title', hidden: ''});
  const closedPart = h('section', {class: 'section', 'aria-labelledby': 'closed-title', hidden: ''});
  const drawDone = ({dirty, merged, closed}: Laid) => {
    mainPart.hidden = !dirty.length;
    mainPart.replaceChildren(heading('main-title', 'main'), ...dirty.map((r) => mainCard(r, states.get(r)!.uncommitted, events, again)));
    mergedPart.hidden = !merged.length;
    mergedPart.replaceChildren(heading('merged-title', t('Merged'), merged.length), mergedList(merged, !filter));
    closedPart.hidden = !closed.length;
    closedPart.replaceChildren(heading('closed-title', t('Closed'), closed.length), closedList(closed, !filter, again));
  };

  write.addEventListener('click', () => {
    write.hidden = true;
    form.open(repos, filter || at || repos[0]);
  });

  const load = () => void store.list().then((r) => {
    repos = r.map((x) => x.name);
    if (filter && !repos.includes(filter)) filter = ALL;
    write.disabled = !repos.length;
    look(filter || (ctx.repo && repos.includes(ctx.repo) ? ctx.repo : repos[0] ?? null));
    paintChips();
    // An issue half written when the page was left is still being written.
    if (form.resume(repos)) write.hidden = true;
    void paint();
  });
  /** No repo here and some on the Remote: each fetched with a press, as Runtime's are, and its issues are here. */
  const onlyThere = () => h('div', {class: 'empty fetch-list'}, h('p', {}, t('Only on the Remote')), ...remoteOnly().map((r) => {
    const b = h('button', {type: 'button', class: 'button small-button'}, t('Fetch')) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = t('Bringing it…');
      try { await bring(r.name); load(); } catch (e) { b.disabled = false; b.textContent = errorText(e); }
    });
    return h('div', {class: 'fetch-row'}, h('span', {}, r.name), b);
  }));
  load();

  const main = h('section', {class: 'flow git-flow', tabindex: '0', 'aria-label': 'Git'},
    pageHead('git'),
    h('div', {class: 'git-filter'}, chips),
    h('section', {class: 'section', 'aria-labelledby': 'issues-title'},
      h('h2', {id: 'issues-title'}, h('span', {}, t('Issues'), ' ', count), write),
      form.element, empty, column),
    mainPart, mergedPart, closedPart);
  const workbench = bench({main, reveal: (path) => { if (at) ctx.openRepo(at, path); }});
  // Issues written anywhere (here, in the shell, with l3 in the Prompt) show
  // up at once, and any change in the repo looked at is read again; not while
  // something is being written in the box or under it, which would be lost.
  let timer = 0;
  const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && (stage.contains(a) || mainPart.contains(a)) && !!(a as HTMLInputElement).value; };
  const soon = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (typing()) soon(); else void paint(); }, 250); };
  const stop = onChange((c) => {
    if (!workbench.element.isConnected) { stop(); return; }
    if (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/') || c.repo === at) soon();
  });
  const back = () => { if (!workbench.element.isConnected) { removeEventListener('focus', back); return; } soon(); };
  addEventListener('focus', back);
  return [workbench.element];
}
