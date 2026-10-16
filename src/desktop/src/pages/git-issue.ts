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
//   Start (Continue here)  →  Commit  →  Push  →  Change  →  Merge or Reject
//
// with Reset (take the change back) while it is undecided, and Back to main.
// Under the box, plainly, its Diff, Review and Reply, each shown only when it
// has something.

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
  if (c) return t('Change · version {n} · {state}', {n: c.version, state: STATE(c.state)});
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
  const acts: Node[] = [];
  if (connection() && !here && changeOf(s, issue)?.state !== 'open') {
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
    ...(here && s?.work ? [steps(issue, s, events, after)] : []),
    acts.length ? h('div', {class: 'row work-act'}, ...acts) : null, error);
}

/**
 * Commit and Push, inside the issue's box: each its button at the left (a
 * done mark in its place once done) and, beside it, what it is about: what
 * is not committed (its diff closed until opened), what is to be pushed.
 * Pushing hands the work to main as its change, again as the next version.
 */
function steps(issue: Issue, s: RepoState, events: IssueEvents, after: () => void): HTMLElement {
  const at = issue.repo;
  const w = s.work!;
  const error = h('p', {class: 'error', role: 'alert'});
  // Done, the button's place holds the done mark and the step's word.
  const slot = (act: HTMLElement, done: boolean, word: string) => h('div', {class: 'step-act'},
    done ? h('span', {class: 'step-done'}, h('span', {class: 'done-mark', 'aria-hidden': 'true'}), word) : act);

  // Commit
  const dirty = s.uncommitted;
  const commit = button(t('Commit'), dirty > 0);
  commit.disabled = !dirty;
  commit.title = named(issue.kind, issue.title);
  commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', ''), after));
  let about: Node;
  if (dirty) {
    const inside = h('div', {}, h('p', {class: 'muted small'}, t('Reading…')));
    const fold = h('details', {class: 'stage-diff'}, h('summary', {}, tn('{n} file not committed', '{n} files not committed', dirty)), inside) as HTMLDetailsElement;
    let read = false;
    fold.addEventListener('toggle', () => {
      if (!fold.open || read) return;
      read = true;
      void git.diff(at).then((files) => inside.replaceChildren(...diffFiles(files, (p) => events.open(at, p))), (e) => inside.replaceChildren(h('p', {class: 'error'}, message(e))));
    });
    about = fold;
  } else {
    about = h('p', {class: 'muted small'}, w.commits ? tn('{n} commit', '{n} commits', w.commits) : t('Edit in File, Forge or the Prompt; what changes shows here.'));
  }
  const committed = !dirty && w.commits > 0;

  // Push
  const open = w.change?.state === 'open';
  const pushed = w.commits > 0 && !w.unpushed && (open || w.change?.state === 'merged');
  const push = button(t('Push'), !dirty && !pushed && w.commits > 0);
  push.disabled = !w.commits || pushed;
  push.addEventListener('click', doing(push, error, async () => { await git.push(at); await git.submit(at); }, after));
  const where = pushed
    ? h('p', {class: 'muted small'}, t('Change · version {n} · {state}', {n: w.change!.version, state: STATE(w.change!.state)}))
    : h('p', {class: 'muted small'}, w.unpushed ? tn('{n} commit to push', '{n} commits to push', w.unpushed) : '');

  return h('div', {class: 'steps'},
    slot(commit, committed, t('Committed')), h('div', {class: 'step-about'}, about),
    slot(push, pushed, t('Pushed')), h('div', {class: 'step-about'}, where), error);
}

/** A step of the work as a box of the issue's width: its name, a check once it is done, its body, its one action at the bottom right. */
function stage(title: string, done: boolean, body: Node[], act: Node[] = [], extra = ''): HTMLElement {
  return h('section', {class: `stage-box ${extra}`.trim(), 'data-done': String(done)},
    h('header', {class: 'stage-head'}, h('h3', {}, title), done ? h('span', {class: 'done-mark', role: 'img', 'aria-label': t('Done')}) : null),
    ...body,
    act.length ? h('div', {class: 'stage-act'}, ...act) : null);
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
 * Under the box, once there is a change: its Review, a larger box whose diff
 * can be marked, with what was said under it and room to say more. A change
 * is reviewed the same way without being worked on here.
 */
export function issueStages(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): Node[] {
  const at = issue.repo;
  const change = changeOf(s, issue);
  const here = hereOf(s, issue);
  const out: Node[] = [];
  if (!connection()) return out;

  if (!change || change.state === 'reset') return out;

  // Review: the change's diff, marked where reviewers marked it, what was said, and room to say more.
  const error = h('p', {class: 'error', role: 'alert'});
  const current = change.reviews.filter((r) => r.version === change.version);
  const marked = new Set(current.flatMap((r) => r.marks ?? []));
  const pending = change.state === 'open' ? new Set<string>() : null;
  const diff = h('div', {class: 'review-diff'}, h('p', {class: 'muted small'}, t('Reading…')));
  void git.changeDiff(at, change).then((files) => diff.replaceChildren(...markedDiff(files, marked, pending)), (e) => diff.replaceChildren(h('p', {class: 'error'}, message(e))));
  // What was said, in order: a verdict with its note, or a comment alone.
  const said = change.reviews.slice().reverse().map((r) => h('div', {class: 'said'},
    h('span', {class: 'muted small'}, `${r.by} · ${ago(r.time)}${r.version !== change.version ? ` · ${t('version {n} (older)', {n: r.version})}` : ''}`),
    r.verdict !== 'comment' ? h('b', {}, r.verdict === 'approve' ? t('Approved') : t('Asked for changes')) : null,
    r.note ? h('p', {class: 'bubble-text'}, r.note) : null));
  const acts: Node[] = [];
  const body: Node[] = [diff, ...said];
  if (change.state === 'open') {
    const text = h('textarea', {class: 'line-in bubble-in', rows: '2', placeholder: t('Comment… (Enter sends)'), 'aria-label': t('Comment'), maxlength: '4000'}) as HTMLTextAreaElement;
    const send = (verdict: git.Review['verdict'], b: HTMLButtonElement) => doing(b, error, async () => {
      if (verdict === 'comment' && !text.value.trim() && !pending!.size) return;
      await git.review(at, change, verdict, text.value, [...pending!]);
    }, after);
    const comment = button(t('Comment'));
    comment.addEventListener('click', send('comment', comment));
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); comment.click(); } });
    body.push(text);
    const approved = current.some((r) => r.verdict === 'approve');
    const reset = button(t('Reset'));
    reset.title = t('Take back the change');
    reset.addEventListener('click', doing(reset, error, () => git.reset(at), after));
    const reject = button(t('Reject'));
    reject.title = t('Do not take it into main (its issue stays open)');
    reject.addEventListener('click', doing(reject, error, () => git.reject(at, change), after));
    const changes = button(t('Ask for changes'));
    changes.addEventListener('click', send('changes', changes));
    if (here) acts.push(reset);
    acts.push(reject, h('span', {class: 'grow'}), comment, changes);
    if (approved) {
      // Merged, the work is done: the repo shows main again.
      const merge = button(t('Merge'), true);
      merge.addEventListener('click', doing(merge, error, async () => { await git.merge(at, change); if (here) await git.switchWork(at, 'main'); events.moved(at); }, after));
      acts.push(merge);
    } else {
      const approve = button(t('Approve'), true);
      approve.addEventListener('click', send('approve', approve));
      acts.push(approve);
    }
  }
  body.push(error);
  out.push(stage(t('Review'), change.state === 'merged', body, acts, 'review'));
  return out;
}
