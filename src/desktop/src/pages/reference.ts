import {h} from '../dom.ts';
import {diffFiles} from './diff-view.ts';
import * as gitops from '../history.ts';
import {t, tn} from '../i18n.ts';
import {onChange, store} from '../repos.ts';
import {findInText, nameMatches, type Hit} from '../search.ts';
import {sessionIfAny, type Run} from './terminal.ts';

// The top of Forge's right pane: a search box over the band line, then one
// reference at a time, switched freely with chips. While something is
// typed in the search box, its results take the reference's place. Each
// view says plainly when it has nothing to show yet.

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

function load(): View {
  try {
    const v = localStorage.getItem(KEY);
    return VIEWS.some((x) => x.id === v) ? v as View : 'issue';
  } catch { return 'issue'; }
}

export interface ReferenceEvents {
  /** Scroll the center to a path in the open repo, at `line` if given. */
  reveal(path: string, line?: number): void;
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

  constructor(events: ReferenceEvents) {
    this.events = events;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: t('Search this repo'),
      'aria-label': t('Search this repo'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    // Edits may have changed the text since the last search.
    this.query.addEventListener('focus', () => { this.files = null; });
    this.query.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.paint(), 150);
    });
    this.query.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.query.value) { event.preventDefault(); this.query.value = ''; this.paint(); }
    });
    const bar = h('div', {class: 'chips', role: 'group', 'aria-label': t('Reference')});
    for (const v of VIEWS) {
      const chip = h('button', {type: 'button', class: 'chip'}, t(v.label));
      chip.addEventListener('click', () => { this.query.value = ''; this.choose(v.id); });
      this.chips.set(v.id, chip);
      bar.append(chip);
    }
    this.body = h('div', {class: 'reference-body'});
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.element = h('section', {class: 'pane reference', 'aria-label': t('Reference')}, form, bar, this.body);
    this.choose(this.view);
    // The diff follows what is saved, here or in the Prompt; the issue list, what is written in issue/.
    const stop = onChange((c) => {
      if (!this.element.isConnected) { stop(); return; }
      if (c.repo !== this.repo || this.pinned || this.query.value.trim()) return;
      if (this.view !== 'diff' && !(this.view === 'issue' && (c.what === 'repo' || c.path === 'issue' || c.path.startsWith('issue/')))) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.paint(), 250);
    });
  }

  /** The repo Forge shows. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.query.disabled = !repo;
    this.paint();
  }

  /** Show one issue in full, with the way into its file. */
  showIssue(issue: {repo: string; file: string; kind: string | null; title: string; detail: string}, open: () => void) {
    this.pinned = true;
    this.element.closest('.work')?.classList.remove('reviewing');
    this.query.value = '';
    for (const chip of this.chips.values()) chip.removeAttribute('aria-current');
    const go = h('button', {type: 'button', class: 'button'}, t('Open in Forge'));
    go.addEventListener('click', open);
    this.body.replaceChildren(h('article', {class: 'issue-one'},
      h('h3', {}, issue.kind ? h('span', {class: 'issue-kind'}, `${issue.kind}：`) : null, issue.title),
      h('p', {class: 'issue-where muted'}, `${issue.repo} · issue/${issue.file}`),
      issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null,
      h('div', {class: 'row'}, go)));
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

  private empty(text: string) { this.body.replaceChildren(h('div', {class: 'empty'}, text)); }

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
    if (!groups.length) { this.empty(t('Nothing found for “{query}”.', {query})); return; }
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
      this.body.replaceChildren(...list.slice().reverse().map((r) => runView(r)));
    };
    draw();
    if (session) this.unwatch = session.watch(draw);
  }

  /** The changes not yet cut, file by file, line by line. */
  private async diff() {
    const repo = this.repo;
    if (!repo) { this.empty(t('Open a repo to see it here')); return; }
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
    return diffFiles(files, open ? {reveal: (p) => this.events.reveal(p)} : {});
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

  /** The repo's issue/ directory, one line per file. */
  private async issues() {
    const repo = this.repo;
    if (!repo) { this.empty(t('Open a repo to see it here')); return; }
    let names: string[];
    try {
      names = (await store.tree(repo, 'issue')).filter((e) => e.kind === 'file').map((e) => e.name);
    } catch {
      if (this.repo === repo && this.view === 'issue' && !this.query.value.trim() && !this.pinned) this.empty(t('No issue/ here'));
      return;
    }
    if (this.repo !== repo || this.view !== 'issue' || this.query.value.trim() || this.pinned) return;
    if (!names.length) { this.empty(t('No Issues yet')); return; }
    this.body.replaceChildren(h('ul', {class: 'issue-list'}, ...names.map((n) => {
      const b = h('button', {type: 'button', class: 'link'}, n);
      b.addEventListener('click', () => this.events.reveal(`issue/${n}`));
      return h('li', {}, b);
    })));
  }
}

/** One run: the line, how long it took (or that it is running), then its output. */
function runView(r: Run): HTMLElement {
  const lines = r.output.replace(/\n$/, '').split('\n');
  const shown = r.output ? lines.slice(0, RUN_LINES) : [];
  return h('div', {class: 'hit-group run'},
    h('div', {class: 'run-head'}, h('span', {class: 'run-line'}, r.line), h('span', {class: 'row-meta'}, r.ms === null ? t('Running') : `${r.ms} ms`)),
    ...(shown.length ? [h('pre', {class: 'run-out'}, shown.join('\n'))] : []),
    ...(lines.length > RUN_LINES ? [h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', lines.length - RUN_LINES))] : []));
}
