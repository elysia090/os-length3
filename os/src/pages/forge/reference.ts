import {h} from '../../ui/dom.ts';
import {glide, LAND, paced, still, where} from '../../ui/glide.ts';
import {counted} from './diff-view.ts';
import * as gitops from '../../repos/history.ts';
import {issuePath, readIssues, type Issue} from '../../repos/issues.ts';
import {t} from '../../i18n.ts';
import {onChange, onRenamed, rekey, store} from '../../repos/repos.ts';
import {stillAt} from '../../repos/search.ts';
import {sessionIfAny, type Run} from '../bench/terminal.ts';
import {errorText} from '../../app/errors.ts';
import {diffButton, issueButton, issueLabel, issueOne, KINDS, markedDiff, openIssues, runButton, runView, type Kind} from './kinds.ts';
import {foundView, patched, readAll, search, type Files} from './found.ts';
import {drawLine, remember, seenButton, seenIn, seenKey, seenKind, seenLabel, type Seen, type Slot} from './seen.ts';
import {issueStore} from '../../repos/issue-store.ts';

// The way to what the center refers to: the search box over the right pane,
// reaching a quarter of the pane's width into the center so that what opens
// under it is not cut off (issue #20); with the pane put away the box goes too, its room kept (issue #45).
// Out of use, nothing of it is under the box and the right pane is straight.
// Pressed, under the box at its width: Issue, diff and Output side by side to
// switch between (kinds.ts), and under them a large box: what was searched and read here,
// newest first. Something typed: what is found in the repo's files and, of
// the one pressed (or all three), its issues, its changes and its runs (found.ts). What
// is searched and read lines up sideways, in the order it came (seen.ts): the one in
// hand fills the box, the ones beside it hidden past its edges but for a
// sliver, pressed (or ← →) to move to them. A file or a line opens in the
// center. Each repo keeps its own search, switch and line while the app runs.
// At rest the right pane says the three beside the Prompt's head (`heads`, diff with how many files are changed):
// pressed there, or on the switch, a kind's list stays out while the keyboard goes back to the file, as something
// read does, until it is put away (Escape, or pressed again).

/** Per repo, while the app is open: what was typed, and the switch pressed (a repo renamed keeps them). */
const queries = new Map<string, string>();
const pills = new Map<string, Kind | null>();
onRenamed((from, to) => { rekey(queries, from, to); rekey(pills, from, to); });

/** The box's card while nothing of the line is in hand: what is found, the switch's list, or what was searched and read. */
type Live = {kind: string; label: string; alone?: boolean};

interface ReferenceEvents {
  /** Scroll the center to a path in the open repo, at `line` if given; with `write`, the caret in it. */
  reveal(path: string, line?: number, write?: boolean): void;
  /** Put a line run before back in the prompt box, to change or send again. */
  recall?(line: string): void;
}

/** Something read under the box: what it is, and how it is drawn again when the repo changes. */
type Reading = {seen: Seen; draw: () => Promise<void> | void};

let made = 0;

/** The search box and what opens under it, for a page that has one (Forge's and Git's bench, Home). */
export class Reference {
  /** The search box and what is under it, for the top line over the right pane. */
  readonly search: HTMLElement;
  private query: HTMLInputElement;
  /** The box gets the keyboard, what is written in it selected (Ctrl+K, Ctrl+P: writing replaces it). */
  findNow() { this.query.focus(); this.query.select(); }
  /** Where no band says which repo it is (Home's), the box names it: "Search garden". */
  named(repo: string | null) { this.say(repo ? t('Search {repo}', {repo}) : this.repo ? t('Search this repo') : t('No repo to search')); }
  /** Under the box: the switch, and under it the large box with what was searched and read in a line. */
  private under: HTMLElement;
  private pillButtons = new Map<Kind, HTMLButtonElement>();
  /** Issue, diff and Output as the pane says them at rest, beside the Prompt's head: pressed, their list opens here. */
  readonly heads: HTMLElement;
  private headButtons = new Map<Kind, HTMLButtonElement>();
  /** A kind's list opened from its pill or its head: it stays out while the keyboard is elsewhere, until put away. */
  private held = false;
  /** Whether a kind's list chosen is held out (a bench's, where a file is written beside it; not Home's). */
  private keeps: boolean;
  private countTimer = 0;
  private panel: HTMLElement;
  /** The inside of the card in hand, where what is found, listed or read is drawn. */
  private body: HTMLElement = h('div', {class: 'found-body'});
  /** The card's foot, at the box's bottom: what is done to what is read there (a diff's Put back). */
  private foot: HTMLElement = h('div', {class: 'found-foot'});
  private repo: string | null = null;
  private events: ReferenceEvents;
  private files: Promise<Files> | null = null;
  private timer = 0;
  private findTimer = 0;
  private found = 0;
  /** Something saved since what is under the box was drawn, while it had the keyboard: drawn again once it does not. */
  private dirty = false;
  private reading: Reading | null = null;
  private unwatch: (() => void) | null = null;
  /** Stops following the store; null while it does not (off the screen). */
  private stop: (() => void) | null = null;
  /** What had the keyboard before the search took it (from outside the search and what is under it). */
  private before: HTMLElement | null = null;
  /** What is under the box going back up into it, while it goes. */
  private leaving: Animation | null = null;

  /** Begin a new issue in the repo shown, from the Issue pill with none open (the page says where it is written). */
  writeIssue: ((repo: string) => void) | null = null;

  constructor(events: ReferenceEvents, o: {keeps?: boolean} = {}) {
    this.events = events;
    this.keeps = !!o.keeps;
    const n = ++made;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: t('Search this repo'),
      'aria-label': t('Search this repo'), autocomplete: 'off', spellcheck: 'false', 'aria-controls': `found-${n}`}) as HTMLInputElement;
    const pillRow = h('div', {class: 'search-pills', role: 'group', 'aria-label': t('What to look in')}, ...KINDS.map(({kind, label}) => {
      const b = h('button', {type: 'button', class: 'chip pill-kind', 'aria-pressed': 'false'}, label()) as HTMLButtonElement;
      b.addEventListener('click', () => this.press(kind));
      this.pillButtons.set(kind, b);
      return b;
    }));
    this.heads = h('div', {class: 'pane-heads', role: 'group', 'aria-label': t('What to look in')}, ...KINDS.map(({kind, label}) => {
      const b = h('button', {type: 'button', class: 'pane-head', 'aria-pressed': 'false'}, label(), kind === 'diff' ? h('span', {class: 'pane-head-n'}) : null) as HTMLButtonElement;
      b.addEventListener('click', () => this.fromHead(kind));
      this.headButtons.set(kind, b);
      return b;
    }));
    this.panel = h('div', {class: 'search-panel'});
    // ← → along the line, as along Git's issues and Server's boards.
    this.panel.addEventListener('keydown', (event) => this.alongLine(event));
    this.under = h('div', {class: 'search-results', id: `found-${n}`, role: 'region', 'aria-label': t('Search results')}, pillRow, this.panel);
    this.query.addEventListener('focus', () => { if (this.dirty) { this.dirty = false; void this.draw(); } else if (!this.panel.childElementCount) void this.draw(); });
    // Pressed with nothing typed: what was searched and read, even from something read in the line.
    this.query.addEventListener('click', () => { if (!this.query.value && this.reading) { this.close(); void this.draw(); } });
    this.query.addEventListener('input', () => {
      this.keep();
      this.close();
      clearTimeout(this.findTimer);
      this.findTimer = window.setTimeout(() => void this.draw(), 150);
    });
    this.query.addEventListener('focus', (event) => {
      const from = event.relatedTarget as HTMLElement | null;
      if (!from || !this.search.contains(from)) this.before = from;
    });
    this.query.addEventListener('keydown', (event) => this.queryKey(event));
    // Along what is there with ↑ ↓; Escape goes back up to the box (from something read: back to what it was chosen from).
    this.panel.addEventListener('keydown', (event) => this.alongList(event));
    // Ctrl+K (⌘+K) comes to it from anywhere; the box does not say so on itself, as an editor's would.
    this.query.setAttribute('aria-keyshortcuts', /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta+K' : 'Control+K');
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.search = h('div', {class: 'search-box'}, form, this.under);
    this.goesUp();
    this.follow();
  }

  /** What the box says where the words would be, and is heard as. */
  private say(words: string) {
    this.query.placeholder = words;
    this.query.setAttribute('aria-label', words);
  }

  /** ← → on the line (or a sliver at its edge): to the one beside. */
  private alongLine(event: KeyboardEvent) {
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !(event.target as HTMLElement).matches('.slide-stage, .stage-hit')) return;
    const hit = this.panel.querySelector<HTMLButtonElement>(`.stage-hit.${event.key === 'ArrowLeft' ? 'prev' : 'next'}`);
    if (hit && !hit.hidden) { event.preventDefault(); hit.click(); }
  }

  /** ↑ ↓ along what can be chosen under the box, up into the box from the first; Escape back up to the box. */
  private alongList(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); if (this.reading) { this.close(); void this.draw(); } this.query.focus(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const all = this.choices();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && at === 0) this.query.focus();
    else all[Math.min(at + (event.key === 'ArrowDown' ? 1 : -1), all.length - 1)]?.focus();
  }

  /** Keys in the box: Escape, ↓ down into what is under it, Enter. */
  private queryKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') { this.escape(event); return; }
    // ↓ goes down into what is under the box; Enter takes the first of it: the first line found, or before it a file
    // whose name holds what was typed (the caret in it). A file's name found by its lines alone, and its diff, are
    // pressed, not gone along (found.ts).
    if (event.key === 'ArrowDown') { const first = this.choices()[0]; if (first) { event.preventDefault(); first.focus(); } return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      // The first found is taken (what was typed goes in the line before it); with none, what was typed does.
      const first = this.choices()[0];
      const q = this.query.value.trim();
      if (first) first.click();
      else if (q) { this.remember({what: 'query', text: q}); void this.draw(); }
    }
  }

  /** Escape in the box: what is read goes, else what is typed, else the box lets go of the keyboard. */
  private escape(event: KeyboardEvent) {
    if (this.reading) { event.preventDefault(); this.close(); void this.draw(); return; }
    if (this.query.value) { event.preventDefault(); this.query.value = ''; this.keep(); void this.draw(); return; }
    // Nothing typed and nothing read: what is under the box goes (a kind's list held out with it).
    event.preventDefault();
    this.putAway();
  }

  /**
   * What is under the box put away (Escape with nothing typed or read, or its ×): what is read or held out goes, the
   * pane is straight again, and the keyboard, if it was in the search, goes back to what had it before the search
   * took it, where it is still to be had; never left on nothing.
   */
  private putAway() {
    const out = this.search.matches('.reading, .kept') && !this.search.contains(document.activeElement);
    this.held = false;
    this.close();
    this.paintPills();
    if (out) this.goUp();
    if (!this.search.contains(document.activeElement)) return;
    const back = this.before;
    this.before = null;
    if (back?.isConnected && !back.closest('[hidden], [inert]') && back.getClientRects().length) back.focus({preventScroll: true});
    else (document.activeElement as HTMLElement).blur();
  }

  /**
   * Let go (the keyboard gone elsewhere, Escape with nothing typed, or put away by its × while the keyboard is
   * elsewhere), what is under the box goes back up into it as it came down out of it, not at once (styles.css
   * .leaving); come back to meanwhile, it stays.
   */
  private goesUp() {
    this.search.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      // (Asked as the keyboard leaves, when it is no longer within: the box itself is what must be on screen.)
      if ((to && this.search.contains(to)) || this.search.matches('.reading, .moving, .kept')) return;
      this.goUp();
    });
    this.search.addEventListener('focusin', () => { this.leaving?.cancel(); this.leaving = null; this.search.classList.remove('leaving'); });
  }

  /** What is under the box going back up into it. */
  private goUp() {
    if (still() || !this.search.getClientRects().length) return;
    this.search.classList.add('leaving');
    const a = this.leaving = this.under.animate([{opacity: 1, transform: 'none'}, {opacity: 0, transform: 'translateY(calc(-1 * var(--s2)))'}],
      {duration: paced(150), easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards'});
    a.finished.then(() => { if (this.leaving !== a) return; this.leaving = null; this.search.classList.remove('leaving'); a.cancel(); }, () => {});
  }

  /** What can be chosen in the card in hand, in order. */
  private choices(): HTMLElement[] { return [...this.body.querySelectorAll<HTMLElement>('button.choice')]; }

  private get pill(): Kind | null { return this.repo ? pills.get(this.repo) ?? null : null; }

  /** A pill pressed shows what of its kind there is (or what of it was found); pressed again, it lets go. */
  private press(kind: Kind) {
    if (!this.repo) return;
    // From one kind to another the ink goes along the row to it, as along Git's.
    const was = this.pill && this.pill !== kind ? where(this.pillButtons.get(this.pill)) : null;
    pills.set(this.repo, this.pill === kind ? null : kind);
    // Chosen, its list stays out while one writes beside it; let go, it is under the box only while the box is in use.
    this.held = this.keeps && this.pill !== null;
    this.close();
    void this.draw();
    this.paintPills();
    const to = this.pillButtons.get(kind);
    if (to?.parentElement) glide(was, to, to.parentElement, 'var(--r-round)');
    this.query.focus({preventScroll: true});
  }

  private paintPills() {
    for (const [kind, b] of this.pillButtons) b.setAttribute('aria-pressed', String(this.pill === kind));
    for (const [kind, b] of this.headButtons) b.setAttribute('aria-pressed', String(this.held && this.pill === kind));
    this.search.classList.toggle('kept', this.held && this.pill !== null);
  }

  /**
   * A head in the pane pressed: its kind's list opens under the box, as from its pill, and stays out while the
   * keyboard goes back to the file; pressed while it is out, it is put away.
   */
  private fromHead(kind: Kind) {
    if (!this.repo) return;
    if (this.pill !== kind) { this.press(kind); return; }
    this.held = !this.held;
    this.close();
    void this.draw();
    if (this.held) this.query.focus({preventScroll: true});
  }

  /** How many files are changed since the last commit, said beside diff in the pane (none: nothing). */
  private countChanges() {
    clearTimeout(this.countTimer);
    const repo = this.repo;
    this.countTimer = window.setTimeout(() => void (repo ? gitops.changes(repo).then((c) => c.files, () => 0) : Promise.resolve(0)).then((n) => {
      const at = this.headButtons.get('diff')?.querySelector('.pane-head-n');
      if (at && repo === this.repo) at.textContent = n ? String(n) : '';
    }), 300);
  }

  /**
   * What is under the box follows what is saved, here or in the Prompt: what is read, the lists, what was found.
   * Off the screen it stops following; a page that comes back with it (Forge's, Git's) calls `resume`.
   */
  private follow() {
    const stop = onChange((c) => {
      if (!this.search.isConnected) { stop(); this.stop = null; return; }
      if (c.repo !== this.repo) return;
      this.countChanges();
      if (this.files) this.files = patched(this.files, c);
      // Not drawn away from under the keyboard: what has it is kept until the box has it again (asked again when
      // the moment comes, the keyboard having gone down into it meanwhile).
      const held = () => this.panel.contains(document.activeElement) && !this.reading;
      if (held()) { this.dirty = true; return; }
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { if (held()) this.dirty = true; else void (this.reading ? this.reading.draw() : this.draw()); }, 250);
    });
    this.stop = stop;
  }

  /** Back on the screen: following again, and drawn afresh (what changed meanwhile is in it). */
  resume() {
    if (!this.stop) this.follow();
    this.files = null;
    this.countChanges();
    void (this.reading ? this.reading.draw() : this.draw());
  }

  /** The repo shown; what was searched, the pill and the history in it come back with it. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.query.disabled = !repo;
    // With no repo it cannot be searched in, and says so where the words would be.
    this.say(repo ? t('Search this repo') : t('No repo to search'));
    this.query.value = repo ? queries.get(repo) ?? '' : '';
    this.held = false;
    this.close();
    void this.draw();
    this.countChanges();
  }

  /** The repo's Prompt is another one now (started, or started again): Output follows that one. */
  runsAgain() { if (this.repo && (this.pill === 'output' || this.reading?.seen.what === 'run')) void (this.reading ? this.reading.draw() : this.draw()); }

  private keep() {
    if (!this.repo) return;
    if (this.query.value) queries.set(this.repo, this.query.value); else queries.delete(this.repo);
  }

  /** Something searched or read here, at the line's end (once: the same thing again stays where it is). */
  private remember(s: Seen) { if (this.repo) remember(this.repo, s); }

  /**
   * The large box: the line of what was searched and read (files aside: they open in the center), with `at` in
   * hand, or the live card at its end (`live`: what is found, the switch's list) or alone (what was searched and
   * read). The card in hand fills it; its neighbours show a sliver past its edges, pressed to move to them, as
   * are ← and → under the box.
   */
  private frame(at: Seen | null, live: Live | null) {
    const line = live?.alone ? [] : seenIn(this.repo ?? '').filter((s) => s.what !== 'file');
    // What is typed is already in the line: that place is the one in hand, not another card at its end.
    const typed = live && !live.alone && live.kind === t('Searched') ? line.findIndex((s) => s.what === 'query' && s.text === live.label) : -1;
    const slots: Slot[] = line.map((s) => ({kind: seenKind(s), label: seenLabel(s), go: () => void this.again(s)}));
    let k = at ? line.findIndex((s) => seenKey(s) === seenKey(at)) : typed;
    if (k < 0 && live) { slots.push({kind: live.kind, label: live.label, go: () => { this.close(); void this.draw(); }}); k = slots.length - 1; }
    if (k < 0) k = slots.length - 1;
    this.body = h('div', {class: 'found-body'});
    this.foot = h('div', {class: 'found-foot'});
    drawLine(this.search, this.panel, slots, k, [this.body, this.foot], () => this.putAway());
  }

  /** Nothing is read under the box any more. */
  private close() {
    this.reading = null;
    this.search.classList.remove('reading');
    this.unwatch?.();
    this.unwatch = null;
  }

  /** Read `seen` in the box, in hand in the line, until another is taken or Escape. */
  private open(seen: Seen, draw: (into: HTMLElement, foot: HTMLElement) => Promise<void> | void) {
    const moving = this.panel.contains(document.activeElement);
    this.close();
    // What was typed comes before what was chosen from it: it is the neighbour to go back to.
    const query = this.query.value.trim();
    if (query) this.remember({what: 'query', text: query});
    this.remember(seen);
    this.frame(seen, null);
    const into = this.body, foot = this.foot;
    this.reading = {seen, draw: async () => { await draw(into, foot); }};
    this.search.classList.add('reading');
    void this.reading.draw();
    if (moving && !this.panel.contains(document.activeElement)) this.panel.querySelector<HTMLElement>('.slide-stage')?.focus({preventScroll: true});
  }

  /** What is in the box now: what was found, the switch's list, or what was searched and read. */
  private async draw() {
    this.paintPills();
    if (this.reading) return;
    const query = this.query.value.trim();
    const repo = this.repo;
    if (!repo) { this.panel.replaceChildren(h('p', {class: 'muted small'}, t('Open a repo to search it'))); return; }
    if (query) { this.frame(null, {kind: t('Searched'), label: query}); return this.find(query); }
    const kind = this.pill;
    if (kind) { this.frame(null, {kind: KINDS.find((k) => k.kind === kind)!.label(), label: ''}); return this.list(kind); }
    // Nothing typed, nothing pressed: what was searched and read here, newest first.
    this.frame(null, {kind: t('Searched and read'), label: '', alone: true});
    const seen = seenIn(repo).slice().reverse();
    if (!seen.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('What is searched and read here comes back here'))); return; }
    this.body.replaceChildren(h('ul', {class: 'found-list'}, ...seen.map((s) => h('li', {}, seenButton(s, (x) => void this.again(x))))));
  }

  private async again(s: Seen) {
    const repo = this.repo;
    if (!repo) return;
    if (s.what === 'query') { this.close(); this.query.value = s.text; this.keep(); void this.draw(); return; }
    if (s.what === 'file') { this.events.reveal(s.path, 0, true); return; }
    if (s.what === 'diff') { this.readDiff(s.path); return; }
    if (s.what === 'run') {
      const r = (sessionIfAny(repo)?.runs ?? []).find((x) => x.started === s.started);
      if (r) this.readRun(r);
      else { this.open(s, (into) => { into.replaceChildren(h('p', {class: 'muted small'}, t('That run is no longer here'))); }); }
      return;
    }
    const issue = (await openIssues(repo).catch(() => [])).find((i) => issuePath(i) === s.path)
      ?? (await readIssues(issueStore, repo).catch(() => [])).find((i) => issuePath(i) === s.path);
    if (issue && this.repo === repo) this.readIssue(issue);
  }

  /** The list of `kind` in `repo` is no longer what is under the box: another repo or pill, something read or typed. */
  private listGone(repo: string, kind: Kind) { return this.repo !== repo || this.pill !== kind || !!this.reading || !!this.query.value.trim(); }

  /** The pill's list: the repo's open issues, its changes file by file, or what was run, newest first. */
  private async list(kind: Kind) {
    const repo = this.repo!;
    if (kind === 'issue') return this.listIssues(repo);
    if (kind === 'diff') return this.listDiff(repo);
    this.listRuns(repo);
  }

  private async listIssues(repo: string) {
    const [all, list] = await Promise.all([readIssues(issueStore, repo).catch(() => []), openIssues(repo).catch(() => [])]);
    if (this.listGone(repo, 'issue')) return;
    if (!list.length) {
      const said = h('p', {class: 'muted small'}, all.length ? t('No open issues') : t('No issues yet'));
      // The way to the first one is where its absence is said, for this repo, with nothing to choose again.
      const write = this.writeIssue;
      const w = write ? h('button', {type: 'button', class: 'button small-button choice'}, t('Write an issue')) : null;
      w?.addEventListener('click', () => write!(repo));
      this.body.replaceChildren(said, ...(w ? [w] : []));
      return;
    }
    this.body.replaceChildren(h('ul', {class: 'issue-list'}, ...list.map((i) => h('li', {}, issueButton(i, '', (x) => this.readIssue(x))))));
  }

  private async listDiff(repo: string) {
    let files: gitops.FileDiff[];
    try { files = await gitops.diff(repo); } catch (e) { this.body.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    if (this.listGone(repo, 'diff')) return;
    if (!files.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('No changes'))); return; }
    this.body.replaceChildren(h('ul', {class: 'found-list'}, ...files.map((f) => {
      const add = f.lines.filter((l) => l.kind === 'add').length, del = f.lines.filter((l) => l.kind === 'del').length;
      return h('li', {}, diffButton(f.path, f.binary ? h('span', {class: 'diff-count'}, t('Binary')) : counted(add, del), (p) => this.readDiff(p)));
    })));
  }

  /** What was run, drawn again as the Prompt runs more. */
  private listRuns(repo: string) {
    const session = sessionIfAny(repo);
    const draw = () => {
      if (this.listGone(repo, 'output')) return;
      const runs = session?.runs ?? [];
      if (!runs.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Nothing run yet'))); return; }
      this.body.replaceChildren(h('ul', {class: 'found-list'}, ...runs.slice().reverse().map((r) => h('li', {}, runButton(r, (x) => this.readRun(x))))));
    };
    draw();
    this.unwatch?.();
    this.unwatch = session ? session.watch(draw) : null;
  }

  /** One issue in full; its words open in the center to be changed. */
  private readIssue(issue: Issue) {
    this.open({what: 'issue', path: issuePath(issue), label: issueLabel(issue)}, (into) => {
      into.replaceChildren(issueOne(issue, () => this.events.reveal(issuePath(issue))));
    });
  }

  /** A file's diff, read whole, following every save; its foot puts it back. */
  private readDiff(path: string) {
    const repo = this.repo!;
    this.open({what: 'diff', path}, async (into, foot) => {
      // A foot asking (Put back) is not drawn away from under the person: drawn once it has its answer.
      if (foot.querySelector('.diff-foot.asking')) return;
      let files: gitops.FileDiff[];
      try { files = await gitops.diff(repo); } catch (e) { into.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
      if (this.repo !== repo || this.reading?.seen.what !== 'diff' || this.reading.seen.path !== path) return;
      // Nor one pressed while the diff was being read (a save elsewhere draws it again): its Put back would go.
      if (foot.querySelector('.diff-foot.asking')) return;
      const f = files.find((x) => x.path === path);
      if (!f) { into.replaceChildren(h('p', {class: 'muted small'}, t('No changes'))); foot.replaceChildren(); return; }
      const [fold] = markedDiff(repo, [f], (p, line) => this.events.reveal(p, line));
      (fold as HTMLDetailsElement).open = true;
      into.replaceChildren(fold);
      // Put back at the box's foot, its bottom right: under all the lines, wherever they end.
      const put = fold.querySelector('.diff-foot');
      foot.replaceChildren(...(put ? [put] : []));
    });
  }

  /** One run: its line (pressed, back in the prompt box), how long it took, all it said. */
  private readRun(r: Run) {
    const repo = this.repo!;
    this.open({what: 'run', started: r.started, line: r.line}, (into) => {
      const run = (sessionIfAny(repo)?.runs ?? []).find((x) => x.started === r.started) ?? r;
      into.replaceChildren(runView(run, this.events.recall));
    });
    const session = sessionIfAny(repo);
    if (session) this.unwatch = session.watch(() => void this.reading?.draw());
  }

  /** What is found for `query`: the repo's files and lines, and of the pill pressed (or all three) its issues, changes and runs. */
  private async find(query: string) {
    const repo = this.repo!;
    const run = ++this.found;
    const kind = this.pill;
    if (!this.body.childElementCount) this.body.replaceChildren(h('p', {class: 'muted small'}, t('Searching…')));
    this.files ??= readAll(repo);
    let files: Files, issues: Issue[], changed: gitops.FileChange[];
    try {
      [files, issues, changed] = await Promise.all([this.files, openIssues(repo).catch(() => []),
        gitops.changes(repo).then((c) => c.folders.flatMap((f) => f.files), () => [])]);
    } catch (e) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Could not search: {message}', {message: String(e)}))); return; }
    if (run !== this.found || repo !== this.repo || this.reading) return;
    const said = foundView(search(query, kind, files, issues, changed, sessionIfAny(repo)?.runs ?? []), query, changed, {
      file: (path) => { this.remember({what: 'query', text: query}); this.remember({what: 'file', path}); this.events.reveal(path, 0, true); },
      line: (path, line) => void this.go(path, line, query),
      diff: (path) => this.readDiff(path),
      issue: (i) => this.readIssue(i),
      run: (r) => this.readRun(r),
    });
    if (!said.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Nothing found for “{query}”', {query}))); return; }
    const had = this.choices().indexOf(document.activeElement as HTMLElement);
    // Come in place of Searching… (not redrawn as one types on), what was found comes down the page, a group a beat
    // after the one above it, as its marks are stroked: not the whole sheet in one frame.
    const fresh = !this.body.querySelector('.hit-group, .search-count');
    this.body.replaceChildren(...said);
    if (fresh && !still()) said.slice(0, 8).forEach((el, i) => el.animate([{opacity: 0, translate: '0 4px'}, {opacity: 1, translate: '0 0'}],
      {duration: paced(220), delay: paced(i * 30), easing: LAND, fill: 'backwards'}));
    if (had >= 0) this.choices()[Math.min(had, this.choices().length - 1)]?.focus();
  }

  /**
   * A line found is opened where it is now: what was found may have been saved over since,
   * so the file as saved is looked at first, and the line followed if it moved.
   */
  private async go(path: string, line: number, query: string) {
    const repo = this.repo;
    if (!repo) return;
    const c = await store.read(repo, path).catch(() => null);
    const at = c?.text == null ? null : stillAt(c.text, query, line);
    if (repo !== this.repo) return;
    if (at === null) {
      // Gone: what is found now is said in its place, and nothing is opened.
      this.files = null;
      void this.draw();
      this.query.focus();
      return;
    }
    this.remember({what: 'query', text: query});
    this.remember({what: 'file', path});
    this.events.reveal(path, at);
  }
}
