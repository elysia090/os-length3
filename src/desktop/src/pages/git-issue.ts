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
const VERDICT = (v: git.Review['verdict']) => ({approve: t('approved'), changes: t('asked for changes'), comment: t('replied')})[v];

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
  if (hereOf(s, issue) && w) {
    const parts = [t('{who} · started {when}', {who: w.started_by || '—', when: ago(w.started_at)})];
    if (s!.uncommitted) parts.push(tn('{n} file not committed', '{n} files not committed', s!.uncommitted));
    parts.push(tn('{n} commit', '{n} commits', w.commits));
    if (w.unpushed) parts.push(tn('{n} not pushed', '{n} not pushed', w.unpushed));
    if (c) parts.push(t('Change · version {n} · {state}', {n: c.version, state: STATE(c.state)}));
    return parts.join(' · ');
  }
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

/** The box: the issue's words, where it stands, and what can be done next. */
export function issueBox(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): HTMLElement {
  const at = issue.repo;
  const path = `issue/${issue.file}`;
  const error = h('p', {class: 'error', role: 'alert'});
  const w = s?.work ?? null;
  const line = s?.lines.find((l) => l.issue === path) ?? null;
  const change = changeOf(s, issue);
  const here = hereOf(s, issue);
  const dirty = (s?.uncommitted ?? 0) > 0;
  const acts: Node[] = [];
  let field: HTMLInputElement | null = null;
  if (connection()) {
    if (!here) {
      const go = button(line ? t('Continue here') : t('Start'), true);
      go.addEventListener('click', doing(go, error, async () => {
        if (line) await git.switchWork(at, line.line); else await git.startWork(at, issue.file);
        events.moved(at);
      }, after));
      acts.push(go);
    } else if (w) {
      // The next step of the work is the one primary action.
      const open = w.change?.state === 'open';
      const next = dirty ? 'commit' : w.unpushed ? 'push' : w.commits && !open && w.change?.state !== 'merged' ? 'change' : null;
      if (next === 'commit') {
        field = h('input', {class: 'line-in', placeholder: t('Note'), 'aria-label': t('The commit\'s note'), maxlength: '400'}) as HTMLInputElement;
        const commit = button(t('Commit'), true);
        commit.title = named(issue.kind, issue.title);
        commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', field!.value), after));
        field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) commit.click(); });
        acts.push(field, commit);
      } else if (next === 'push') {
        const push = button(t('Push'), true);
        push.addEventListener('click', doing(push, error, () => git.push(at), after));
        acts.push(push);
      } else if (next === 'change') {
        const hand = button(t('Change'), true);
        hand.title = w.change ? t('Hand in what was pushed as the next version') : t('Hand in what was pushed to main');
        hand.addEventListener('click', doing(hand, error, () => git.submit(at), after));
        acts.push(hand);
      }
      if (open) {
        const reset = button(t('Reset'));
        reset.title = t('Take back the change');
        reset.addEventListener('click', doing(reset, error, () => git.reset(at), after));
        acts.push(reset);
      }
    }
    // The receiver's side: an undecided change is taken into main, or not.
    if (change?.state === 'open') {
      const quiet = acts.some((a) => (a as HTMLElement).classList?.contains('primary'));
      const merge = button(t('Merge'), !quiet);
      // Merged, the work is done: the repo shows main again.
      merge.addEventListener('click', doing(merge, error, async () => { await git.merge(at, change); if (here) await git.switchWork(at, 'main'); events.moved(at); }, after));
      const reject = button(t('Reject'));
      reject.title = t('Do not take it into main (its issue stays open)');
      reject.addEventListener('click', doing(reject, error, () => git.reject(at, change), after));
      acts.push(merge, reject);
    }
    if (here) {
      const leave = button(t('Back to main'));
      leave.addEventListener('click', doing(leave, error, async () => { await git.switchWork(at, 'main'); events.moved(at); }, after));
      acts.push(h('span', {class: 'grow'}), leave);
    }
  }
  const say = connection() ? standing(s, issue) : t('History and work are kept on the Remote. Sign in to it to work on an issue and commit.');
  return h('div', {class: 'issue-box'},
    issueHead(issue, events),
    issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null,
    say ? h('p', {class: 'muted small'}, say) : null,
    acts.length ? h('div', {class: `row work-act${field ? ' with-field' : ''}`}, ...acts) : null, error);
}

/** Under the box, plainly: its Diff, Review and Reply, each only when it has something. */
export function issueBelow(issue: Issue, s: RepoState | undefined, events: IssueEvents, after: () => void): Node[] {
  const at = issue.repo;
  const change = changeOf(s, issue);
  const here = hereOf(s, issue);
  const section = (title: string, n: number, ...body: Node[]) =>
    h('section', {class: 'section'}, h('h2', {}, h('span', {}, title, n ? h('small', {}, `${n}`) : null)), ...body);
  const into = (holder: HTMLElement, files: Promise<git.FileDiff[]>, open?: (p: string) => void) =>
    void files.then((list) => { holder.replaceChildren(...diffFiles(list, open)); if (!list.length) holder.closest('section')?.remove(); },
      (e) => holder.replaceChildren(h('p', {class: 'error'}, message(e))));
  const out: Node[] = [];

  // Diff: what is not committed yet (while worked on here), else the change as handed in.
  if (here && (s?.uncommitted ?? 0) > 0) {
    const holder = h('div', {}, h('p', {class: 'muted small'}, t('Reading…')));
    out.push(section(t('Diff'), s!.uncommitted, holder));
    into(holder, git.diff(at), (p) => events.open(at, p));
  } else if (change) {
    const holder = h('div', {}, h('p', {class: 'muted small'}, t('Reading…')));
    out.push(section(t('Diff'), change.files, holder));
    into(holder, git.changeDiff(at, change));
  }
  if (!change) return out;

  // Review: a verdict on one version.
  const reviews = change.reviews.filter((r) => r.verdict !== 'comment');
  const error = h('p', {class: 'error', role: 'alert'});
  const rows = reviews.map((r) => h('div', {class: 'row-item'},
    h('span', {class: 'row-name'}, `${r.by} ${VERDICT(r.verdict)}${r.note ? `: ${r.note}` : ''}`),
    h('span', {class: 'row-meta'}, r.version === change.version ? t('version {n}', {n: r.version}) : t('version {n} (older)', {n: r.version})),
    h('span', {class: 'row-meta'}, ago(r.time))));
  const body: Node[] = rows.length ? [h('div', {class: 'rows'}, ...rows)] : [];
  if (change.state === 'open') {
    const note = h('input', {class: 'line-in', placeholder: t('Note'), 'aria-label': t('The review\'s note')}) as HTMLInputElement;
    const yes = button(t('Approve'), true), no = button(t('Ask for changes'));
    yes.addEventListener('click', doing(yes, error, () => git.review(at, change, 'approve', note.value), after));
    no.addEventListener('click', doing(no, error, () => git.review(at, change, 'changes', note.value), after));
    body.push(h('div', {class: 'row work-act with-field'}, note, yes, no), error);
  }
  if (body.length) out.push(section(t('Review'), reviews.length, ...body));

  // Reply: talk under the change, in order.
  const replies = change.reviews.filter((r) => r.verdict === 'comment').slice().reverse();
  const text = h('textarea', {class: 'line-in bubble-in', rows: '1', placeholder: t('Reply…'), 'aria-label': t('Reply'), maxlength: '4000'}) as HTMLTextAreaElement;
  const send = button(t('Reply'));
  const failed = h('p', {class: 'error', role: 'alert'});
  const go = doing(send, failed, async () => { if (text.value.trim()) await git.review(at, change, 'comment', text.value); }, after);
  send.addEventListener('click', () => void go());
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void go(); } });
  out.push(section(t('Reply'), replies.length,
    ...(replies.length ? [h('div', {class: 'reply-list'}, ...replies.map((r) => h('div', {class: 'bubble'},
      h('span', {class: 'muted small'}, `${r.by} · ${ago(r.time)} · ${t('version {n}', {n: r.version})}`), h('p', {class: 'bubble-text'}, r.note))))] : []),
    h('div', {class: 'row write-line'}, text, send), failed));
  return out;
}
