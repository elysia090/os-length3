import {h} from '../../ui/dom.ts';
import {arrive, cut, LAND, paced, pop, still} from '../../ui/glide.ts';
import * as gitops from '../../../repo/history.ts';
import {t} from '../../../text/i18n.ts';
import {issuePath, number, readIssues, type Issue} from '../../../repo/issues.ts';
import {bring, remoteOnly} from '../../../shipto/lifecycle.ts';
import {connection} from '../../../shipto/connection.ts';
import {onChange, onRenamed, rekey, store} from '../../../repo/repos.ts';
import {workPlaces} from '../kit/places.ts';
import {bench, type Bench} from '../bench/bench.ts';
import {openNext as openConversation} from '../kit/next.ts';
import {icon} from '../../ui/icons.ts';
import type {Context} from '../kit/context.ts';
import {Sections} from './done.ts';
import {backToMain, crossfade, issuePaper, issueHead, issueSteps, knowIssues, mergeRow, resize, type IssueEvents, type RepoState} from './issue.ts';
import {IssueRow} from './issue-row.ts';
import {RepoFolders} from './repo-chips.ts';
import {laidOut} from '../../../repo/git-state.ts';
import {newIssue, type Made} from './issue-form.ts';
import {errorText} from '../../../api/errors.ts';
import {issueStore} from '../../../repo/issue-store.ts';
import {SPRING} from '../../ui/law.ts';
import {wholeCells} from '../../ui/row.ts';
import {amidOnGrid} from '../../ui/on-grid.ts';

/** Git is one repo's issue desk. The name above main changes desks, not places. */
const NEW = '+new';
const key = (i: Issue) => `${i.repo}/${i.file}`;
interface IssueLink {repo: string; issue: string}
let linked: IssueLink | null = null;
/** Last issue (or the new issue slot) on each desk, not a global selection. */
const chosenIn = new Map<string, string>();
type Bookmark = {selector: string; ordinal: number; selection?: [number | null, number | null, 'forward' | 'backward' | 'none' | null]};
interface View {issue: string | null; top: number; left: number; focus: Bookmark | null}
const visited = new Map<string, View>();

// A renamed repo keeps both the issue and the previous position of that desk.
onRenamed((from, to) => {
  const moved = (k: string) => k.startsWith(`${from}/`) ? `${to}${k.slice(from.length)}` : k;
  if (linked?.repo === from) linked = {repo: to, issue: moved(linked.issue)};
  rekey(chosenIn, from, to);
  rekey(visited, from, to);
  for (const [r, k] of chosenIn) chosenIn.set(r, moved(k));
  const view = visited.get(to);
  if (view?.issue) view.issue = moved(view.issue);
  stood.delete(from);
  issuesRead.delete(from);
});

/** A link to an issue takes its own Git desk, even when another repo was last in hand. */
export function showIssue(repo: string, file: string) {
  linked = {repo, issue: `${repo}/${file.replace(/^issue\//, '')}`};
  chosenIn.set(repo, linked.issue);
}

function bookmark(root: HTMLElement, el: HTMLElement | null): Bookmark | null {
  if (!el || !root.contains(el)) return null;
  const named = el.dataset.gitFocus;
  const step = el.closest<HTMLElement>('[data-step]')?.dataset.step;
  const file = el.classList.contains('git-main-file') ? el.dataset.path : null;
  const selector = named ? `[data-git-focus="${CSS.escape(named)}"]`
    : step ? `.git-switch [data-step="${CSS.escape(step)}"] > button`
    : file ? `.git-main-file[data-path="${CSS.escape(file)}"]`
    : ['.git-diff-scroll', '.git-review-text', '.issue-summary', '.issue-first', '.issue-detail', '.issue-retitle',
      '.issue-words', '.issue-stage', '.git-desk'].find(s => el.matches(s));
  if (!selector) return null;
  const inIssue = el.closest('.issue-slot');
  const by = inIssue ? `.issue-slot[aria-current="true"] ${selector}` : selector;
  const ordinal = [...root.querySelectorAll(by)].indexOf(el);
  if (ordinal < 0) return null;
  const selection: Bookmark['selection'] = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
    ? [el.selectionStart, el.selectionEnd, el.selectionDirection] : undefined;
  return {selector: by, ordinal, selection};
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
      // An issue's own file is history by itself as it is written (repo/issue-store.ts): one still waiting (written
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
    // Issues are main's whatever work the repo shows (repo/issue-store.ts): renumbered there, and committed.
    if (!st || st.error) return false;
    const inUse = new Set([...st.lines.map((l) => l.issue), ...st.changes.map((c) => c.issue)]);
    return number(issueStore, r, issues.filter((i) => i.repo === r), inUse);
  }));
}

/** main's sheet while the issue not written yet is in the hand: the steps it will have, each waiting. */
const waiting = () => h('div', {class: 'switch-lines'},
  ...[t('Start'), t('Commit'), t('Submit'), t('Merge')].map((w) => h('div', {class: 'switch-line'}, h('span', {class: 'switch-word'}, w))));

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
  private readonly folders = new RepoFolders((repo, origin) => this.choose(repo, origin));
  /** main's sheet, at the desk's edge: the steps of the issue in full, a line a step (issueSteps). */
  private readonly steps = h('div', {class: 'git-switch', role: 'group', 'aria-label': t('Steps')});
  /** At the desk's edge: main's sheet. Not there while there is no repo. */
  private readonly side: HTMLElement;
  /** What is so, said at the foot of the issue not written yet while there is no open issue. */
  private noneSaid = '';
  private readonly count = h('small', {});
  /** Where the issues would be when there are none: the empty place that writes the first, or what is so. */
  private readonly empty = h('div', {}, h('p', {class: 'muted small'}, t('Loading…')));
  private readonly row: IssueRow;
  private readonly sections = new Sections();
  private readonly workbench: Bench;
  private readonly places: ReturnType<typeof workPlaces>;
  private repos: string[] = [];
  /** The repo looked at: the reference and the Prompt point at it. */
  private at: string | null = null;
  /** Want and shown are distinct: a fetch never renames the old desk or gets to choose on a stale reply. */
  private wants: string | null = null;
  private route = linked;
  private origin: HTMLElement | null = null;
  private rememberRepo = false;
  private listing = 0;
  private cancelRestore: (() => void) | null = null;
  private states = new Map<string, RepoState>();
  private readonly events: IssueEvents;
  private readonly again = () => void this.paint();
  // Refreshes of the same desk coalesce; a choice of a different desk never waits for an obsolete read.
  private drawing: {repo: string | null; again: boolean; promise: Promise<void>} | null = null;
  private timer = 0;
  /** The issue the row goes to once it is drawn (one reopened), from the one in full before. */
  private slideTo: string | null = null;
  /** Drawn once: what is drawn after that moves from what it was (goOn); the first drawing is simply there. */
  private laid = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
    linked = null;
    this.side = h('div', {class: 'git-side none'}, this.folders.element, this.steps, this.sections.main);
    wholeCells(this.side);
    this.row = new IssueRow({
      landed: (i, moved) => this.landed(i, moved),
      slot: (x, now) => this.slot(x, now),
      tail: (now) => this.tail(now),
      landedTail: () => { if (this.at) chosenIn.set(this.at, NEW); },
      slid: () => {},
    });
    this.events = {
      open: (repo, path) => ctx.openRepo(repo, path),
      // The repo shows another copy: what File, Forge and the issues read is that copy now.
      // Started, continued or back on main: that repo is the one worked on.
      moved: (repo) => { ctx.remember(repo); if (repo === this.at) void this.paint(); },
      aside: (i) => this.row.aside(key(i)),
      back: (i) => { this.slideTo = key(i); },
    };
    this.workbench = this.bench();
    this.element = this.workbench.element;
    this.element.classList.add('git-layout');
    this.element.prepend(h('h1', {class: 'git-title'}, t('Git')));
    this.places = workPlaces(this.element, (place) => {
      if (place === 'Git') return;
      if (this.at) ctx.remember(this.at);
      if (ctx.forgePlace) void ctx.forgePlace(place); else void ctx.go('forge');
    }, () => ctx.placeCommands?.(['forge']) ?? []);
    this.places.set('Git', false);
    this.drawKnown();
    this.load();
    this.watch();
  }

  /** The named main sheet at the left, the paper in hand beside it, and the record below. */
  private bench(): Bench {
    const main = h('section', {class: 'flow git-flow git-desk', tabindex: '0', 'aria-label': 'Git'},
      // At the desk's edge, beside the row: main's sheet, the steps of the issue in hand.
      this.side,
      h('section', {class: 'section git-issues', 'aria-labelledby': 'issues-title'},
        h('div', {class: 'issues-head'}, h('h2', {id: 'issues-title'}, h('span', {}, t('Issues'), ' ', this.count))),
        this.empty, this.row.column),
      ...this.sections.under);
    return bench({strip: h('span', {class: 'bar-room', 'aria-hidden': 'true'}), main, reveal: (path) => { if (this.at) this.ctx.openRepo(this.at, path); }, word: (a) => { openConversation(a); void this.ctx.go('inbox'); }, back: true, paneless: true,
      went: (repo, to) => {
        if (to === 'todo') { void this.ctx.go('home'); return; }
        if ('file' in to) { this.ctx.openRepo(repo, to.file); return; }
        this.route = {repo, issue: `${repo}/${to.issue.replace(/^issue\//, '')}`};
        chosenIn.set(repo, this.route.issue);
        if (this.repos.includes(repo)) this.choose(repo, null); else this.load();
      }});
  }

  /** The repo this desk now shows is also the one to which the existing reference and shell point. */
  private look(repo: string | null, remember = false) {
    if (this.at !== repo) this.workbench.setRepo(repo);
    this.at = repo;
    this.folders.show(this.repos, repo);
    this.places.set('Git', !!repo);
    if (repo && remember) this.ctx.remember(repo);
  }

  private first(names: readonly string[]) {
    const first = [this.route?.repo, this.wants, this.at, this.ctx.repo].find(name => !!name && names.includes(name));
    return first || names[0] || null;
  }

  /** A return can show the last desk at once, then read it again without replacing it if it is unchanged. */
  private drawKnown() {
    const repos = reposRead;
    if (!repos?.length || !connection()) return;
    const repo = this.first(repos);
    if (!repo || !stood.has(repo) || !issuesRead.has(repo)) return;
    this.repos = repos;
    this.wants = repo;
    this.take(repo, issuesRead.get(repo)!, new Map([[repo, stood.get(repo)!]]));
  }

  private load() {
    const listing = ++this.listing;
    void store.names().then((names) => {
      if (listing !== this.listing || !this.element.isConnected) return;
      this.repos = names;
      if (this.route && !names.includes(this.route.repo)) this.route = null;
      reposRead = this.repos;
      this.wants = this.first(this.repos);
      this.folders.show(this.repos, this.at);
      void this.paint();
    }, (error: unknown) => {
      if (listing === this.listing && this.element.isConnected) this.failed(error);
    });
  }

  /** Choosing is explicit Git navigation. Keep the current paper throughout the read; no placeholder issue. */
  private choose(repo: string, origin: HTMLElement | null) {
    if (!this.repos.includes(repo)) return;
    this.cancelRestore?.();
    if (this.route?.repo !== repo) this.route = null;
    if (repo !== this.wants) this.slideTo = null;
    this.wants = repo;
    this.origin = origin;
    this.rememberRepo = true;
    this.folders.say(repo !== this.at ? t('Loading…') : '');
    void this.paint();
  }

  private failed(error: unknown) {
    this.wants = this.at;
    this.route = null;
    this.origin = null;
    this.rememberRepo = false;
    if (this.at) this.folders.say(errorText(error));
    else this.empty.replaceChildren(h('p', {class: 'error', role: 'alert'}, errorText(error)));
  }

  private issueInHand() { return this.row.current()?.key ?? (this.row.atTail ? NEW : null); }

  private saveView() {
    if (!this.at) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = !active || this.folders.owns(active) || active === document.body ? this.origin : active;
    const doc = document.scrollingElement;
    visited.set(this.at, {issue: this.issueInHand(), top: doc?.scrollTop ?? 0, left: doc?.scrollLeft ?? 0,
      focus: bookmark(this.element, el)});
  }

  private restoreView() {
    this.cancelRestore?.();
    const visit = this.at ? visited.get(this.at) : undefined;
    const doc = document.scrollingElement;
    if (!doc || !this.element.isConnected || this.element.closest('[hidden], [inert]')) return;
    const same = visit?.issue === this.issueInHand();
    let wanted = same ? visit?.focus ?? null : null;
    const top = same ? visit?.top ?? 0 : 0;
    const left = same ? visit?.left ?? 0 : 0;
    const controller = new AbortController();
    const {signal} = controller;
    const grows = new ResizeObserver(put);
    const ends = window.setTimeout(stop, 1500);
    const desk = this.element;
    const belongs = () => !desk.isConnected || !!desk.closest('[hidden], [inert]');
    this.cancelRestore = stop;
    for (const event of ['wheel', 'pointerdown', 'touchmove', 'keydown']) window.addEventListener(event, stop, {capture: true, passive: true, signal});
    function stop() { controller.abort(); grows.disconnect(); clearTimeout(ends); }
    function put() {
      if (belongs()) { stop(); return; }
      if (wanted) {
        const element = desk.querySelectorAll<HTMLElement>(wanted.selector)[wanted.ordinal];
        if (element?.getClientRects().length && !element.matches(':disabled, [inert]') && !element.closest('[inert]')) {
          element.focus({preventScroll: true});
          const selection = wanted.selection;
          if (selection && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
            && selection[0] !== null && selection[1] !== null) element.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
          wanted = null;
        }
      }
      doc!.scrollTop = top;
      doc!.scrollLeft = left;
      if (!wanted && doc!.scrollTop >= top - 1 && doc!.scrollLeft >= left - 1) stop();
    }
    this.folders.focus();
    grows.observe(this.element);
    put();
  }

  // ---- the row of issues ----

  /** Issue `i` on screen: the one shown, its repo the one looked at (and worked on, when the person went to it). */
  private landed(i: Issue, moved: boolean) {
    chosenIn.set(i.repo, key(i));
    if (moved) this.ctx.remember(i.repo);
  }

  /**
   * What issue `x`'s slot holds. Each issue is a column: its card, and once pushed, its Review and Merge under it,
   * so they slide with it. The neighbours show only their heads.
   */
  private slot(x: Issue, now: boolean): HTMLElement[] {
    if (!now) return [h('div', {class: 'issue-card'}, issueHead(x, true))];
    const st = this.states.get(x.repo);
    // The steps follow the issue in hand. The desk is named once, over main.
    // (A step taken from the keyboard: drawn again, the keyboard is on the same line, the page not moved.)
    const on = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.git-switch [data-step]')?.dataset.step;
    this.steps.replaceChildren(issueSteps(x, st, this.events, this.again));
    if (on) this.steps.querySelector<HTMLElement>(`[data-step="${on}"] > button`)?.focus({preventScroll: true});
    // Under the current box, out of it: Back to main at its left, for the issue the repo shows.
    const leave = backToMain(x, st, this.events, this.again);
    // Under the sheet, read down a dotted line from its foot: the change's Review (its history at the line, what it
    // changes and what is said of it at the right), and where the line ends, what is done to the issue from here.
    const {box, history: review} = issuePaper(x, st, this.events, this.again);
    const merge = mergeRow(x, st, this.again);
    const after = review || leave || merge
      ? h('div', {class: 'issue-after'}, h('div', {class: 'issue-run'}, review), leave || merge ? h('div', {class: 'issue-end'}, leave, merge) : null) : null;
    return [h('div', {class: 'issue-card'}, box), after].filter((n): n is HTMLElement => !!n);
  }

  /**
   * The row's last slot: the issue not written yet, going into the repo looked at. In the hand, main's sheet beside it
   * has the steps it will have, every one waiting: the sheet stays where it stands as the row goes along.
   */
  private tail(now: boolean): HTMLElement[] {
    const repo = this.at;
    if (now) this.steps.replaceChildren(waiting());
    return [newIssue(now, repo, this.noneSaid, {made: (made) => this.written(made), back: () => this.row.back()})];
  }

  /**
   * Made at the row's end: its repo is the one looked at and worked on, and the new issue is the one shown, there at
   * once where it was written, the keyboard in its summary to go on writing it.
   */
  private written(made: Made) {
    const file = `${made.repo}/${made.file.replace(/^issue\//, '')}`;
    chosenIn.set(made.repo, file);
    if (made.repo === this.wants) {
      this.slideTo = file;
      this.row.land = 'summary';
      void this.paint();
    }
  }

  // ---- drawing ----

  private paint(): Promise<void> {
    const repo = this.wants;
    if (this.drawing?.repo === repo) {
      this.drawing.again = true;
      return this.drawing.promise;
    }
    const task = {repo, again: false, promise: Promise.resolve()};
    this.drawing = task;
    const current = () => this.drawing === task && !task.again && this.element.isConnected;
    task.promise = this.draw(repo, current).finally(() => {
      if (this.drawing !== task) return;
      this.drawing = null;
      if (task.again) void this.paint();
    });
    return task.promise;
  }

  private async draw(repo: string | null, current: () => boolean) {
    try {
      const issues = repo ? await readIssues(issueStore, repo) : [];
      if (!current()) return;
      const states = new Map<string, RepoState>();
      if (repo && connection()) await standings([repo], states);
      if (!current()) return;
      if (repo) {
        const state = states.get(repo);
        if (state) stood.set(repo, state);
        issuesRead.set(repo, issues);
      }
      if ((await renumber(issues, states)).some(Boolean)) return;
      if (current()) this.take(repo, issues, states);
    } catch (error) {
      if (current()) this.failed(error);
    }
  }

  private take(repo: string | null, issues: Issue[], states: Map<string, RepoState>) {
    const switched = this.at !== repo;
    const moveBetween = switched && this.at !== null && repo !== null;
    if (switched) this.saveView();
    this.look(repo, this.rememberRepo || !!this.route);
    this.states = states;
    this.origin = null;
    this.rememberRepo = false;
    this.folders.say();
    if (repo && this.route?.repo === repo) {
      this.slideTo = this.route.issue;
      this.row.land = true;
      this.route = null;
    }
    const shown = repo ? [repo] : [];
    if (!switched && !this.slideTo && this.laidFrom === JSON.stringify([shown, issues, [...states]])) return;
    knowIssues(issues);
    this.lay(shown, issues, switched);
    if (moveBetween) this.restoreView();
  }

  /** What was laid out last, as read: the same read again is not drawn again. */
  private laidFrom = '';

  /** The issues of `shown` and the sections round them, drawn from `issues` and where each repo stands now. */
  private lay(shown: string[], issues: Issue[], switched: boolean) {
    this.laidFrom = JSON.stringify([shown, issues, [...this.states]]);
    // Oldest first, so #1 is on the left; merged and closed ones are done with, and listed under the issues.
    const laid = laidOut(shown, issues, this.states);
    const before = this.stood();
    // Moves go on from what was drawn; not the first drawing, nor while a box goes down into its line (git/issue.ts
    // mergeRow): what that lands on stays where it was found.
    const moving = this.laid && !switched && !still() && !document.querySelector('.morph-box');
    this.laid = true;
    const row = !this.row.stage.hidden, none = !!this.empty.firstElementChild;
    this.counted(laid.open.length);
    this.sections.draw(laid, this.at ?? '', this.states, this.events, this.again, moving);
    if (laid.open.length) this.drawSome(laid.open, switched); else this.drawNone(issues);
    const card = this.row.current();
    if (!moving) return;
    this.goOn(before);
    // The row come into sight (an issue reopened, one come from elsewhere): its box comes in, not there at once; the
    // words said where the first would be, there again once the last has gone, the same.
    if (!row && card) arrive(card.card, 1, 'y', 10, 260);
    if (!none && this.empty.firstElementChild) this.empty.animate([{opacity: 0}, {opacity: 1}], {duration: cut() ? 0 : paced(220), easing: SPRING});
  }

  /** The same issue's paper and lower history are the only surface allowed to crossfade on an update. */
  private stood() {
    const card = this.row.current();
    const below = [...card?.card.parentElement?.children ?? []].filter((c) => c !== card?.card);
    const under = below.map((c) => c.className);
    const tall = new Map(below.map((c) => [c.className, c.getBoundingClientRect().height]));
    return {card, under, tall};
  }

  private goOn(was: ReturnType<GitPage['stood']>) {
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
      c.animate([{opacity: 0, translate: '0 8px'}, {opacity: 1, translate: '0 0'}], {duration: cut() ? 0 : paced(260), delay: cut() ? 0 : paced(100), easing: LAND, fill: 'backwards'});
    }
  }

  /** No repo at all (a first run): the first made, the whole card the deed, as Forge's and Home's New repo are. */
  private firstRepo(): HTMLElement {
    const b = h('button', {type: 'button', class: 'card new issue-new'}, icon('new-repo'), h('span', {}, t('Create your first repo')),
      h('small', {class: 'muted'}, t('No repos yet'))) as HTMLButtonElement;
    b.addEventListener('click', () => void this.ctx.go('new-repo'));
    amidOnGrid(b);
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
    this.noneSaid = '';
    this.side.classList.remove('none');
    const to = this.slideTo === null ? -1 : open.findIndex((i) => key(i) === this.slideTo);
    this.slideTo = null;
    // Gone to from the one in full (one reopened), the row slides there; one just written is there at once, where the
    // box it was written in stood (`inPlace`).
    const repo = this.at;
    const mine = repo ? chosenIn.get(repo) : null;
    if (to >= 0) { this.row.fill(open, to, inPlace ? -1 : open.findIndex((i) => key(i) === mine)); return; }
    // (On the issue not written yet, the row stays there.)
    let was = mine === NEW ? open.length : open.findIndex((i) => key(i) === mine);
    const work = repo ? this.states.get(repo)?.work : null;
    if (was < 0 && work && work.line !== 'main') was = open.findIndex((i) => i.repo === repo && issuePath(i) === work.issue);
    if (was < 0 && repo) was = open.findIndex((i) => i.repo === repo);
    this.row.fill(open, was >= 0 ? was : 0);
  }

  /**
   * None open: the issue not written yet alone in the row, in the hand at the desk's edge where the first would be,
   * what is so said quietly at its foot. No repo: nothing to write an issue in; the first repo made, said once.
   */
  private drawNone(issues: Issue[]) {
    this.slideTo = null;
    this.row.land = false;
    this.side.classList.toggle('none', !this.repos.length);
    if (!this.repos.length) {
      this.row.none();
      this.steps.replaceChildren();
      this.empty.replaceChildren(remoteOnly().length ? this.onlyThere() : this.firstRepo());
      return;
    }
    this.empty.replaceChildren();
    this.noneSaid = issues.length ? t('No open issues') : t('No issues yet');
    this.row.fill([], 0);
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
   * Issues written anywhere (here, in the shell, with why in the Prompt) show up at once, and any change in the repo
   * looked at is read again; not while something is being written in the box or under it, which would be lost.
   */
  private watch() {
    const stop = onChange((c) => {
      if (!this.element.isConnected) { stop(); return; }
      if (c.what === 'repo') { this.load(); return; }
      if (c.repo === this.at || c.repo === this.wants) this.soon();
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
