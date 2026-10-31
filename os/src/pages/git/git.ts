import {h} from '../../ui/dom.ts';
import {after, arrive, LAND, paced, pop, putAway, still, unfold} from '../../ui/glide.ts';
import * as gitops from '../../repos/history.ts';
import {t} from '../../i18n.ts';
import {issuePath, number, readIssues, type Issue} from '../../repos/issues.ts';
import {bring, remoteOnly} from '../../remote/lifecycle.ts';
import {connection} from '../../remote/connection.ts';
import {onChange, onRenamed, rekey, store} from '../../repos/repos.ts';
import {bench, type Bench} from '../bench/bench.ts';
import {openNext as openConversation} from '../inbox.ts';
import {icon} from '../../ui/icons.ts';
import type {Context} from '../context.ts';
import {foldAway, opened, Sections} from './done.ts';
import {backToMain, crossfade, issueBox, issueHead, knowIssues, mergeRow, resize, reviewBox, type IssueEvents, type RepoState} from './issue.ts';
import {IssueRow} from './issue-row.ts';
import {paintChips} from './repo-chips.ts';
import {laidOut} from '../../repos/git-state.ts';
import {issueForm, type IssueForm, type Made} from './issue-form.ts';
import {errorText} from '../../app/errors.ts';
import {issueStore} from '../../repos/issue-store.ts';

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

// A repo renamed: its chip stays chosen, and the issue shown in it with it; where it stood is read again.
onRenamed((from, to) => {
  const moved = (k: string) => (k.startsWith(`${from}/`) ? `${to}${k.slice(from.length)}` : k);
  if (filter === from) filter = to;
  if (chosen) chosen = moved(chosen);
  rekey(chosenIn, from, to);
  for (const [r, k] of chosenIn) chosenIn.set(r, moved(k));
  stood.delete(from);
});

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
async function standings(repos: readonly string[], fresh: Map<string, RepoState>): Promise<unknown> {
  // Every repo's lines and changes in one ask of the Remote; what is not committed, each of its own.
  const stand = await gitops.standings(repos).catch((e: unknown) => repos.map(() => e instanceof Error ? e : new Error(String(e))));
  return Promise.all(repos.map(async (r, i) => {
    try {
      const at = stand[i];
      if (!at || at instanceof Error) throw at ?? new Error(r);
      let {work, lines, changes} = at;
      // A work whose change was merged (here or on another device) is done: the repo shows main again.
      if (work.line !== 'main' && changes.some((c) => c.line === work.line && c.state === 'merged')) {
        await gitops.switchWork(r, 'main');
        work = await gitops.work(r);
      }
      let changed = await gitops.changes(r);
      // An issue's own file is history by itself as it is written (repos/issue-store.ts): one still waiting (written
      // signed out, renumbered, one whose commit did not go) is committed now, and never counted as the person's.
      const issueFolder = (f: {folder: string}) => f.folder === 'issue' || f.folder.startsWith('issue/');
      if (work.line === 'main' && changed.folders.some(issueFolder) && await issueStore.settle(r)) changed = await gitops.changes(r);
      const uncommitted = changed.folders.filter((f) => !issueFolder(f)).reduce((n, f) => n + f.files.length, 0);
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
    // Issues are main's whatever work the repo shows (repos/issue-store.ts): renumbered there, and committed.
    if (!st || st.error) return false;
    const inUse = new Set([...st.lines.map((l) => l.issue), ...st.changes.map((c) => c.issue)]);
    return number(issueStore, r, issues.filter((i) => i.repo === r), inUse);
  }));
}

/** Where each repo stood when Git last read it: drawn at once when the page is come back to, then read again. */
const stood = new Map<string, RepoState>();
/** The repos and each one's issues as Git last read them: with `stood`, the page come back to is drawn from its first
 * frame as it was left (never "Loading…" a moment as it comes in), then read again. */
let reposRead: string[] | null = null;
const issuesRead = new Map<string, Issue[]>();

/** The page while it is shown: its repos, where each stands, and what is drawn of them. */
class GitPage {
  readonly element: HTMLElement;
  private readonly ctx: Context;
  private readonly chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': 'repo'});
  private readonly write = h('button', {class: 'button small-button issues-write', type: 'button'}, t('Create issue')) as HTMLButtonElement;
  private readonly count = h('small', {});
  /** Where the issues would be when there are none: the dashed card that writes the first, or what is so. */
  private readonly empty = h('div', {}, h('p', {class: 'muted small'}, t('Loading…')));
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
  /** main's edges easing to the row's after a drawing (slid). */
  private mainSettling: Animation | null = null;
  /** The issue the row goes to once it is drawn (one reopened), from the one in full before. */
  private slideTo: string | null = null;
  /** An issue just made: the height of the box it was written in, which becomes its card as it is drawn (lay). */
  private becoming: number | null = null;
  /** Drawn once: what is drawn after that moves from what it was (goOn); the first drawing is simply there. */
  private laid = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.form = issueForm({done: (made, back) => this.written(made, back)});
    this.row = new IssueRow({
      landed: (i, moved) => this.landed(i, moved),
      slot: (x, now) => this.slot(x, now),
      // main's cards stand in the same column as the issue in full, and go with it along the row.
      slid: (lead, single, drawn) => {
        const main = this.sections.main;
        // Drawn again, its edges ease to the row's new ones as the row's do (git/issue-row.ts settle).
        if (drawn && !still()) { main.classList.add('settling'); this.mainSettling?.cancel(); this.mainSettling = after(280, () => main.classList.remove('settling')); }
        main.style.setProperty('--row-lead', `${lead}`);
        main.classList.toggle('single', single);
      },
    });
    this.events = {
      open: (repo, path) => ctx.openRepo(repo, path),
      // The repo shows another copy: what File, Forge and the issues read is that copy now.
      // Started, continued or back on main: that repo is the one worked on.
      moved: (repo) => { ctx.remember(repo); if (repo === this.at) void this.paint(); },
      aside: (i) => this.row.aside(key(i)),
      back: (i) => { this.slideTo = key(i); },
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
    this.drawKnown();
    this.watch();
    this.element.prepend(h('h1', {class: 'sr-only'}, t('Git')));
  }

  /** The page on the work bench: main's over the issues, the sections under them, its repos on its band. */
  private bench(): Bench {
    const main = h('section', {class: 'flow git-flow', tabindex: '0', 'aria-label': 'Git'},
      // What main has not committed comes first, over the issues: what is in hand before what is planned.
      this.sections.main,
      h('section', {class: 'section', 'aria-labelledby': 'issues-title'},
        // Write an issue on the heading's line at its right: one place, however tall the box in full is (not between
        // it and its Review); with none to show, the dashed card where the first would be is the way instead.
        h('div', {class: 'issues-head none'}, h('h2', {id: 'issues-title'}, h('span', {}, t('Issues'), ' ', this.count)), this.write),
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

  /**
   * Come back to: drawn at once from what was read last time (the repos, their issues, where each stood), so the page
   * comes in as it was left; read again after, it is drawn again only where something moved.
   */
  private drawKnown() {
    const repos = reposRead;
    if (!repos?.length || !connection()) return;
    const shown = repos.filter((r) => !filter || r === filter);
    if (!shown.every((r) => stood.has(r) && issuesRead.has(r))) return;
    this.repos = repos;
    this.write.disabled = false;
    this.look(filter || (this.ctx.repo && repos.includes(this.ctx.repo) ? this.ctx.repo : repos[0] ?? null));
    this.paintChips();
    const issues = shown.flatMap((r) => issuesRead.get(r)!);
    knowIssues(repos.flatMap((r) => issuesRead.get(r) ?? []));
    this.states = new Map(shown.map((r) => [r, stood.get(r)!]));
    this.lay(shown, issues);
    this.known = true;
  }
  /** Drawn from what was read before (drawKnown): the first reading after is drawn only if it differs. */
  private known = false;

  /** The repos here, read again: the chips, the repo looked at, an issue half written, and the issues. */
  private load() {
    void store.list().then((r) => {
      this.repos = r.map((x) => x.name);
      reposRead = this.repos;
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
    // No repo yet: All of nothing is no choice; the row stands aside until there is a repo to choose.
    this.chips.hidden = !this.repos.length;
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
    // Under the current box, out of it: Back to main at its left, for the issue the repo shows.
    const leave = backToMain(x, st, this.events, this.again);
    return [h('div', {class: 'issue-card'}, issueBox(x, st, this.events, this.again)),
      leave ? h('div', {class: 'issue-under'}, leave) : null,
      reviewBox(x, st, this.again), mergeRow(x, st, this.events, this.again)].filter((n): n is HTMLElement => !!n);
  }

  /**
   * Written: its repo is the one looked at and worked on, and the new issue is the one shown, with the keyboard on it.
   * The box it was written in stays as it was until the page is drawn with the issue in it, and then becomes its card
   * where it stood (lay): one box the whole way, never the box folding away and a card coming after it.
   */
  private written(made: Made | null, back: string | null) {
    this.write.hidden = false;
    if (!made) this.empty.hidden = false;
    // Asked for from Forge's reference and put back: back there, as it was.
    if (!made && back) { this.ctx.openRepo(back); return; }
    if (!made) { (this.write.getClientRects().length ? this.write : this.empty.querySelector<HTMLElement>('button') ?? this.write).focus({preventScroll: true}); return; }
    if (filter && filter !== made.repo) { filter = made.repo; this.paintChips(); }
    this.slideTo = `${made.repo}/${made.file}`;
    chosenIn.set(made.repo, this.slideTo);
    this.look(made.repo, true);
    this.row.land = true;
    const height = this.form.element.getBoundingClientRect().height;
    this.becoming = height || null;
    if (!height) this.form.clear();
    // Not drawn after all (the page read again failing): the box does not stay standing in the way.
    else setTimeout(() => { if (this.becoming === height) { this.becoming = null; this.form.clear(); this.empty.hidden = false; } }, 6000);
    void this.paint();
  }

  // ---- drawing ----

  private paint(): Promise<void> {
    if (this.drawing) { this.more = true; return this.drawing; }
    this.drawing = this.draw().finally(() => { this.drawing = null; if (this.more) { this.more = false; void this.paint(); } });
    return this.drawing;
  }

  private async draw() {
    const all = await Promise.all(this.repos.map((r) => readIssues(issueStore, r)));
    // Every issue read names its own file wherever a diff shows it (main's card, an issue's Commit row).
    knowIssues(all.flat());
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
    for (const r of shown) issuesRead.set(r, all[this.repos.indexOf(r)] ?? []);
    // Drawn early from what was read before, and read the same now: it stands as it is (not drawn twice over).
    const same = (early || this.known) && this.laidFrom === JSON.stringify([shown, issues, [...fresh]]);
    this.known = false;
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
    const before = this.stood();
    // Moves go on from what was drawn; not the first drawing, nor while a box goes down into its line (git/issue.ts
    // mergeRow): what that lands on stays where it was found.
    const moving = this.laid && !still() && !document.querySelector('.morph-box');
    this.laid = true;
    // The box an issue was just written in: taken away as the issue's card is drawn where it stood (below).
    const becoming = this.becoming;
    this.becoming = null;
    const writ = becoming ? this.form.element.cloneNode(true) as HTMLElement : null;
    if (becoming) { this.form.clear(); this.empty.hidden = false; }
    const row = !this.row.stage.hidden, none = !!this.empty.firstElementChild;
    this.counted(laid.open.length);
    opened(this.sections.main);
    this.sections.draw(laid, filter, this.states, this.events, this.again, moving);
    if (laid.open.length) this.drawSome(laid.open, !!becoming); else this.drawNone(issues);
    const card = this.row.current();
    if (writ && card) { crossfade(writ, card.card, becoming!); resize(card.card, becoming!); }
    if (!moving) return;
    this.goOn(before);
    // The row come into sight (an issue reopened, one come from elsewhere): its box comes in, not there at once; the
    // dashed card that writes the first, there again once the last has gone, the same.
    if (!row && card && !writ) arrive(card.card, 1, 'y', 10, 260);
    if (!none && this.empty.firstElementChild) this.empty.animate([{opacity: 0}, {opacity: 1}], {duration: paced(220), easing: 'ease-out'});
  }

  /** main's part and the issue in full as they stand, for the drawing after to go on from. */
  private stood() {
    const main = this.sections.main;
    const cards = new Map([...main.querySelectorAll<HTMLElement>(':scope > .main-card')].map((c) => [c.getAttribute('aria-label') ?? '', {el: c, height: c.getBoundingClientRect().height}]));
    const card = this.row.current();
    // What stood under the issue in full, out of its box (Back to main, its Review, Merge), by kind, and how tall.
    const below = [...card?.card.parentElement?.children ?? []].filter((c) => c !== card?.card);
    const under = below.map((c) => c.className);
    const tall = new Map(below.map((c) => [c.className, c.getBoundingClientRect().height]));
    return {main: main.hidden ? 0 : main.getBoundingClientRect().height, kids: [...main.children], style: main.getAttribute('style') ?? '',
      cards, card, under, tall};
  }

  /**
   * Drawn again, nothing jumps: main's part folds away where it stood (its repo shows a work now), unfolds (back on
   * main, an issue closed), or goes to its new height, the issues under it going with it; the issue in full goes from
   * the height it was to the one it is (a commit's files gone, Push's line come). Not while a merged issue's box goes
   * down into its line (git/issue.ts mergeRow): what that lands on stays where it was found.
   */
  private goOn(was: ReturnType<GitPage['stood']>) {
    const main = this.sections.main;
    const now = main.hidden ? 0 : main.getBoundingClientRect().height;
    if (was.main && !now) foldAway(main, was.kids, was.style);
    else if (!was.main && now) unfold(main, 280);
    else {
      // A repo's card gone from main (another repo chosen, its changes committed) folds away where it stood, the cards
      // under it closing up as it does; one come opens where it now stands. Gone at once, the rest jumped into its room
      // and only the part's foot moved after.
      const cards = () => [...main.querySelectorAll<HTMLElement>(':scope > .main-card')];
      const here = new Set(cards().map((c) => c.getAttribute('aria-label') ?? ''));
      const order = [...was.cards.keys()];
      order.forEach((label, k) => {
        if (here.has(label)) return;
        const ghost = was.cards.get(label)!.el;
        ghost.inert = true;
        ghost.setAttribute('aria-hidden', 'true');
        const after = order.slice(k + 1).find((l) => here.has(l));
        const next = after ? cards().find((c) => c.getAttribute('aria-label') === after) : undefined;
        if (next) next.before(ghost); else main.append(ghost);
        putAway(ghost, () => ghost.remove(), {fold: true, ms: 280});
      });
      for (const c of cards()) if (!was.cards.has(c.getAttribute('aria-label') ?? '')) unfold(c, 280);
      resize(main, was.main);
      // Each repo's card drawn again where it was: what changed in it fades over as it goes to its new height.
      for (const c of cards()) {
        const old = was.cards.get(c.getAttribute('aria-label') ?? '');
        if (old) { crossfade(old.el, c, old.height); resize(c, old.height); }
      }
    }
    // The issue in full drawn again (a step done): what changed in its box fades over, the box going to its new height.
    const card = this.row.current();
    if (!was.card || card?.key !== was.card.key) return;
    crossfade(was.card.card, card.card, was.card.height);
    resize(card.card, was.card.height);
    // What comes under it with the step (its Review once handed in, Back to main once started) comes in after the box
    // has begun to change, from a little lower, not there at once.
    for (const c of card.card.parentElement?.children ?? []) {
      // (Not the box's own, nor what it showed before still fading over it: crossfade.) One there before (the Review,
      // what was said in it drawn again) goes from the height it had, not there at once at its new one.
      if (c.classList.contains('issue-card')) continue;
      if (was.under.includes(c.className)) { if (c instanceof HTMLElement) resize(c, was.tall.get(c.className) ?? 0); continue; }
      c.animate([{opacity: 0, translate: '0 8px'}, {opacity: 1, translate: '0 0'}], {duration: paced(260), delay: paced(100), easing: LAND, fill: 'backwards'});
    }
  }

  /** No repo at all (a first run): the first made, the whole card the deed, as Forge's and Home's New repo are. */
  private firstRepo(): HTMLElement {
    const b = h('button', {type: 'button', class: 'card new issue-new'}, icon('new-repo'), h('span', {}, t('Create your first repo')),
      h('small', {class: 'muted'}, t('No repos yet'))) as HTMLButtonElement;
    b.addEventListener('click', () => void this.ctx.go('new-repo'));
    return b;
  }

  /** A count that changes while it is seen (an issue written, or closed and gone down) gives a beat as it does. */
  private counted(n: number) {
    const text = n ? `${n}` : '';
    if (this.count.textContent === text) return;
    const seen = this.count.isConnected && this.count.textContent !== '';
    this.count.textContent = text;
    if (seen && text) pop(this.count, .12, 300);
  }

  /**
   * The issues as the row's boxes, at the one last looked at, in the repo worked on when that has one here; none looked
   * at yet (the app just opened), at the issue that repo's work is on, so a reload finds the work where it was left.
   */
  private drawSome(open: Issue[], inPlace = false) {
    this.empty.replaceChildren();
    this.write.parentElement?.classList.remove('none');
    const to = this.slideTo === null ? -1 : open.findIndex((i) => key(i) === this.slideTo);
    this.slideTo = null;
    // Gone to from the one in full (one reopened), the row slides there; one just written is there at once, where the
    // box it was written in stood (`inPlace`).
    if (to >= 0) { this.row.fill(open, to, inPlace ? -1 : open.findIndex((i) => key(i) === chosen)); return; }
    const repo = this.ctx.repo;
    const mine = repo && open.some((i) => i.repo === repo) && !chosen?.startsWith(`${repo}/`) ? chosenIn.get(repo) : chosen;
    let was = open.findIndex((i) => key(i) === mine);
    const work = repo ? this.states.get(repo)?.work : null;
    if (was < 0 && work && work.line !== 'main') was = open.findIndex((i) => i.repo === repo && issuePath(i) === work.issue);
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
    // The dashed card is the way to write the first: the heading's Write stands aside meanwhile (one way, not two).
    this.write.parentElement?.classList.add('none');
    if (!this.repos.length) { this.empty.replaceChildren(remoteOnly().length ? this.onlyThere() : this.firstRepo()); return; }
    const first = h('button', {type: 'button', class: 'card new issue-new'}, icon('new-repo'), h('span', {}, t('Create issue')),
      h('small', {class: 'muted'}, issues.length ? t('No open issues') : t('No issues yet'))) as HTMLButtonElement;
    first.disabled = this.write.disabled;
    first.addEventListener('click', () => this.write.click());
    this.empty.replaceChildren(first);
  }

  /** No repo here and some on the Remote: each fetched with a press, as Runtime's are, and its issues are here. */
  private onlyThere() {
    return h('div', {class: 'empty fetch-list'}, h('p', {}, t('Remote only')), ...remoteOnly().map((r) => {
      const b = h('button', {type: 'button', class: 'button small-button'}, t('Fetch')) as HTMLButtonElement;
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = t('Fetching…');
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
