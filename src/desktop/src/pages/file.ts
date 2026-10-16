import {bytes, h} from '../dom.ts';
import {icon} from '../icons.ts';
import {store, type Entry} from '../repos.ts';
import type {Context} from './context.ts';
import {terminalFor} from './terminal.ts';
import {tree} from './tree.ts';

/**
 * File: the tree of "/" lies over the left edge and opens under the pointer;
 * the repo strip on top, the repo read top to bottom in the center
 * (directories open into their files as you scroll), and the reference and
 * terminal on the right at the same weight as the center. Choosing a path
 * inside a repo in the tree scrolls the center to it.
 */

/** A path chosen in the tree for a repo that is not open yet. */
let pendingReveal: string | null = null;

export function file(ctx: Context): Node[] {
  let reader: Reader | null = null;
  const left = tree(ctx.repo, {
    choose(repo, path) {
      if (reader && reader.repo === repo) { void reader.reveal(path); return; }
      pendingReveal = path;
      ctx.openRepo(repo);
    },
  });
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'repoの中身'});
  const side = h('aside', {class: 'side', 'aria-label': '参照とターミナル'},
    h('section', {class: 'pane', 'aria-labelledby': 'reference-title'},
      h('h2', {id: 'reference-title'}, '参照'),
      h('div', {class: 'empty'}, 'プレビュー・diff・実行結果・関連Issueを、今の作業に合わせて切り替えて見る場所です。まだ接続していません。')),
    h('section', {class: 'pane terminal', 'aria-labelledby': 'terminal-title'},
      h('h2', {id: 'terminal-title'}, 'Terminal')));
  const terminalPane = side.lastElementChild as HTMLElement;

  void store.list().then((repos) => {
    const current = ctx.repo && repos.some((r) => r.name === ctx.repo) ? ctx.repo : repos[0]?.name ?? null;
    for (const r of repos) {
      const tab = h('button', {type: 'button', class: 'repo-tab'}, r.name);
      if (r.name === current) tab.setAttribute('aria-current', 'page');
      tab.addEventListener('click', () => ctx.openRepo(r.name));
      strip.append(tab);
    }
    const add = h('button', {type: 'button', class: 'repo-tab add', 'aria-label': '新しいrepo'}, icon('new-repo'));
    add.addEventListener('click', () => ctx.go('new-repo'));
    strip.append(add);
    if (!current) {
      flow.append(h('div', {class: 'empty'}, 'repoがありません。上の ＋ から作れます。'));
      terminalPane.append(h('div', {class: 'empty'}, 'repoを開くと、そのrepoでshellが動きます。'));
      return;
    }
    terminalPane.append(terminalFor(current));
    reader = new Reader(current);
    flow.append(h('h1', {class: 'flow-title'}, current), reader.directory('', 0));
    const path = pendingReveal;
    pendingReveal = null;
    if (path) void reader.reveal(path);
  });
  return [h('div', {class: 'work'}, left, strip, flow, side)];
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Run `load` once, when `el` comes near the visible part of the flow or when asked. */
function lazy(el: HTMLElement, load: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | null = null;
  const run = () => (started ??= load());
  const observer = new IntersectionObserver((seen) => {
    if (!seen.some((s) => s.isIntersecting)) return;
    observer.disconnect();
    void run();
  }, {rootMargin: '1200px 0px'});
  observer.observe(el);
  return () => { observer.disconnect(); return run(); };
}

/** One repo read top to bottom. */
class Reader {
  readonly repo: string;
  /** Directory loaders by path ('' is the repo root). */
  private loads = new Map<string, () => Promise<void>>();
  /** Every directory and file section by path. */
  private sections = new Map<string, HTMLElement>();

  constructor(repo: string) { this.repo = repo; }

  /** Load the directories down to `path`, then scroll it into view. */
  async reveal(path: string) {
    const parts = path ? path.split('/') : [];
    for (let i = 0; i < parts.length; i++) await this.loads.get(parts.slice(0, i).join('/'))?.();
    const target = path ? this.sections.get(path) : this.sections.get('');
    if (!target) return;
    target.scrollIntoView({block: 'start'});
    target.classList.add('revealed');
    setTimeout(() => target.classList.remove('revealed'), 1200);
  }

  directory(path: string, depth: number): HTMLElement {
    const section = h('section', {class: 'dir', 'data-path': path || '/'});
    this.sections.set(path, section);
    if (path) section.append(h('h2', {class: 'path', style: `--depth:${depth}`}, `${path}/`));
    const body = h('div', {class: 'dir-body'}, h('p', {class: 'muted'}, '…'));
    section.append(body);
    this.loads.set(path, lazy(section, () => this.fill(path, depth, body)));
    return section;
  }

  private async fill(path: string, depth: number, body: HTMLElement) {
    let entries: Entry[];
    try { entries = await store.tree(this.repo, path); } catch (e) { body.replaceChildren(h('p', {class: 'muted'}, String(e))); return; }
    if (!entries.length) { body.replaceChildren(h('p', {class: 'muted'}, '空のディレクトリ')); return; }
    // An index of this directory, then each entry in the same order.
    const index = h('ul', {class: 'index'}, ...entries.map((e) => {
      const target = join(path, e.name);
      const link = h('a', {href: `#${encodeURIComponent(target)}`}, e.kind === 'dir' ? `${e.name}/` : e.name);
      link.addEventListener('click', (event) => { event.preventDefault(); void this.reveal(target); });
      return h('li', {}, link, e.kind === 'file' ? h('span', {class: 'muted'}, bytes(e.size)) : null);
    }));
    body.replaceChildren(index, ...entries.map((e) =>
      e.kind === 'dir' ? this.directory(join(path, e.name), depth + 1) : this.file(join(path, e.name), e)));
  }

  private file(path: string, entry: Entry): HTMLElement {
    const section = h('section', {class: 'file', 'data-path': path},
      h('h2', {class: 'path'}, path, h('span', {class: 'muted'}, bytes(entry.size))));
    this.sections.set(path, section);
    const body = h('pre', {class: 'code'}, '…');
    section.append(body);
    if (entry.kind === 'link') { body.textContent = 'シンボリックリンク'; return section; }
    lazy(section, async () => {
      try {
        const c = await store.read(this.repo, path);
        if (c.text === null) { body.replaceWith(h('p', {class: 'muted'}, `バイナリ · ${bytes(c.size)}`)); return; }
        body.textContent = c.text || '（空）';
        if (c.truncated) section.append(h('p', {class: 'muted'}, `先頭 ${bytes(new TextEncoder().encode(c.text).length)} だけ表示しています（全体 ${bytes(c.size)}）`));
      } catch (e) {
        body.textContent = String(e);
      }
    });
    return section;
  }
}
