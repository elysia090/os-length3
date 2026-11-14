import {kindWords} from '../kit/todo-list.ts';
import {ago, day, h} from '../../ui/dom.ts';
import {arrive, LAND, lift, type Lifted, morph, paced, putAway, still} from '../../ui/glide.ts';
import * as git from '../../repos/history.ts';
import {t, tn} from '../../i18n/i18n.ts';
import {closeMark, issueName, issuePath, saveIssue, setClosed, type Issue} from '../../repos/issues.ts';
import {connection, myName} from '../../remote/connection.ts';
import {changeFor, type Standing} from '../../repos/git-state.ts';
import {named} from '../../repos/text.ts';
import {diffFiles} from '../kit/diff-view.ts';
import {beingChanged, issueEditor} from './issue-form.ts';
import {agentLine, agentMark} from './agent-line.ts';
import {errorText} from '../../host/errors.ts';
import {busy} from './held.ts';
import {issueStore} from '../../repos/issue-store.ts';
import {SPRING} from '../../ui/law.ts';

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

const STATE = (s: git.Change['state']) => ({open: t('Pending'), merged: t('Merged'), rejected: t('Rejected'), reset: t('Withdrawn')})[s];

/** Run `f` with `b` held down (busy), then `after`; a failure is said in `error`, and `b` can be pressed again. */
const doing = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>, after: () => void) => async () => {
  busy(b, true);
  error.textContent = '';
  try { await f(); justDone = {word: b.textContent ?? '', until: performance.now() + 3000}; after(); } catch (e) { error.textContent = errorText(e); busy(b, false); }
};
/** The step just done here, for a moment: its done mark, drawn next, lands rather than being there (slot). */
let justDone: {word: string; until: number} | null = null;
/** What was just said in a change's Review here, for a moment: drawn next, it lands in the conversation (reviewBox). */
let justSaid: {change: string; until: number} | null = null;
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
  // One that will not be done is closed, at the foot's left as what goes against the box: it goes
  // under Closed, where Reopen brings it back. Whatever work the repo shows: an issue is main's.
  const leave = offered ? closeDeed(issue, error, events, after) : null;
  // Its title is changed where it is read: pressed, the head becomes the fields it was written in. Its summary is
  // written right under it, the work's margin note.
  const words = h('button', {type: 'button', class: 'issue-words', title: t('Edit description')}, issueHead(issue));
  // Its work, the sheet's lead, beside its words: what is not committed, or the change handed in.
  const work = workOf(issue, s, events);
  if (work) unfolding(work, issuePath(issue));
  // Its name over the sheet's corner, as every sheet has one: its number and kind, and that it is under way here.
  const name = h('p', {class: 'issue-name', 'aria-hidden': 'true'}, [issueName(issue), issue.kind].filter(Boolean).join(' '), here ? ' ' : null, here ? h('i', {}, t('under way')) : null);
  const box = h('div', {class: work ? 'issue-box' : 'issue-box no-work'},
    name, words, summary(issue, after), agentLine(issue), ...(work ? [work] : []), foot(issue, s, leave, []), error);
  const editor = () => issueEditor(issue, (saved) => { if (saved) after(); else box.replaceWith(issueBox(issue, s, events, after)); });
  words.addEventListener('click', () => words.replaceWith(editor()));
  // Its words half changed when the box was left: the box opens as the fields, as they were.
  if (beingChanged(issue)) words.replaceWith(editor());
  return box;
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
  const said = (word: string) => h('span', {class: 'switch-word'}, word);
  const lines: {done: boolean; el: HTMLElement}[] = [];
  // Start (Resume here, where it was started before).
  lines.push(offered ? {done: false, el: startDeed(issue, s, error, events, after)} : {done: here || open, el: said(t('Start'))});
  // Commit: what is not committed goes to one's own Remote, named by the issue.
  const dirty = w ? s?.uncommitted ?? 0 : 0;
  if (w && !(!dirty && w.commits > 0)) {
    const commit = button(t('Commit'));
    commit.disabled = !dirty;
    commit.title = named(issue.kind, issue.title);
    commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', ''), after));
    lines.push({done: false, el: commit});
  } else lines.push({done: !!w || open, el: said(t('Commit'))});
  // Submit: a commit hands itself in on one's own repo; the switch says whether the change is in, and takes it back.
  if (w && w.commits > 0 && !(w.change?.state === 'merged' && !w.unpushed)) {
    const inNow = !w.unpushed && w.change?.state === 'open';
    const power = h('button', {type: 'button', class: 'switch-power', role: 'switch', 'aria-checked': String(inNow), 'aria-label': t('Submitted'),
      title: inNow ? t('Disabling withdraws this Change') : t('Submit the commits as this Change')}, t('Submit')) as HTMLButtonElement;
    power.disabled = !inNow && dirty > 0;
    const was = String(inNow);
    const turn = doing(power, error, () => (inNow ? git.reset(at) : git.push(at).then(() => git.submit(at)))
      .catch((e: unknown) => { power.setAttribute('aria-checked', was); throw e; }), after);
    power.addEventListener('click', () => { power.setAttribute('aria-checked', String(!inNow)); void turn(); });
    lines.push({done: inNow, el: power});
  } else lines.push({done: open, el: said(t('Submit'))});
  // Merge: once the version is approved.
  lines.push(open && change ? {done: false, el: mergeDeed(issue, s, change, error, events, after)} : {done: false, el: said(t('Merge'))});
  const next = lines.findIndex((l) => !l.done);
  return h('div', {class: 'switch-lines'},
    ...lines.map((l, k) => h('div', {class: l.done ? 'switch-line done' : k === next ? 'switch-line next' : 'switch-line'}, l.el)), error);
}

/** Each change's diff as last read (by repo, change and version), and each copy's not committed: see diffsRead, uncommittedRead. */
/**
 * An issue's work, in its sheet beside its words: what is not committed in the copy shown (named for a screen reader
 * by how many files), else the change handed in; before the first edit, where the work is done. None where there is
 * no work yet. Only what changed is in focus: a line either side of it stays, out of focus, and the rest is left out.
 */
function workOf(issue: Issue, s: RepoState | undefined, events: IssueEvents): HTMLElement | null {
  const at = issue.repo;
  const here = hereOf(s, issue), w = here ? s?.work ?? null : null;
  const change = connection() ? changeFor(s, issue) : null;
  const dirty = w ? s?.uncommitted ?? 0 : 0;
  const draw = (list: git.FileDiff[]) => workFiles(list, (p) => events.open(at, p));
  const fill = (box: HTMLElement, was: git.FileDiff[] | undefined, read: Promise<git.FileDiff[]>, keep: (list: git.FileDiff[]) => git.FileDiff[]) => {
    box.append(...(was ? draw(was) : [quiet(t('Loading…'))]));
    // Read for the first time, the files come in under "Loading…" and the box grows to hold them, never a jump.
    const show = (...nodes: Node[]) => { const from = box.isConnected ? box.getBoundingClientRect().height : 0; box.replaceChildren(...nodes); resize(box, from); };
    void read.then((list) => { const now = keep(list); if (!was || JSON.stringify(now) !== JSON.stringify(was)) show(...draw(now)); },
      (e) => show(h('p', {class: 'error'}, errorText(e))));
    return box;
  };
  if (w && dirty) {
    const copy = `${at}\0${w.line}`;
    return fill(h('div', {class: 'issue-work changes', role: 'region', 'aria-label': tn('{n} uncommitted file', '{n} uncommitted files', dirty)}),
      uncommittedRead.get(copy), git.diff(at), (list) => { uncommittedRead.set(copy, list); return list; });
  }
  if (change && change.state !== 'reset') {
    const read = `${at}\0${change.id}\0${change.version}`;
    return fill(h('div', {class: 'issue-work', role: 'region', 'aria-label': t('Diff')}), diffsRead.get(read), git.changeDiff(at, change),
      (list) => { diffsRead.set(read, list); return list; });
  }
  if (w) return h('div', {class: 'issue-work none'}, quiet(t('Edits in File, Forge, or Prompt appear here.')));
  return null;
}

/** How many lines either side of a change stay in an issue's work, out of focus. */
const ABOUT = 1;

/**
 * Files changed, as an issue's sheet shows them: a file's name (pressed, it opens in Forge) and how much was added and
 * taken away, then its lines: what was added and what was taken away in focus on their bands, a line about them out
 * of focus (`far`), the rest of the file left out. The work's sum after them, large, where the sheet turns.
 */
function workFiles(files: git.FileDiff[], reveal: (path: string) => void): HTMLElement[] {
  let plus = 0, minus = 0;
  const out = files.map((f) => {
    const lines = f.lines.filter((l) => l.kind !== 'hunk');
    const near = lines.map((_, i) => lines.some((x, j) => x.kind !== 'same' && Math.abs(i - j) <= ABOUT));
    const shown = lines.filter((l, i) => l.kind !== 'same' || near[i]);
    // (A line about a change that says nothing, at either end, is not a row.)
    while (shown.length && shown[0]!.kind === 'same' && !shown[0]!.text.trim()) shown.shift();
    while (shown.length && shown.at(-1)!.kind === 'same' && !shown.at(-1)!.text.trim()) shown.pop();
    const indent = Math.min(...shown.filter((l) => l.text.trim()).map((l) => l.text.length - l.text.trimStart().length), Infinity);
    const add = lines.filter((l) => l.kind === 'add').length, del = lines.filter((l) => l.kind === 'del').length;
    plus += add; minus += del;
    const name = h('button', {type: 'button', class: 'work-name'}, f.path);
    name.addEventListener('click', () => reveal(f.path));
    return h('div', {class: 'work-file'},
      h('div', {class: 'work-head'}, name, h('span', {class: 'work-count'}, add ? h('span', {class: 'diff-add'}, `+${add}`) : null, del ? h('span', {class: 'diff-del'}, `−${del}`) : null)),
      f.binary ? quiet(t('Binary')) : h('div', {class: 'work-lines'}, ...shown.map((l) => h('div', {class: l.kind === 'add' ? 'work-line add' : l.kind === 'del' ? 'work-line del' : 'work-line far'},
        h('span', {class: 'work-sign', 'aria-hidden': 'true'}, l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''),
        h('span', {class: 'work-text'}, Number.isFinite(indent) ? l.text.slice(indent) : l.text)))));
  });
  if (plus || minus) out.push(h('p', {class: 'work-sum', 'aria-hidden': 'true'}, plus ? h('span', {class: 'diff-add'}, `+${plus}`) : null, minus ? h('span', {class: 'diff-del'}, `−${minus}`) : null));
  return out;
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
      {duration: paced(240), easing: SPRING, fill: 'forwards'});
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
  // Commits made here and not handed in (signed out as they were made, a change taken back): said with where it stands.
  const w = hereOf(s, issue) ? s?.work ?? null : null;
  const waits = w?.unpushed ? tn('{n} commit not submitted', '{n} commits not submitted', w.unpushed) : '';
  return h('div', {class: 'issue-foot'}, leave, h('div', {class: 'issue-about'}, h('span', {class: 'issue-where'}, issue.repo),
    say ? h('span', {class: s?.error ? 'error small' : 'muted small'}, say) : null, waits ? h('span', {class: 'muted small'}, waits) : null), ...acts);
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
        c.animate([{opacity: 0}, {opacity: 0, offset: .3}, {opacity: 1}], {duration: ms, easing: SPRING});
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
  const a = p.animate([{opacity: 0}, {opacity: 1}], {duration: paced(220), delay: paced(40), easing: SPRING, fill: 'backwards'});
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
    if (here) await git.switchWork(at, 'main');
    events.moved(at);
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
  reject.title = t('Do not merge into main (issue remains open)');
  reject.addEventListener('click', doing(reject, error, () => git.reject(at, change), after));
  return h('div', {class: 'steps merge-row'}, reject, error);
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
  const pending = change.state === 'open' ? new Set<string>() : null;
  const read = `${at}\0${change.id}\0${change.version}`;
  const was = diffsRead.get(read);
  // What is read at the right is the change as it stands, not a history: the history is down the line at its left
  // (below), and the one pressed there says whose marks and words the change is read with (`shown`: at first the
  // version it stands at; an earlier one, what was asked of it when it was sent back).
  let shown = change.version, files = was;
  const diff = h('div', {class: 'review-diff'}, h('p', {class: 'muted small'}, t('Loading…')));
  const drawDiff = () => {
    if (!files) return;
    const marked = new Set(change.reviews.filter((r) => r.version === shown).flatMap((r) => r.marks ?? []));
    diff.replaceChildren(...markedDiff(files, marked, shown === change.version ? pending : null, read));
  };
  drawDiff();
  void git.changeDiff(at, change).then((now) => {
    diffsRead.set(read, now);
    if (!files || JSON.stringify(now) !== JSON.stringify(files)) { files = now; drawDiff(); }
  }, (e) => diff.replaceChildren(h('p', {class: 'error'}, errorText(e))));
  // What was said of the version shown, the newest first: a verdict with its note, or a comment alone. An approval
  // is said over the sheet's corner, not in the conversation (its note, if any, still shows).
  // Said here just now: the newest comes down into the conversation from the field it was written in, not there at once.
  const landing = justSaid?.change === change.id && performance.now() < justSaid.until;
  if (landing) justSaid = null;
  const said = h('div', {class: 'review-chat'});
  const drawSaid = (fresh: boolean) => {
    const told = change.reviews.filter((r) => r.version === shown && (r.verdict !== 'approve' || r.note));
    said.replaceChildren(...told.slice().reverse().map((r, k) => h('div', {class: fresh && k === 0 ? 'bubble fresh' : 'bubble'},
      h('span', {class: 'muted small'}, `${r.by} · ${ago(r.time)}`),
      r.verdict === 'changes' ? h('span', {class: 'step-done'}, t('Changes requested')) : null,
      r.note ? h('p', {class: 'bubble-text'}, r.note) : null)));
    said.hidden = !told.length;
    said.firstElementChild?.addEventListener('animationend', (e) => (e.currentTarget as HTMLElement).classList.remove('fresh'), {once: true});
  };
  drawSaid(landing);
  const body: Node[] = [said];
  /** What is written with (the field, its keys): only of the version the change stands at. */
  const writes: HTMLElement[] = [];
  if (change.state === 'open') {
    // Under what was said, a comment more, written in a roomy field and sent
    // with the lines marked (Ctrl+Enter, or Comment); under it, Approve as a
    // ○. Merge and Reject follow under the box.
    const text = h('textarea', {class: 'line-in review-in', rows: '7', placeholder: t('Add a comment…'), 'aria-label': t('Comment'), maxlength: '4000'}) as HTMLTextAreaElement;
    // A comment, or asking for changes, says something: with nothing written or marked, the field is where to say it.
    const send = (verdict: git.Review['verdict'], b: HTMLButtonElement) => doing(b, error, async () => {
      if (!text.value.trim() && !pending!.size) { text.focus(); throw new Error(verdict === 'changes' ? t('Specify requested changes or select target lines') : ''); }
      await git.review(at, change, verdict, text.value, [...pending!]);
      justSaid = {change: change.id, until: performance.now() + 3000};
    }, after);
    // Approve is a ○: pressed, it turns green (the done mark) and stays so.
    let approve: HTMLElement;
    if (current.some((r) => r.verdict === 'approve')) approve = h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), t('Approve'));
    else {
      const b = h('button', {type: 'button', class: 'approve-mark'}, h('span', {class: 'ring', 'aria-hidden': 'true'}), t('Approve')) as HTMLButtonElement;
      // What is written and marked goes with it; only a written note shows in the conversation.
      b.addEventListener('click', doing(b, error, async () => {
        await git.review(at, change, 'approve', text.value, [...pending!]);
        if (text.value.trim()) justSaid = {change: change.id, until: performance.now() + 3000};
      }, after));
      approve = b;
    }
    const comment = button(t('Comment'));
    comment.addEventListener('click', send('comment', comment));
    // Asking for changes: what is written and marked goes with it, and the conversation says it was asked.
    const changes = button(t('Request changes'));
    changes.addEventListener('click', send('changes', changes));
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); comment.click(); } });
    writes.push(text, h('div', {class: 'review-verdict'}, approve, h('span', {class: 'grow'}), changes, comment));
    body.push(...writes);
  }
  body.push(error);
  // The change's history, down the line: each time it was handed in, said large by when (under it, small, what it
  // says, or that changes were asked of it). Pressed, the change is read with what was marked and said of it then.
  const versions = [...new Set([...change.reviews.map((r) => r.version), change.version])].sort((a, b) => a - b);
  const history = h('ol', {class: 'issue-history', 'aria-label': t('Commits')}, ...versions.map((v) => {
    const of = change.reviews.filter((r) => r.version === v), sent = of.filter((r) => r.verdict === 'changes').pop();
    const when = v === change.version ? change.updatedAt : (sent ?? of[of.length - 1]).time;
    const b = h('button', {type: 'button', class: 'history-at', 'aria-pressed': String(v === shown)},
      h('time', {datetime: new Date(when).toISOString()}, clock(when)), h('span', {}, sent ? t('Changes requested') : change.note || `v${v}`)) as HTMLButtonElement;
    b.addEventListener('click', () => {
      shown = v;
      for (const o of history.querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
      drawDiff();
      drawSaid(false);
      for (const el of writes) el.hidden = v !== change.version;
    });
    return h('li', {}, b);
  }));
  const approvals = current.filter((r) => r.verdict === 'approve');
  const by = change.state !== 'open' ? null
    : quiet(approvals.length ? t('Approved by {who}', {who: [...new Set(approvals.map((r) => r.by))].join(', ')}) : t('Not approved yet'));
  return h('section', {class: 'review-box', 'aria-label': t('Review')}, history, diff,
    h('div', {class: 'review-sheet'}, h('header', {class: 'stage-head'}, h('h3', {}, t('Review')), by), ...body));
}

/** When, as a clock says it within a day (14:32); earlier, the day. */
const clock = (ms: number) => {
  const d = new Date(ms);
  return Date.now() - ms < 86_400_000 ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day(ms);
};
