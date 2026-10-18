import {h} from '../dom.ts';
import {diffFiles} from './diff-view.ts';
import * as gitops from '../history.ts';
import {issueName, issuePath, readIssues, type Issue} from '../issues.ts';
import {t, tn} from '../i18n.ts';
import {onChange, store} from '../repos.ts';
import {findInText, nameMatches, type Hit} from '../search.ts';
import {sessionIfAny, type Run} from './terminal.ts';
import {answers} from './common.ts';
import {connection} from '../remote.ts';

// The top of Forge's right pane: a search box over the band line, then one
// reference at a time, switched freely with chips. While something is
// typed in the search box, its results take the reference's place. A view
// with nothing to show says so in one quiet line, no box: the right pane only
// refers to the center, and the center is where things are made. What is
// searched belongs to its repo: each keeps its own while the app runs.

type View = 'issue' | 'diff' | 'run';
const VIEWS: readonly {id: View; label: string}[] = [
  {id: 'issue', label: 'Issue'},
  {id: 'diff', label: 'diff'},
  {id: 'run', label: 'Output'},
];
const KEY = 'length3.os.reference';
const FILE_LIMIT = 2000;
/** Lines of a run's output shown before "n more lines". */
const RUN_LINES = 40;
const HIT_LIMIT = 200;

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

function load(): View {
  try {
    const v = localStorage.getItem(KEY);
    return VIEWS.some((x) => x.id === v) ? v as View : 'issue';
  } catch { return 'issue'; }
}

export interface ReferenceEvents {
  /** Scroll the center to a path in the open repo, at `line` if given. */
  reveal(path: string, line?: number): void;
  /** Put a line run before back in the prompt box, to change or send again. */
  recall?(line: string): void;
}

/** The repo's text files, read once per search session. */
async function readAll(repo: string): Promise<{path: string; text: string}[]> {
  const out: {path: string; text: string}[] = [];
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

export class Reference {
  readonly element: HTMLElement;
  private body: HTMLElement;
  private query: HTMLInputElement;
  private chips = new Map<View, HTMLElement>();
  private view = load();
  private repo: string | null = null;
  private events: ReferenceEvents;
  private files: Promise<{path: string; text: string}[]> | null = null;
  private timer = 0;
  private run = 0;
  /** An issue shown in full stays until the person chooses something else. */
  private pinned = false;
  private unwatch: (() => void) | null = null;
  /** Stops following the store; null while it does not (off the screen). */
  private stop: (() => void) | null = null;

  constructor(events: ReferenceEvents) {
    this.events = events;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: t('Search this repo'),
      'aria-label': t('Search this repo'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    // Edits may have changed the text since the last search.
    this.query.addEventListener('focus', () => { this.files = null; });
    this.query.addEventListener('input', () => {
      this.keep();
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.paint(), 150);
    });
    this.query.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.query.value) { event.preventDefault(); this.query.value = ''; this.keep(); this.paint(); }
    });
    const bar = h('div', {class: 'chips', role: 'group', 'aria-label': t('Reference')});
    for (const v of VIEWS) {
      const chip = h('button', {type: 'button', class: 'chip'}, t(v.label));
      chip.addEventListener('click', () => { this.query.value = ''; this.keep(); this.choose(v.id); });
      this.chips.set(v.id, chip);
      bar.append(chip);
    }
    this.body = h('div', {class: 'reference-body'});
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.element = h('section', {class: 'pane reference', 'aria-label': t('Reference')}, form, bar, this.body);
    this.choose(this.view);
    this.follow();
  }

  /**
   * The diff follows what is saved, here or in the Prompt; the issue list, what is written in
   * issue/. Off the screen it stops following; a page that comes back with it (Forge's) calls
   * `resume`, which follows again and draws what changed meanwhile.
   */
  private follow() {
    const stop = onChange((c) => {
      if (!this.element.isConnected) { stop(); this.stop = null; return; }
      if (c.repo !== this.repo || this.pinned || this.query.value.trim()) return;
      if (this.view !== 'diff' && !(this.view === 'issue' && (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/')))) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.paint(), 250);
    });
    this.stop = stop;
  }

  /** Back on the screen: following again, and drawn afresh if it had stopped (what changed meanwhile is in it). */
  resume() {
    if (this.stop) return;
    this.follow();
    if (!this.pinned) this.paint();
  }

  /** The repo Forge shows; what was searched in it comes back with it. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.query.disabled = !repo;
    this.query.value = repo ? queries.get(repo) ?? '' : '';
    this.paint();
  }

  private keep() {
    if (!this.repo) return;
    if (this.query.value) queries.set(this.repo, this.query.value); else queries.delete(this.repo);
  }

  /** One issue in full, from the list; its words open in the center to be changed. */
  private showIssue(issue: Issue) {
    const go = h('button', {type: 'button', class: 'button small-button'}, t('Change its words'));
    go.addEventListener('click', () => this.events.reveal(issuePath(issue)));
    const back = h('button', {type: 'button', class: 'button small-button'}, t('Every issue'));
    back.addEventListener('click', () => { this.pinned = false; void this.issues(); });
    // It stays while the repo changes, until the person goes back or chooses something else.
    this.pinned = true;
    this.body.replaceChildren(h('article', {class: 'issue-one'},
      h('h3', {}, issueName(issue) ? h('span', {class: 'issue-no'}, `${issueName(issue)} `) : null, issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title),
      issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null,
      answers(back, go)));
  }

  private choose(view: View) {
    this.view = view;
    try { localStorage.setItem(KEY, view); } catch { /* convenience only */ }
    this.paint();
  }

  private mark() {
    const searching = this.query.value.trim() !== '';
    for (const [id, chip] of this.chips) {
      if (id === this.view && !searching) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    }
  }

  private empty(text: string) { this.body.replaceChildren(h('p', {class: 'muted small'}, text)); }

  private paint() {
    this.pinned = false;
    this.element.closest('.work')?.classList.remove('reviewing');
    this.unwatch?.();
    this.unwatch = null;
    this.mark();
    if (this.query.value.trim()) { void this.search(this.query.value.trim()); return; }
    if (this.view === 'issue') void this.issues();
    else if (this.view === 'diff') void this.diff();
    else this.runs();
  }

  private async search(query: string) {
    const repo = this.repo;
    if (!repo) { this.empty(t('Open a repo to search it')); return; }
    const run = ++this.run;
    this.body.replaceChildren(h('p', {class: 'muted small'}, t('Searching…')));
    this.files ??= readAll(repo);
    let files;
    try { files = await this.files; } catch (e) { this.empty(t('Could not search: {message}', {message: String(e)})); return; }
    if (run !== this.run || repo !== this.repo || this.pinned) return;
    const groups: {path: string; hits: Hit[]}[] = [];
    let total = 0;
    for (const f of files) {
      if (total >= HIT_LIMIT) break;
      const hits = findInText(f.text, query, HIT_LIMIT - total);
      if (!hits.length && !nameMatches(f.path, query)) continue;
      groups.push({path: f.path, hits});
      total += hits.length;
    }
    if (!groups.length) { this.empty(t('Nothing found for “{query}”', {query})); return; }
    this.body.replaceChildren(
      h('p', {class: 'muted small search-count'}, `${tn('{n} file', '{n} files', groups.length)} · ${total >= HIT_LIMIT ? t('{n} lines (only the first)', {n: total}) : tn('{n} line', '{n} lines', total)}`),
      ...groups.map((g) => {
        const name = h('button', {type: 'button', class: 'hit-file'}, g.path);
        name.addEventListener('click', () => this.events.reveal(g.path));
        return h('div', {class: 'hit-group'}, name, ...g.hits.map((hit) => {
          const b = h('button', {type: 'button', class: 'hit'},
            h('span', {class: 'hit-line'}, String(hit.line)),
            h('span', {class: 'hit-text'}, hit.text.slice(0, hit.from), h('mark', {}, hit.text.slice(hit.from, hit.to)), hit.text.slice(hit.to)));
          b.addEventListener('click', () => this.events.reveal(g.path, hit.line));
          return b;
        }));
      }));
  }

  /** What was run in this repo's Prompt, newest first, following it as it runs. */
  private runs() {
    const repo = this.repo;
    const session = repo ? sessionIfAny(repo) : undefined;
    const draw = () => {
      if (this.pinned || this.view !== 'run' || this.query.value.trim() || this.repo !== repo) return;
      const list = session?.runs ?? [];
      if (!list.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('Nothing run yet'))); return; }
      this.body.replaceChildren(...list.slice().reverse().map((r) => runView(r, this.events.recall)));
    };
    draw();
    if (session) this.unwatch = session.watch(draw);
  }

  /** The changes not yet cut, file by file, line by line. */
  private async diff() {
    const repo = this.repo;
    // No repo: nothing to refer to, and nothing said about it here.
    if (!repo) { this.body.replaceChildren(); return; }
    const run = ++this.run;
    let files: gitops.FileDiff[];
    try { files = await gitops.diff(repo); } catch (e) {
      if (run === this.run) this.body.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e)));
      return;
    }
    if (run !== this.run || repo !== this.repo || this.view !== 'diff' || this.query.value.trim() || this.pinned) return;
    if (!files.length) { this.body.replaceChildren(h('p', {class: 'muted small'}, t('No changes'))); return; }
    this.body.replaceChildren(...this.diffFiles(files, true));
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
    this.pinned = true;
    // A change under review takes the whole side: the Prompt steps aside until the reference shows something else.
    this.element.closest('.work')?.classList.add('reviewing');
    this.query.value = '';
    for (const chip of this.chips.values()) chip.removeAttribute('aria-current');
    const diff = h('div', {}, h('p', {class: 'muted small'}, t('Reading…')));
    this.body.replaceChildren(h('article', {class: 'issue-one'}, head, ...actions), diff);
    void files.then((list) => {
      const shown = folder === null ? list : list.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === folder);
      diff.replaceChildren(...(shown.length ? this.diffFiles(shown, false) : [h('p', {class: 'muted small'}, t('No changes'))]));
    }, (e) => diff.replaceChildren(h('p', {class: 'error'}, e instanceof Error ? e.message : String(e))));
  }

  /** The repo's issues, one line each (#3 Fix：its title); pressed, one is shown in full. */
  private async issues() {
    const repo = this.repo;
    // No repo: nothing to refer to, and nothing said about it here.
    if (!repo) { this.body.replaceChildren(); return; }
    // Only the open ones, as Git shows them: one merged or closed is done with.
    const [all, merged] = await Promise.all([readIssues(store, repo), mergedIssues(repo)]);
    const list = all.filter((i) => i.closed === null && !merged.has(issuePath(i)));
    if (this.repo !== repo || this.view !== 'issue' || this.query.value.trim() || this.pinned) return;
    if (!list.length) { this.empty(all.length ? t('No open issues') : t('No issues yet')); return; }
    this.body.replaceChildren(h('ul', {class: 'issue-list'}, ...list.map((i) => {
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
  return h('div', {class: 'hit-group run'},
    h('div', {class: 'run-head'}, line, h('span', {class: 'row-meta'}, r.ms === null ? t('Running') : `${r.ms} ms`)),
    ...(shown.length ? [h('pre', {class: 'run-out'}, shown.join('\n'))] : []),
    ...(lines.length > RUN_LINES ? [h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', lines.length - RUN_LINES))] : []));
}
