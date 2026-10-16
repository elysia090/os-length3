import {bytes, h} from '../dom.ts';
import {store, type Entry} from '../repos.ts';
import type {Context} from './context.ts';
import {Reference} from './reference.ts';
import {terminalFor} from './terminal.ts';

/**
 * Forge, the place you work: the repos as a strip of chips across the top,
 * the open repo read like a page in a browser in the large center (scrolled
 * to the file chosen in File), and a narrow right pane that stays out of the
 * way: a reference switched freely on top, the terminal below. There are no
 * tabs here; files are chosen from File.
 */

/** A path to scroll to once Forge is drawn. */
let pending: string | null = null;
/** The Forge on screen, so File can move it in place. */
let live: {element: HTMLElement; show(repo: string, path: string): void} | null = null;

/** Show `repo` at `path` in the Forge on screen; false when Forge is not showing. */
export function showInForge(repo: string, path: string): boolean {
  if (!live?.element.isConnected) return false;
  live.show(repo, path);
  return true;
}

/** Scroll to `path` when Forge is next drawn. */
export function revealNext(path: string) { pending = path || null; }

export function forge(ctx: Context): Node[] {
  let reader: Reader | null = null;
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'repoの中身'});
  const terminalTitle = h('h2', {id: 'terminal-title'}, 'Terminal');
  const terminalPane = h('section', {class: 'pane terminal', 'aria-labelledby': 'terminal-title'}, terminalTitle);
  const reference = new Reference({reveal: (path) => { chosen = path; soon(); void reader?.reveal(path); }});
  const side = h('aside', {class: 'side', 'aria-label': '参照とターミナル'}, reference.element, terminalPane);
  const work = h('div', {class: 'work'}, strip, flow, side);

  // The reference follows the file at the top of the center as it scrolls,
  // or the file just chosen in File until the person scrolls themselves
  // (a short file near the end may never reach the top).
  let frame = 0;
  let chosen: string | null = null;
  const follow = () => {
    frame = 0;
    const top = flow.getBoundingClientRect().top + 48;
    let at: HTMLElement | null = chosen ? flow.querySelector<HTMLElement>(`section.file[data-path="${CSS.escape(chosen)}"]`) : null;
    if (!at) for (const f of flow.querySelectorAll<HTMLElement>('section.file')) {
      const r = f.getBoundingClientRect();
      if (r.top <= top + 1 && r.bottom > top) { at = f; break; }
      if (r.top > top) { at ??= f; break; }
    }
    reference.setFile(at ? {path: at.dataset.path!, size: Number(at.dataset.size),
      lines: at.dataset.lines ? Number(at.dataset.lines) : null} : null);
  };
  const soon = () => { frame ||= requestAnimationFrame(follow); };
  flow.addEventListener('scroll', soon, {passive: true});
  for (const type of ['wheel', 'keydown', 'touchmove']) {
    flow.addEventListener(type, () => { chosen = null; }, {passive: true});
  }
  new MutationObserver(soon).observe(flow, {subtree: true, childList: true, attributes: true, attributeFilter: ['data-lines']});

  /** Show `repo` in the strip, the center and the terminal, in place. */
  const show = (repo: string, path = '') => {
    if (reader?.repo !== repo) {
      ctx.remember(repo);
      for (const chip of strip.querySelectorAll<HTMLElement>('.chip')) {
        if (chip.dataset.repo === repo) chip.setAttribute('aria-current', 'page'); else chip.removeAttribute('aria-current');
      }
      reader = new Reader(repo);
      reference.setRepo(repo);
      flow.replaceChildren(h('h1', {class: 'flow-title'}, repo), reader.directory('', 0));
      flow.scrollTop = 0;
      terminalPane.replaceChildren(terminalTitle, terminalFor(repo));
    }
    if (path) { chosen = path; soon(); void reader.reveal(path); }
  };
  live = {element: work, show};

  void store.list().then((repos) => {
    const current = ctx.repo && repos.some((r) => r.name === ctx.repo) ? ctx.repo : repos[0]?.name ?? null;
    for (const r of repos) {
      const chip = h('button', {type: 'button', class: 'chip', 'data-repo': r.name}, r.name);
      chip.addEventListener('click', () => show(r.name));
      strip.append(chip);
    }
    const path = pending ?? '';
    pending = null;
    if (current) { show(current, path); return; }
    flow.append(h('div', {class: 'empty'}, 'repoがありません。左の ＋ から作れます。'));
    terminalPane.append(h('div', {class: 'empty'}, 'repoを開くと、そのrepoでshellが動きます。'));
  });
  return [work];
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
    // Each entry in order, like one long page; there is no index to click.
    body.replaceChildren(...entries.map((e) =>
      e.kind === 'dir' ? this.directory(join(path, e.name), depth + 1) : this.file(join(path, e.name), e)));
  }

  private file(path: string, entry: Entry): HTMLElement {
    const section = h('section', {class: 'file', 'data-path': path, 'data-size': String(entry.size)},
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
        section.dataset.lines = String(c.text ? c.text.split('\n').length - (c.text.endsWith('\n') ? 1 : 0) : 0);
        if (c.truncated) section.append(h('p', {class: 'muted'}, `先頭 ${bytes(new TextEncoder().encode(c.text).length)} だけ表示しています（全体 ${bytes(c.size)}）`));
      } catch (e) {
        body.textContent = String(e);
      }
    });
    return section;
  }
}
