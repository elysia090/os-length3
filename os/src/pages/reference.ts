import {h} from '../dom.ts';
import {diffFiles, fileName} from './diff-view.ts';
import * as gitops from '../history.ts';
import {issueName, issuePath, readIssues, type Issue} from '../issues.ts';
import {t, tn} from '../i18n.ts';
import {onChange, store, type Change} from '../repos.ts';
import {findInText, nameFirst, nameMatches, stillAt, type Hit} from '../search.ts';
import {sessionIfAny, type Run} from './terminal.ts';
import {answers} from './common.ts';
import {connection} from '../remote.ts';

// The way to what the center refers to: the search box over the right pane,
// reaching a quarter of the pane's width into the center so that what opens
// under it is not cut off (issue #20); with the pane put away the box stays.
// Out of use, nothing of it is under the box and the right pane is straight.
// Pressed, under the box at its width: Issue, diff and Output side by side to
// switch between, and under them a large box: what was searched and read here,
// newest first. Something typed: what is found in the repo's files and, of
// the one pressed (or all three), its issues, its changes and its runs. What
// is searched and read lines up sideways, in the order it came: the one in
// hand fills the box, the ones beside it hidden past its edges but for a
// sliver, pressed (or ← →) to move to them. A file or a line opens in the
// center. Each repo keeps its own search, switch and line while the app runs.

const FILE_LIMIT = 2000;
/** Lines of a run's output shown before "n more lines". */
const RUN_LINES = 40;
const HIT_LIMIT = 200;
/** Issues and runs said under the box for a search, at most. */
const OTHER_LIMIT = 20;
/** What was searched and read, kept per repo, at most (how many is not decided by the issue; a short line). */
const HISTORY = 10;

type Kind = 'issue' | 'diff' | 'output';
const KINDS: {kind: Kind; label: () => string}[] = [
  {kind: 'issue', label: () => t('Issue')}, {kind: 'diff', label: () => t('diff')}, {kind: 'output', label: () => t('Output')},
];

/** One thing searched or read: a query, a file opened from what was found, an issue, a file's diff, a run. */
type Seen = {what: 'query'; text: string} | {what: 'file'; path: string} | {what: 'issue'; path: string; label: string}
  | {what: 'diff'; path: string} | {what: 'run'; started: number; line: string};
const seenKey = (s: Seen) => (s.what === 'query' ? `q:${s.text}` : s.what === 'run' ? `r:${s.started}` : `${s.what}:${s.path}`);

/** What a thing searched or read is called, and what it is. */
const seenLabel = (s: Seen) => (s.what === 'query' ? s.text : s.what === 'issue' ? s.label : s.what === 'run' ? s.line : fileName(s.path));
const seenKind = (s: Seen) => (s.what === 'query' ? t('Searched') : s.what === 'file' ? t('File') : s.what === 'issue' ? t('Issue') : s.what === 'diff' ? t('diff') : t('Output'));

/**
 * Per repo, while the app is open: what was typed, the switch pressed, and what was searched and read, oldest
 * first: the line it makes sideways keeps its order (one come back to stays where it is), so its places hold.
 */
const queries = new Map<string, string>();
const pills = new Map<string, Kind | null>();
const history = new Map<string, Seen[]>();

/** The box's card while nothing of the line is in hand: what is found, the switch's list, or what was searched and read. */
type Live = {kind: string; label: string; alone?: boolean};
/**
 * Lines of each repo's diff marked as with a highlighter, to come back to
 * while reading: kept by what the line is (its file, kind, text and which
 * time that text comes in the file), so a mark stays on its line as the diff
 * is drawn again, and goes when the line does.
 */
const marks = new Map<string, Set<string>>();

export interface ReferenceEvents {
  /** Scroll the center to a path in the open repo, at `line` if given; with `write`, the caret in it. */
  reveal(path: string, line?: number, write?: boolean): void;
  /** Put a line run before back in the prompt box, to change or send again. */
  recall?(line: string): void;
}

type Files = {path: string; text: string}[];

/** The repo's text files, read once per search session. */
async function readAll(repo: string): Promise<Files> {
  const out: Files = [];
  const walk = async (dir: string) => {
    for (const e of await store.tree(repo, dir)) {
      if (out.length >= FILE_LIMIT) return;
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') { await walk(path); continue; }
      if (e.kind !== 'file') continue;
      // Gone since the listing (a Prompt, another device): nothing of it to search.
      const c = await store.read(repo, path).catch(() => null);
      if (c?.text != null) out.push({path, text: c.text});
    }
  };
  await walk('');
  return out;
}

/** The files read for a search, as a change saved since leaves them: the file's new text, or read again. */
function patched(files: Promise<Files>, c: Change): Promise<Files> | null {
  if (c.what !== 'file' || c.text == null) return null;
  return files.then((list) => {
    const at = list.findIndex((f) => f.path === c.path);
    if (at < 0) return [...list, {path: c.path, text: c.text!}];
    const next = list.slice();
    next[at] = {path: c.path, text: c.text!};
    return next;
  });
}

/** Something read under the box: what it is, and how it is drawn again when the repo changes. */
type Reading = {seen: Seen; draw: () => Promise<void> | void};

let made = 0;

export class Reference {
  /** The search box and what is under it, for the top line over the right pane. */
  readonly search: HTMLElement;
  private query: HTMLInputElement;
  /** Under the box: the switch, and under it the large box with what was searched and read in a line. */
  private under: HTMLElement;
  private pillButtons = new Map<Kind, HTMLButtonElement>();
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

  /** Begin a new issue in the repo shown, from the Issue pill with none open (the page says where it is written). */
  writeIssue: ((repo: string) => void) | null = null;

  constructor(events: ReferenceEvents) {
    this.events = events;
    const n = ++made;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: t('Search this repo'),
      'aria-label': t('Search this repo'), autocomplete: 'off', spellcheck: 'false', 'aria-controls': `found-${n}`}) as HTMLInputElement;
    const pillRow = h('div', {class: 'search-pills', role: 'group', 'aria-label': t('What to look in')}, ...KINDS.map(({kind, label}) => {
      const b = h('button', {type: 'button', class: 'chip pill-kind', 'aria-pressed': 'false'}, label()) as HTMLButtonElement;
      b.addEventListener('click', () => this.press(kind));
      this.pillButtons.set(kind, b);
      return b;
    }));
    this.panel = h('div', {class: 'search-panel'});
    // ← → along the line, as along Git's issues and Server's boards.
    this.panel.addEventListener('keydown', (event) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !(event.target as HTMLElement).matches('.slide-stage, .stage-hit')) return;
      const hit = this.panel.querySelector<HTMLButtonElement>(`.stage-hit.${event.key === 'ArrowLeft' ? 'prev' : 'next'}`);
      if (hit && !hit.hidden) { event.preventDefault(); hit.click(); }
    });
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
    this.query.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        if (this.reading) { event.preventDefault(); this.close(); void this.draw(); return; }
        if (this.query.value) { event.preventDefault(); this.query.value = ''; this.keep(); void this.draw(); return; }
        // Nothing typed and nothing read: what is under the box goes, and the pane is straight again.
        event.preventDefault(); this.query.blur(); return;
      }
      // ↓ goes down into what is under the box; Enter takes the first of it (a file found by its name: the caret in it).
      if (event.key === 'ArrowDown') { const first = this.choices()[0]; if (first) { event.preventDefault(); first.focus(); } return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        // The first found is taken (what was typed goes in the line before it); with none, what was typed does.
        const first = this.choices()[0];
        const q = this.query.value.trim();
        if (first) first.click();
        else if (q) { this.remember({what: 'query', text: q}); void this.draw(); }
      }
    });
    // Along what is there with ↑ ↓; Escape goes back up to the box (from something read: back to what it was chosen from).
    this.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (this.reading) { this.close(); void this.draw(); } this.query.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const all = this.choices();
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      event.preventDefault();
      if (event.key === 'ArrowUp' && at === 0) this.query.focus();
      else all[Math.min(at + (event.key === 'ArrowDown' ? 1 : -1), all.length - 1)]?.focus();
    });
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.search = h('div', {class: 'search-box'}, form, this.under);
    this.follow();
  }

  /** What can be chosen in the card in hand, in order. */
  private choices(): HTMLElement[] { return [...this.body.querySelectorAll<HTMLElement>('button.choice')]; }

  private get pill(): Kind | null { return this.repo ? pills.get(this.repo) ?? null : null; }

  /** A pill pressed shows what of its kind there is (or what of it was found); pressed again, it lets go. */
  private press(kind: Kind) {
    if (!this.repo) return;
    pills.set(this.repo, this.pill === kind ? null : kind);
    this.close();
    void this.draw();
    this.query.focus({preventScroll: true});
  }

  private paintPills() {
    for (const [kind, b] of this.pillButtons) b.setAttribute('aria-pressed', String(this.pill === kind));
  }

  /**
   * What is under the box follows what is saved, here or in the Prompt: what is read, the lists, what was found.
   * Off the screen it stops following; a page that comes back with it (Forge's, Git's) calls `resume`.
   */
  private follow() {
    const stop = onChange((c) => {
      if (!this.search.isConnected) { stop(); this.stop = null; return; }
      if (c.repo !== this.repo) return;
      if (this.files) this.files = patched(this.files, c);
      if (this.panel.contains(document.activeElement) && !this.reading) { this.dirty = true; return; }
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void (this.reading ? this.reading.draw() : this.draw()), 250);
    });
    this.stop = stop;
  }

  /** Back on the screen: following again, and drawn afresh (what changed meanwhile is in it). */
  resume() {
    if (!this.stop) this.follow();
    this.files = null;
    void (this.reading ? this.reading.draw() : this.draw());
  }

  /** The repo shown; what was searched, the pill and the history in it come back with it. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.query.disabled = !repo;
    this.query.value = repo ? queries.get(repo) ?? '' : '';
    this.close();
    void this.draw();
  }

  /** The repo's Prompt is another one now (started, or started again): Output follows that one. */
  runsAgain() { if (this.repo && (this.pill === 'output' || this.reading?.seen.what === 'run')) void (this.reading ? this.reading.draw() : this.draw()); }

  private keep() {
    if (!this.repo) return;
    if (this.query.value) queries.set(this.repo, this.query.value); else queries.delete(this.repo);
  }

  /** Something searched or read, at the line's end (once: the same thing again stays where it is). */
  private remember(s: Seen) {
    if (!this.repo) return;
    const list = history.get(this.repo) ?? [];
    if (list.some((x) => seenKey(x) === seenKey(s))) return;
    history.set(this.repo, [...list, s].slice(-HISTORY));
  }

  /**
   * The large box: the line of what was searched and read (files aside: they open in the center), with `at` in
   * hand, or the live card at its end (`live`: what is found, the switch's list) or alone (what was searched and
   * read). The card in hand fills it; its neighbours show a sliver past its edges, pressed to move to them, as
   * are ← and → under the box.
   */
  private frame(at: Seen | null, live: Live | null) {
    const line = live?.alone ? [] : (history.get(this.repo ?? '') ?? []).filter((s) => s.what !== 'file');
    // What is typed is already in the line: that place is the one in hand, not another card at its end.
    const typed = live && !live.alone && live.kind === t('Searched') ? line.findIndex((s) => s.what === 'query' && s.text === live.label) : -1;
    type Slot = {kind: string; label: string; go: () => void};
    const slots: Slot[] = line.map((s) => ({kind: seenKind(s), label: seenLabel(s), go: () => void this.again(s)}));
    let k = at ? line.findIndex((s) => seenKey(s) === seenKey(at)) : typed;
    if (k < 0 && live) { slots.push({kind: live.kind, label: live.label, go: () => { this.close(); void this.draw(); }}); k = slots.length - 1; }
    if (k < 0) k = slots.length - 1;
    const had = this.panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : '';
    const stepped = had.includes('found-step') ? (had.includes('prev') ? 'prev' : 'next') : null;
    this.body = h('div', {class: 'found-body'});
    this.foot = h('div', {class: 'found-foot'});
    const track = h('div', {class: 'slide-track', style: `--at:${k}`}, ...slots.map((_, i) => h('div', {class: 'slide', 'aria-current': String(i === k)},
      h('div', {class: 'found-card'}, ...(i === k ? [this.body, this.foot] : [])))));
    const edge = (by: -1 | 1) => {
      const to = slots[k + by];
      // For the pointer: the keyboard and a screen reader have the same moves in ← → under the box.
      const b = h('button', {type: 'button', class: `stage-hit ${by < 0 ? 'prev' : 'next'}`, tabindex: '-1', 'aria-hidden': 'true'}) as HTMLButtonElement;
      b.hidden = !to;
      b.addEventListener('click', () => to?.go());
      return b;
    };
    const stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Searched and read'), 'aria-roledescription': 'carousel'}, track, edge(-1), edge(1));
    // Held out while the line is drawn again under the keyboard, so the keyboard can stay on it.
    const moved = had.includes('stage-hit') || had.includes('slide-stage') || !!stepped;
    if (moved) this.search.classList.add('moving');
    // Under the box, ← and → to the ones beside: the same moves as the slivers, where a hand finds them.
    const step = (by: -1 | 1) => {
      const to = slots[k + by];
      const b = h('button', {type: 'button', class: `found-step ${by < 0 ? 'prev' : 'next'}`, 'aria-label': to ? `${to.kind} ${to.label}`.trim() : '', title: to ? `${to.kind} ${to.label}`.trim() : ''}, by < 0 ? '←' : '→') as HTMLButtonElement;
      b.disabled = !to;
      b.addEventListener('click', () => to?.go());
      return b;
    };
    // What the one in hand is, said under the box between the steps, not over what it holds.
    const here = slots[k];
    const nav = h('div', {class: 'found-nav'}, step(-1),
      h('p', {class: 'found-here'}, h('span', {class: 'found-kind'}, here.kind), here.label ? h('span', {class: 'found-what'}, here.label) : null,
        slots.length > 1 ? h('span', {class: 'found-at'}, `${k + 1} / ${slots.length}`) : null),
      step(1));
    this.panel.replaceChildren(h('div', {class: `slides${slots.length === 1 ? ' single' : ''}${k < slots.length - 1 ? ' more' : ''}`, style: `--lead:${slots.length === 1 || k === 0 ? 0 : k === slots.length - 1 ? 2 : 1}`}, stage), nav);
    // Moved along by a press at an edge: the keyboard stays on the line.
    if (moved) {
      // Stepped with ← or →: the keyboard stays on that step (or the line, at its end).
      const on = stepped ? this.panel.querySelector<HTMLButtonElement>(`.found-step.${stepped}`) : null;
      (on && !on.disabled ? on : stage).focus({preventScroll: true});
      this.search.classList.remove('moving');
    }
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
    const seen = (history.get(repo) ?? []).slice().reverse();
    if (!seen.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('What is searched and read here comes back here'))); return; }
    this.body.replaceChildren(h('ul', {class: 'found-list'}, ...seen.map((s) => h('li', {}, this.seenButton(s)))));
  }

  /** One thing searched or read, pressed to search or read it again. */
  private seenButton(s: Seen): HTMLElement {
    const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-kind'}, seenKind(s)),
      h('span', {class: s.what === 'run' || s.what === 'file' || s.what === 'diff' ? 'found-what mono' : 'found-what'}, seenLabel(s)));
    b.addEventListener('click', () => void this.again(s));
    return b;
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
    const issue = (await this.openIssues(repo).catch(() => [])).find((i) => issuePath(i) === s.path)
      ?? (await readIssues(store, repo).catch(() => [])).find((i) => issuePath(i) === s.path);
    if (issue && this.repo === repo) this.readIssue(issue);
  }

  /** The pill's list: the repo's open issues, its changes file by file, or what was run, newest first. */
  private async list(kind: Kind) {
    const repo = this.repo!;
    if (kind === 'issue') {
      const [all, list] = await Promise.all([readIssues(store, repo).catch(() => []), this.openIssues(repo).catch(() => [])]);
      if (this.repo !== repo || this.pill !== kind || this.reading || this.query.value.trim()) return;
      if (!list.length) {
        const said = h('p', {class: 'muted small'}, all.length ? t('No open issues') : t('No issues yet'));
        // The way to the first one is where its absence is said, for this repo, with nothing to choose again.
        const write = this.writeIssue;
        const w = write ? h('button', {type: 'button', class: 'button small-button choice'}, t('Write an issue')) : null;
        w?.addEventListener('click', () => write!(repo));
        this.body.replaceChildren(said, ...(w ? [w] : []));
        return;
      }
      this.body.replaceChildren(h('ul', {class: 'issue-list'}, ...list.map((i) => h('li', {}, this.issueButton(i)))));
      return;
    }
    if (kind === 'diff') {
      let files: gitops.FileDiff[];
      try { files = await gitops.diff(repo); } catch (e) { this.body.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e))); return; }
      if (this.repo !== repo || this.pill !== kind || this.reading || this.query.value.trim()) return;
      if (!files.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('No changes'))); return; }
      this.body.replaceChildren(h('ul', {class: 'found-list'}, ...files.map((f) => {
        const add = f.lines.filter((l) => l.kind === 'add').length, del = f.lines.filter((l) => l.kind === 'del').length;
        const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what mono'}, fileName(f.path)),
          h('span', {class: 'diff-count'}, f.binary ? t('Binary') : `${add ? `+${add}` : ''}${del ? ` −${del}` : ''}`.trim()));
        b.addEventListener('click', () => this.readDiff(f.path));
        return h('li', {}, b);
      })));
      return;
    }
    const session = sessionIfAny(repo);
    const draw = () => {
      if (this.repo !== repo || this.pill !== 'output' || this.reading || this.query.value.trim()) return;
      const runs = session?.runs ?? [];
      if (!runs.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Nothing run yet'))); return; }
      this.body.replaceChildren(h('ul', {class: 'found-list'}, ...runs.slice().reverse().map((r) => h('li', {}, this.runButton(r)))));
    };
    draw();
    this.unwatch?.();
    this.unwatch = session ? session.watch(draw) : null;
  }

  private issueButton(i: Issue): HTMLElement {
    const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what'},
      issueName(i) ? h('span', {class: 'issue-no'}, `${issueName(i)} `) : null, i.kind ? `${i.kind}：` : '', i.title));
    b.addEventListener('click', () => this.readIssue(i));
    return b;
  }

  private runButton(r: Run): HTMLElement {
    const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what mono'}, r.line),
      h('span', {class: 'row-meta'}, r.ms === null ? t('Running') : `${r.ms} ms`));
    b.addEventListener('click', () => this.readRun(r));
    return b;
  }

  /** One issue in full; its words open in the center to be changed. */
  private readIssue(issue: Issue) {
    const label = `${issueName(issue) ? `${issueName(issue)} ` : ''}${issue.kind ? `${issue.kind}：` : ''}${issue.title}`;
    this.open({what: 'issue', path: issuePath(issue), label}, (into) => {
      const go = h('button', {type: 'button', class: 'button small-button choice'}, t('Change its words'));
      go.addEventListener('click', () => this.events.reveal(issuePath(issue)));
      into.replaceChildren(h('article', {class: 'issue-one'},
        h('h3', {}, issueName(issue) ? h('span', {class: 'issue-no'}, `${issueName(issue)} `) : null, issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title),
        issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null, answers(go)));
    });
  }

  /** A file's diff, read whole, following every save; its foot puts it back. */
  private readDiff(path: string) {
    const repo = this.repo!;
    this.open({what: 'diff', path}, async (into, foot) => {
      // A foot asking (Put back) is not drawn away from under the person: drawn once it has its answer.
      if (foot.querySelector('.diff-foot.asking')) return;
      let files: gitops.FileDiff[];
      try { files = await gitops.diff(repo); } catch (e) { into.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e))); return; }
      if (this.repo !== repo || this.reading?.seen.what !== 'diff' || this.reading.seen.path !== path) return;
      const f = files.find((x) => x.path === path);
      if (!f) { into.replaceChildren(h('p', {class: 'muted small'}, t('No changes'))); foot.replaceChildren(); return; }
      const [fold] = this.diffFiles([f]);
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

  /** Files of a diff of the copy here: a name opens the file, a line's number opens it there, a line pressed is marked. */
  private diffFiles(files: gitops.FileDiff[]): HTMLElement[] {
    const repo = this.repo!;
    const marked = marks.get(repo) ?? new Set<string>();
    marks.set(repo, marked);
    // The same text twice in a file is two lines: each is told apart by which time it comes.
    const times = new Map<string, number>();
    return diffFiles(files, {
      reveal: (p, line) => this.events.reveal(p, line),
      putBack: (f) => gitops.putBack(repo, f.path),
      // Pressing a line marks it, again unmarks it; its number still opens the center there.
      line: (row, key, l) => {
        const line = `${key.slice(0, key.lastIndexOf(':'))}\n${l.kind}\n${l.text}`;
        const n = (times.get(line) ?? 0) + 1;
        times.set(line, n);
        const what = `${line}\n${n}`;
        row.classList.add('markable');
        // The line's words are what is marked: heard as a toggle named by them, pressed while marked.
        const words = row.querySelector<HTMLElement>('.diff-words');
        words?.setAttribute('role', 'button');
        const paint = () => { row.classList.toggle('marked', marked.has(what)); words?.setAttribute('aria-pressed', String(marked.has(what))); };
        paint();
        row.addEventListener('click', (event) => {
          if ((event.target as HTMLElement).closest('.diff-no')) return;
          if (marked.has(what)) marked.delete(what); else marked.add(what);
          paint();
        });
      },
    });
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
      [files, issues, changed] = await Promise.all([this.files, this.openIssues(repo).catch(() => []),
        gitops.changes(repo).then((c) => c.folders.flatMap((f) => f.files), () => [])]);
    } catch (e) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Could not search: {message}', {message: String(e)}))); return; }
    if (run !== this.found || repo !== this.repo || this.reading) return;
    const q = query.toLowerCase();
    const groups: {path: string; hits: Hit[]}[] = [];
    let total = 0;
    // Files are under no pill: with one pressed, only what is of its kind is found.
    if (!kind) for (const f of files) {
      if (total >= HIT_LIMIT) break;
      const hits = findInText(f.text, query, HIT_LIMIT - total);
      if (!hits.length && !nameMatches(f.path, query)) continue;
      groups.push({path: f.path, hits});
      total += hits.length;
    }
    const issueHits = !kind || kind === 'issue' ? issues.filter((i) => `${issueName(i)} ${i.kind ?? ''}：${i.title}\n${i.detail}`.toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [];
    const diffHits = kind === 'diff' ? changed.filter((c) => c.path.toLowerCase().includes(q) || fileName(c.path).toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [];
    const runs = !kind || kind === 'output' ? (sessionIfAny(repo)?.runs ?? []).slice().reverse().filter((r) => r.line.toLowerCase().includes(q) || r.output.toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [];
    if (!groups.length && !issueHits.length && !diffHits.length && !runs.length) {
      this.body.replaceChildren(h('p', {class: 'muted small'}, t('Nothing found for “{query}”', {query})));
      return;
    }
    const changes = new Map(changed.map((c) => [c.path, c]));
    const said: HTMLElement[] = [];
    if (groups.length) said.push(h('p', {class: 'muted small search-count'}, `${tn('{n} file', '{n} files', groups.length)} · ${total >= HIT_LIMIT ? t('{n} lines (only the first)', {n: total}) : tn('{n} line', '{n} lines', total)}`));
    for (const g of nameFirst(groups, query)) {
      // A file chosen by its name is the one to work on: the caret goes in it.
      const name = h('button', {type: 'button', class: 'choice hit-file'}, g.path);
      name.addEventListener('click', () => { this.remember({what: 'query', text: query}); this.remember({what: 'file', path: g.path}); this.events.reveal(g.path, 0, true); });
      const c = changes.get(g.path);
      // Changed since the last commit: its diff is a press away, read under the box.
      const diff = c ? h('button', {type: 'button', class: 'choice hit-diff', 'aria-label': t('The diff of {path}', {path: fileName(g.path)})},
        `${c.added ? `+${c.added}` : ''}${c.removed ? ` −${c.removed}` : ''}`.trim() || t('diff')) : null;
      diff?.addEventListener('click', () => this.readDiff(g.path));
      said.push(h('div', {class: 'hit-group'}, h('div', {class: 'hit-head'}, name, diff), ...g.hits.map((hit) => {
        const b = h('button', {type: 'button', class: 'choice hit'},
          h('span', {class: 'hit-line'}, String(hit.line)),
          h('span', {class: 'hit-text'}, hit.text.slice(0, hit.from), h('mark', {}, hit.text.slice(hit.from, hit.to)), hit.text.slice(hit.to)));
        b.addEventListener('click', () => void this.go(g.path, hit.line, query));
        return b;
      })));
    }
    if (issueHits.length) said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('Issue')), ...issueHits.map((i) => this.issueButton(i))));
    if (diffHits.length) said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('diff')), ...diffHits.map((c) => {
      const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what mono'}, fileName(c.path)),
        h('span', {class: 'diff-count'}, `${c.added ? `+${c.added}` : ''}${c.removed ? ` −${c.removed}` : ''}`.trim()));
      b.addEventListener('click', () => this.readDiff(c.path));
      return b;
    })));
    if (runs.length) said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('Output')), ...runs.map((r) => this.runButton(r))));
    const had = this.choices().indexOf(document.activeElement as HTMLElement);
    this.body.replaceChildren(...said);
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

  /** The repo's open issues, as Git shows them: one merged or closed is done with. */
  private async openIssues(repo: string): Promise<Issue[]> {
    const [all, merged] = await Promise.all([readIssues(store, repo), mergedIssues(repo)]);
    return all.filter((i) => i.closed === null && !merged.has(issuePath(i)));
  }
}

/** The issues of `repo` whose change was merged ("issue/001.md"); none known without the Remote. */
const mergedIssues = (repo: string): Promise<Set<string>> => (connection()
  ? gitops.changesOf(repo).then((list) => new Set(list.filter((c) => c.state === 'merged').map((c) => c.issue)), () => new Set<string>())
  : Promise.resolve(new Set<string>()));

/** One run: the line (pressed, it is back in the prompt box), how long it took (or that it is running), then its output. */
function runView(r: Run, recall?: (line: string) => void): HTMLElement {
  const lines = r.output.replace(/\n$/, '').split('\n');
  const shown = r.output ? lines.slice(0, RUN_LINES) : [];
  let line: HTMLElement = h('span', {class: 'run-line'}, r.line);
  if (recall) {
    line = h('button', {type: 'button', class: 'hit-file run-line', title: t('Put back in the prompt box')}, r.line);
    line.addEventListener('click', () => recall(r.line));
  }
  return h('div', {class: 'hit-group run', 'data-started': String(r.started)},
    h('div', {class: 'run-head'}, line, h('span', {class: 'row-meta'}, r.ms === null ? t('Running') : `${r.ms} ms`)),
    ...(shown.length ? [h('pre', {class: 'run-out'}, shown.join('\n'))] : []),
    ...(lines.length > RUN_LINES ? [h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', lines.length - RUN_LINES))] : []));
}
