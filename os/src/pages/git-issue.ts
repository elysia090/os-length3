import {ago, h} from '../dom.ts';
import * as git from '../history.ts';
import {t, tn} from '../i18n.ts';
import {closeMark, issueName, issuePath, setClosed, type Issue} from '../issues.ts';
import {connection, me} from '../remote.ts';
import {store} from '../repos.ts';
import {changeFor, type Standing} from '../git-state.ts';
import {named} from '../text.ts';
import {diffFiles} from './diff-view.ts';
import {beingChanged, issueEditor} from './issue-form.ts';

// An issue on the Git page, as one large box (issue #17). Its branch and
// worktree are never named: Start gives the issue its own copy of the repo,
// which File, Forge and the Prompt then show. The box offers only what can
// be done next, one primary action at a time, in the order of the work:
//
//   Start (Continue here) · Changes · Commit · Push (Reset)
//
// and Back to main (at the foot's left, as what leaves always is). Under the box, the Review in a box of its own (Comment,
// and Approve as a ○), and under that, Merge with Reject at its left. A change received from someone
// else shows Commit and Push done already.

export interface IssueEvents {
  open(repo: string, path: string): void;
  /** The repo now shows another copy (or main moved): the shell reads it again. */
  moved(repo: string): void;
}

/** Where a repo stands, read once for every issue of it. */
export interface RepoState extends Standing { lines: git.Line[];
  /** Where it stands could not be read (the Remote away, or refusing): said on its issues, and nothing offered meanwhile. */
  error?: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function button(text: string, primary = false): HTMLButtonElement {
  return h('button', {class: primary ? 'button primary' : 'button', type: 'button'}, text) as HTMLButtonElement;
}

const STATE = (s: git.Change['state']) => ({open: t('Undecided'), merged: t('Merged'), rejected: t('Rejected'), reset: t('Taken back')})[s];

/** Run `f` with `b` held down, then `after`; a failure is said in `error`. */
const doing = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>, after: () => void) => async () => {
  b.disabled = true;
  error.textContent = '';
  try { await f(); after(); } catch (e) { error.textContent = message(e); b.disabled = false; }
};

/** The issue's change (the latest record of it). */
export const changeOf = changeFor;

/** Who is signed in, for the line a close is written with; read once. */
let whoAmI: Promise<string> | null = null;
const myName = () => (whoAmI ??= me().then((m) => m?.name ?? '', () => { whoAmI = null; return ''; }));

/** Close an issue that will not be done: its file says so on its last line (the day, and who). */
export const closeIssue = async (issue: Issue) => setClosed(store, issue, closeMark(await myName()));
/** Open a closed issue again. */
export const reopenIssue = (issue: Issue) => setClosed(store, issue, null);
const hereOf = (s: RepoState | undefined, issue: Issue) => !!s?.work && s.work.line !== 'main' && s.work.issue === issuePath(issue);

/** Where the issue stands, quietly, in a few words. */
function standing(s: RepoState | undefined, issue: Issue): string {
  const path = issuePath(issue);
  const c = changeOf(s, issue);
  const w = s?.work;
  // Worked on here: who and when; the boxes under it say the rest.
  if (hereOf(s, issue) && w) return t('{who} · started {when}', {who: w.started_by || '—', when: ago(w.started_at)});
  // An open change says where it stands in its Push row.
  if (c) return c.state === 'open' ? '' : t('Change · version {n} · {state}', {n: c.version, state: STATE(c.state)});
  const line = s?.lines.find((l) => l.issue === path);
  if (line) return t('{who} · started {when}', {who: line.startedBy || '—', when: ago(line.startedAt)});
  return '';
}

/** The head of an issue's box: its number and title. */
export function issueHead(issue: Issue): HTMLElement {
  const no = issueName(issue);
  return h('div', {class: 'issue-big-head'},
    h('h2', {}, no ? h('span', {class: 'issue-no'}, no) : null, no ? ' ' : null, issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title));
}

/** The box: the issue's words, where it stands, and the way into its work (or back out). */
export function issueBox(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement {
  const at = issue.repo;
  const path = issuePath(issue);
  const error = h('p', {class: 'error', role: 'alert'});
  const line = s?.lines.find((l) => l.issue === path) ?? null;
  const here = hereOf(s, issue);
  const change = connection() ? changeOf(s, issue) : null;
  const acts: Node[] = [];
  let leave: HTMLButtonElement | null = null;
  // Nothing is offered until where it stands is known.
  const known = connection() && !s?.error;
  if (known && !here && change?.state !== 'open') {
    const go = button(line ? t('Continue here') : t('Start'), true);
    go.addEventListener('click', doing(go, error, async () => {
      if (line) await git.switchWork(at, line.line); else await git.startWork(at, issue.file);
      events.moved(at);
    }, after));
    acts.push(go);
  } else if (here) {
    leave = button(t('Back to main'));
    leave.addEventListener('click', doing(leave, error, async () => { await git.switchWork(at, 'main'); events.moved(at); }, after));
  }
  // One that will not be done is closed, at the foot's left as what goes against the box: it goes
  // under Closed, where Reopen brings it back. Only while the repo shows main, whose issue/ it is in.
  if (known && !here && change?.state !== 'open' && s?.work?.line === 'main') {
    leave = button(t('Close'));
    leave.title = t('Will not be done: it goes under Closed, where it can be reopened');
    leave.addEventListener('click', doing(leave, error, () => closeIssue(issue), after));
  }
  // At the box's foot, opposite its action: its repo and, quietly, who started it and when.
  const say = !connection() ? t('History and work are kept on the Remote. Sign in to it to work on an issue and commit.') : s?.error ?? standing(s, issue);
  // Its words are changed where they are read: pressed, the head and the detail become the fields they were written in.
  const words = h('button', {type: 'button', class: 'issue-words', title: t('Change its words')},
    issueHead(issue), issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null);
  const box = h('div', {class: 'issue-box'},
    words,
    ...(here && s?.work ? [steps(issue, s, events, after)] : change?.state === 'open' ? [received(change)] : []),
    h('div', {class: 'issue-foot'}, leave, h('div', {class: 'issue-about'}, h('span', {class: 'issue-where'}, issue.repo), say ? h('span', {class: s?.error ? 'error small' : 'muted small'}, say) : null), ...acts), error);
  const editor = () => issueEditor(issue, (saved) => { if (saved) after(); else box.replaceWith(issueBox(issue, s, events, after)); });
  words.addEventListener('click', () => words.replaceWith(editor()));
  // Its words half changed when the box was left: the box opens as the fields, as they were.
  if (beingChanged(issue)) words.replaceWith(editor());
  return box;
}

/**
 * What is not committed in the copy `at` shows (▸ 5 files): pressed, its diff
 * lies over what is under it, so nothing moves; Escape or a press outside closes it.
 */
export function notCommitted(at: string, n: number, events: IssueEvents): HTMLElement {
  const inside = h('div', {class: 'step-diff'}, quiet(t('Reading…')));
  const fold = h('details', {class: 'stage-diff'}, h('summary', {}, tn('{n} file not committed', '{n} files not committed', n)), inside) as HTMLDetailsElement;
  let read = false;
  const away = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !fold.contains(e.target as Node)) fold.open = false; };
  fold.addEventListener('toggle', () => {
    for (const k of ['pointerdown', 'keydown'] as const) (fold.open ? document.addEventListener : document.removeEventListener).call(document, k, away);
    if (!fold.open || read) return;
    read = true;
    void git.diff(at).then((files) => inside.replaceChildren(...diffFiles(files, {reveal: (p) => events.open(at, p)})), (e) => inside.replaceChildren(h('p', {class: 'error'}, message(e))));
  });
  return fold;
}

/** A step's place at the right: its button, or once done the done mark and the same word (green says it is done). */
const slot = (act: HTMLElement, done: boolean, word: string) => h('div', {class: 'step-act'},
  done ? h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), word) : act);
const about = (...n: (Node | null)[]) => h('div', {class: 'step-about'}, ...n);
const quiet = (text: string) => h('p', {class: 'muted small'}, text);

/**
 * Commit and Push, inside the issue's box, each a row: what it stands at at
 * the left, its button at the right (green, the done mark, once done), and
 * what takes it back (Reset) at the row's left end. Beside Commit, what is not committed:
 * its diff opens over what is under it, so neither button moves. Pushing
 * hands the work to main as its change, again as the next version; until it
 * is decided, Reset takes it back.
 */
function steps(issue: Issue, s: RepoState, events: IssueEvents, after: () => void): HTMLElement {
  const at = issue.repo;
  const w = s.work!;
  const error = h('p', {class: 'error', role: 'alert'});

  // Change
  const dirty = s.uncommitted;
  let what: Node;
  if (dirty) {
    what = notCommitted(at, dirty, events);
  } else {
    what = quiet(w.commits ? t('No changes') : t('Edit in File, Forge or the Prompt; what changes shows here.'));
  }

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
  let reset: HTMLButtonElement | null = null;
  if (pushed && open) {
    reset = button(t('Reset'));
    reset.title = t('Take back the change');
    reset.addEventListener('click', doing(reset, error, () => git.reset(at), after));
  }
  const where = pushed
    ? h('div', {class: 'step-line'}, reset, quiet(t('Change · version {n} · {state}', {n: w.change!.version, state: STATE(w.change!.state)})))
    : w.unpushed ? quiet(tn('{n} commit to push', '{n} commits to push', w.unpushed)) : null;

  return h('div', {class: 'steps'},
    h('div', {class: 'step-about step-changes'}, what), slot(commit, committed, t('Commit')),
    about(where), slot(push, pushed, t('Push')), error);
}

/** Someone else's change, received: committed and pushed already, by whom and which version. */
function received(change: git.Change): HTMLElement {
  return h('div', {class: 'steps'},
    about(quiet(change.submittedBy || '—')), slot(h('span'), true, t('Commit')),
    about(quiet(t('Change · version {n} · {state}', {n: change.version, state: STATE(change.state)}))), slot(h('span'), true, t('Push')));
}

/**
 * Merge, the last step, under the Review (not in it): Reject at the left,
 * who approved it, and its button at the right, primary once the version is
 * approved.
 */
export function mergeRow(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement | null {
  const change = connection() ? changeOf(s, issue) : null;
  if (!change || change.state !== 'open') return null;
  const at = issue.repo;
  const here = hereOf(s, issue);
  const error = h('p', {class: 'error', role: 'alert'});
  const approvals = change.reviews.filter((r) => r.version === change.version && r.verdict === 'approve');
  const merge = button(t('Merge'), approvals.length > 0);
  merge.disabled = !approvals.length;
  // Merged, the work is done: the repo shows main again.
  merge.addEventListener('click', doing(merge, error, async () => { await git.merge(at, change); if (here) await git.switchWork(at, 'main'); events.moved(at); }, after));
  const by = approvals.length ? t('Approved by {who}', {who: [...new Set(approvals.map((r) => r.by))].join(', ')}) : t('Not approved yet');
  const reject = button(t('Reject'));
  reject.title = t('Do not take it into main (its issue stays open)');
  reject.addEventListener('click', doing(reject, error, () => git.reject(at, change), after));
  return h('div', {class: 'steps merge-row'}, about(h('div', {class: 'step-line'}, reject, quiet(by))), slot(merge, false, ''), error);
}

/** A diff whose lines can be marked, as with a highlighter: `marked` shows, `pending` collects what is pressed now. */
function markedDiff(files: git.FileDiff[], marked: Set<string>, pending: Set<string> | null): HTMLElement[] {
  return diffFiles(files, {line: (row, key) => {
    if (marked.has(key)) row.classList.add('marked');
    if (!pending) return;
    row.classList.add('markable');
    row.addEventListener('click', () => {
      if (marked.has(key)) return;
      if (pending.has(key)) pending.delete(key); else pending.add(key);
      row.classList.toggle('marking', pending.has(key));
    });
  }});
}

/**
 * The change's Review, inside the issue's box under Commit and Push: its
 * diff (marked where reviewers marked it, scrolling in place), what was said
 * as a conversation, and room to say more. A change is reviewed the same way
 * without being worked on here.
 */
export function reviewBox(issue: Issue, s: RepoState | undefined, after: () => void): HTMLElement | null {
  const at = issue.repo;
  const change = changeOf(s, issue);
  if (!connection() || !change || change.state === 'reset') return null;

  // Review: the change's diff, marked where reviewers marked it, what was said, and room to say more.
  const error = h('p', {class: 'error', role: 'alert'});
  const current = change.reviews.filter((r) => r.version === change.version);
  const marked = new Set(current.flatMap((r) => r.marks ?? []));
  const pending = change.state === 'open' ? new Set<string>() : null;
  const diff = h('div', {class: 'review-diff'}, h('p', {class: 'muted small'}, t('Reading…')));
  void git.changeDiff(at, change).then((files) => diff.replaceChildren(...markedDiff(files, marked, pending)), (e) => diff.replaceChildren(h('p', {class: 'error'}, message(e))));
  // What was said, in order: a verdict with its note, or a comment alone.
  // What was said, in order, as a conversation: a verdict with its note, or a comment alone.
  // An approval is the ○ turning green, not a box in the conversation (its note, if any, still shows).
  const told = change.reviews.filter((r) => r.verdict !== 'approve' || r.note);
  const said = h('div', {class: 'review-chat'}, ...told.slice().reverse().map((r) => h('div', {class: 'bubble'},
    h('span', {class: 'muted small'}, `${r.by} · ${ago(r.time)}${r.version !== change.version ? ` · ${t('version {n} (older)', {n: r.version})}` : ''}`),
    r.verdict === 'changes' ? h('span', {class: 'step-done'}, t('Asked for changes')) : null,
    r.note ? h('p', {class: 'bubble-text'}, r.note) : null)));
  const body: Node[] = [diff, ...(told.length ? [said] : [])];
  if (change.state === 'open') {
    // Under what was said, a comment more, written in a roomy field and sent
    // with the lines marked (Ctrl+Enter, or Comment); under it, Approve as a
    // ○. Merge and Reject follow under the box.
    const text = h('textarea', {class: 'line-in review-in', rows: '7', placeholder: t('Comment…'), 'aria-label': t('Comment'), maxlength: '4000'}) as HTMLTextAreaElement;
    // A comment, or asking for changes, says something: with nothing written or marked, the field is where to say it.
    const send = (verdict: git.Review['verdict'], b: HTMLButtonElement) => doing(b, error, async () => {
      if (!text.value.trim() && !pending!.size) { text.focus(); throw new Error(verdict === 'changes' ? t('Say what to change, or mark its lines') : ''); }
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
    const changes = button(t('Ask for changes'));
    changes.addEventListener('click', send('changes', changes));
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); comment.click(); } });
    body.push(text, h('div', {class: 'review-verdict'}, approve, h('span', {class: 'grow'}), changes, comment));
  }
  body.push(error);
  return h('section', {class: 'review-box', 'aria-label': t('Review')},
    h('header', {class: 'stage-head'}, h('h3', {}, t('Review'))),
    ...body);
}
