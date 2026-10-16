import {bytes, h} from '../dom.ts';
import {icon} from '../icons.ts';
import {store, type Entry} from '../repos.ts';
import type {Context} from './context.ts';
import {terminalFor} from './terminal.ts';

/**
 * File: the repo strip on top, the repo read top to bottom in the center
 * (directories open into their files as you scroll), and the reference and
 * terminal on the right at the same weight as the center.
 */
export function file(ctx: Context): Node[] {
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
    flow.append(h('h1', {class: 'flow-title'}, current));
    flow.append(directory(current, '', 0));
  });
  return [h('div', {class: 'work'}, strip, flow, side)];
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Load `render` when `el` comes near the visible part of the flow. */
function whenNear(el: HTMLElement, render: () => Promise<void>) {
  const observer = new IntersectionObserver((seen) => {
    if (!seen.some((s) => s.isIntersecting)) return;
    observer.disconnect();
    void render();
  }, {rootMargin: '1200px 0px'});
  observer.observe(el);
}

function directory(repo: string, path: string, depth: number): HTMLElement {
  const section = h('section', {class: 'dir', 'data-path': path || '/'});
  if (path) section.append(h('h2', {class: 'path', style: `--depth:${depth}`}, `${path}/`));
  const body = h('div', {class: 'dir-body'}, h('p', {class: 'muted'}, '…'));
  section.append(body);
  whenNear(section, async () => {
    let entries: Entry[];
    try { entries = await store.tree(repo, path); } catch (e) { body.replaceChildren(h('p', {class: 'muted'}, String(e))); return; }
    if (!entries.length) { body.replaceChildren(h('p', {class: 'muted'}, '空のディレクトリ')); return; }
    // An index of this directory, then each entry in the same order.
    const index = h('ul', {class: 'index'}, ...entries.map((e) => {
      const target = join(path, e.name);
      const link = h('a', {href: `#${encodeURIComponent(target)}`}, e.kind === 'dir' ? `${e.name}/` : e.name);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        section.querySelector(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({block: 'start'});
      });
      return h('li', {}, link, e.kind === 'file' ? h('span', {class: 'muted'}, bytes(e.size)) : null);
    }));
    body.replaceChildren(index, ...entries.map((e) =>
      e.kind === 'dir' ? directory(repo, join(path, e.name), depth + 1) : fileView(repo, join(path, e.name), e)));
  });
  return section;
}

function fileView(repo: string, path: string, entry: Entry): HTMLElement {
  const section = h('section', {class: 'file', 'data-path': path},
    h('h2', {class: 'path'}, path, h('span', {class: 'muted'}, bytes(entry.size))));
  const body = h('pre', {class: 'code'}, '…');
  section.append(body);
  if (entry.kind === 'link') { body.textContent = 'シンボリックリンク'; return section; }
  whenNear(section, async () => {
    try {
      const c = await store.read(repo, path);
      if (c.text === null) { body.replaceWith(h('p', {class: 'muted'}, `バイナリ · ${bytes(c.size)}`)); return; }
      body.textContent = c.text || '（空）';
      if (c.truncated) section.append(h('p', {class: 'muted'}, `先頭 ${bytes(new TextEncoder().encode(c.text).length)} だけ表示しています（全体 ${bytes(c.size)}）`));
    } catch (e) {
      body.textContent = String(e);
    }
  });
  return section;
}
