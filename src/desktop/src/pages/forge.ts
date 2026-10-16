import {bytes, h} from '../dom.ts';
import {store, type Entry} from '../repos.ts';
import type {Context} from './context.ts';
import {readingOrder} from '../reading.ts';
import {Reference} from './reference.ts';
import {terminalFor} from './terminal.ts';

/**
 * Forge, the place you work. From the first moment the large center is the
 * contents of File: the open repo's files one after another, read like a
 * page in a browser and scrolled to the file chosen in File. Nothing sits
 * above it, and there are no tabs; repos and files are chosen from File. A
 * narrow right pane stays out of the way: a reference switched freely on
 * top, the terminal below.
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
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'repoの中身'});
  const terminalTitle = h('h2', {id: 'terminal-title'}, 'Terminal');
  const terminalPane = h('section', {class: 'pane terminal', 'aria-labelledby': 'terminal-title'}, terminalTitle);
  const reference = new Reference({reveal: (path) => { chosen = path; soon(); void reader?.reveal(path); }});
  const side = h('aside', {class: 'side', 'aria-label': '参照とターミナル'}, reference.element, terminalPane);
  const work = h('div', {class: 'work'}, flow, side);

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

  /** Show `repo` in the center and the terminal, in place. */
  const show = (repo: string, path = '') => {
    if (reader?.repo !== repo) {
      ctx.remember(repo);
      reader = new Reader(repo);
      reference.setRepo(repo);
      flow.replaceChildren(reader.directory(''));
      flow.scrollTop = 0;
      terminalPane.replaceChildren(terminalTitle, terminalFor(repo));
    }
    if (path) { chosen = path; soon(); void reader.reveal(path); }
  };
  live = {element: work, show};

  void store.list().then((repos) => {
    const current = ctx.repo && repos.some((r) => r.name === ctx.repo) ? ctx.repo : repos[0]?.name ?? null;
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

/** One repo read top to bottom: only files, directories are just where they come from. */
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

  directory(path: string): HTMLElement {
    const section = h('section', {class: 'dir', 'data-path': path || '/'}, path ? null : h('p', {class: 'muted'}, '…'));
    this.sections.set(path, section);
    this.loads.set(path, lazy(section, () => this.fill(path, section)));
    return section;
  }

  private async fill(path: string, section: HTMLElement) {
    let entries: Entry[];
    try { entries = await store.tree(this.repo, path); } catch (e) { section.replaceChildren(h('p', {class: 'muted'}, String(e))); return; }
    // An empty directory shows nothing; only an empty repo says so.
    if (!entries.length) { section.replaceChildren(path ? '' : h('div', {class: 'empty'}, 'このrepoにはまだfileがありません。')); return; }
    section.replaceChildren(...readingOrder(entries).map((e) =>
      e.kind === 'dir' ? this.directory(join(path, e.name)) : this.file(join(path, e.name), e)));
  }

  private file(path: string, entry: Entry): HTMLElement {
    // The heading is the file's place in "/": the repo part quiet, the rest plain.
    const section = h('section', {class: 'file', 'data-path': path, 'data-size': String(entry.size)},
      h('h2', {class: 'path'}, h('span', {}, h('span', {class: 'muted'}, `/root/${this.repo}/`), path),
        h('span', {class: 'muted'}, bytes(entry.size))));
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
