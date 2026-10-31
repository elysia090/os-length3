import {kindWords} from '../todo-list.ts';
import {ago, h} from '../../ui/dom.ts';
import {arrive, LAND, lift, type Lifted, morph, paced, putAway, still} from '../../ui/glide.ts';
import * as git from '../../repos/history.ts';
import {t, tn} from '../../i18n.ts';
import {closeMark, issueName, issuePath, saveIssue, setClosed, type Issue} from '../../repos/issues.ts';
import {connection, myName} from '../../remote/connection.ts';
import {changeFor, type Standing} from '../../repos/git-state.ts';
import {named} from '../../repos/text.ts';
import {diffFiles} from '../forge/diff-view.ts';
import {beingChanged, issueEditor} from './issue-form.ts';
import {agentLine, agentMark} from './agent-line.ts';
import {errorText} from '../../app/errors.ts';
import {busy} from './held.ts';
import {issueStore} from '../../repos/issue-store.ts';

// An issue on the Git page, as one large box (issue #17). Its branch and
// worktree are never named: Start gives the issue its own copy of the repo,
// which File, Forge and the Prompt then show. The box offers only what can
// be done next, one primary action at a time, in the order of the work:
//
//   Start (Continue here) · Changes · Commit · Push (Reset)
//
// and Back to main (under the box at its left, out of it, as what leaves always is: backToMain). Under that, the
// Review in a box of its own (Comment,
// and Approve as a ○), and under that, Merge with Reject at its left. A change received from someone
// else shows Commit and Push done already.

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
const HALF = 'length3.git.summaries';
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

const STATE = (s: git.Change['state']) => ({open: t('Pending'), merged: t('Merged'), rejected: t('Rejected'), reset: t('Withdrawn')})[s];

/** Run `f` with `b` held down (busy), then `after`; a failure is said in `error`, and `b` can be pressed again. */
const doing = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>, after: () => void) => async () => {
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

/** Where the issue stands, quietly, in a few words. */
function standing(s: RepoState | undefined, issue: Issue): string {
  const path = issuePath(issue);
  const c = changeFor(s, issue);
  const w = s?.work;
  // Worked on here: who and when; the boxes under it say the rest.
  if (hereOf(s, issue) && w) return t('{who} · started {when}', {who: w.started_by || '—', when: ago(w.started_at)});
  // An open change says where it stands in its Push row; one decided, what came of it (never its version: a count the
  // Remote keeps of hand-ins, not a thing the person holds in mind).
  if (c) return c.state === 'open' ? '' : STATE(c.state);
  const line = s?.lines.find((l) => l.issue === path);
  if (line) return t('{who} · started {when}', {who: line.startedBy || '—', when: ago(line.startedAt)});
  return '';
}

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

/** The box: the issue's words, where it stands, and the way into its work (or back out). */
export function issueBox(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const here = hereOf(s, issue);
  const change = connection() ? changeFor(s, issue) : null;
  // Nothing is offered until where it stands is known; nor while it is worked on here, or its change is in.
  const offered = connection() && !s?.error && !here && change?.state !== 'open';
  const acts: Node[] = offered ? [startDeed(issue, s, error, events, after)] : [];
  // One that will not be done is closed, at the foot's left as what goes against the box: it goes
  // under Closed, where Reopen brings it back. Whatever work the repo shows: an issue is main's.
  const leave = offered ? closeDeed(issue, error, events, after) : null;
  // Its title is changed where it is read: pressed, the head becomes the fields it was written in. Its summary is
  // written right under it, above Commit and Push.
  const words = h('button', {type: 'button', class: 'issue-words', title: t('Edit description')}, issueHead(issue));
  const work = here && s?.work ? steps(issue, s, events, after) : null;
  if (work) unfolding(work.element, issuePath(issue));
  // The change's power switch, low at the box's right, where its foot's action is.
  if (work?.reset) acts.push(work.reset);
  const box = h('div', {class: 'issue-box'},
    words, summary(issue, after), agentLine(issue),
    ...(work ? [work.element] : change?.state === 'open' ? [received(change)] : []),
    foot(issue, s, leave, acts), error);
  const editor = () => issueEditor(issue, (saved) => { if (saved) after(); else box.replaceWith(issueBox(issue, s, events, after)); });
  words.addEventListener('click', () => words.replaceWith(editor()));
  // Its words half changed when the box was left: the box opens as the fields, as they were.
  if (beingChanged(issue)) words.replaceWith(editor());
  return box;
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
  leave.title = t('Won\'t fix: moves to Closed (can be reopened later)');
  leave.addEventListener('click', doing(leave, error, async () => {
    // It goes down as it is closed, toward Closed under the page, where its line lands lit; not closed, it is back.
    const going = still() ? null : (leave.closest('.issue-slot') ?? leave.closest('.issue-box'))?.animate([{transform: 'none', opacity: 1}, {transform: 'translateY(28px) scale(.97)', opacity: 0}],
      {duration: paced(240), easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'});
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

/** At the box's foot, opposite its action: its repo and, quietly, who started it and when; Close at its left. */
function foot(issue: Issue, s: RepoState | undefined, leave: HTMLElement | null, acts: Node[]): HTMLElement {
  const say = !connection() ? t('History is stored on Remote. Sign in to work on issues and commit.') : s?.error ?? standing(s, issue);
  return h('div', {class: 'issue-foot'}, leave, h('div', {class: 'issue-about'}, h('span', {class: 'issue-where'}, issue.repo),
    say ? h('span', {class: s?.error ? 'error small' : 'muted small'}, say) : null), ...acts);
}

/**
 * Each copy's diff not committed, as last read, by repo and the line it shows (main, or an issue's work): drawn again,
 * it is there at once (as diffsRead keeps a change's). By the line too: just started, an issue's Commit row is not
 * drawn from main's files (they flashed there, and the folds opened for them were kept open).
 */
const uncommittedRead = new Map<string, git.FileDiff[]>();

/** What each issue is about ("Fix：title"), by repo and its file's path, as Git last read them (knowIssues). */
const aboutIssue = new Map<string, string>();
/** The issues read (every repo's, open or done with): an issue's own file in a diff is then named by what it is about. */
export function knowIssues(issues: readonly Issue[]) {
  aboutIssue.clear();
  for (const i of issues) aboutIssue.set(`${i.repo}\0${issuePath(i)}`, named(i.kind, i.title));
}

/**
 * What is not committed in the copy `at` shows (on `line`): its diff, there from the start (named for a screen reader
 * by how many files: "5 files not committed"); a file's name opens it in Forge.
 */
export function notCommitted(at: string, line: string, n: number, events: IssueEvents): HTMLElement {
  // Straight on what it is in (main's card, the issue's box), not a box of its own inside it: each file a fold, its
  // name and what it comes to on its head, the first few open, a long one's lines past 30 waiting under "n more lines";
  // an issue's own file (written, its words changed, closed) shut to its line, "#3 Fix：title".
  const copy = `${at}\0${line}`;
  // On main, an issue's own file is not the person's to commit: it is committed by itself as it is written
  // (repos/issue-store.ts), so one on its way there is not shown waiting here.
  const theirs = (list: git.FileDiff[]) => (line === 'main' ? list.filter((f) => !f.path.startsWith('issue/')) : list);
  const files = (list: git.FileDiff[]) => diffFiles(theirs(list), {reveal: (p) => events.open(at, p), cut: 30, kept: copy,
    issue: (p) => aboutIssue.get(`${at}\0${p}`) ?? null});
  const was = uncommittedRead.get(copy);
  const box = h('div', {class: 'changes', role: 'region', 'aria-label': tn('{n} uncommitted file', '{n} uncommitted files', n)}, ...(was ? files(was) : [quiet(t('Loading…'))]));
  // Read for the first time, the files come in under "Loading…" and the box grows to hold them, never a jump.
  const show = (...nodes: Node[]) => { const from = box.isConnected ? box.getBoundingClientRect().height : 0; box.replaceChildren(...nodes); resize(box, from); };
  void git.diff(at).then((list) => {
    uncommittedRead.set(copy, list);
    if (!was || JSON.stringify(list) !== JSON.stringify(was)) show(...files(list));
  }, (e) => show(h('p', {class: 'error'}, errorText(e))));
  return box;
}

/**
 * `el`'s height goes from what it was (`from`) to what it now holds (a line asked for is shorter than the files it
 * names; an issue's box once its commit's files have gone; files read in under "Loading…"): never a jump.
 */
export function resize(el: HTMLElement, from: number) {
  if (still() || !from || !el.isConnected) return;
  const box = el.getBoundingClientRect(), to = box.height;
  if (Math.abs(to - from) < 2) return;
  el.style.overflow = 'hidden';
  const back = () => { el.style.overflow = ''; };
  const ms = paced(280);
  el.animate([{height: `${from}px`}, {height: `${to}px`}], {duration: ms, easing: LAND}).finished.then(back, back);
  // Grown: what now stands below where its edge was comes in as the edge goes down over it, never cut through mid-line.
  if (to > from) {
    for (const c of el.children) {
      if (c instanceof HTMLElement && c.getBoundingClientRect().top - box.top >= from - 4) {
        c.animate([{opacity: 0}, {opacity: 0, offset: .3}, {opacity: 1}], {duration: ms, easing: 'ease-out'});
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
  if (still() || old === now || !parent || !now.isConnected) return;
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
  old.animate([{opacity: 1}, {opacity: 0}], {duration: paced(160), easing: 'linear', fill: 'forwards'}).finished.then(() => old.remove(), () => old.remove());
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
  ghost.animate([{height: `${from}px`}, {height: `${at.height}px`}], {duration: paced(280), easing: LAND, fill: 'forwards'});
}
/** A part of a box drawn again coming in (crossfade), named so a drawing after it can go on from it. */
const COMING = 'coming-in';
const comeIn = (p: Element) => {
  const a = p.animate([{opacity: 0}, {opacity: 1}], {duration: paced(220), delay: paced(40), easing: 'ease-out', fill: 'backwards'});
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

/**
 * A step's place: its button, or once done the done mark and the same word (green says it is done). `then`: done by
 * the same deed as the step before it, whose mark lands just now (a commit hands itself in): this one lands after it,
 * in the order the work goes, never done before the step it follows.
 */
const slot = (act: HTMLElement, done: boolean, word: string, then = false) => {
  const fresh = done && justDone?.word === word && performance.now() < justDone.until;
  if (fresh) justDone = null;
  const mark = fresh ? 'done-mark fresh' : then ? 'done-mark fresh then' : 'done-mark';
  return h('div', {class: 'step-act'},
    done ? h('span', {class: 'step-done'}, h('span', {class: mark, 'aria-hidden': 'true'}), word) : act);
};
const about = (...n: (Node | null)[]) => h('div', {class: 'step-about'}, ...n);
const quiet = (text: string) => h('p', {class: 'muted small'}, text);

/**
 * Commit and Push, inside the issue's box, one under the other at its right (green, the done mark, once done), what
 * each stands at at its left: the work's deeds go down the one edge Start was pressed on, as Merge's does under the
 * Review, so the pointer goes down the box rather than across it. Beside Commit, what is not committed: its diff opens
 * there. Pushing hands the work to main as its change, again as the next version; until it is decided, the change's
 * power switch (low at the box's right: `reset`) is on, and switched off takes it back.
 */
function steps(issue: Issue, s: RepoState, events: IssueEvents, after: () => void): {element: HTMLElement; reset: HTMLElement | null} {
  const at = issue.repo;
  const w = s.work!;
  const error = h('p', {class: 'error', role: 'alert'});

  // Change
  const dirty = s.uncommitted;
  // Nothing to commit says nothing (Commit's done mark says it); before the first, where the work is done.
  const what: Node | null = dirty ? notCommitted(at, w.line, dirty, events)
    : w.commits ? null : quiet(t('Edits in File, Forge, or Prompt appear here.'));

  // Commit
  const commit = button(t('Commit'), dirty > 0);
  commit.disabled = !dirty;
  commit.title = named(issue.kind, issue.title);
  commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', ''), after));
  const committed = !dirty && w.commits > 0;

  // Push
  const open = w.change?.state === 'open';
  const pushed = w.commits > 0 && !w.unpushed && (open || w.change?.state === 'merged');
  const push = button(t('Push'), !dirty && !pushed && w.commits > 0);
  push.disabled = !w.commits || pushed;
  push.addEventListener('click', doing(push, error, async () => { await git.push(at); await git.submit(at); }, after));
  // The change's power switch: on while it is in, said by its word beside it (Handed in); switched off, it is taken
  // back (Reset). Pressed, it goes off at once, as a switch does under the hand, and back on if it could not.
  let reset: HTMLElement | null = null;
  if (pushed && open) {
    const power = h('button', {type: 'button', class: 'power', role: 'switch', 'aria-checked': 'true', 'aria-label': t('Submitted'),
      title: t('Disabling withdraws this Change')}, h('span', {class: 'knob'})) as HTMLButtonElement;
    const off = doing(power, error, () => git.reset(at).catch((e: unknown) => { power.setAttribute('aria-checked', 'true'); throw e; }), after);
    power.addEventListener('click', () => { power.setAttribute('aria-checked', 'false'); void off(); });
    reset = h('span', {class: 'power-line'}, h('span', {class: 'muted small', 'aria-hidden': 'true'}, t('Submitted')), power);
  }
  // Taken back or rejected, Push's row still says so (the switch gone off has its answer), until it is pushed anew.
  // Handed in and waiting, it says nothing more: its done mark says it is in, and the Review under the box what is next.
  const where = w.unpushed ? quiet(tn('{n} commit to push', '{n} commits to push', w.unpushed))
    : w.change && w.change.state !== 'open' ? quiet(STATE(w.change.state)) : null;

  const commitSlot = slot(commit, committed, t('Commit'));
  return {element: h('div', {class: 'steps issue-steps'},
    h('div', {class: 'step-about step-changes'}, what), commitSlot,
    about(where), slot(push, pushed, t('Push'), !!commitSlot.querySelector('.done-mark.fresh')), error), reset};
}

/** Someone else's change, received: committed and pushed already, by whom and which version. */
function received(change: git.Change): HTMLElement {
  return h('div', {class: 'steps issue-steps'},
    about(quiet(change.submittedBy || '—')), slot(h('span'), true, t('Commit')),
    about(null), slot(h('span'), true, t('Push')));
}

/**
 * Merge, the last step, under the Review (not in it): Reject at the left,
 * who approved it, and its button at the right, primary once the version is
 * approved.
 */
/** Changes merged from here a moment ago (when): each one's line lands under Merged, lit, as its issue goes into it. */
const mergedNow = new Map<string, number>();
export const justMerged = (id: string) => Date.now() - (mergedNow.get(id) ?? 0) < 4000;

export function mergeRow(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement | null {
  const change = connection() ? changeFor(s, issue) : null;
  if (!change || change.state !== 'open') return null;
  const at = issue.repo;
  const here = hereOf(s, issue);
  const error = h('p', {class: 'error', role: 'alert'});
  const approvals = change.reviews.filter((r) => r.version === change.version && r.verdict === 'approve');
  const merge = button(t('Merge'), approvals.length > 0);
  merge.disabled = !approvals.length;
  // Merged, the work is done: the repo shows main again.
  // Merged, the issue's box goes down into its line under Merged, which lands lit: the issue is done.
  let from: DOMRect | null = null;
  let words: Lifted | null = null;
  let rest: HTMLElement | null = null;
  merge.addEventListener('click', doing(merge, error, async () => {
    await git.merge(at, change);
    mergedNow.set(change.id, Date.now());
    const slotEl = merge.closest<HTMLElement>('.issue-slot');
    const card = slotEl?.querySelector<HTMLElement>('.issue-card');
    // What stood under the box (its Review, Merge, Back to main) is done with: it folds away first, the box staying
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
    if (here) await git.switchWork(at, 'main');
    events.moved(at);
  }, () => {
    after();
    if (from) morph(from, () => document.querySelector<HTMLElement>(`.done-row[data-change="${CSS.escape(change.id)}"]`), 460, '', 150,
      words ? {lifted: words, to: (row) => row.querySelector('.done-name'), ...(rest ? {rest} : {})} : undefined);
  }));
  const by = approvals.length ? t('Approved by {who}', {who: [...new Set(approvals.map((r) => r.by))].join(', ')}) : t('Not approved yet');
  const reject = button(t('Reject'));
  reject.title = t('Do not merge into main (issue remains open)');
  reject.addEventListener('click', doing(reject, error, () => git.reject(at, change), after));
  return h('div', {class: 'steps merge-row'}, about(h('div', {class: 'step-line'}, reject, quiet(by))), slot(merge, false, ''), error);
}

/** A diff whose lines can be marked, as with a highlighter: `marked` shows, `pending` collects what is pressed now. */
function markedDiff(files: git.FileDiff[], marked: Set<string>, pending: Set<string> | null, kept: string): HTMLElement[] {
  // Each file a fold as main's card and the Commit row have them, its lines from the box's own edge (not set off to
  // the right of its name), what is opened or shut kept so as the Review is drawn again.
  return diffFiles(files, {kept, line: (row, key) => {
    if (marked.has(key)) row.classList.add('marked');
    if (!pending) return;
    row.classList.add('markable');
    // The line's words are what is marked: heard as a toggle named by them, pressed while marked.
    const words = row.querySelector<HTMLElement>('.diff-words');
    words?.setAttribute('role', 'button');
    words?.setAttribute('aria-pressed', String(marked.has(key)));
    row.addEventListener('click', () => {
      if (marked.has(key)) return;
      if (pending.has(key)) pending.delete(key); else pending.add(key);
      row.classList.toggle('marking', pending.has(key));
      words?.setAttribute('aria-pressed', String(pending.has(key)));
    });
  }});
}

/**
 * The change's Review, inside the issue's box under Commit and Push: its
 * diff (marked where reviewers marked it, scrolling in place), what was said
 * as a conversation, and room to say more. A change is reviewed the same way
 * without being worked on here.
 */
/**
 * Each change's diff as last read (by repo, change and version): the Review drawn again as the page is read again is
 * as tall as it was at once, not "Loading…" a moment, which closed the page up under the person reading it.
 */
const diffsRead = new Map<string, git.FileDiff[]>();

export function reviewBox(issue: Issue, s: RepoState | undefined, after: () => void): HTMLElement | null {
  const at = issue.repo;
  const change = changeFor(s, issue);
  if (!connection() || !change || change.state === 'reset') return null;

  // Review: the change's diff, marked where reviewers marked it, what was said, and room to say more.
  const error = h('p', {class: 'error', role: 'alert'});
  const current = change.reviews.filter((r) => r.version === change.version);
  const marked = new Set(current.flatMap((r) => r.marks ?? []));
  const pending = change.state === 'open' ? new Set<string>() : null;
  const read = `${at}\0${change.id}\0${change.version}`;
  const was = diffsRead.get(read);
  const diff = h('div', {class: 'review-diff'}, ...(was ? markedDiff(was, marked, pending, read) : [h('p', {class: 'muted small'}, t('Loading…'))]));
  void git.changeDiff(at, change).then((files) => {
    diffsRead.set(read, files);
    if (!was || JSON.stringify(files) !== JSON.stringify(was)) diff.replaceChildren(...markedDiff(files, marked, pending, read));
  }, (e) => diff.replaceChildren(h('p', {class: 'error'}, errorText(e))));
  // What was said, in order: a verdict with its note, or a comment alone.
  // What was said, in order, as a conversation: a verdict with its note, or a comment alone.
  // An approval is the ○ turning green, not a box in the conversation (its note, if any, still shows).
  const told = change.reviews.filter((r) => r.verdict !== 'approve' || r.note);
  const said = h('div', {class: 'review-chat'}, ...told.slice().reverse().map((r) => h('div', {class: 'bubble'},
    h('span', {class: 'muted small'}, `${r.by} · ${ago(r.time)}${r.version !== change.version ? ` · ${t('v{n} (older)', {n: r.version})}` : ''}`),
    r.verdict === 'changes' ? h('span', {class: 'step-done'}, t('Changes requested')) : null,
    r.note ? h('p', {class: 'bubble-text'}, r.note) : null)));
  const body: Node[] = [diff, ...(told.length ? [said] : [])];
  if (change.state === 'open') {
    // Under what was said, a comment more, written in a roomy field and sent
    // with the lines marked (Ctrl+Enter, or Comment); under it, Approve as a
    // ○. Merge and Reject follow under the box.
    const text = h('textarea', {class: 'line-in review-in', rows: '7', placeholder: t('Add a comment…'), 'aria-label': t('Comment'), maxlength: '4000'}) as HTMLTextAreaElement;
    // A comment, or asking for changes, says something: with nothing written or marked, the field is where to say it.
    const send = (verdict: git.Review['verdict'], b: HTMLButtonElement) => doing(b, error, async () => {
      if (!text.value.trim() && !pending!.size) { text.focus(); throw new Error(verdict === 'changes' ? t('Specify requested changes or select target lines') : ''); }
      await git.review(at, change, verdict, text.value, [...pending!]);
    }, after);
    // Approve is a ○: pressed, it turns green (the done mark) and stays so.
    let approve: HTMLElement;
    if (current.some((r) => r.verdict === 'approve')) approve = h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), t('Approve'));
    else {
      const b = h('button', {type: 'button', class: 'approve-mark'}, h('span', {class: 'ring', 'aria-hidden': 'true'}), t('Approve')) as HTMLButtonElement;
      // What is written and marked goes with it; only a written note shows in the conversation.
      b.addEventListener('click', doing(b, error, () => git.review(at, change, 'approve', text.value, [...pending!]), after));
      approve = b;
    }
    const comment = button(t('Comment'));
    comment.addEventListener('click', send('comment', comment));
    // Asking for changes: what is written and marked goes with it, and the conversation says it was asked.
    const changes = button(t('Request changes'));
    changes.addEventListener('click', send('changes', changes));
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); comment.click(); } });
    body.push(text, h('div', {class: 'review-verdict'}, approve, h('span', {class: 'grow'}), changes, comment));
  }
  body.push(error);
  return h('section', {class: 'review-box', 'aria-label': t('Review')},
    h('header', {class: 'stage-head'}, h('h3', {}, t('Review'))),
    ...body);
}
