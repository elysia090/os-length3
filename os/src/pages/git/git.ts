import {h} from '../../ui/dom.ts';
import {arrive, pop} from '../../ui/glide.ts';
import * as gitops from '../../repos/history.ts';
import {t} from '../../i18n.ts';
import {number, readIssues, type Issue} from '../../repos/issues.ts';
import {bring, remoteOnly} from '../../remote/lifecycle.ts';
import {connection} from '../../remote/connection.ts';
import {onChange, store} from '../../repos/repos.ts';
import {bench, type Bench} from '../bench/bench.ts';
import {openNext as openConversation} from '../inbox.ts';
import {icon} from '../../ui/icons.ts';
import type {Context} from '../context.ts';
import {Sections} from './done.ts';
import {backToMain, issueBox, issueHead, mergeRow, reviewBox, type IssueEvents, type RepoState} from './issue.ts';
import {IssueRow} from './issue-row.ts';
import {paintChips} from './repo-chips.ts';
import {laidOut} from '../../repos/git-state.ts';
import {issueForm, type IssueForm} from './issue-form.ts';
import {errorText} from '../../app/errors.ts';

/**
 * Git: what happens between a repo and the outside, in the issues' terms.
 * The repo chips are one row that slides sideways, however many repos there
 * are, so they never push the issues down; while an issue is written, the
 * repo chosen there is the one it goes in (All leaves that as it was).
 * Under the repo chips, the issues not merged yet as large boxes side by
 * side: one in full, its neighbours' edges showing at both sides. An edge is
 * the way to the box beside (hover lifts it; ← → do the same), and the track
 * slides there. The box holds the issue's number, words and next action
 * (git/issue.ts); under it, plainly, its Diff, Review and Reply.
 *
 * Issues are read straight from each repo's issue/ (nothing is kept twice).
 *
 * The repo the bench shows is the one worked on, on every page: a chip, an
 * issue gone to with an edge or an arrow, or one just written, makes its repo
 * the one Forge opens. Coming to Git changes nothing by itself: it opens at
 * the issue last looked at in the repo worked on. The keyboard stays on the
 * same part of the box as one goes along the row.
 *
 * Its parts: the repo chips (repo-chips.ts), the row of issues (issue-row.ts),
 * an issue's box (issue.ts), and the sections round them (done.ts).
 */

const ALL = '';
let filter = ALL;
/** The issue shown, kept while the app runs: repo and file. */
let chosen: string | null = null;
/** The issue last looked at in each repo. */
const chosenIn = new Map<string, string>();

const key = (i: Issue) => `${i.repo}/${i.file}`;

/** Git opened at `file` (an issue) of `repo`, as from a line that says it was written: it is the one shown. */
export function showIssue(repo: string, file: string) {
  chosen = `${repo}/${file}`;
  chosenIn.set(repo, chosen);
  if (filter !== ALL && filter !== repo) filter = repo;
}

export function git(ctx: Context): Node[] {
  return [new GitPage(ctx).element];
}

/**
 * Where each of `repos` stands, into `fresh`: the work it shows (main again once that work's change was merged), the
 * issues started, the changes to main, and what is not committed.
 */
function standings(repos: readonly string[], fresh: Map<string, RepoState>): Promise<unknown> {
  return Promise.all(repos.map(async (r) => {
    try {
      let {work, lines, changes} = await gitops.standing(r);
      // A work whose change was merged (here or on another device) is done: the repo shows main again.
      if (work.line !== 'main' && changes.some((c) => c.line === work.line && c.state === 'merged')) {
        await gitops.switchWork(r, 'main');
        work = await gitops.work(r);
      }
      const uncommitted = (await gitops.changes(r)).files;
      fresh.set(r, {work, lines, changes, uncommitted});
    } catch (e) {
      fresh.set(r, {work: null, lines: [], changes: [], uncommitted: 0, error: errorText(e)});
    }
  }));
}

/**
 * An issue without a number (written by hand, or two devices' met under one) takes the next free one; the store's
 * change draws the page again. Not on main's behalf while a work is shown: that copy is the work's.
 */
function renumber(issues: readonly Issue[], states: ReadonlyMap<string, RepoState>): Promise<unknown[]> {
  return Promise.all([...new Set(issues.filter((i) => i.n === null).map((i) => i.repo))].map((r) => {
    const st = states.get(r);
    if (!st || st.error || (st.work && st.work.line !== 'main')) return false;
    const inUse = new Set([...st.lines.map((l) => l.issue), ...st.changes.map((c) => c.issue)]);
    return number(store, r, issues.filter((i) => i.repo === r), inUse);
  }));
}

/** Where each repo stood when Git last read it: drawn at once when the page is come back to, then read again. */
const stood = new Map<string, RepoState>();

/** The page while it is shown: its repos, where each stands, and what is drawn of them. */
class GitPage {
  readonly element: HTMLElement;
  private readonly ctx: Context;
  private readonly chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  private readonly write = h('button', {class: 'button', type: 'button'}, t('Write an issue')) as HTMLButtonElement;
  private readonly count = h('small', {});
  /** Where the issues would be when there are none: the dashed card that writes the first, or what is so. */
  private readonly empty = h('div', {}, h('p', {class: 'muted small'}, t('Reading…')));
  private readonly form: IssueForm;
  private readonly row: IssueRow;
  private readonly sections = new Sections();
  private readonly workbench: Bench;
  private repos: string[] = [];
  /** The repo looked at: the reference and the Prompt point at it. */
  private at: string | null = null;
  private states = new Map<string, RepoState>();
  private readonly events: IssueEvents;
  private readonly again = () => void this.paint();
  // One drawing at a time; asked again meanwhile, it draws once more after, from what is then true.
  private drawing: Promise<void> | null = null;
  private more = false;
  private timer = 0;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.form = issueForm({done: (made, back) => this.written(made, back)});
    this.row = new IssueRow({
      landed: (i, moved) => this.landed(i, moved),
      slot: (x, now) => this.slot(x, now),
      // main's cards stand in the same column as the issue in full, and go with it along the row.
      slid: (lead, single) => { this.sections.main.style.setProperty('--lead', `${lead}`); this.sections.main.classList.toggle('single', single); },
    });
    this.events = {
      open: (repo, path) => ctx.openRepo(repo, path),
      // The repo shows another copy: what File, Forge and the issues read is that copy now.
      // Started, continued or back on main: that repo is the one worked on.
      moved: (repo) => { ctx.remember(repo); if (repo === this.at) void this.paint(); },
    };
    this.write.addEventListener('click', () => {
      this.write.hidden = true;
      // The dashed card that stood for it becomes the issue being written.
      this.empty.hidden = true;
      if (!this.form.resume(this.repos, true)) this.form.open(this.repos, filter || this.at || this.repos[0]);
    });
    this.load();
    this.workbench = this.bench();
    this.element = this.workbench.element;
    this.watch();
    this.element.prepend(h('h1', {class: 'sr-only'}, t('Git')));
  }

  /** The page on the work bench: main's over the issues, the sections under them, its repos on its band. */
  private bench(): Bench {
    const main = h('section', {class: 'flow git-flow', tabindex: '0', 'aria-label': 'Git'},
      // What main has not committed comes first, over the issues: what is in hand before what is planned.
      this.sections.main,
      h('section', {class: 'section', 'aria-labelledby': 'issues-title'},
        h('h2', {id: 'issues-title'}, h('span', {}, t('Issues'), ' ', this.count)),
        this.form.element, this.empty, this.row.column),
      ...this.sections.under);
    // Its repos are its band, on the top line as Forge's pills are, so the page starts where the rail's places do.
    return bench({strip: h('div', {class: 'git-band'}, this.chips), main, reveal: (path) => { if (this.at) this.ctx.openRepo(this.at, path); }, word: (a) => { openConversation(a); void this.ctx.go('inbox'); }, back: true,
      went: (repo, to) => { if (to === 'todo') { void this.ctx.go('home'); return; } showIssue(repo, to.issue); this.row.land = true; void this.paint(); }});
  }

  /** Point the reference and the Prompt at `repo`; `chosen` when the person chose it, which makes it the repo worked on. */
  private look(repo: string | null, chosen = false) {
    this.at = repo;
    if (!repo) return;
    this.workbench.setRepo(repo);
    if (chosen) this.ctx.remember(repo);
  }

  /** The repos here, read again: the chips, the repo looked at, an issue half written, and the issues. */
  private load() {
    void store.list().then((r) => {
      this.repos = r.map((x) => x.name);
      if (filter && !this.repos.includes(filter)) filter = ALL;
      this.write.disabled = !this.repos.length;
      this.look(filter || (this.ctx.repo && this.repos.includes(this.ctx.repo) ? this.ctx.repo : this.repos[0] ?? null));
      this.paintChips();
      // An issue half written when the page was left is still being written.
      if (this.form.resume(this.repos)) this.write.hidden = true;
      void this.paint();
    });
  }

  // ---- the repo chips ----

  private paintChips() {
    paintChips(this.chips, [ALL, ...this.repos], filter, (r, e) => this.choose(r, e));
  }

  /** A chip pressed: its repo's issues shown, and it the repo looked at and written in. */
  private choose(r: string, e: MouseEvent) {
    // Pressed with the pointer while an issue is being written, it only said where: the words take the keyboard back.
    // Another chosen: the issues it shows come in after the ink has gone to it.
    const other = filter !== r;
    filter = r;
    this.paintChips();
    if (r) { this.look(r, true); this.form.retarget(r); if (e.detail && !this.form.element.hidden) this.form.writeOn(); }
    void this.paint().then(() => { if (other) arrive(this.row.stage.hidden ? this.empty : this.row.stage, 1, 'y', 10, 260); });
  }

  // ---- the row of issues ----

  /** Issue `i` on screen: the one shown, its repo the one looked at (and worked on, when the person went to it). */
  private landed(i: Issue, moved: boolean) {
    chosen = key(i);
    chosenIn.set(i.repo, chosen);
    this.look(i.repo, moved);
  }

  /**
   * What issue `x`'s slot holds. Each issue is a column: its card, and once pushed, its Review and Merge under it,
   * so they slide with it. The neighbours show only their heads.
   */
  private slot(x: Issue, now: boolean): HTMLElement[] {
    if (!now) return [h('div', {class: 'issue-card'}, issueHead(x, true))];
    const st = this.states.get(x.repo);
    // Under the current box, out of it: Back to main at its left (for the issue the repo shows), Write an issue at its right.
    return [h('div', {class: 'issue-card'}, issueBox(x, st, this.events, this.again)),
      h('div', {class: 'issue-under'}, backToMain(x, st, this.events, this.again) ?? h('span'), this.write),
      reviewBox(x, st, this.again), mergeRow(x, st, this.events, this.again)].filter((n): n is HTMLElement => !!n);
  }

  /** Written: its repo is the one looked at and worked on, and the new issue is the one shown, with the keyboard on it. */
  private written(made: {repo: string; file: string} | null, back: string | null) {
    this.write.hidden = false;
    this.empty.hidden = false;
    // Asked for from Forge's reference and put back: back there, as it was.
    if (!made && back) { this.ctx.openRepo(back); return; }
    if (!made) { (this.write.isConnected ? this.write : this.empty.querySelector<HTMLElement>('button') ?? this.write).focus({preventScroll: true}); return; }
    if (filter && filter !== made.repo) { filter = made.repo; this.paintChips(); }
    chosen = `${made.repo}/${made.file}`;
    chosenIn.set(made.repo, chosen);
    this.look(made.repo, true);
    this.row.land = true;
    void this.paint();
  }

  // ---- drawing ----

  private paint(): Promise<void> {
    if (this.drawing) { this.more = true; return this.drawing; }
    this.drawing = this.draw().finally(() => { this.drawing = null; if (this.more) { this.more = false; void this.paint(); } });
    return this.drawing;
  }

  private async draw() {
    const all = await Promise.all(this.repos.map((r) => readIssues(store, r)));
    const issues = all.flatMap((x, j) => (!filter || this.repos[j] === filter ? x : []));
    const shown = this.repos.filter((r) => !filter || r === filter);
    // Come back to: where each repo stood when last read is drawn at once, while it is read again (a repo's standing is
    // several of the core's answers, one after another, a long wait with many repos), and drawn again only if it moved.
    const early = connection() && !this.states.size && shown.length > 0 && shown.every((r) => stood.has(r));
    if (early) {
      this.states = new Map(shown.map((r) => [r, stood.get(r)!]));
      this.lay(shown, issues);
    }
    // Where each repo stands: the work it shows, the issues started, the changes to main.
    const fresh = new Map<string, RepoState>();
    // Every repo looked at, issues or not: what its main has not committed shows too.
    if (connection()) await standings(shown, fresh);
    // Asked again while this read (an issue written meanwhile): what it read may be from before, so it is not drawn,
    // nor does it choose the issue shown; the drawing after it, from what is true then, does.
    if (this.more) return;
    for (const [r, st] of fresh) stood.set(r, st);
    // Drawn early from what was read before, and read the same now: it stands as it is (not drawn twice over).
    const same = early && this.laidFrom === JSON.stringify([shown, issues, [...fresh]]);
    this.states = fresh;
    if (same) return;
    if ((await renumber(issues, this.states)).some(Boolean)) return;
    this.lay(shown, issues);
  }

  /** What was laid out last, as read: the same read again is not drawn again. */
  private laidFrom = '';

  /** The issues of `shown` and the sections round them, drawn from `issues` and where each repo stands now. */
  private lay(shown: string[], issues: Issue[]) {
    this.laidFrom = JSON.stringify([shown, issues, [...this.states]]);
    // Oldest first, so #1 is on the left; merged and closed ones are done with, and listed under the issues.
    const laid = laidOut(shown, issues, this.states);
    this.counted(laid.open.length);
    this.sections.draw(laid, filter, this.states, this.events, this.again);
    if (laid.open.length) this.drawSome(laid.open); else this.drawNone(issues);
  }

  /** A count that changes while it is seen (an issue written, or closed and gone down) gives a beat as it does. */
  private counted(n: number) {
    const text = n ? `${n}` : '';
    if (this.count.textContent === text) return;
    const seen = this.count.isConnected && this.count.textContent !== '';
    this.count.textContent = text;
    if (seen && text) pop(this.count, .12, 300);
  }

  /** The issues as the row's boxes, at the one last looked at, in the repo worked on when that has one here. */
  private drawSome(open: Issue[]) {
    this.empty.replaceChildren();
    const repo = this.ctx.repo;
    const mine = repo && open.some((i) => i.repo === repo) && !chosen?.startsWith(`${repo}/`) ? chosenIn.get(repo) : chosen;
    let was = open.findIndex((i) => key(i) === mine);
    if (was < 0 && repo) was = open.findIndex((i) => i.repo === repo);
    this.row.fill(open, was >= 0 ? was : 0);
  }

  /**
   * None to show: where the first would be, the dashed card that writes it (pressed, it becomes the issue being
   * written), with what is so said quietly under its word. No repo: said once, as wide as its words.
   */
  private drawNone(issues: Issue[]) {
    this.row.none();
    this.sections.main.classList.add('single');
    if (!this.repos.length) { this.empty.replaceChildren(remoteOnly().length ? this.onlyThere() : h('div', {class: 'empty'}, t('No repos yet'))); return; }
    const first = h('button', {type: 'button', class: 'card new issue-new'}, icon('new-repo'), h('span', {}, t('Write an issue')),
      h('small', {class: 'muted'}, issues.length ? t('No open issues') : t('No issues yet'))) as HTMLButtonElement;
    first.disabled = this.write.disabled;
    first.addEventListener('click', () => this.write.click());
    this.empty.replaceChildren(first);
  }

  /** No repo here and some on the Remote: each fetched with a press, as Runtime's are, and its issues are here. */
  private onlyThere() {
    return h('div', {class: 'empty fetch-list'}, h('p', {}, t('Only on the Remote')), ...remoteOnly().map((r) => {
      const b = h('button', {type: 'button', class: 'button small-button'}, t('Fetch')) as HTMLButtonElement;
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = t('Bringing it…');
        try { await bring(r.name); this.load(); } catch (e) { b.disabled = false; b.textContent = errorText(e); }
      });
      return h('div', {class: 'fetch-row'}, h('span', {}, r.name), b);
    }));
  }

  // ---- drawn again as the repos change ----

  /**
   * Issues written anywhere (here, in the shell, with l3 in the Prompt) show up at once, and any change in the repo
   * looked at is read again; not while something is being written in the box or under it, which would be lost.
   */
  private watch() {
    const stop = onChange((c) => {
      if (!this.element.isConnected) { stop(); return; }
      if (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/') || c.repo === this.at) this.soon();
    });
    const back = () => { if (!this.element.isConnected) { removeEventListener('focus', back); return; } this.soon(); };
    addEventListener('focus', back);
  }

  private typing() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && (this.row.stage.contains(a) || this.sections.main.contains(a)) && !!(a as HTMLInputElement).value;
  }

  /** Drawn again in a moment. Not while a committed card is still going off (git/done.ts): it is drawn again once it has gone. */
  private soon() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { if (this.typing() || this.sections.main.querySelector('.leaving')) this.soon(); else void this.paint(); }, 250);
  }
}
