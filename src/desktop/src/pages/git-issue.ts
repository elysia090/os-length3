import {ago, h} from '../dom.ts';
import * as git from '../history.ts';
import {t, tn} from '../i18n.ts';
import type {Issue} from '../issues.ts';
import {connection} from '../remote.ts';
import {named} from '../text.ts';
import {diffFiles} from './diff-view.ts';

// An issue on the Git page, as one large box (issue #17). Its branch and
// worktree are never named: Start gives the issue its own copy of the repo,
// which File, Forge and the Prompt then show. The box offers only what can
// be done next, one primary action at a time, in the order of the work:
//
//   Start (Continue here) · Changes · Commit · Push (Reset)
//
// and Back to main. Under the box, the Review in a box of its own (Reject,
// Comment, Approve), and under that, Merge. A change received from someone
// else shows Commit and Push done already.

export interface IssueEvents {
  open(repo: string, path: string): void;
  /** The repo now shows another copy (or main moved): the shell reads it again. */
  moved(repo: string): void;
}

/** Where a repo stands, read once for every issue of it. */
export interface RepoState { work: git.Work | null; lines: git.Line[]; changes: git.Change[]; uncommitted: number }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** issue/001.md is #1; a name that is not a number is itself. */
export const issueNumber = (file: string) => { const n = /^0*(\d+)\.md$/.exec(file); return n ? `#${n[1]}` : file.replace(/\.md$/, ''); };

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
export const changeOf = (s: RepoState | undefined, issue: Issue) => s?.changes.find((x) => x.issue === `issue/${issue.file}`) ?? null;
/** Still to do: not merged into main. */
export const unmerged = (s: RepoState | undefined, issue: Issue) => changeOf(s, issue)?.state !== 'merged';
const hereOf = (s: RepoState | undefined, issue: Issue) => !!s?.work && s.work.line !== 'main' && s.work.issue === `issue/${issue.file}`;

/** Where the issue stands, quietly, in a few words. */
function standing(s: RepoState | undefined, issue: Issue): string {
  const path = `issue/${issue.file}`;
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

/** The head of an issue's box: its number, title and where it lives (which opens the file). */
export function issueHead(issue: Issue, events?: IssueEvents): HTMLElement {
  const where = `${issue.repo} · issue/${issue.file}`;
  const place = events ? h('button', {type: 'button', class: 'link issue-where'}, where) : h('span', {class: 'issue-where'}, where);
  if (events) place.addEventListener('click', () => events.open(issue.repo, `issue/${issue.file}`));
  return h('header', {class: 'issue-big-head'},
    h('h2', {}, h('span', {class: 'issue-no'}, issueNumber(issue.file)), ' ', issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title),
    place);
}

/** The box: the issue's words, where it stands, and the way into its work (or back out). */
export function issueBox(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement {
  const at = issue.repo;
  const path = `issue/${issue.file}`;
  const error = h('p', {class: 'error', role: 'alert'});
  const line = s?.lines.find((l) => l.issue === path) ?? null;
  const here = hereOf(s, issue);
  const change = connection() ? changeOf(s, issue) : null;
  const acts: Node[] = [];
  if (connection() && !here && change?.state !== 'open') {
    const go = button(line ? t('Continue here') : t('Start'), true);
    go.addEventListener('click', doing(go, error, async () => {
      if (line) await git.switchWork(at, line.line); else await git.startWork(at, issue.file);
      events.moved(at);
    }, after));
    acts.push(h('span', {class: 'grow'}), go);
  } else if (here) {
    const leave = button(t('Back to main'));
    leave.addEventListener('click', doing(leave, error, async () => { await git.switchWork(at, 'main'); events.moved(at); }, after));
    acts.push(h('span', {class: 'grow'}), leave);
  }
  const say = connection() ? standing(s, issue) : t('History and work are kept on the Remote. Sign in to it to work on an issue and commit.');
  return h('div', {class: 'issue-box'},
    issueHead(issue, events),
    issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null,
    say ? h('p', {class: 'muted small'}, say) : null,
    ...(here && s?.work ? [steps(issue, s, events, after)] : change?.state === 'open' ? [received(change)] : []),
    acts.length ? h('div', {class: 'row work-act'}, ...acts) : null, error);
}

/** A step's place at the left: its button, or once done the done mark and the step's word. */
const slot = (act: HTMLElement, done: boolean, word: string) => h('div', {class: 'step-act'},
  done ? h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), word) : act);
const about = (...n: (Node | null)[]) => h('div', {class: 'step-about'}, ...n);
const quiet = (text: string) => h('p', {class: 'muted small'}, text);

/**
 * Change, Commit and Push, inside the issue's box, from the top: what is
 * changed and not committed (its diff closed until opened, scrolling in
 * place), then Commit, then Push, each its button at the left (the done
 * mark in its place once done). The diff is above both, so opening it moves
 * neither apart. Pushing hands the work to main as its change, again as the
 * next version; until it is decided, Reset takes it back.
 */
function steps(issue: Issue, s: RepoState, events: IssueEvents, after: () => void): HTMLElement {
  const at = issue.repo;
  const w = s.work!;
  const error = h('p', {class: 'error', role: 'alert'});

  // Change
  const dirty = s.uncommitted;
  let what: Node;
  if (dirty) {
    const inside = h('div', {class: 'step-diff'}, quiet(t('Reading…')));
    const fold = h('details', {class: 'stage-diff'}, h('summary', {}, tn('{n} file not committed', '{n} files not committed', dirty)), inside) as HTMLDetailsElement;
    let read = false;
    // Open, the diff lies over what is under it (nothing moves); Escape or a press outside closes it.
    const away = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !fold.contains(e.target as Node)) fold.open = false; };
    fold.addEventListener('toggle', () => {
      for (const k of ['pointerdown', 'keydown'] as const) (fold.open ? document.addEventListener : document.removeEventListener).call(document, k, away);
      if (!fold.open || read) return;
      read = true;
      void git.diff(at).then((files) => inside.replaceChildren(...diffFiles(files, (p) => events.open(at, p))), (e) => inside.replaceChildren(h('p', {class: 'error'}, message(e))));
    });
    what = fold;
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
    ? h('div', {class: 'step-line'}, quiet(t('Change · version {n} · {state}', {n: w.change!.version, state: STATE(w.change!.state)})), reset)
    : w.unpushed ? quiet(tn('{n} commit to push', '{n} commits to push', w.unpushed)) : null;

  return h('div', {class: 'steps'},
    h('div', {class: 'step-act'}, h('span', {class: 'step-name'}, t('Changes'))), about(what),
    slot(commit, committed, t('Committed')), about(),
    slot(push, pushed, t('Pushed')), about(where), error);
}

/** Someone else's change, received: committed and pushed already, by whom and which version. */
function received(change: git.Change): HTMLElement {
  return h('div', {class: 'steps'},
    slot(h('span'), true, t('Committed')), about(quiet(change.submittedBy || '—')),
    slot(h('span'), true, t('Pushed')), about(quiet(t('Change · version {n} · {state}', {n: change.version, state: STATE(change.state)}))));
}

/**
 * Merge, the last step, under the Review (not in it): its button at the
 * left, primary once the version is approved, and who approved it.
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
  return h('div', {class: 'steps merge-row'}, slot(merge, false, ''), about(quiet(by)), error);
}

/** A diff whose lines can be marked, as with a highlighter: `marked` shows, `pending` collects what is pressed now. */
function markedDiff(files: git.FileDiff[], marked: Set<string>, pending: Set<string> | null): HTMLElement[] {
  return files.map((f) => {
    const lines = f.binary ? [h('p', {class: 'muted small'}, t('Binary'))] : f.lines.map((l, k) => {
      if (l.kind === 'hunk') return k === 0 ? null : h('div', {class: 'diff-line hunk'}, l.text.replace(/^@@ [^@]* @@ ?/, '') || '…');
      const key = `${f.path}:${k}`;
      const row = h('div', {class: `diff-line ${l.kind}`, 'data-mark': key}, l.text || ' ');
      if (marked.has(key)) row.classList.add('marked');
      if (pending) {
        row.classList.add('markable');
        row.addEventListener('click', () => {
          if (marked.has(key)) return;
          if (pending.has(key)) pending.delete(key); else pending.add(key);
          row.classList.toggle('marking', pending.has(key));
        });
      }
      return row;
    }).filter(Boolean) as HTMLElement[];
    if (f.more) lines.push(h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', f.more)));
    return h('div', {class: 'hit-group'}, h('div', {class: 'hit-file'}, f.path), h('div', {class: 'diff'}, ...lines));
  });
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
  const said = h('div', {class: 'review-chat'}, ...change.reviews.slice().reverse().map((r) => h('div', {class: 'bubble'},
    h('span', {class: 'muted small'}, `${r.by} · ${ago(r.time)}${r.version !== change.version ? ` · ${t('version {n} (older)', {n: r.version})}` : ''}`),
    r.verdict === 'approve' ? h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), t('Approved'))
      : r.verdict === 'changes' ? h('span', {class: 'step-done'}, t('Asked for changes')) : null,
    r.note ? h('p', {class: 'bubble-text'}, r.note) : null)));
  const body: Node[] = [diff, ...(change.reviews.length ? [said] : [])];
  if (change.state === 'open') {
    // Under what was said, the procedure in its order: a comment more,
    // written in a roomy field and sent with the lines marked (Ctrl+Enter, or
    // Comment), then the verdict under it (Reject at the left, Approve at the
    // right). Merge follows under the box.
    const text = h('textarea', {class: 'line-in review-in', rows: '7', placeholder: t('Comment…'), 'aria-label': t('Comment'), maxlength: '4000'}) as HTMLTextAreaElement;
    const send = (verdict: git.Review['verdict'], b: HTMLButtonElement) => doing(b, error, async () => {
      if (verdict === 'comment' && !text.value.trim() && !pending!.size) return;
      await git.review(at, change, verdict, text.value, [...pending!]);
    }, after);
    const reject = button(t('Reject'));
    reject.title = t('Do not take it into main (its issue stays open)');
    reject.addEventListener('click', doing(reject, error, () => git.reject(at, change), after));
    // Approved, Approve's place holds the done mark.
    let approve: HTMLElement;
    if (current.some((r) => r.verdict === 'approve')) approve = h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), t('Approved'));
    else {
      const b = button(t('Approve'), true);
      b.addEventListener('click', send('approve', b));
      approve = b;
    }
    const comment = button(t('Comment'));
    comment.addEventListener('click', send('comment', comment));
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); comment.click(); } });
    body.push(text, h('div', {class: 'review-send'}, comment), h('div', {class: 'review-verdict'}, reject, h('span', {class: 'grow'}), approve));
  }
  body.push(error);
  return h('section', {class: 'review-box', 'aria-label': t('Review')},
    h('header', {class: 'stage-head'}, h('h3', {}, t('Review'))),
    ...body);
}
