import {ago, day, h} from '../../ui/dom.ts';
import * as git from '../../repos/history.ts';
import {t, tn} from '../../i18n.ts';
import {closedBy, numberOf, type Issue} from '../../repos/issues.ts';
import {kindOf} from '../../repos/text.ts';
import {answers, askFoot, SETTLE} from '../common.ts';
import {counted, diffFiles} from '../forge/diff-view.ts';
import {clock, LAND, nudge, paced, putAway, still, unfold} from '../../ui/glide.ts';
import {crossfade, justClosed, justMerged, notCommitted, reopenIssue, resize, type IssueEvents, type RepoState} from './issue.ts';
import type {Laid} from '../../repos/git-state.ts';
import {kindWords} from '../todo-list.ts';
import {errorText} from '../../app/errors.ts';
import {busy} from './held.ts';

// What Git shows round the issues: over them, what main has not committed
// (with its Commit, named by its line as l3 commit names it); under them,
// what is done with, newest first: what was committed on main from here,
// the issues merged, read only with their diffs, and those closed without
// being done, each with Reopen.

const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;

const heading = (id: string, text: string, n = 0) => h('h2', {id}, h('span', {}, text, ' ', h('small', {}, n ? `${n}` : '')));

/** The sections round the issues: main's over them, and under them what is done with, each its own section. */
export class Sections {
  readonly main = h('section', {class: 'section main-part', 'aria-labelledby': 'main-title', hidden: ''});
  // What was committed on main from here is done with: under the issues, with what was merged and closed.
  private readonly committed = h('section', {class: 'section', 'aria-labelledby': 'committed-title', hidden: ''});
  private readonly merged = h('section', {class: 'section', 'aria-labelledby': 'merged-title', hidden: ''});
  private readonly closed = h('section', {class: 'section', 'aria-labelledby': 'closed-title', hidden: ''});
  /** Those under the issues, in their order. */
  readonly under = [this.committed, this.merged, this.closed];

  /**
   * Drawn again for what is `laid` out, of the repo `filter` (all, when ''). `moving`: drawn again while the page is
   * seen (not its first drawing), so a section under the issues that comes unfolds, and one that goes folds away.
   */
  draw({dirty, merged, closed}: Laid, filter: string, states: ReadonlyMap<string, RepoState>, events: IssueEvents, again: () => void, moving = false) {
    const was = this.under.map((s) => (s.hidden ? null : [...s.children]));
    // main: what it has not committed, each a card. What was committed on it from here is under the issues.
    const cuts = committedIn(filter || null);
    this.main.hidden = !dirty.length;
    // Many waiting in All: a row each, so the issues are not a long way down; one repo shown, its card.
    const brief = !filter && dirty.length > BRIEF;
    this.main.replaceChildren(heading('main-title', 'main'), ...dirty.map((r) => mainCard(r, states.get(r)!.uncommitted, events, again, brief)));
    this.committed.hidden = !cuts.length;
    this.committed.replaceChildren(heading('committed-title', t('Committed')), committedList(cuts, !filter));
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

/** More repos than this waiting to be committed, in All: each a row (its name, how many, Commit), its files folded. */
const BRIEF = 3;
/** Repos whose row (in All, many waiting) was opened to its files: open again when drawn again. */
const unfolded = new Set<string>();

/** The line a commit on main is being named by, per repo: kept as written until it is committed or put back with Not now. */
const naming = new Map<string, string>();
/** Repos whose line was put away with Escape: kept, the card back to Commit until it is pressed again. */
const folded = new Set<string>();

/** Committed on main from here, newest first, a few: each stays a line under main where its card was. */
const committed: {repo: string; cut: git.Cut}[] = [];
const KEPT = 3;
const committedIn = (filter: string | null) => committed.filter((c) => !filter || c.repo === filter);

/**
 * Committed, the card goes: it slides off sideways as it fades, and the room it took closes after it, so what is under
 * it comes up rather than jumping. Done once it has gone (the page is drawn again after).
 */
async function slideOff(card: HTMLElement): Promise<void> {
  if (still() || !card.isConnected) return;
  card.classList.add('leaving');
  const off = card.animate([{transform: 'none', opacity: 1}, {transform: 'translateX(96px)', opacity: 0}], {duration: paced(340), easing: LAND, fill: 'forwards'});
  // The last card waiting on main takes main's heading with it: the part closes up whole as the card goes, not leaving
  // "main" over nothing until the page is read again.
  const part = card.parentElement;
  const whole = !!part && part.querySelectorAll(':scope > .main-card').length === 1;
  const room = whole ? part! : card;
  const cs = getComputedStyle(room);
  const close = room.animate([
    {height: `${room.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth},
    {height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px'},
  ], {duration: paced(280), delay: paced(160), easing: LAND, fill: 'forwards'});
  room.style.overflow = 'hidden';
  if (whole) part!.querySelector(':scope > h2')?.animate([{opacity: 1}, {opacity: 0}], {duration: paced(200), delay: paced(120), fill: 'forwards'});
  await Promise.all([off.finished, close.finished]).catch(() => {});
  // Closed up, it stays so until the page is drawn again without it (which takes the closing off, git.ts lay).
  if (whole) closing.add(part!);
}

/** main's part closed up with its last card (slideOff), until the page drawn again hides it. */
const closing = new WeakSet<HTMLElement>();
/** main's part drawn again: what closed it up is taken off (hidden now, or shown again with what waits). */
export function opened(part: HTMLElement) {
  if (!closing.has(part)) return;
  closing.delete(part);
  part.style.overflow = '';
  for (const a of part.getAnimations()) a.cancel();
  for (const a of part.querySelector(':scope > h2')?.getAnimations() ?? []) a.cancel();
}

/**
 * main's card for a repo with something not committed: its files (▸ 2 files,
 * their diff over what is under it) and Commit. Commit asks in the card for
 * its line ("Fix：title", as `l3 commit REPO "Fix：title"` takes it), Not now
 * at the left and Commit at the right, under the pointer.
 */
function mainCard(repo: string, n: number, events: IssueEvents, after: () => void, brief = false): HTMLElement {
  const card = h('div', {class: `main-card${brief ? ' brief' : ''}`, role: 'group', 'aria-label': t('Uncommitted changes on main in {repo}', {repo})});
  const plain = () => {
    const from = card.isConnected ? card.getBoundingClientRect().height : 0;
    const old = card.isConnected ? card.cloneNode(true) as HTMLElement : null;
    const commit = button(t('Commit'), 'primary');
    commit.addEventListener('click', () => ask(commit));
    // Laid out as an issue's box is: its name at the top, the files under it on the card itself, and at its foot how
    // many wait at the left and Commit at the right, where an issue's next step is.
    const foot = h('div', {class: 'issue-foot main-foot'},
      h('span', {class: 'muted small'}, tn('{n} file to commit on main', '{n} files to commit on main', n)), commit);
    if (!brief) card.replaceChildren(h('h3', {class: 'main-title'}, repo), notCommitted(repo, 'main', n, events), foot);
    else {
      // A row: its name opens its files under it (read only then), and closes them again.
      const open = unfolded.has(repo);
      const name = h('button', {type: 'button', class: 'main-open', 'aria-expanded': String(open)}, repo);
      name.addEventListener('click', () => {
        if (open) unfolded.delete(repo); else unfolded.add(repo);
        plain();
        card.querySelector<HTMLElement>('.main-open')?.focus();
      });
      card.replaceChildren(h('h3', {class: 'main-title'}, name), foot, ...(open ? [notCommitted(repo, 'main', n, events)] : []));
    }
    if (old) crossfade(old, card, from);
    resize(card, from);
    return commit;
  };
  const ask = (from: Element | null) => {
    const foot = from ? askFoot(from, card) : answers;
    const was = card.isConnected ? card.getBoundingClientRect().height : 0;
    const old = card.isConnected ? card.cloneNode(true) as HTMLElement : null;
    const line = h('input', {class: 'line-in', placeholder: t('Fix: Description of changes'), 'aria-label': t('Commit title format: Type: Title'), maxlength: '200', spellcheck: 'false'}) as HTMLInputElement;
    folded.delete(repo);
    line.value = naming.get(repo) ?? '';
    naming.set(repo, line.value);
    const error = h('p', {class: 'error', role: 'alert'});
    // What was said of the line (no title) is about the line as it was: written on, it is gone.
    line.addEventListener('input', () => { naming.set(repo, line.value); if (error.textContent) error.textContent = ''; });
    const no = button(t('Cancel'), 'small-button');
    const yes = button(t('Commit'), 'small-button primary');
    no.addEventListener('click', () => { naming.delete(repo); folded.delete(repo); plain().focus(); });
    const shown = performance.now();
    yes.addEventListener('click', async () => {
      if (performance.now() - shown < SETTLE) return;
      if (!kindOf(line.value).title.trim()) { error.textContent = t('Commit requires a title (e.g. Fix: title)'); line.focus(); nudge(line); return; }
      busy(yes, true);
      error.textContent = '';
      try {
        const cut = await git.cut(repo, null, line.value, '');
        naming.delete(repo);
        committed.unshift({repo, cut});
        committed.splice(KEPT);
        // The card slides off sideways and its room closes; drawn again, its line under main lands lit.
        await slideOff(card);
        after();
      } catch (e) { error.textContent = errorText(e); busy(yes, false); }
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
    if (old) crossfade(old, card, was);
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
function committedList(list: {repo: string; cut: git.Cut}[], all: boolean): HTMLElement {
  const newest = committed[0]?.cut.id;
  return h('div', {class: 'done-list'}, ...list.map(({repo, cut}) => {
    const meta = t('Committed {when}', {when: ago(cut.time || Date.now())});
    const row = h('div', {class: 'done-row done-head', 'data-cut': cut.id}, named(null, cut.kind, cut.title),
      cut.added || cut.removed ? counted(cut.added, cut.removed) : null, h('span', {class: 'grow'}),
      h('span', {class: 'muted small'}, all ? `${repo} · ${meta}` : meta));
    landing(row, `cut\0${cut.id}`, cut.id === newest && Date.now() - (cut.time || 0) < 4000, 'just-cut');
    return row;
  }));
}

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
      fold.animate([{height: `${from}px`}, {height: `${to}px`}], {duration: paced(220), easing: LAND}).finished.then(() => {
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
