import {h} from '../../ui/dom.ts';
import {ago, day} from '../../../text/format.ts';
import * as git from '../../../repo/history.ts';
import {t} from '../../../text/i18n.ts';
import {closedBy, numberOf, type Issue} from '../../../repo/issues.ts';
import {diffFiles} from '../kit/diff-view.ts';
import {clock, cut, LAND, paced, putAway, still, unfold} from '../../ui/glide.ts';
import {justClosed, justMerged, reopenIssue, resize, type IssueEvents, type RepoState} from './issue.ts';
import type {Laid} from '../../../repo/git-state.ts';
import {kindWords} from '../kit/todo-list.ts';
import {errorText} from '../../../api/errors.ts';
import {busy, held} from './held.ts';

// What Git shows round the issues: over them, what main has not committed
// (with its Commit, named by its line as why commit names it); under them,
// what is done with, newest first: what was committed on main from here,
// the issues merged, read only with their diffs, and those closed without
// being done, each with Reopen.

const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;

const heading = (id: string, text: string, n = 0) => h('h2', {id}, h('span', {}, text, ' ', h('small', {}, n ? `${n}` : '')));

/** The sections round the issues: main's over them, and under them what is done with, each its own section. */
export class Sections {
  readonly main = h('section', {class: 'section main-part', 'aria-label': t('Not committed'), hidden: ''});
  private readonly merged = h('section', {class: 'section', 'aria-labelledby': 'merged-title', hidden: ''});
  private readonly closed = h('section', {class: 'section', 'aria-labelledby': 'closed-title', hidden: ''});
  /** Those under the issues, in their order. */
  readonly under = [this.merged, this.closed];

  /**
   * Drawn again for what is `laid` out, of the repo `filter` (all, when ''). `moving`: drawn again while the page is
   * seen (not its first drawing), so a section under the issues that comes unfolds, and one that goes folds away.
   */
  draw({dirty, merged, closed}: Laid, filter: string, states: ReadonlyMap<string, RepoState>, events: IssueEvents, again: () => void, moving = false) {
    const was = this.under.map((s) => (s.hidden ? null : [...s.children]));
    this.main.hidden = !dirty.length;
    this.main.replaceChildren(...dirty.map((repo) => mainWork(repo, states, events, again)));
    this.merged.hidden = !merged.length;
    this.merged.replaceChildren(heading('merged-title', t('Merged'), merged.length), mergedList(merged, !filter));
    this.closed.hidden = !closed.length;
    this.closed.replaceChildren(heading('closed-title', t('Closed'), closed.length), closedList(closed, !filter, events, again));
    if (!moving || still()) return;
    this.under.forEach((s, i) => {
      const kids = was[i];
      if (!kids && !s.hidden) unfold(s, 280);
      else if (kids && s.hidden) foldAway(s, kids);
    });
  }
}

/**
 * A part gone from the page in a drawing (it has nothing to show now): what it showed folds away where it stood, what
 * is under it closing up as it does, rather than gone at once. `kids`: what it held, taken from it by the drawing.
 */
export function foldAway(part: HTMLElement, kids: Element[], style = part.getAttribute('style') ?? '') {
  if (still() || !kids.length) return;
  const ghost = h('section', {class: part.className, style, 'aria-hidden': 'true'}, ...kids);
  ghost.inert = true;
  part.before(ghost);
  putAway(ghost, () => ghost.remove(), {fold: true, ms: 280});
}

/**
 * When each line lit as it lands was first drawn, by what it is: drawn again meanwhile (the page read again a moment
 * after), the line goes on from where it had got to, never landing a second time, nor losing its light at once.
 */
const landedAt = new Map<string, number>();
/** The longest of a landing line's moves (its light, styles git-review.css line-lit). */
const LIT = 1600;
function landing(row: HTMLElement, key: string, fresh: boolean, kind = 'landing') {
  const was = landedAt.get(key), now = clock();
  if (was === undefined) {
    if (!fresh) return;
    landedAt.set(key, now);
  }
  const into = was === undefined ? 0 : now - was;
  if (into >= LIT) return;
  row.classList.add(kind);
  if (into) row.style.animationDelay = `${-into}ms`;
}

/** Kept by repo, so drawing again on this desk does not close the line being written. */
export function opened(_part: HTMLElement) {}

function mainWork(repo: string, states: ReadonlyMap<string, RepoState>, events: IssueEvents, again: () => void): HTMLElement {
  const files = h('ul', {class: 'git-main-files'});
  const error = h('p', {class: 'error', role: 'alert'});
  const title = h('input', {class: 'git-main-commit', 'aria-label': t('Commit title'), placeholder: t('Commit title')}) as HTMLInputElement;
  const cut = button(t('Commit'));
  const record = async () => {
    if (held(cut)) return;
    busy(cut, true);
    error.textContent = '';
    try {
      await git.cut(repo, null, title.value, '', 'main');
      again();
    } catch (e) {
      busy(cut, false);
      error.textContent = errorText(e);
    }
  };
  cut.addEventListener('click', () => void record());
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) void record(); });
  const n = states.get(repo)?.uncommitted ?? 0;
  void git.mainChanges(repo).then((diff) => {
    if (!diff.connected) return;
    const shown = diff.folders.flatMap((f) => f.files).filter((f) => !f.path.startsWith('issue/'));
    files.replaceChildren(...shown.map((f) => {
      const path = f.status === 'removed' ? h('span', {}, f.path) :
        h('button', {type: 'button', class: 'git-main-file', 'data-path': f.path}, f.path);
      if (path instanceof HTMLButtonElement) path.addEventListener('click', () => {
        void git.work(repo).then((active) => {
          if (active.line === 'main') events.open(repo, f.path);
          else error.textContent = t('Read main before opening its uncommitted file');
        }, (e) => { error.textContent = errorText(e); });
      });
      return h('li', {}, path, h('span', {class: 'git-main-count'}, f.binary ? t('Binary') : `+${f.added} −${f.removed}`));
    }));
  }, (e) => { error.textContent = errorText(e); });
  return h('div', {class: 'git-main-pending'}, h('p', {class: 'git-main-label'}, t('Not committed'), ' · ', String(n)), files, title, cut, error);
}

/** "#3 Fix：title", the number quiet, as an issue's head writes it. */
const named = (n: number | null, kind: string | null, title: string) => h('span', {class: 'done-name'},
  n === null ? null : h('span', {class: 'issue-no'}, `#${n} `), kind ? h('span', {class: 'issue-kind'}, ...kindWords(kind)) : null, title);

/** The merged ones opened, by change: the page drawn again (anything saved in the repo does it) keeps them open. */
const unfurled = new Set<string>();
/** A merged change's diff as read (it never changes): opened again, it is there at once. */
const diffsRead = new Map<string, () => Node[]>();


/** The issues merged into main, newest first: who handed each in and when it was merged; opened, its diff. Only read. */
function mergedList(list: {repo: string; change: git.Change}[], all: boolean): HTMLElement {
  return h('div', {class: 'done-list'}, ...list.map(({repo, change: c}) => {
    const inside = h('div', {class: 'done-diff'});
    const meta = t('{who} · merged {when}', {who: c.submittedBy || '—', when: ago(c.updatedAt)});
    const head = h('summary', {class: 'done-head'}, named(numberOf(c.issue.replace(/^issue\//, '')), c.kind || null, c.title),
      h('span', {class: 'muted small'}, all ? `${repo} · ${meta}` : meta));
    const fold = h('details', {class: 'done-row', 'data-change': c.id}, head, inside) as HTMLDetailsElement;
    landing(fold, `merged\0${c.id}`, justMerged(c.id));
    // What it holds, grown into from the height it had (its head alone, or "Loading…"): never there at once.
    const show = (...nodes: Node[]) => { const from = fold.getBoundingClientRect().height; inside.replaceChildren(...nodes); resize(fold, from); };
    let read = false;
    fold.addEventListener('toggle', () => {
      if (fold.open) unfurled.add(c.id); else unfurled.delete(c.id);
      if (!fold.open || read) return;
      read = true;
      const was = diffsRead.get(c.id);
      if (was) { inside.replaceChildren(...was()); return; }
      // Read quickly (as it nearly always is), its diff comes straight in; only a slow read says it is on its way.
      const slow = setTimeout(() => show(h('p', {class: 'muted small'}, t('Loading…'))), 300);
      void git.changeDiff(repo, c).then((files) => {
        const nodes = () => (files.length ? diffFiles(files, {kept: `merged\0${c.id}`}) : [h('p', {class: 'muted small'}, t('No changes'))]);
        diffsRead.set(c.id, nodes);
        clearTimeout(slow);
        show(...nodes());
      }, (e) => { clearTimeout(slow); show(h('p', {class: 'error'}, errorText(e))); });
    });
    // Pressed, it opens growing from its head, and shuts closing up to it (not the browser's at once).
    head.addEventListener('click', (e) => {
      if (still()) return;
      const from = fold.getBoundingClientRect().height;
      if (!fold.open) { requestAnimationFrame(() => { if (fold.open) resize(fold, from); }); return; }
      e.preventDefault();
      if (fold.classList.contains('shutting')) return;
      fold.classList.add('shutting');
      fold.style.overflow = 'hidden';
      const to = head.getBoundingClientRect().height;
      fold.animate([{height: `${from}px`}, {height: `${to}px`}], {duration: cut() ? 0 : paced(220), easing: LAND}).finished.then(() => {
        fold.open = false;
        fold.style.overflow = '';
        fold.classList.remove('shutting');
      }, () => {});
    });
    fold.open = unfurled.has(c.id);
    return fold;
  }));
}

/** A day as a line under Closed says when (a close is marked by its day alone, not its hour): today, yesterday, or
 * the day, never "3 h ago" for one closed a moment ago. */
function onDay(at: number, now = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return at >= today ? t('today') : at >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() ? t('yesterday') : day(at);
}

/**
 * The issues closed without being done: when and by whom, and Reopen at the row's right end (while the repo shows
 * main); reopened, the row goes to it (events.back).
 */
function closedList(list: {issue: Issue; reopen: boolean}[], all: boolean, events: IssueEvents, after: () => void): HTMLElement {
  return h('div', {class: 'done-list'}, ...list.map(({issue: i, reopen}) => {
    const {at, by} = closedBy(i.closed ?? '');
    const when = at === null ? '' : onDay(at);
    const meta = by ? t('{who} · closed {day}', {who: by, day: when}) : t('Closed {day}', {day: when});
    const error = h('p', {class: 'error', role: 'alert'});
    let act: HTMLButtonElement | null = null;
    if (reopen) {
      act = button(t('Reopen'), 'small-button');
      act.setAttribute('aria-label', t('Reopen {issue}', {issue: i.n === null ? i.title : `#${i.n}`}));
      act.addEventListener('click', async () => {
        if (held(act!)) return;
        busy(act!, true);
        try { await reopenIssue(i); events.back?.(i); after(); } catch (e) { error.textContent = errorText(e); busy(act!, false); }
      });
    }
    // Closed just now from its box: its line lands here, lit a moment, where the eye goes after it.
    const row = h('div', {class: 'done-row done-head'}, named(i.n, i.kind, i.title), h('span', {class: 'muted small'}, all ? `${i.repo} · ${meta}` : meta), h('span', {class: 'grow'}), act, error);
    landing(row, `closed\0${i.repo}/${i.file}`, justClosed(i));
    return row;
  }));
}
