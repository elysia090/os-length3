import {h} from '../dom.ts';
import {store} from '../repos.ts';
import {findInText, nameMatches, type Hit} from '../search.ts';

// The top of Forge's right pane: a search box over the band line, then one
// reference at a time, switched freely with chips. While something is
// typed in the search box, its results take the reference's place. Each
// view says plainly when it has nothing to show yet.

type View = 'issue' | 'diff' | 'run';
const VIEWS: readonly {id: View; label: string}[] = [
  {id: 'issue', label: 'Issue'},
  {id: 'diff', label: 'diff'},
  {id: 'run', label: '実行結果'},
];
const KEY = 'length3.os.reference';
const FILE_LIMIT = 2000;
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

  constructor(events: ReferenceEvents) {
    this.events = events;
    this.query = h('input', {type: 'search', class: 'search-in', placeholder: 'このrepoを検索',
      'aria-label': 'このrepoを検索', autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    // Edits may have changed the text since the last search.
    this.query.addEventListener('focus', () => { this.files = null; });
    this.query.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.paint(), 150);
    });
    this.query.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.query.value) { event.preventDefault(); this.query.value = ''; this.paint(); }
    });
    const bar = h('div', {class: 'chips', role: 'group', 'aria-label': '参照'});
    for (const v of VIEWS) {
      const chip = h('button', {type: 'button', class: 'chip'}, v.label);
      chip.addEventListener('click', () => { this.query.value = ''; this.choose(v.id); });
      this.chips.set(v.id, chip);
      bar.append(chip);
    }
    this.body = h('div', {class: 'reference-body'});
    const form = h('form', {class: 'search', role: 'search'}, this.query);
    form.addEventListener('submit', (event) => event.preventDefault());
    this.element = h('section', {class: 'pane reference', 'aria-label': '参照'}, form, bar, this.body);
    this.choose(this.view);
  }

  /** The repo Forge shows. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.files = null;
    this.query.disabled = !repo;
    this.paint();
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
    this.mark();
    if (this.query.value.trim()) { void this.search(this.query.value.trim()); return; }
    if (this.view === 'issue') void this.issues();
    else if (this.view === 'diff') this.empty('diff はまだありません。保存した変更をrepoの前の状態と比べられるようになると、ここに出ます。');
    else this.empty('実行結果はまだ接続していません。今はTerminalに直接出ます。');
  }

  private async search(query: string) {
    const repo = this.repo;
    if (!repo) { this.empty('repoを帯に出すと、そのrepoを検索できます。'); return; }
    const run = ++this.run;
    this.body.replaceChildren(h('p', {class: 'muted small'}, '検索中…'));
    this.files ??= readAll(repo);
    let files;
    try { files = await this.files; } catch (e) { this.empty(`検索できませんでした: ${String(e)}`); return; }
    if (run !== this.run || repo !== this.repo) return;
    const groups: {path: string; hits: Hit[]}[] = [];
    let total = 0;
    for (const f of files) {
      if (total >= HIT_LIMIT) break;
      const hits = findInText(f.text, query, HIT_LIMIT - total);
      if (!hits.length && !nameMatches(f.path, query)) continue;
      groups.push({path: f.path, hits});
      total += hits.length;
    }
    if (!groups.length) { this.empty(`「${query}」は見つかりませんでした。`); return; }
    this.body.replaceChildren(
      h('p', {class: 'muted small search-count'}, `${groups.length} file · ${total} 行${total >= HIT_LIMIT ? '（先頭だけ）' : ''}`),
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

  /** The repo's issue/ directory, one line per file. */
  private async issues() {
    const repo = this.repo;
    if (!repo) { this.empty('repoを開くと、そのrepoのissue/が出ます。'); return; }
    let names: string[];
    try {
      names = (await store.tree(repo, 'issue')).filter((e) => e.kind === 'file').map((e) => e.name);
    } catch {
      if (this.repo === repo && this.view === 'issue' && !this.query.value.trim()) this.empty('このrepoには issue/ がありません。');
      return;
    }
    if (this.repo !== repo || this.view !== 'issue' || this.query.value.trim()) return;
    if (!names.length) { this.empty('issue/ はまだ空です。ここに1件1fileで書きます。'); return; }
    this.body.replaceChildren(h('ul', {class: 'issue-list'}, ...names.map((n) => {
      const b = h('button', {type: 'button', class: 'link'}, n);
      b.addEventListener('click', () => this.events.reveal(`issue/${n}`));
      return h('li', {}, b);
    })));
  }
}
