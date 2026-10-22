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

// What the center refers to, and the way to it. The search box sits on the
// center's top line, in its middle: what is typed there is looked for in the
// repo's files, its open issues and what was run in its Prompt, and the
// results open under the box, over the center. A line or a file chosen opens
// the center there; an issue, a file's diff or a run is read in the right
// pane. The right pane holds no switch: its issues, its diff and its output
// one under another, each under its heading, following the repo as it
// changes; a heading with nothing under it says so in one quiet line. What
// is searched belongs to its repo: each keeps its own while the app runs.

const FILE_LIMIT = 2000;
/** Lines of a run's output shown before "n more lines". */
const RUN_LINES = 40;
const HIT_LIMIT = 200;
/** Issues and runs said under the box for a search, at most. */
const OTHER_LIMIT = 20;

/** What was searched in each repo. */
const queries = new Map<string, string>();
/**
 * Lines of each repo's diff marked as with a highlighter, to come back to
 * while reading: kept by what the line is (its file, kind, text and which
 * time that text comes in the file), so a
 * mark stays on its line as the diff is drawn again, and goes when the line
 * does. Kept here, like the search, for as long as the app is open.
 */
const marks = new Map<string, Set<string>>();

export interface ReferenceEvents {
  /** Scroll the center to a path in the open repo, at `line` if given; with `write`, the caret in it. */
  reveal(path: string, line?: number, write?: boolean): void;
  /** Put a line run before back in the prompt box, to change or send again. */
  recall?(line: string): void;
  /** Something was chosen to be read in the right pane: it is shown, if it was put away. */
  show?(): void;
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

/** One of the right pane's parts: its heading, then what it holds. */
function part(id: string, title: string): {element: HTMLElement; body: HTMLElement} {
  const body = h('div', {class: 'ref-list'});
  return {element: h('section', {class: 'ref-part', 'aria-labelledby': id}, h('h2', {id}, title), body), body};
}

let made = 0;

export class Reference {
  /** The right pane's part: what is read there. */
  readonly element: HTMLElement;
  /** The search box and what it finds, for the center's top line. */
  readonly search: HTMLElement;
  private body: HTMLElement;
  private overview: HTMLElement;
  private pinnedView: HTMLElement;
  private issuePart: ReturnType<typeof part>;
  private diffPart: ReturnType<typeof part>;
  private runPart: ReturnType<typeof part>;
  private query: HTMLInputElement;
  private results: HTMLElement;
  private repo: string | null = null;
  private events: ReferenceEvents;
  private files: Promise<Files> | null = null;
  private timer = 0;
  private findTimer = 0;
  private run = 0;
  private found = 0;
  /** The diff as last drawn, so the same one is not drawn again. */
  private drawnDiff = '';
  /** Something saved since the results were drawn, while they had the keyboard: drawn again once they do not. */
  private dirty = false;
  /** An issue shown in full, or a change handed in, stays until the person chooses something else. */
  private pinned = false;
  private unwatch: (() => void) | null = null;
  /** Stops following the store; null while it does not (off the screen). */
  private stop: (() => void) | null = null;

  constructor(events: ReferenceEvents) {
    this.events = events;
    const n = ++made;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: t('Search this repo'),
      'aria-label': t('Search this repo'), autocomplete: 'off', spellcheck: 'false', 'aria-controls': `found-${n}`}) as HTMLInputElement;
    this.results = h('div', {class: 'search-results', id: `found-${n}`, role: 'region', 'aria-label': t('Search results')});
    this.query.addEventListener('focus', () => { if (this.dirty) { this.dirty = false; this.find(); } });
    this.query.addEventListener('input', () => {
      this.keep();
      clearTimeout(this.findTimer);
      this.findTimer = window.setTimeout(() => this.find(), 150);
    });
    this.query.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && this.query.value) { event.preventDefault(); this.query.value = ''; this.keep(); this.find(); return; }
      // ↓ goes down into what was found; Enter takes the first of it (a file found by its name: the caret in it).
      if (event.key === 'ArrowDown') { const first = this.choices()[0]; if (first) { event.preventDefault(); first.focus(); } return; }
      if (event.key === 'Enter') { event.preventDefault(); this.choices()[0]?.click(); }
    });
    // Along what was found with ↑ ↓; Escape goes back up to the box, which keeps what was typed.
    this.results.addEventListener('keydown', (event) => {
      const all = this.choices();
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (event.key === 'ArrowUp' && at === 0) this.query.focus();
        else all[Math.min(at + (event.key === 'ArrowDown' ? 1 : -1), all.length - 1)]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); this.query.focus(); }
    });
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.search = h('div', {class: 'search-box'}, form, this.results);

    this.issuePart = part(`ref-issue-${n}`, t('Issue'));
    this.diffPart = part(`ref-diff-${n}`, t('diff'));
    this.runPart = part(`ref-run-${n}`, t('Output'));
    this.overview = h('div', {class: 'ref-parts'}, this.issuePart.element, this.diffPart.element, this.runPart.element);
    this.pinnedView = h('div', {class: 'ref-pinned', hidden: ''});
    this.body = h('div', {class: 'reference-body'}, this.overview, this.pinnedView);
    this.element = h('section', {class: 'pane reference', 'aria-label': t('Reference')}, this.body);
    this.paint();
    this.follow();
  }

  /** What was found that can be chosen, in order. */
  private choices(): HTMLElement[] { return [...this.results.querySelectorAll<HTMLElement>('button')]; }

  /**
   * The right pane follows what is saved, here or in the Prompt: the diff any change, the issues
   * what is written in issue/; the search reads the file again. Off the screen it stops following;
   * a page that comes back with it (Forge's) calls `resume`, which follows again and draws afresh.
   */
  private follow() {
    const stop = onChange((c) => {
      if (!this.element.isConnected) { stop(); this.stop = null; return; }
      if (c.repo !== this.repo) return;
      if (this.files) this.files = patched(this.files, c);
      if (this.query.value.trim()) this.stale();
      if (this.pinned) return;
      clearTimeout(this.timer);
      const issues = c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/');
      this.timer = window.setTimeout(() => { void this.diff(); if (issues) void this.issues(); }, 250);
    });
    this.stop = stop;
  }

  /** What was found may be out of date: found again now, or once the keyboard is back in the box. */
  private stale() {
    if (this.results.contains(document.activeElement)) { this.dirty = true; return; }
    clearTimeout(this.findTimer);
    this.findTimer = window.setTimeout(() => this.find(), 250);
  }

  /** Back on the screen: following again, and drawn afresh if it had stopped (what changed meanwhile is in it). */
  resume() {
    // Kept on the page while another was shown, it still followed the files; what is not a file's change
    // (a commit made in Git, which moves the diff's base) is read again now all the same.
    if (!this.stop) this.follow();
    this.files = null;
    if (!this.pinned) this.paint();
    if (this.query.value.trim()) this.find();
  }

  /** The repo Forge shows; what was searched in it comes back with it. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.drawnDiff = '';
    this.query.disabled = !repo;
    this.query.value = repo ? queries.get(repo) ?? '' : '';
    this.unpin();
    this.paint();
    this.find();
  }

  private keep() {
    if (!this.repo) return;
    if (this.query.value) queries.set(this.repo, this.query.value); else queries.delete(this.repo);
  }

  /** Something in place of the parts (one issue, a change handed in), until it is put away. */
  private pin(...nodes: Node[]) {
    this.pinned = true;
    this.pinnedView.replaceChildren(...nodes);
    this.pinnedView.hidden = false;
    this.overview.hidden = true;
    this.body.scrollTop = 0;
    this.events.show?.();
  }

  private unpin() {
    this.pinned = false;
    this.pinnedView.hidden = true;
    this.pinnedView.replaceChildren();
    this.overview.hidden = false;
    this.element.closest('.work')?.classList.remove('reviewing');
  }

  /** One issue in full, from the list or a search; its words open in the center to be changed. */
  private showIssue(issue: Issue) {
    const go = h('button', {type: 'button', class: 'button small-button'}, t('Change its words'));
    go.addEventListener('click', () => this.events.reveal(issuePath(issue)));
    const back = h('button', {type: 'button', class: 'button small-button'}, t('Every issue'));
    back.addEventListener('click', () => { this.unpin(); this.paint(); });
    // It stays while the repo changes, until the person goes back or chooses something else.
    this.pin(h('article', {class: 'issue-one'},
      h('h3', {}, issueName(issue) ? h('span', {class: 'issue-no'}, `${issueName(issue)} `) : null, issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title),
      issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null,
      answers(back, go)));
    go.focus({preventScroll: true});
  }

  /** The right pane's parts, each drawn afresh. */
  private paint() {
    this.unwatch?.();
    this.unwatch = null;
    if (!this.repo) {
      // No repo: nothing to refer to, and nothing said about it here.
      for (const p of [this.issuePart, this.diffPart, this.runPart]) p.body.replaceChildren();
      this.overview.hidden = true;
      return;
    }
    if (!this.pinned) this.overview.hidden = false;
    void this.issues();
    void this.diff();
    this.runs();
  }

  /** Bring a part (and in it the element `at`, if given) into view, marked for a moment as the center marks a place. */
  private reveal(p: {element: HTMLElement}, at?: HTMLElement | null) {
    if (this.pinned) this.unpin();
    this.events.show?.();
    const target = at ?? p.element;
    requestAnimationFrame(() => {
      target.scrollIntoView({block: 'start'});
      target.classList.add('revealed');
      setTimeout(() => target.classList.remove('revealed'), 1200);
    });
  }

  private async find() {
    const query = this.query.value.trim();
    const repo = this.repo;
    const run = ++this.found;
    if (!query) { this.results.replaceChildren(); return; }
    if (!repo) { this.results.replaceChildren(h('p', {class: 'muted small'}, t('Open a repo to search it'))); return; }
    if (!this.results.childElementCount) this.results.replaceChildren(h('p', {class: 'muted small'}, t('Searching…')));
    this.files ??= readAll(repo);
    let files: Files, issues: Issue[], changed: gitops.FileChange[];
    try {
      [files, issues, changed] = await Promise.all([this.files, this.openIssues(repo).catch(() => []),
        gitops.changes(repo).then((c) => c.folders.flatMap((f) => f.files), () => [])]);
    } catch (e) { this.results.replaceChildren(h('p', {class: 'muted small'}, t('Could not search: {message}', {message: String(e)}))); return; }
    if (run !== this.found || repo !== this.repo) return;
    const q = query.toLowerCase();
    const groups: {path: string; hits: Hit[]}[] = [];
    let total = 0;
    for (const f of files) {
      if (total >= HIT_LIMIT) break;
      const hits = findInText(f.text, query, HIT_LIMIT - total);
      if (!hits.length && !nameMatches(f.path, query)) continue;
      groups.push({path: f.path, hits});
      total += hits.length;
    }
    const issueHits = issues.filter((i) => `${issueName(i)} ${i.kind ?? ''}：${i.title}\n${i.detail}`.toLowerCase().includes(q)).slice(0, OTHER_LIMIT);
    const runs = (sessionIfAny(repo)?.runs ?? []).slice().reverse().filter((r) => r.line.toLowerCase().includes(q) || r.output.toLowerCase().includes(q)).slice(0, OTHER_LIMIT);
    if (!groups.length && !issueHits.length && !runs.length) {
      this.results.replaceChildren(h('p', {class: 'muted small'}, t('Nothing found for “{query}”', {query})));
      return;
    }
    const changes = new Map(changed.map((c) => [c.path, c]));
    const said: HTMLElement[] = [];
    if (groups.length) said.push(h('p', {class: 'muted small search-count'}, `${tn('{n} file', '{n} files', groups.length)} · ${total >= HIT_LIMIT ? t('{n} lines (only the first)', {n: total}) : tn('{n} line', '{n} lines', total)}`));
    for (const g of nameFirst(groups, query)) {
      // A file chosen by its name is the one to work on: the caret goes in it.
      const name = h('button', {type: 'button', class: 'hit-file'}, g.path);
      name.addEventListener('click', () => this.events.reveal(g.path, 0, true));
      const c = changes.get(g.path);
      // Changed since the last commit: its diff is a press away, read in the right pane.
      const diff = c ? h('button', {type: 'button', class: 'hit-diff', 'aria-label': t('The diff of {path}', {path: fileName(g.path)})},
        `${c.added ? `+${c.added}` : ''}${c.removed ? ` −${c.removed}` : ''}`.trim() || t('diff')) : null;
      diff?.addEventListener('click', () => this.showDiffOf(g.path));
      said.push(h('div', {class: 'hit-group'}, h('div', {class: 'hit-head'}, name, diff), ...g.hits.map((hit) => {
        const b = h('button', {type: 'button', class: 'hit'},
          h('span', {class: 'hit-line'}, String(hit.line)),
          h('span', {class: 'hit-text'}, hit.text.slice(0, hit.from), h('mark', {}, hit.text.slice(hit.from, hit.to)), hit.text.slice(hit.to)));
        b.addEventListener('click', () => void this.go(g.path, hit.line, query));
        return b;
      })));
    }
    if (issueHits.length) {
      said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('Issue')), ...issueHits.map((i) => {
        const b = h('button', {type: 'button', class: 'hit-file hit-issue'}, issueName(i) ? h('span', {class: 'issue-no'}, `${issueName(i)} `) : null, i.kind ? `${i.kind}：` : '', i.title);
        b.addEventListener('click', () => this.showIssue(i));
        return b;
      })));
    }
    if (runs.length) {
      said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('Output')), ...runs.map((r) => {
        const b = h('button', {type: 'button', class: 'hit-file hit-run'}, r.line);
        b.addEventListener('click', () => this.showRun(r));
        return b;
      })));
    }
    const had = this.choices().indexOf(document.activeElement as HTMLElement);
    this.results.replaceChildren(...said);
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
      void this.find();
      this.query.focus();
      return;
    }
    this.events.reveal(path, at);
  }

  private showDiffOf(path: string) {
    void this.diff().then(() => {
      const fold = [...this.diffPart.body.querySelectorAll<HTMLDetailsElement>('details.diff-file')].find((d) => d.dataset.path === path);
      if (fold) fold.open = true;
      this.reveal(this.diffPart, fold);
      fold?.querySelector<HTMLElement>('summary')?.focus({preventScroll: true});
    });
  }

  private showRun(r: Run) {
    this.runs();
    const at = [...this.runPart.body.querySelectorAll<HTMLElement>('.run')].find((e) => e.dataset.started === String(r.started));
    this.reveal(this.runPart, at);
    at?.querySelector<HTMLElement>('button')?.focus({preventScroll: true});
  }

  /** The repo's Prompt is another one now (started, or started again): Output follows that one. */
  runsAgain() { if (this.repo) this.runs(); }

  /** What was run in this repo's Prompt, newest first, following it as it runs. */
  private runs() {
    const repo = this.repo;
    const session = repo ? sessionIfAny(repo) : undefined;
    const draw = () => {
      if (this.repo !== repo) return;
      const list = session?.runs ?? [];
      if (!list.length) { this.runPart.body.replaceChildren(h('p', {class: 'muted small'}, t('Nothing run yet'))); return; }
      this.runPart.body.replaceChildren(...list.slice().reverse().map((r) => runView(r, this.events.recall)));
    };
    draw();
    this.unwatch?.();
    this.unwatch = session ? session.watch(draw) : null;
  }

  /** The changes not yet cut, file by file, line by line. */
  private async diff() {
    const repo = this.repo;
    if (!repo) return;
    const run = ++this.run;
    let files: gitops.FileDiff[];
    try { files = await gitops.diff(repo); } catch (e) {
      if (run === this.run) this.diffPart.body.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e)));
      return;
    }
    if (run !== this.run || repo !== this.repo) return;
    // A head asking (Put back) is not drawn away from under the person: drawn once it has its answer.
    if (this.diffPart.body.querySelector('.diff-head.asking')) { clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.diff(), 250); return; }
    // The same diff as drawn: nothing is drawn again (a fold pressed, a head about to ask, stay as they are).
    const drawn = JSON.stringify(files);
    if (drawn === this.drawnDiff && this.diffPart.body.isConnected) return;
    this.drawnDiff = drawn;
    // The folds open or shut as they were left, each by its file.
    const was = new Map([...this.diffPart.body.querySelectorAll<HTMLDetailsElement>('details.diff-file')].map((d) => [d.dataset.path, d.open]));
    if (!files.length) { this.diffPart.body.replaceChildren(h('p', {class: 'muted small'}, t('No changes'))); return; }
    const folds = this.diffFiles(files, true);
    folds.forEach((d, i) => { (d as HTMLDetailsElement).dataset.path = files[i].path; const open = was.get(files[i].path); if (open !== undefined) (d as HTMLDetailsElement).open = open; });
    this.diffPart.body.replaceChildren(...folds);
  }

  /** Files of a diff (a name opens the file when it is the work's own). */
  private diffFiles(files: gitops.FileDiff[], open: boolean): HTMLElement[] {
    if (!open || !this.repo) return diffFiles(files);
    const repo = this.repo;
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

  /** A change handed in, to review: its name, what to do with it, then its diff (only `folder`'s when given). */
  showChange(head: Node, actions: Node[], files: Promise<gitops.FileDiff[]>, folder: string | null = null) {
    // A change under review takes the whole side: the Prompt steps aside until the reference shows something else.
    this.element.closest('.work')?.classList.add('reviewing');
    const diff = h('div', {}, h('p', {class: 'muted small'}, t('Reading…')));
    this.pin(h('article', {class: 'issue-one'}, head, ...actions), diff);
    void files.then((list) => {
      const shown = folder === null ? list : list.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === folder);
      diff.replaceChildren(...(shown.length ? this.diffFiles(shown, false) : [h('p', {class: 'muted small'}, t('No changes'))]));
    }, (e) => diff.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e))));
  }

  /** The repo's open issues, as Git shows them: one merged or closed is done with. */
  private async openIssues(repo: string): Promise<Issue[]> {
    const [all, merged] = await Promise.all([readIssues(store, repo), mergedIssues(repo)]);
    return all.filter((i) => i.closed === null && !merged.has(issuePath(i)));
  }

  /** The repo's issues, one line each (#3 Fix：its title); pressed, one is shown in full. */
  private async issues() {
    const repo = this.repo;
    if (!repo) return;
    const [all, list] = await Promise.all([readIssues(store, repo), this.openIssues(repo)]);
    if (this.repo !== repo) return;
    if (!list.length) { this.issuePart.body.replaceChildren(h('p', {class: 'muted small'}, all.length ? t('No open issues') : t('No issues yet'))); return; }
    this.issuePart.body.replaceChildren(h('ul', {class: 'issue-list'}, ...list.map((i) => {
      const b = h('button', {type: 'button', class: 'link'}, issueName(i) ? h('span', {class: 'issue-no'}, `${issueName(i)} `) : null, i.kind ? `${i.kind}：` : '', i.title);
      b.addEventListener('click', () => this.showIssue(i));
      return h('li', {}, b);
    })));
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
