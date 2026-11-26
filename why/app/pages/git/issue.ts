import {kindWords} from '../kit/todo-list.ts';
import {h} from '../../ui/dom.ts';
import {arrive, cut, LAND, lift, type Lifted, morph, nudge, paced, putAway, still} from '../../ui/glide.ts';
import * as git from '../../../repo/history.ts';
import {t, tn} from '../../../text/i18n.ts';
import {closeMark, issueName, issuePath, saveIssue, setClosed, type Issue} from '../../../repo/issues.ts';
import {connection, myName} from '../../../shipto/connection.ts';
import {changeFor, type Standing} from '../../../repo/git-state.ts';
import {diffPaper} from './diff-paper.ts';
import {gitTotals, hasApproval, issueReview, readingLatest} from './review.ts';
import {beingChanged, retitle} from './issue-form.ts';
import {agentLine, agentMark} from './agent-line.ts';
import {errorText} from '../../../api/errors.ts';
import {busy, held} from './held.ts';
import {issueStore} from '../../../repo/issue-store.ts';
import {SPRING} from '../../ui/law.ts';

// The issue is the paper in hand. Work is at its right, verdicts at its foot,
// and commits and conversation remain on the ground below it.
export interface IssueEvents {
  open(repo: string, path: string): void;
  /** The repo now shows another copy (or main moved): the shell reads it again. */
  moved(repo: string): void;
  /** `issue` is going from the row (closed): the row goes to the box beside it meanwhile, done once it is there. */
  aside?(issue: Issue): Promise<void>;
  /** `issue` is back in the row (reopened): drawn again, the row goes to it. */
  back?(issue: Issue): void;
}

/** Where a repo stands, read once for every issue of it. */
export interface RepoState extends Standing { lines: git.Line[];
  /** Where it stands could not be read (the Remote away, or refusing): said on its issues, and nothing offered meanwhile. */
  error?: string }


function button(text: string, primary = false): HTMLButtonElement {
  return h('button', {class: primary ? 'button primary' : 'button', type: 'button'}, text) as HTMLButtonElement;
}

/** A summary half written in an issue's box, by its path, kept while the page is drawn again under it. */
const summaries = new Map<string, string>();
/**
 * The same, kept in this tab as it is written (sessionStorage, at once), so a reload or a crash before the field
 * is left (its save) loses none of it; those come back as the page is drawn again, and are saved then.
 */
const HALF = 'why.git.summaries';
const kept = (): Record<string, string> => { try { return JSON.parse(sessionStorage.getItem(HALF) ?? '{}') as Record<string, string>; } catch { return {}; } };
const keep = (key: string, value: string | null) => {
  try {
    const all = kept();
    if (value === null) delete all[key]; else all[key] = value;
    if (Object.keys(all).length) sessionStorage.setItem(HALF, JSON.stringify(all)); else sessionStorage.removeItem(HALF);
  } catch { /* kept while the page is drawn, then */ }
};

/**
 * The issue's summary (what was written under its first line), above Commit and Push: written right there, the
 * field one with the box's ground until it is pressed (then a field), saved as it is left. The box is that much
 * taller (issue #20). The same summary, named as where it was first written.
 */
function summary(issue: Issue, after: () => void): HTMLElement {
  const key = `${issue.repo}/${issuePath(issue)}`;
  const field = h('textarea', {class: 'issue-summary', rows: '4', 'aria-label': t('Summary'), placeholder: t('Summary'), spellcheck: 'false'}) as HTMLTextAreaElement;
  // Back from a reload with what was written and not yet saved: it is as it was, and saved now, as leaving it would.
  const back = summaries.has(key) ? undefined : kept()[key];
  field.value = summaries.get(key) ?? back ?? issue.detail;
  const error = h('p', {class: 'error', role: 'alert'});
  field.addEventListener('input', () => { summaries.set(key, field.value); keep(key, field.value); });
  const save = async () => {
    if (field.value === issue.detail) { summaries.delete(key); keep(key, null); return; }
    try { await saveIssue(issueStore, issue, issue.kind, issue.title, field.value); summaries.delete(key); keep(key, null); after(); }
    catch (e) { error.textContent = t('Failed to create: {message}', {message: errorText(e)}); }
  };
  field.addEventListener('blur', () => void save());
  if (back !== undefined) void save();
  return h('div', {class: 'issue-summary-wrap'}, field, error);
}

/** Run `f` with `b` held down (busy), then `after`; a failure is said in `error`, and `b` can be pressed again. */
const doing = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>, after: () => void) => async () => {
  if (held(b)) return;
  busy(b, true);
  error.textContent = '';
  try { await f(); justDone = {word: b.textContent ?? '', until: performance.now() + 3000}; after(); } catch (e) { error.textContent = errorText(e); busy(b, false); }
};
/** The step just done here, for a moment: its done mark, drawn next, lands rather than being there (slot). */
let justDone: {word: string; until: number} | null = null;
/** The issue closed here just now, for a moment: its line under Closed lands rather than being there (git/done.ts). */
let closedNow: {repo: string; path: string; until: number} | null = null;
export const justClosed = (i: Issue): boolean =>
  !!closedNow && closedNow.repo === i.repo && closedNow.path === issuePath(i) && performance.now() < closedNow.until;
/** The issue started here last, and when: its steps unfold, through a draw again or two (issueBox). */
let started: {path: string; at: number} | null = null;


/** Close an issue that will not be done: its file says so on its last line (the day, and who). */
/** Closed, its file says by whom: the name the Remote knows the person by (none, not answered). */
const closeIssue = async (issue: Issue) => setClosed(issueStore, issue, closeMark(await myName().catch(() => '')));
/** Open a closed issue again. */
export const reopenIssue = (issue: Issue) => setClosed(issueStore, issue, null);
const hereOf = (s: RepoState | undefined, issue: Issue) => !!s?.work && s.work.line !== 'main' && s.work.issue === issuePath(issue);

/**
 * The head of an issue's box: its number and title. A neighbour's (`peek`)
 * is its number alone, at the edge that shows, never a title cut short.
 */
export function issueHead(issue: Issue, peek = false): HTMLElement {
  const no = issueName(issue);
  if (peek) return h('div', {class: 'issue-big-head peek'}, h('h2', {}, h('span', {class: 'issue-no'}, no || '#'), agentMark(issue)));
  return h('div', {class: 'issue-big-head'},
    h('h2', {}, no ? h('span', {class: 'issue-no'}, no) : null, no ? ' ' : null, issue.kind ? h('span', {class: 'issue-kind'}, ...kindWords(issue.kind)) : null, issue.title));
}

/** One paper in the hand, with its history kept outside on the desk. */
export function issuePaper(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void) {
  const error = h('p', {class: 'error', role: 'alert'});
  const here = hereOf(s, issue);
  const change = connection() ? changeFor(s, issue) : null;
  const offered = connection() && !s?.error && !here && change?.state !== 'open';
  const leave = offered ? closeDeed(issue, error, events, after) : null;
  const head = issueHead(issue);
  const words = h('button', {type: 'button', class: 'issue-words'}, head);
  const totals = h('div', {class: 'git-totals'});
  const review = change && change.state !== 'reset' ? issueReview(issue.repo, change, totals, after) : null;
  const work = review?.work ?? workOf(issue, s, totals);
  if (work) unfolding(work, issuePath(issue));
  const name = h('p', {class: 'issue-name', 'aria-hidden': 'true'}, ['Issue', issueName(issue), issue.kind ? '/ ' + issue.kind : ''].filter(Boolean).join(' '));
  const box = h('div', {class: work ? 'issue-box git-paper' : 'issue-box git-paper no-work'}, name, words, summary(issue, after),
    work, work ? totals : null, review?.foot ?? null, foot(s, leave), error);
  const detail = () => box.querySelector<HTMLTextAreaElement>('.issue-summary')?.value ?? issue.detail;
  words.addEventListener('click', () => retitle(issue, words, head, detail, error, after));
  if (beingChanged(issue)) retitle(issue, words, head, detail, error, after, false);
  const history = review?.history ?? workspaceHistory(issue, s);
  const hands = agentLine(issue);
  if (hands && history) history.append(hands);
  return {box, history: history ?? hands};
}

/**
 * The steps of an issue's work, as the lines of main's sheet (git.ts): Start, Commit, Submit, Merge, one under
 * another. A step done is its word alone; the one to take next is the line the sheet's band is on (`next`), a button
 * (or the change's switch: Submitted, on while its last commit is in; switched off it is taken back, on again handed
 * in anew); the ones after it are their words, waiting. One at a time, in the order of the work.
 */
export function issueSteps(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const at = issue.repo;
  const here = hereOf(s, issue), w = here ? s?.work ?? null : null;
  const change = connection() ? changeFor(s, issue) : null;
  const open = change?.state === 'open';
  const offered = connection() && !s?.error && !here && !open;
  // A step not to be taken now is still a line the keyboard goes to (↑ ↓), and pressed it says no at once, where it is.
  const said = (word: string) => h('button', {type: 'button', class: 'switch-word', 'aria-disabled': 'true'}, word) as HTMLButtonElement;
  const lines: {done: boolean; el: HTMLElement}[] = [];
  // Start (Resume here, where it was started before).
  lines.push(offered ? {done: false, el: startDeed(issue, s, error, events, after)} : {done: here || open, el: said(t('Start'))});
  // Commit: what is not committed goes to one's own Remote, named by the issue.
  const dirty = w ? s?.uncommitted ?? 0 : 0;
  if (w && !(!dirty && w.commits > 0)) {
    const commit = button(t('Commit'));
    if (!dirty) commit.setAttribute('aria-disabled', 'true');
    commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', '', w.line), after));
    lines.push({done: false, el: commit});
  } else lines.push({done: !!w || open, el: said(t('Commit'))});
  // One press offers the exact recorded work head. No visual switch flips while Remote is still answering.
  const local = s?.lines.find((l) => l.issue === issuePath(issue));
  const inNow = !!w && !!local?.head && local.head === change?.head && open;
  const pending = !!w && !!local?.head && local.head !== local.base && !inNow && change?.state !== 'merged';
  if (w && local?.head && pending && !dirty) {
    const head = local.head;
    const send = button(t('Submit'));
    send.addEventListener('click', doing(send, error, () => git.submitAt(at, w.line, head), after));
    lines.push({done: false, el: send});
  } else lines.push({done: inNow || (!w && open), el: said(t('Submit'))});
  // Merge: once the version is approved.
  lines.push(open && change ? {done: false, el: mergeDeed(issue, s, change, error, events, after)} : {done: false, el: said(t('Merge'))});
  const next = lines.findIndex((l) => !l.done);
  const standing = open && change ? (pending ? t('Not submitted') : dirty ? t('Not committed') :
    hasApproval(change) ? t('Ready to merge') : t('Needs approval')) : '';
  const names = ['start', 'commit', 'submit', 'merge'];
  const keys = lines.map((l) => l.el);
  // One of them is where Tab comes in: the step to take next (or the first).
  keys.forEach((k, j) => k.tabIndex = j === Math.max(0, next) ? 0 : -1);
  const element = h('div', {class: 'switch-lines', role: 'group', 'aria-label': t('Steps')},
    ...lines.map((l, k) => h('div', {class: l.done ? 'switch-line done' : k === next ? 'switch-line next' : 'switch-line', 'data-step': names[k]}, l.el)),
    standing ? h('p', {class:'git-ledger-status'}, standing) : null, error);
  // ↑ ↓ go along the four, Home and End to the first and the last; Enter or a press takes the step, at once, and a
  // step that cannot be taken now says no where it is (the nudge), so every press is answered in its own frame.
  element.addEventListener('keydown', (event) => {
    const j = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (j < 0) return;
    const to = event.key === 'ArrowDown' ? Math.min(keys.length - 1, j + 1) : event.key === 'ArrowUp' ? Math.max(0, j - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    keys[to]!.focus({preventScroll: true});
  });
  element.addEventListener('click', (event) => {
    const b = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!b || !held(b) || b.getAttribute('aria-busy') === 'true') return;
    event.preventDefault();
    event.stopPropagation();
    nudge(b.closest('.switch-line'));
  }, true);
  return element;
}

/** The work not submitted yet. An already submitted revision keeps the paper, even while more work is made. */
function workOf(issue: Issue, s: RepoState | undefined, totals: HTMLElement): HTMLElement | null {
  const repo = issue.repo;
  const w = hereOf(s, issue) ? s?.work ?? null : null;
  const line = s?.lines.find((l) => l.issue === issuePath(issue));
  const dirty = w ? s?.uncommitted ?? 0 : 0;
  const committed = line?.head && line.head !== line.base ? line.head : null;
  if (!w || (!dirty && !committed)) return null;
  const signed = connection();
  const copy = JSON.stringify([signed?.user ?? signed?.session, repo, w.line, dirty ? 'draft' : committed]);
  const work = h('div', {class: 'git-work', role: 'region', 'aria-label': dirty ?
    tn('{n} uncommitted file', '{n} uncommitted files', dirty) : t('Diff')});
  const show = (files: git.FileDiff[]) => {
    gitTotals(totals, files);
    work.replaceChildren(files.length ? diffPaper(files, {key: copy}).element : quiet(t('No changes')));
  };
  const known = uncommittedRead.get(copy);
  if (known) show(known); else work.append(quiet(t('Loading…')));
  void (dirty ? git.diff(repo,w.line) : git.workDiffAt(repo, w.line, committed!)).then((list) => {
    uncommittedRead.delete(copy);
    uncommittedRead.set(copy, list);
    if (uncommittedRead.size > 16) uncommittedRead.delete(uncommittedRead.keys().next().value!);
    show(list);
  }, (e) => work.replaceChildren(h('p', {class: 'error'}, errorText(e))));
  return work;
}

function workspaceHistory(issue: Issue, s: RepoState | undefined): HTMLElement | null {
  const line = s?.lines.find((l) => l.issue === issuePath(issue));
  if (!hereOf(s, issue) || !line?.head || line.head === line.base) return null;
  const history = h('section', {class: 'git-history', 'aria-label': t('Commits')});
  const note = h('p', {class: 'git-history-who'}, t('Not submitted'));
  const list = h('ol', {class: 'git-events'});
  history.append(note, list);
  void git.logOf(issue.repo, line.line).then((got) => {
    const at = got.findIndex((c) => c.id === line.head);
    if (at < 0) return;
    const base = got.findIndex((c) => c.id === line.base);
    list.replaceChildren(...got.slice(at, base < 0 ? undefined : base).map((c) =>
      h('li', {class: 'git-history-version-row'}, h('div', {class: 'git-history-commit'}, h('code', {title: c.id}, c.id.slice(0, 8)), c.title))));
  }, (e) => history.append(h('p', {class: 'error'}, errorText(e))));
  return history;
}

/** Start, or Continue here where it was started before: the issue's own copy of the repo is the one shown. */
function startDeed(issue: Issue, s: RepoState | undefined, error: HTMLElement, events: IssueEvents, after: () => void): HTMLButtonElement {
  const at = issue.repo;
  const line = s?.lines.find((l) => l.issue === issuePath(issue)) ?? null;
  const go = button(line ? t('Resume here') : t('Start'), true);
  go.addEventListener('click', doing(go, error, async () => {
    if (line) await git.switchWork(at, line.line); else await git.startWork(at, issue.file);
    events.moved(at);
  }, after));
  return go;
}

/**
 * Close: it will not be done, and goes under Closed. Its box goes down out of the row, and the row goes on to the box
 * beside it before the page is drawn again: never a hole where it was.
 */
function closeDeed(issue: Issue, error: HTMLElement, events: IssueEvents, after: () => void): HTMLButtonElement {
  const leave = button(t('Close'));
  leave.addEventListener('click', doing(leave, error, async () => {
    // It goes down as it is closed, toward Closed under the page, where its line lands lit; not closed, it is back.
    const going = still() ? null : (leave.closest('.issue-slot') ?? leave.closest('.issue-box'))?.animate([{transform: 'none', opacity: 1}, {transform: 'translateY(28px) scale(.97)', opacity: 0}],
      {duration: cut() ? 0 : paced(240), easing: SPRING, fill: 'forwards'});
    // Said before its file is written: the page is drawn again as the file changes (git.ts watch), and the line that
    // drawing puts under Closed is the one that lands, not one there plain and then landing again.
    closedNow = {repo: issue.repo, path: issuePath(issue), until: performance.now() + 3000};
    try { await Promise.all([closeIssue(issue), going?.finished]); } catch (e) { closedNow = null; going?.cancel(); throw e; }
    await events.aside?.(issue);
  }, after));
  return leave;
}

/**
 * Started here just now: its steps unfold where Start was, the next thing to do coming in after the deed (and the
 * box drawn again meanwhile, as it is once the repo is read again, carries the unfolding on from where it was).
 */
function unfolding(steps: HTMLElement, path: string) {
  if (justDone && (justDone.word === t('Start') || justDone.word === t('Resume here')) && performance.now() < justDone.until) {
    justDone = null;
    started = {path, at: performance.now()};
  }
  if (started?.path === path) arrive(steps, -1, 'y', 10, 280, performance.now() - started.at);
}

/** Only an actual error, offline state, or Close is said on the sheet. The repo and phase are on main's ledger. */
function foot(s: RepoState | undefined, leave: HTMLElement | null): HTMLElement | null {
  const say = !connection() ? t('History is stored on Remote. Sign in to work on issues and commit.') : s?.error;
  return say || leave ? h('div', {class: 'issue-foot'}, leave, say ? h('p', {class: 'muted small'}, say) : null) : null;
}
const uncommittedRead = new Map<string, git.FileDiff[]>();

/** Issues are read by the page; the active paper no longer keeps a shadow index of their paths. */
export function knowIssues(_issues: readonly Issue[]) {}

/**
 * `el`'s height goes from what it was (`from`) to what it now holds (a line asked for is shorter than the files it
 * names; an issue's box once its commit's files have gone; files read in under "Loading…"): never a jump.
 */
export function resize(el: HTMLElement, from: number) {
  if (still() || cut() || !from || !el.isConnected) return;
  const box = el.getBoundingClientRect(), to = box.height;
  if (Math.abs(to - from) < 2) return;
  el.style.overflow = 'hidden';
  const back = () => { el.style.overflow = ''; };
  const ms = paced(280);
  el.animate([{height: `${from}px`}, {height: `${to}px`}], {duration: cut() ? 0 : ms, easing: LAND}).finished.then(back, back);
  // Grown: what now stands below where its edge was comes in as the edge goes down over it, never cut through mid-line.
  if (to > from) {
    for (const c of el.children) {
      if (c instanceof HTMLElement && c.getBoundingClientRect().top - box.top >= from - 4) {
        c.animate([{opacity: 0}, {opacity: 0, offset: .3}, {opacity: 1}], {duration: cut() ? 0 : ms, easing: SPRING});
      }
    }
  }
}

/** The parts a box is drawn in, to tell one drawing from the next: its children, under a lone wrapper (an issue's). */
const partsOf = (el: Element): Element[] => {
  let at = el;
  while (at.children.length === 1 && at.firstElementChild!.children.length) at = at.firstElementChild!;
  return [...at.children];
};

/**
 * `now` drawn where `old` was (the same box drawn again: a step done, a line asked for): what changed in it fades from
 * what it was to what it is as the box goes from `old`'s height (`from`) to its own; what is the same stays as it is,
 * neither going nor coming. `old` is taken (it is out of the page by then, or a copy). Before `resize`, which would
 * have `now` at `from` already.
 */
export function crossfade(old: HTMLElement, now: HTMLElement, from: number) {
  const parent = now.parentElement;
  if (still() || cut() || old === now || !parent || !now.isConnected) return;
  // The parts the same in both, one for one: kept still (the old one hidden, the new one not faded).
  const was = partsOf(old), is = partsOf(now);
  const same = new Map<Element, Element>();
  const taken = new Set<Element>();
  for (const p of is) {
    const q = was.find((x) => !taken.has(x) && x.outerHTML === p.outerHTML);
    if (q) { same.set(p, q); taken.add(q); }
  }
  const coming = (q: Element) => q.getAnimations().find((a) => a.id === COMING && a.playState === 'running');
  // `old` was itself still coming in over what was before it (the page read again twice over one step): what was
  // before it goes on fading, now over this one, and what this one shows comes in from where `old`'s had got to;
  // never `old`'s parts, all but unseen yet, taken for what is going (a moment of nothing in the box).
  const prior = fading.get(old);
  if (prior?.getAnimations().some((a) => a.playState === 'running')) {
    const at = was.map(coming).find(Boolean)?.currentTime ?? 0;
    over(prior, now, parent, from);
    fading.set(now, prior);
    for (const p of is) {
      const q = same.get(p);
      if (!q) comeIn(p).currentTime = at;
      else { const a = coming(q); if (a) comeIn(p).currentTime = a.currentTime; }
    }
    return;
  }
  // A part still coming in from a drawing a moment before goes on coming in from where it had got to, neither
  // starting over nor there at once.
  for (const [p, q] of same) { const a = coming(q); if (a) comeIn(p).currentTime = a.currentTime; }
  if (same.size === is.length && is.length === was.length) return;
  for (const q of taken) (q as HTMLElement).style.visibility = 'hidden';
  old.inert = true;
  old.setAttribute('aria-hidden', 'true');
  old.removeAttribute('id');
  over(old, now, parent, from);
  fading.set(now, old);
  // What went is mostly gone before what comes is much there (words over words are never read as one smear), yet the
  // two overlap, so the place is never empty a moment between them.
  old.animate([{opacity: 1}, {opacity: 0}], {duration: cut() ? 0 : paced(160), easing: 'linear', fill: 'forwards'}).finished.then(() => old.remove(), () => old.remove());
  for (const p of is) if (!same.has(p)) comeIn(p);
}
/** What a box drawn again showed before, still fading over it (crossfade), by the box. */
const fading = new WeakMap<Element, HTMLElement>();
/** `ghost` laid over `now` in `parent`, from `from` tall to as tall as `now` is, cut there. */
function over(ghost: HTMLElement, now: HTMLElement, parent: HTMLElement, from: number) {
  const at = now.getBoundingClientRect(), on = parent.getBoundingClientRect();
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  Object.assign(ghost.style, {position: 'absolute', left: `${at.left - on.left - parent.clientLeft}px`, top: `${at.top - on.top - parent.clientTop}px`,
    width: `${at.width}px`, height: `${from}px`, margin: '0', borderColor: 'transparent', background: 'transparent', overflow: 'hidden',
    pointerEvents: 'none', zIndex: '1', animation: 'none'});
  parent.append(ghost);
  ghost.animate([{height: `${from}px`}, {height: `${at.height}px`}], {duration: cut() ? 0 : paced(280), easing: LAND, fill: 'forwards'});
}
/** A part of a box drawn again coming in (crossfade), named so a drawing after it can go on from it. */
const COMING = 'coming-in';
const comeIn = (p: Element) => {
  const a = p.animate([{opacity: 0}, {opacity: 1}], {duration: cut() ? 0 : paced(220), delay: cut() ? 0 : paced(40), easing: SPRING, fill: 'backwards'});
  a.id = COMING;
  return a;
};

/**
 * Back to main, for the issue the repo shows: out of the box, under it at its left (git.ts), as what leaves the
 * work always is. Null for any other issue.
 */
export function backToMain(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement | null {
  if (!hereOf(s, issue)) return null;
  const at = issue.repo;
  const error = h('p', {class: 'error', role: 'alert'});
  const leave = button(t('Back to main'));
  leave.addEventListener('click', doing(leave, error, async () => { await git.switchWork(at, 'main'); events.moved(at); }, after));
  return h('div', {class: 'issue-leave'}, leave, error);
}

const quiet = (text: string) => h('p', {class: 'muted small'}, text);

/**
 * Merge, the last step, under the Review (not in it): Reject at the left,
 * who approved it, and its button at the right, primary once the version is
 * approved.
 */
/** Changes merged from here a moment ago (when): each one's line lands under Merged, lit, as its issue goes into it. */
const mergedNow = new Map<string, number>();
export const justMerged = (id: string) => Date.now() - (mergedNow.get(id) ?? 0) < 4000;

/** Merge, as the last of the sheet's steps: primary once this version is approved, and not before. */
function mergeDeed(issue: Issue, s: RepoState | undefined, change: git.Change, error: HTMLElement, events: IssueEvents, after: () => void): HTMLButtonElement {
  const at = issue.repo;
  const here = hereOf(s, issue);
  const local = s?.lines.find((line) => line.issue === issuePath(issue));
  const ready = hasApproval(change) && (!local || local.head === change.head) && (!here || !s?.uncommitted);
  const merge = button(t('Merge'), ready);
  if (!ready) merge.setAttribute('aria-disabled', 'true');
  // Merged, the work is done: the repo shows main again.
  // Merged, the issue's box goes down into its line under Merged, which lands lit: the issue is done.
  let from: DOMRect | null = null;
  let words: Lifted | null = null;
  let rest: HTMLElement | null = null;
  merge.addEventListener('click', doing(merge, error, async () => {
    if (!readingLatest(at, change)) throw new Error(t('Read the latest version before merging'));
    await git.mergeAt(at, change);
    mergedNow.set(change.id, Date.now());
    const slotEl = document.querySelector<HTMLElement>('.issue-slot[aria-current="true"]');
    const card = slotEl?.querySelector<HTMLElement>('.issue-card');
    // What stood under the box (its Review, Reject, Back to main) is done with: it folds away first, the box staying
    // where it is, so the box goes down into its line on its own (not a page that loses its foot at once under it).
    const under = [...(slotEl?.querySelectorAll<HTMLElement>(':scope > :not(.issue-card)') ?? [])];
    await Promise.all(under.map((el) => new Promise<void>((gone) => putAway(el, () => { el.remove(); gone(); }, {fold: true, ms: 220}))));
    from = card?.getBoundingClientRect() ?? null;
    words = lift(card?.querySelector('h2'));
    // The rest of what the box held goes with the sheet, fading as it sets off, its title carried on by itself.
    if (card) {
      rest = card.cloneNode(true) as HTMLElement;
      rest.querySelector<HTMLElement>('h2')?.style.setProperty('visibility', 'hidden');
    }
    // The Remote has already merged. The standing refresh will finish a copy still shown here;
    // failure to refresh or to bring main to this device cannot turn that write into a rejected Merge.
    if (here) events.moved(at);
  }, () => {
    after();
    if (from) morph(from, () => document.querySelector<HTMLElement>(`.done-row[data-change="${CSS.escape(change.id)}"]`), 460, '', 150,
      words ? {lifted: words, to: (row) => row.querySelector('.done-name'), ...(rest ? {rest} : {})} : undefined);
  }));
  return merge;
}

/** Under the Review, out of it: Reject at the left, and who approved this version (Merge is the sheet's last step). */
export function mergeRow(issue: Issue, s: RepoState | undefined, after: () => void): HTMLElement | null {
  const change = connection() ? changeFor(s, issue) : null;
  if (!change || change.state !== 'open') return null;
  const at = issue.repo;
  const error = h('p', {class: 'error', role: 'alert'});
  const reject = button(t('Reject'));
  reject.addEventListener('click', doing(reject, error, () => {
    if (!readingLatest(at, change)) throw new Error(t('Read the latest version first'));
    return git.rejectAt(at, change);
  }, after));
  return h('div', {class: 'steps merge-row'}, reject, error);
}
