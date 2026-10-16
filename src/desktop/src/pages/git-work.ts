import {ago, h} from '../dom.ts';
import * as git from '../history.ts';
import {t, tn} from '../i18n.ts';
import {parseIssue, type Issue} from '../issues.ts';
import {connection} from '../remote.ts';
import {store} from '../repos.ts';
import {named} from '../text.ts';

// The sections under the issues on the Git page, for one repo at a time
// (issue #17). The branch and worktree of an issue are never named: choosing
// to work on an issue gives it its own copy of the repo, which File, Forge
// and the Prompt show while you work on it.
//
//   Work            the issue's work, or main: who started it and when, and
//                   the few operations: Commit, Push, Submit change (again
//                   after more commits), Reset (take it back), Back to main
//   Not committed   the work's draft against its last commit, by folder
//   Commits         the work's history
//   Changes handed in  each change to main by kind and title, the folders it
//                   reaches, its version and reviews; Review, Merge, Reject
//
// A section with nothing in it is not shown; counts are bare numbers.

export interface GitWork {
  sections: HTMLElement[];
  /** Look at `repo`, with `issue` chosen when one is. */
  show(repo: string | null, issue: Issue | null): void;
  /** Read again: something in the repo changed. */
  refresh(): void;
}

export interface GitWorkEvents {
  open(repo: string, path: string): void;
  /** Show a change in the right pane: its name, what can be done, its diff. */
  review(head: Node, actions: Node[], files: Promise<git.FileDiff[]>, folder?: string | null): void;
  /** The repo now shows another work's copy: the shell reads it again. */
  moved(repo: string): void;
}

const counts = (added: number, removed: number) => `+${added} −${removed}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const folderName = (repo: string, f: string) => (f ? `${f}/` : `${repo}/`);

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

const STATE = (s: git.Change['state']) => ({open: t('Undecided'), merged: t('Merged'), rejected: t('Rejected'), reset: t('Taken back')})[s];
const VERDICT = (v: git.Review['verdict']) => ({approve: t('approved'), changes: t('asked for changes'), comment: t('commented')})[v];

export function gitWork(events: GitWorkEvents): GitWork {
  const section = (id: string, title: string) => {
    const small = h('small', {});
    const body = h('div', {});
    const el = h('section', {class: 'section', 'aria-labelledby': id, hidden: ''}, h('h2', {id}, h('span', {}, title, small)), body);
    return {el, small, body};
  };
  const workS = section('work-title', t('Work'));
  const changesS = section('changes-title', t('Not committed'));
  const cutsS = section('cuts-title', t('Commits'));
  const handedS = section('handed-title', t('Changes handed in'));
  let repo: string | null = null;
  let issue: Issue | null = null;
  let run = 0;
  let timer = 0;

  /** Run `f` with `b` held down; a failure is said under the work. */
  const doing = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<unknown>) => async () => {
    b.disabled = true;
    error.textContent = '';
    try { await f(); paint(); } catch (e) { error.textContent = message(e); b.disabled = false; }
  };

  const changeRows = (at: string, c: git.Changes) => h('div', {class: 'rows'}, ...c.folders.flatMap((f) => [
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

  const cutRows = (at: string, list: git.Cut[]) => h('div', {class: 'rows'}, ...list.map((c) =>
    h('div', {class: 'row-item', title: c.id},
      h('span', {class: 'row-name'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
      h('span', {class: 'row-meta'}, c.merged ? t('merge') : c.folders.map((f) => folderName(at, f)).join(' ')),
      h('span', {class: 'row-meta'}, ago(c.time)))));

  /** The work card: where the repo stands, and what can be done next. */
  const workCard = (at: string, w: git.Work, c: git.Changes, own: Issue | null): Node[] => {
    const error = h('p', {class: 'error', role: 'alert'});
    const chosen = issue ? `issue/${issue.file}` : null;
    const onIt = w.line !== 'main' && (!chosen || w.issue === chosen);
    if (!connection()) return [h('p', {class: 'muted note'}, t('History and work are kept on the Remote. Sign in to it to work on an issue and commit.'))];
    if (chosen && !onIt) {
      const go = button(t('Work on this issue'), 'primary');
      go.addEventListener('click', doing(go, error, async () => { await git.startWork(at, issue!.file); events.moved(at); }));
      return [h('div', {class: 'work-card'},
        h('p', {}, t('It gets its own copy of {repo}. File, Forge and the Prompt show that copy while you work; main stays as it is until the change is merged.', {repo: at})),
        w.line !== 'main' ? h('p', {class: 'muted small'}, t('{repo} shows the work on {issue} now.', {repo: at, issue: w.issue ?? w.line})) : null,
        h('div', {class: 'row work-act'}, go)), error];
    }
    if (!onIt) {
      // main: commits name themselves; work on an issue is chosen above.
      const line = h('input', {class: 'line-in', placeholder: t('Kind：title'), 'aria-label': t('The commit\'s title'), maxlength: '200'}) as HTMLInputElement;
      const commit = button(t('Commit'), 'primary');
      commit.disabled = !c.files;
      commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, line.value, '')));
      return [h('div', {class: 'work-card'},
        h('div', {class: 'work-head'}, h('b', {}, 'main'), h('span', {class: 'muted'}, t('Choose an issue above to work on it in its own copy.'))),
        h('div', {class: 'row work-act'}, line, commit)), error];
    }
    const note = h('input', {class: 'line-in', placeholder: t('Note'), 'aria-label': t('The commit\'s note'), maxlength: '400'}) as HTMLInputElement;
    const commit = button(t('Commit'), c.files ? 'primary' : '');
    commit.disabled = !c.files;
    commit.title = issue ? named(issue.kind, issue.title) : '';
    commit.addEventListener('click', doing(commit, error, () => git.cut(at, null, '', note.value)));
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !commit.disabled) commit.click(); });
    const push = button(t('Push'), !c.files && w.unpushed ? 'primary' : '');
    push.disabled = !w.unpushed;
    push.addEventListener('click', doing(push, error, () => git.push(at)));
    const open = w.change?.state === 'open';
    const submit = button(w.change && w.change.state !== 'merged' ? t('Submit change again') : t('Submit change'), !c.files && !w.unpushed && w.commits ? 'primary' : '');
    // What is handed in is what was pushed: something committed, nothing unpushed, not merged already.
    submit.disabled = !w.commits || w.unpushed > 0 || w.change?.state === 'merged';
    submit.addEventListener('click', doing(submit, error, () => git.submit(at)));
    const reset = button(t('Reset'));
    reset.hidden = !open;
    reset.title = t('Take back the change you submitted');
    reset.addEventListener('click', doing(reset, error, () => git.reset(at)));
    const back = button(t('Back to main'));
    back.addEventListener('click', doing(back, error, async () => { await git.switchWork(at, 'main'); events.moved(at); }));
    const state = w.change
      ? t('Submitted · version {n} · {state}', {n: w.change.version, state: STATE(w.change.state)})
      : t('Not submitted');
    return [h('div', {class: 'work-card', 'aria-current': 'true'},
      h('div', {class: 'work-head'}, h('b', {}, issue ? named(issue.kind, issue.title) : own ? named(own.kind, own.title) : w.issue ?? w.line),
        h('span', {class: 'muted'}, t('{who} · started {when}', {who: w.started_by || '—', when: ago(w.started_at)}))),
      h('p', {class: 'muted small'}, `${tn('{n} commit', '{n} commits', w.commits)} · ${tn('{n} not pushed', '{n} not pushed', w.unpushed)} · ${state}`),
      h('div', {class: 'row work-act'}, note, commit),
      h('div', {class: 'row work-act'}, push, submit, reset, h('span', {class: 'grow'}), back)), error];
  };

  /** One change handed in: what, where it reaches, its reviews, and what the receiver can do. */
  const handedRow = (at: string, c: git.Change) => {
    const error = h('p', {class: 'error', role: 'alert'});
    const name = named(c.kind || null, c.title);
    const latest = c.reviews.find((r) => r.version === c.version);
    const older = c.reviews.find((r) => r.version !== c.version);
    const diff = () => git.changeDiff(at, c);
    const reviewing = (folder: string | null = null) => {
      const note = h('input', {class: 'line-in', placeholder: t('Note'), 'aria-label': t('The review\'s note')}) as HTMLInputElement;
      const verdicts = (['approve', 'changes', 'comment'] as const).map((v) => {
        const b = button(v === 'approve' ? t('Approve') : v === 'changes' ? t('Ask for changes') : t('Comment'), v === 'approve' ? 'small-button primary' : 'small-button');
        b.addEventListener('click', doing(b, error, () => git.review(at, c, v, note.value)));
        return b;
      });
      events.review(
        h('div', {}, h('h3', {}, name), h('p', {class: 'issue-where muted'}, t('{repo} · version {n} · {who}', {repo: at, n: c.version, who: c.submittedBy || '—'}))),
        c.state === 'open' ? [h('div', {class: 'row'}, note), h('div', {class: 'row'}, ...verdicts), error] : [h('p', {class: 'muted'}, STATE(c.state))],
        diff(), folder);
    };
    const actions: Node[] = [];
    if (c.state === 'open') {
      const review = button(t('Review'), 'small-button');
      review.addEventListener('click', () => reviewing());
      const merge = button(t('Merge'), 'small-button');
      merge.addEventListener('click', doing(merge, error, async () => { await git.merge(at, c); events.moved(at); }));
      const reject = button(t('Reject'), 'small-button');
      reject.title = t('Do not take it into main (its issue stays open)');
      reject.addEventListener('click', doing(reject, error, () => git.reject(at, c)));
      actions.push(review, merge, reject);
    }
    return h('div', {class: 'handed', 'data-state': c.state},
      h('div', {class: 'row-item'},
        h('span', {class: 'row-name'}, c.kind ? h('span', {class: 'issue-kind'}, `${c.kind}：`) : null, c.title),
        h('span', {class: 'state-chip'}, STATE(c.state))),
      h('div', {class: 'row-item muted small'},
        h('span', {class: 'row-name'}, t('version {n} · {who} · {when} · {files}', {n: c.version, who: c.submittedBy || '—', when: ago(c.updatedAt), files: tn('{n} file', '{n} files', c.files)}))),
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
      actions.length ? h('div', {class: 'row work-act'}, ...actions) : null, error);
  };

  const paint = () => {
    const at = repo;
    const mine = ++run;
    const all = [workS, changesS, cutsS, handedS];
    if (!at) { for (const s of all) s.el.hidden = true; return; }
    const connected = connection() !== null;
    void Promise.all([
      git.changes(at),
      connected ? git.log(at) : Promise.resolve([] as git.Cut[]),
      connected ? git.work(at).catch(() => ({line: 'main', issue: null, started_by: '', started_at: 0, commits: 0, unpushed: 0, change: null}) as git.Work) : Promise.resolve({line: 'main', issue: null, started_by: '', started_at: 0, commits: 0, unpushed: 0, change: null} as git.Work),
      connected ? git.changesOf(at).catch(() => [] as git.Change[]) : Promise.resolve([] as git.Change[]),
    ]).then(async ([c, log, w, handed]) => {
      // The work's own issue, named by its title even when no issue is chosen above.
      const own = !issue && w.issue ? await store.read(at, w.issue).then((r) => (r.text == null ? null : parseIssue(at, w.issue!.slice('issue/'.length), r.text)), () => null) : null;
      if (mine !== run) return;
      workS.el.hidden = false;
      workS.body.replaceChildren(...workCard(at, w, c, own));
      changesS.el.hidden = !c.files;
      changesS.small.textContent = c.files ? `${c.files}` : '';
      changesS.body.replaceChildren(changeRows(at, c));
      const shown = issue && w.issue !== `issue/${issue.file}` ? log.filter((x) => x.issue === `issue/${issue!.file}`) : log;
      cutsS.el.hidden = !shown.length;
      cutsS.small.textContent = `${shown.length}`;
      cutsS.body.replaceChildren(cutRows(at, shown));
      handedS.el.hidden = !connected;
      handedS.small.textContent = handed.length ? `${handed.length}` : '';
      handedS.body.replaceChildren(...(handed.length ? handed.map((x) => handedRow(at, x))
        : [h('div', {class: 'empty'}, t('No changes handed in yet. Work on an issue, push, and Submit change.'))]));
    }, (e) => {
      if (mine !== run) return;
      changesS.el.hidden = false;
      cutsS.el.hidden = true;
      changesS.body.replaceChildren(h('p', {class: 'error'}, message(e)));
    });
  };

  return {
    sections: all(),
    show(r, i) { repo = r; issue = i; paint(); },
    refresh() { clearTimeout(timer); timer = window.setTimeout(paint, 250); },
  };
  function all() { return [workS.el, changesS.el, cutsS.el, handedS.el]; }
}
