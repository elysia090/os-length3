import {ago, h} from '../dom.ts';
import * as git from '../history.ts';
import {t, tn} from '../i18n.ts';
import type {Issue} from '../issues.ts';
import {connection} from '../remote.ts';
import {named} from '../text.ts';

// An issue opened on the Git page, large: everything about it in one place
// (issue #17). Its branch and worktree are never named: Start gives the issue
// its own copy of the repo, which File, Forge and the Prompt then show, and
// the operations are the issue's own:
//
//   Start / Continue here   take up the issue in its own copy
//   Commit                  what is not committed becomes a commit, named by the issue
//   Push                    the commits go to the Remote
//   Change                  what was pushed is handed to main (again: its next version)
//   Reset                   take the change back
//   Back to main            the repo shows main again
//
// Under them: what is not committed, the issue's commits, and its change with
// its reviews. The receiver reviews a change and settles it by Merge or Reject.

export interface IssueEvents {
  open(repo: string, path: string): void;
  /** Show a change in the right pane: its name, what can be done, its diff. */
  review(head: Node, actions: Node[], files: Promise<git.FileDiff[]>, folder?: string | null): void;
  /** The repo now shows another copy (or main moved): the shell reads it again. */
  moved(repo: string): void;
  /** Back to the list of issues. */
  close(): void;
}

const counts = (added: number, removed: number) => `+${added} −${removed}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const folderName = (repo: string, f: string) => (f ? `${f}/` : `${repo}/`);


export function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

export const STATE = (s: git.Change['state']) => ({open: t('Undecided'), merged: t('Merged'), rejected: t('Rejected'), reset: t('Taken back')})[s];
const VERDICT = (v: git.Review['verdict']) => ({approve: t('approved'), changes: t('asked for changes'), comment: t('commented')})[v];

/** Run `f` with `b` held down, then `after`; a failure is said in `error`. */
export const doing = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>, after: () => void) => async () => {
  b.disabled = true;
  error.textContent = '';
  try { await f(); after(); } catch (e) { error.textContent = message(e); b.disabled = false; }
};

export const cutRows = (at: string, list: git.Cut[], withRepo = false) => h('div', {class: 'rows'}, ...list.map((c) =>
  h('div', {class: 'row-item', title: c.id},
    h('span', {class: 'row-name'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
    h('span', {class: 'row-meta'}, withRepo ? at : c.merged ? t('merge') : c.folders.map((f) => folderName(at, f)).join(' ')),
    h('span', {class: 'row-meta'}, ago(c.time)))));

/** One change: what, where it reaches, its reviews, and what the receiver can do. */
export function changeItem(at: string, c: git.Change, events: Pick<IssueEvents, 'review' | 'moved'>, after: () => void, withRepo = false): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const name = named(c.kind || null, c.title);
  const latest = c.reviews.find((r) => r.version === c.version);
  const older = c.reviews.find((r) => r.version !== c.version);
  const reviewing = (folder: string | null = null) => {
    const note = h('input', {class: 'line-in', placeholder: t('Note'), 'aria-label': t('The review\'s note')}) as HTMLInputElement;
    const verdicts = (['approve', 'changes', 'comment'] as const).map((v) => {
      const b = button(v === 'approve' ? t('Approve') : v === 'changes' ? t('Ask for changes') : t('Comment'), v === 'approve' ? 'small-button primary' : 'small-button');
      b.addEventListener('click', doing(b, error, () => git.review(at, c, v, note.value), after));
      return b;
    });
    events.review(
      h('div', {}, h('h3', {}, name), h('p', {class: 'issue-where muted'}, t('{repo} · version {n} · {who}', {repo: at, n: c.version, who: c.submittedBy || '—'}))),
      c.state === 'open' ? [h('div', {class: 'row'}, note), h('div', {class: 'row'}, ...verdicts), error] : [h('p', {class: 'muted'}, STATE(c.state))],
      git.changeDiff(at, c), folder);
  };
  const actions: Node[] = [];
  const review = button(t('Review'), 'small-button');
  review.addEventListener('click', () => reviewing());
  actions.push(review);
  if (c.state === 'open') {
    const merge = button(t('Merge'), 'small-button');
    merge.addEventListener('click', doing(merge, error, async () => { await git.merge(at, c); events.moved(at); }, after));
    const reject = button(t('Reject'), 'small-button');
    reject.title = t('Do not take it into main (its issue stays open)');
    reject.addEventListener('click', doing(reject, error, () => git.reject(at, c), after));
    actions.push(merge, reject);
  }
  return h('div', {class: 'handed', 'data-state': c.state},
    h('div', {class: 'row-item'},
      h('span', {class: 'row-name'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
      h('span', {class: 'state-chip'}, STATE(c.state))),
    h('div', {class: 'row-item muted small'},
      h('span', {class: 'row-name'}, `${withRepo ? `${at} · ` : ''}${t('version {n} · {who} · {when} · {files}', {n: c.version, who: c.submittedBy || '—', when: ago(c.updatedAt), files: tn('{n} file', '{n} files', c.files)})}`)),
    // Where it reaches, folder by folder: a reviewer enters from the area they look after.
    ...c.folders.map((f) => {
      const b = h('button', {type: 'button', class: 'row-item', style: '--depth:1'}, h('span', {class: 'mono row-name'}, folderName(at, f)));
      b.addEventListener('click', () => reviewing(f));
      return b;
    }),
    latest || older ? h('div', {class: 'row-item muted small', style: '--depth:1'}, h('span', {class: 'row-name'}, [
      latest ? `${latest.by} ${VERDICT(latest.verdict)}${latest.note ? `: ${latest.note}` : ''}` : '',
      !latest && older ? t('{who} {verdict} version {n}; version {m} is newer', {who: older.by, verdict: VERDICT(older.verdict), n: older.version, m: c.version}) : '',
    ].join(''))) : null,
    h('div', {class: 'row work-act'}, ...actions), error);
}

export interface IssueView {
  element: HTMLElement;
  /** Read again: something in the repo changed. */
  refresh(): void;
}

export function issueView(issue: Issue, events: IssueEvents): IssueView {
  const at = issue.repo;
  const path = `issue/${issue.file}`;
  const back = h('button', {type: 'button', class: 'link back-link'}, t('← Issues'));
  back.addEventListener('click', () => events.close());
  const edit = button(t('Edit'), 'small-button');
  edit.addEventListener('click', () => events.open(at, path));
  const state = h('div', {class: 'issue-state'}, h('p', {class: 'muted'}, t('Reading…')));
  const element = h('article', {class: 'issue-big', 'aria-label': named(issue.kind, issue.title)},
    h('div', {class: 'row'}, back),
    h('header', {class: 'issue-big-head'},
      h('h2', {}, issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title),
      h('div', {class: 'row'}, h('span', {class: 'issue-where muted'}, `${at} · ${path}`), h('span', {class: 'grow'}), edit)),
    issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null,
    state);
  let run = 0;
  let timer = 0;

  const sub = (title: string, n: number | string, ...body: Node[]) =>
    h('section', {class: 'sub-part'}, h('h3', {}, title, n ? h('small', {}, `${n}`) : null), ...body);

  /** What can be done with the issue now, by where the repo stands. */
  const controls = (w: git.Work, line: git.Line | null, c: git.Changes, error: HTMLElement): Node[] => {
    const after = () => paint();
    if (!connection()) return [h('p', {class: 'muted'}, t('History and work are kept on the Remote. Sign in to it to work on an issue and commit.'))];
    const here = w.line !== 'main' && w.issue === path;
    if (!here) {
      const go = button(line ? t('Continue here') : t('Start'), 'primary');
      go.addEventListener('click', doing(go, error, async () => {
        if (line) await git.switchWork(at, line.line); else await git.startWork(at, issue.file);
        events.moved(at);
      }, after));
      return [h('div', {class: 'work-card'},
        h('p', {}, line
          ? t('{who} started it {when}. Continue here to see its copy of {repo}.', {who: line.startedBy || '—', when: ago(line.startedAt), repo: at})
          : t('It gets its own copy of {repo}. File, Forge and the Prompt show that copy while you work; main stays as it is until the change is merged.', {repo: at})),
        w.line !== 'main' ? h('p', {class: 'muted small'}, t('{repo} shows the work on {issue} now.', {repo: at, issue: w.issue ?? w.line})) : null,
        h('div', {class: 'row work-act'}, go)), error];
    }
    const note = h('input', {class: 'line-in', placeholder: t('Note'), 'aria-label': t('The commit\'s note'), maxlength: '400'}) as HTMLInputElement;
    const commit = button(t('Commit'), c.files ? 'primary' : '');
    commit.disabled = !c.files;
    commit.title = named(issue.kind, issue.title);
    commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', note.value), after));
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !commit.disabled) commit.click(); });
    const push = button(t('Push'), !c.files && w.unpushed ? 'primary' : '');
    push.disabled = !w.unpushed;
    push.addEventListener('click', doing(push, error, () => git.push(at), after));
    const open = w.change?.state === 'open';
    const change = button(t('Change'), !c.files && !w.unpushed && w.commits && !open ? 'primary' : '');
    change.title = w.change && w.change.state !== 'merged' ? t('Hand in what was pushed as the next version') : t('Hand in what was pushed to main');
    // What is handed in is what was pushed: something committed, nothing unpushed, not merged already.
    change.disabled = !w.commits || w.unpushed > 0 || w.change?.state === 'merged';
    change.addEventListener('click', doing(change, error, () => git.submit(at), after));
    const reset = button(t('Reset'));
    reset.hidden = !open;
    reset.title = t('Take back the change');
    reset.addEventListener('click', doing(reset, error, () => git.reset(at), after));
    const leave = button(t('Back to main'));
    leave.addEventListener('click', doing(leave, error, async () => { await git.switchWork(at, 'main'); events.moved(at); }, after));
    const where = w.change
      ? t('Change · version {n} · {state}', {n: w.change.version, state: STATE(w.change.state)})
      : t('No change yet');
    return [h('div', {class: 'work-card', 'aria-current': 'true'},
      h('p', {class: 'muted small'}, `${t('{who} · started {when}', {who: w.started_by || '—', when: ago(w.started_at)})} · ${tn('{n} commit', '{n} commits', w.commits)} · ${tn('{n} not pushed', '{n} not pushed', w.unpushed)} · ${where}`),
      h('div', {class: 'row work-act'}, note, commit),
      h('div', {class: 'row work-act'}, push, change, reset, h('span', {class: 'grow'}), leave)), error];
  };

  const changeRows = (c: git.Changes) => h('div', {class: 'rows'}, ...c.folders.flatMap((f) => [
    h('div', {class: 'row-item row-head'}, h('span', {class: 'mono row-name'}, folderName(at, f.folder))),
    ...f.files.map((x) => {
      const b = h('button', {type: 'button', class: 'row-item', style: '--depth:1'},
        h('span', {class: 'row-word'}, git.statusWord(x.status)),
        h('span', {class: 'mono row-name'}, f.folder ? x.path.slice(f.folder.length + 1) : x.path),
        h('span', {class: 'row-meta'}, x.binary ? t('Binary') : counts(x.added, x.removed))) as HTMLButtonElement;
      if (x.status !== 'removed') b.addEventListener('click', () => events.open(at, x.path));
      else b.disabled = true;
      return b;
    }),
  ]));

  const paint = () => {
    const mine = ++run;
    const connected = connection() !== null;
    const none: git.Work = {line: 'main', issue: null, started_by: '', started_at: 0, commits: 0, unpushed: 0, change: null};
    void Promise.all([
      git.changes(at),
      connected ? git.work(at).catch(() => none) : Promise.resolve(none),
      connected ? git.lines(at).catch(() => [] as git.Line[]) : Promise.resolve([] as git.Line[]),
      connected ? git.changesOf(at).catch(() => [] as git.Change[]) : Promise.resolve([] as git.Change[]),
    ]).then(async ([c, w, lines, handed]) => {
      const line = lines.find((l) => l.issue === path) ?? null;
      const here = w.line !== 'main' && w.issue === path;
      // Its commits: the work's own while it is shown here, else what main took from it.
      const cuts = !connected ? [] : here ? await git.log(at).catch(() => []) : (await git.logOf(at, 'main').catch(() => [] as git.Cut[])).filter((x) => x.issue === path);
      const mineOnly = here && line ? cuts.slice(0, Math.max(0, w.commits)) : cuts;
      const changes = handed.filter((x) => x.issue === path);
      if (mine !== run) return;
      const error = h('p', {class: 'error', role: 'alert'});
      state.replaceChildren(...controls(w, line, c, error),
        ...(here && c.files ? [sub(t('Not committed'), c.files, changeRows(c))] : []),
        ...(mineOnly.length ? [sub(t('Commits'), mineOnly.length, cutRows(at, mineOnly))] : []),
        ...(changes.length ? [sub(t('Change'), '', ...changes.map((x) => changeItem(at, x, events, () => paint())))] : []));
    }, (e) => { if (mine === run) state.replaceChildren(h('p', {class: 'error'}, message(e))); });
  };
  paint();
  return {element, refresh() { clearTimeout(timer); timer = window.setTimeout(paint, 250); }};
}

/** A badge for an issue in the list: being worked on here, started, or its change's state. */
export function issueBadge(path: string, w: git.Work | null, lines: git.Line[], changes: git.Change[]): string {
  const c = changes.find((x) => x.issue === path);
  if (c) return `${t('Change')} · ${STATE(c.state)}`;
  if (w && w.line !== 'main' && w.issue === path) return t('Working here');
  if (lines.some((l) => l.issue === path)) return t('Started');
  return '';
}


