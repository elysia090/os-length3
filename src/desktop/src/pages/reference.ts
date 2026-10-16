import {h} from '../dom.ts';
import {store} from '../repos.ts';

// The top of Forge's right pane: one reference at a time, switched freely
// with chips. Each view says plainly when it has nothing to show yet.

type View = 'issue' | 'diff' | 'run';
const VIEWS: readonly {id: View; label: string}[] = [
  {id: 'issue', label: 'Issue'},
  {id: 'diff', label: 'diff'},
  {id: 'run', label: '実行結果'},
];
const KEY = 'length3.os.reference';

function load(): View {
  try {
    const v = localStorage.getItem(KEY);
    return VIEWS.some((x) => x.id === v) ? v as View : 'issue';
  } catch { return 'issue'; }
}

export interface ReferenceEvents {
  /** Scroll the center to a path in the open repo. */
  reveal(path: string): void;
}

export class Reference {
  readonly element: HTMLElement;
  private body: HTMLElement;
  private chips = new Map<View, HTMLElement>();
  private view = load();
  private repo: string | null = null;
  private events: ReferenceEvents;

  constructor(events: ReferenceEvents) {
    this.events = events;
    const bar = h('div', {class: 'chips', role: 'group', 'aria-label': '参照'});
    for (const v of VIEWS) {
      const chip = h('button', {type: 'button', class: 'chip'}, v.label);
      chip.addEventListener('click', () => this.choose(v.id));
      this.chips.set(v.id, chip);
      bar.append(chip);
    }
    this.body = h('div', {class: 'reference-body'});
    this.element = h('section', {class: 'pane reference', 'aria-label': '参照'}, bar, this.body);
    this.choose(this.view);
  }

  /** The repo Forge shows. */
  setRepo(repo: string | null) {
    this.repo = repo;
    this.paint();
  }

  private choose(view: View) {
    this.view = view;
    try { localStorage.setItem(KEY, view); } catch { /* convenience only */ }
    for (const [id, chip] of this.chips) {
      if (id === view) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    }
    this.paint();
  }

  private empty(text: string) { this.body.replaceChildren(h('div', {class: 'empty'}, text)); }

  private paint() {
    if (this.view === 'issue') {
      void this.issues();
    } else if (this.view === 'diff') {
      this.empty('diff はまだありません。Forgeでの編集をrepoに書き戻せるようになると、ここに出ます。');
    } else {
      this.empty('実行結果はまだ接続していません。今はTerminalに直接出ます。');
    }
  }

  /** The repo's issue/ directory, one line per file. */
  private async issues() {
    const repo = this.repo;
    if (!repo) { this.empty('repoを開くと、そのrepoのissue/が出ます。'); return; }
    let names: string[];
    try {
      names = (await store.tree(repo, 'issue')).filter((e) => e.kind === 'file').map((e) => e.name);
    } catch {
      if (this.repo === repo && this.view === 'issue') this.empty('このrepoには issue/ がありません。');
      return;
    }
    if (this.repo !== repo || this.view !== 'issue') return;
    if (!names.length) { this.empty('issue/ はまだ空です。ここに1件1fileで書きます。'); return; }
    this.body.replaceChildren(h('ul', {class: 'issue-list'}, ...names.map((n) => {
      const b = h('button', {type: 'button', class: 'link'}, n);
      b.addEventListener('click', () => this.events.reveal(`issue/${n}`));
      return h('li', {}, b);
    })));
  }
}
