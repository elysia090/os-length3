import {ago, day, h} from '../dom.ts';
import * as git from '../history.ts';
import {t, tn} from '../i18n.ts';
import {closedBy, numberOf, type Issue} from '../issues.ts';
import {kindOf} from '../text.ts';
import {answers, askFoot, SETTLE} from './common.ts';
import {counted, diffFiles} from './diff-view.ts';
import {LAND, nudge, paced, still} from '../glide.ts';
import {justClosed, justMerged, notCommitted, reopenIssue, type IssueEvents} from './git-issue.ts';
import {kindWords} from './todo-box.ts';
import {errorText} from '../errors.ts';

// What Git shows under the issues: what main has not committed (with its
// Commit, named by its line as l3 commit names it), then what is done with,
// newest first: the issues merged, read only with their diffs, and those
// closed without being done, each with Reopen.

const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;

/** The line a commit on main is being named by, per repo: kept as written until it is committed or put back with Not now. */
const naming = new Map<string, string>();
/** Repos whose line was put away with Escape: kept, the card back to Commit until it is pressed again. */
const folded = new Set<string>();

/** Committed on main from here, newest first, a few: each stays a line under main where its card was. */
const committed: {repo: string; cut: git.Cut}[] = [];
const KEPT = 3;
export const committedIn = (filter: string | null) => committed.filter((c) => !filter || c.repo === filter);

/**
 * Committed, the card goes: it slides off sideways as it fades, and the room it took closes after it, so what is under
 * it comes up rather than jumping. Done once it has gone (the page is drawn again after).
 */
async function slideOff(card: HTMLElement): Promise<void> {
  if (still() || !card.isConnected) return;
  card.classList.add('leaving');
  const cs = getComputedStyle(card);
  const off = card.animate([{transform: 'none', opacity: 1}, {transform: 'translateX(96px)', opacity: 0}], {duration: paced(340), easing: LAND, fill: 'forwards'});
  const close = card.animate([
    {height: `${card.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth},
    {height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', borderTopWidth: '0px', borderBottomWidth: '0px'},
  ], {duration: paced(280), delay: paced(160), easing: LAND, fill: 'forwards'});
  card.style.overflow = 'hidden';
  await Promise.all([off.finished, close.finished]).catch(() => {});
}

/** The card's height goes from what it was to what it now holds (a line asked for is shorter than the files it names). */
function resize(card: HTMLElement, from: number) {
  if (still() || !from || !card.isConnected) return;
  const to = card.getBoundingClientRect().height;
  if (Math.abs(to - from) < 2) return;
  card.style.overflow = 'hidden';
  const back = () => { card.style.overflow = ''; };
  card.animate([{height: `${from}px`}, {height: `${to}px`}], {duration: paced(280), easing: LAND}).finished.then(back, back);
}

/**
 * main's card for a repo with something not committed: its files (▸ 2 files,
 * their diff over what is under it) and Commit. Commit asks in the card for
 * its line ("Fix：title", as `l3 commit REPO "Fix：title"` takes it), Not now
 * at the left and Commit at the right, under the pointer.
 */
export function mainCard(repo: string, n: number, events: IssueEvents, after: () => void): HTMLElement {
  const card = h('div', {class: 'main-card', role: 'group', 'aria-label': t('Not committed on main in {repo}', {repo})});
  const plain = () => {
    const from = card.isConnected ? card.getBoundingClientRect().height : 0;
    const commit = button(t('Commit'), 'primary');
    commit.addEventListener('click', () => ask(commit));
    // Laid out as an issue's box is: its name at the top, the files under it on the card itself, and at its foot how
    // many wait at the left and Commit at the right, where an issue's next step is.
    card.replaceChildren(h('h3', {class: 'main-title'}, repo),
      notCommitted(repo, n, events),
      h('div', {class: 'issue-foot main-foot'},
        h('span', {class: 'muted small'}, tn('{n} file to commit on main', '{n} files to commit on main', n)), commit));
    resize(card, from);
    return commit;
  };
  const ask = (from: Element | null) => {
    const foot = from ? askFoot(from, card) : answers;
    const was = card.isConnected ? card.getBoundingClientRect().height : 0;
    const line = h('input', {class: 'line-in', placeholder: t('Fix: what changed'), 'aria-label': t('The commit\'s line as Kind: title'), maxlength: '200', spellcheck: 'false'}) as HTMLInputElement;
    folded.delete(repo);
    line.value = naming.get(repo) ?? '';
    naming.set(repo, line.value);
    line.addEventListener('input', () => naming.set(repo, line.value));
    const error = h('p', {class: 'error', role: 'alert'});
    const no = button(t('Not now'), 'small-button');
    const yes = button(t('Commit'), 'small-button primary');
    no.addEventListener('click', () => { naming.delete(repo); folded.delete(repo); plain().focus(); });
    const shown = performance.now();
    yes.addEventListener('click', async () => {
      if (performance.now() - shown < SETTLE) return;
      if (!kindOf(line.value).title.trim()) { error.textContent = t('A commit needs a title (for example Fix：title)'); line.focus(); nudge(line); return; }
      yes.disabled = true;
      error.textContent = '';
      try {
        const cut = await git.cut(repo, null, line.value, '');
        naming.delete(repo);
        committed.unshift({repo, cut});
        committed.splice(KEPT);
        // The card slides off sideways and its room closes; drawn again, its line under main lands lit.
        await slideOff(card);
        after();
      } catch (e) { error.textContent = errorText(e); yes.disabled = false; }
    });
    // One line, nothing to break: Enter commits it, as Ctrl+Enter does.
    line.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); yes.click(); } });
    // Escape puts it back as Not now does, but what was written waits for Commit to be pressed again.
    line.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (line.value.trim()) folded.add(repo); else naming.delete(repo);
      plain().focus();
    });
    card.replaceChildren(h('div', {class: 'off-ask'}, h('h3', {class: 'main-title'}, repo),
      h('p', {class: 'muted small'}, tn('{n} file to commit on main', '{n} files to commit on main', n)), line, error, foot(no, yes)));
    resize(card, was);
    line.focus({preventScroll: true});
  };
  if (naming.has(repo) && !folded.has(repo)) ask(null); else plain();
  return card;
}

/** "#3 Fix：title", the number quiet, as an issue's head writes it. */
const named = (n: number | null, kind: string | null, title: string) => h('span', {class: 'done-name'},
  n === null ? null : h('span', {class: 'issue-no'}, `#${n} `), kind ? h('span', {class: 'issue-kind'}, ...kindWords(kind)) : null, title);

/** What was committed on main from here: its line, how much it changed, and when; the newest lit as it lands. */
export function committedList(list: {repo: string; cut: git.Cut}[], all: boolean): HTMLElement {
  const newest = committed[0]?.cut.id;
  return h('div', {class: 'done-list'}, ...list.map(({repo, cut}) => {
    const meta = t('Committed {when}', {when: ago(cut.time || Date.now())});
    const row = h('div', {class: 'done-row done-head', 'data-cut': cut.id}, named(null, cut.kind, cut.title),
      cut.added || cut.removed ? counted(cut.added, cut.removed) : null, h('span', {class: 'grow'}),
      h('span', {class: 'muted small'}, all ? `${repo} · ${meta}` : meta));
    if (cut.id === newest && Date.now() - (cut.time || 0) < 4000) row.classList.add('just-cut');
    return row;
  }));
}

/** The merged ones opened, by change: the page drawn again (anything saved in the repo does it) keeps them open. */
const opened = new Set<string>();


/** The issues merged into main, newest first: who handed each in and when it was merged; opened, its diff. Only read. */
export function mergedList(list: {repo: string; change: git.Change}[], all: boolean): HTMLElement {
  return h('div', {class: 'done-list'}, ...list.map(({repo, change: c}) => {
    const inside = h('div', {class: 'done-diff'}, h('p', {class: 'muted small'}, t('Reading…')));
    const meta = t('{who} · merged {when}', {who: c.submittedBy || '—', when: ago(c.updatedAt)});
    const fresh = justMerged(c.id);
    const fold = h('details', {class: fresh ? 'done-row landing' : 'done-row', 'data-change': c.id},
      h('summary', {class: 'done-head'}, named(numberOf(c.issue.replace(/^issue\//, '')), c.kind || null, c.title),
        h('span', {class: 'muted small'}, all ? `${repo} · ${meta}` : meta)),
      inside) as HTMLDetailsElement;
    let read = false;
    fold.addEventListener('toggle', () => {
      if (fold.open) opened.add(c.id); else opened.delete(c.id);
      if (!fold.open || read) return;
      read = true;
      void git.changeDiff(repo, c).then((files) => inside.replaceChildren(...(files.length ? diffFiles(files, {beside: true}) : [h('p', {class: 'muted small'}, t('No changes'))])),
        (e) => inside.replaceChildren(h('p', {class: 'error'}, errorText(e))));
    });
    fold.open = opened.has(c.id);
    return fold;
  }));
}

/** The issues closed without being done: when and by whom, and Reopen at the row's right end (while the repo shows main). */
export function closedList(list: {issue: Issue; reopen: boolean}[], all: boolean, after: () => void): HTMLElement {
  return h('div', {class: 'done-list'}, ...list.map(({issue: i, reopen}) => {
    const {at, by} = closedBy(i.closed ?? '');
    const when = at === null ? '' : day(at);
    const meta = by ? t('{who} · closed {day}', {who: by, day: when}) : t('Closed {day}', {day: when});
    const error = h('p', {class: 'error', role: 'alert'});
    let act: HTMLButtonElement | null = null;
    if (reopen) {
      act = button(t('Reopen'), 'small-button');
      act.setAttribute('aria-label', t('Reopen {issue}', {issue: i.n === null ? i.title : `#${i.n}`}));
      act.addEventListener('click', async () => {
        act!.disabled = true;
        try { await reopenIssue(i); after(); } catch (e) { error.textContent = errorText(e); act!.disabled = false; }
      });
    }
    // Closed just now from its box: its line lands here, lit a moment, where the eye goes after it.
    return h('div', {class: justClosed(i) ? 'done-row done-head landing' : 'done-row done-head'}, named(i.n, i.kind, i.title), h('span', {class: 'muted small'}, all ? `${i.repo} · ${meta}` : meta), h('span', {class: 'grow'}), act, error);
  }));
}
