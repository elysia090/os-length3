import {addToBand, offBand, parseBand, removeFromBand} from '../band.ts';
import {getState, setState} from '../state.ts';
import {bytes, h} from '../dom.ts';
import {mark} from '../icons.ts';
import {onChange, store, type Change, type Entry} from '../repos.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {lineCount, readingOrder} from '../reading.ts';
import {bench} from './bench.ts';

/**
 * Forge, the place you work. The repos out to work on run as pills in a band
 * on the top line; ⊕ brings the rest out and each
 * pill comes off with its ×. The large center is the open repo's files one
 * after another, an endless page you scroll through and edit in place,
 * opened at the file chosen in File; there are no tabs. A prompt box sits at
 * the bottom of the center. The narrow right pane holds the search box and a
 * reference switched freely on top and the terminal below; using the prompt
 * box sends the terminal up over the center, just above the box, and the
 * reference grows down into the room it leaves.
 */

/** Set when Forge is opened for a repo: the path to scroll to ('' for the top). */
let pending: string | null = null;

/** The Forge on screen, so File can move it in place. */
let live: {element: HTMLElement; show(repo: string, path: string): void} | null = null;

/** Show `repo` at `path` in the Forge on screen; false when Forge is not showing. */
export function showInForge(repo: string, path: string): boolean {
  if (!live?.element.isConnected) return false;
  live.show(repo, path);
  return true;
}

/** Forge is next drawn for the repo just asked for, at `path` ('' for its top). */
export function revealNext(path: string) { pending = path; }

export function forge(ctx: Context): Node[] {
  let reader: Reader | null = null;
  let repo: string | null = null;
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'repoの中身'});

  const work = bench({strip, main: flow, reveal: (path, line) => void reader?.reveal(path, line)});

  // The band: ⊕ at its left, then the repos out to work on, each a pill that
  // comes off with its ×. One press of ⊕ brings every repo not on the band
  // out at once, on the right; this is not adding tabs one by one. With no
  // pill left the center shows Topic.
  let band: string[] = [];
  let all: string[] = [];
  const pills = h('div', {class: 'pills'});
  const add = h('button', {type: 'button', class: 'band-add', 'aria-label': 'repoを全部帯に出す'}, mark('plus')) as HTMLButtonElement;
  strip.append(add, pills);
  const saveBand = () => { void setState('band', JSON.stringify(band)).catch(() => { /* the band is a convenience */ }); };
  add.addEventListener('click', () => {
    const rest = offBand(band, all);
    if (!rest.length) return;
    for (const name of rest) band = addToBand(band, name);
    saveBand();
    if (repo) paintBand(); else show(rest[0]);
  });

  const paintBand = () => {
    pills.replaceChildren(...band.map((name) => {
      const open = h('button', {type: 'button', class: 'pill-name'}, name);
      open.addEventListener('click', () => show(name));
      const close = h('button', {type: 'button', class: 'pill-close', 'aria-label': `${name}を帯から外す`}, mark('close'));
      close.addEventListener('click', () => takeOff(name));
      const pill = h('span', {class: 'pill', 'data-repo': name}, open, close);
      if (name === repo) pill.setAttribute('aria-current', 'page');
      return pill;
    }));
    const rest = offBand(band, all).length;
    add.disabled = rest === 0;
    add.title = rest ? `repoを全部帯に出す（あと ${rest}）` : 'すべてのrepoが帯に出ています';
  };

  const takeOff = (name: string) => {
    const r = removeFromBand(band, name, repo);
    band = r.band;
    saveBand();
    if (!r.active) topic();
    else if (r.active !== repo) show(r.active);
    else paintBand();
  };

  /** Nothing on the band: the center is Topic. */
  const topic = () => {
    repo = null;
    reader = null;
    work.setRepo(null, '帯にrepoを出すと動きます');
    flow.replaceChildren(h('div', {class: 'topic'}, pageHead('topic'),
      h('div', {class: 'empty'}, 'まだ投稿はありません')));
    flow.scrollTop = 0;
    paintBand();
  };

  /** Show `name` in the band, the center and the terminal, in place. */
  const show = (name: string, path = '') => {
    band = addToBand(band, name);
    saveBand();
    if (repo !== name) {
      repo = name;
      ctx.remember(name);
      reader = new Reader(name, flow);
      work.setRepo(name);
      flow.replaceChildren(reader.directory(''));
      flow.scrollTop = 0;
    }
    paintBand();
    if (path) void reader!.reveal(path);
  };
  live = {element: work.element, show};

  // The repo changed through the store (the shell, l3's twin in the Prompt,
  // Git…): open files take the new text, new or removed entries redraw the
  // page where it was.
  let again = 0;
  const stop = onChange((c) => {
    if (!work.element.isConnected) { stop(); return; }
    if (c.repo !== repo || !reader || !reader.take(c)) return;
    clearTimeout(again);
    again = window.setTimeout(() => {
      if (!repo) return;
      const top = flow.scrollTop;
      reader = new Reader(repo, flow);
      flow.replaceChildren(reader.directory(''));
      requestAnimationFrame(() => { flow.scrollTop = top; });
    }, 150);
  });

  void store.list().then((repos) => {
    all = repos.map((r) => r.name);
    band = parseBand(getState('band'), all, ctx.repo);
    const asked = pending;
    pending = null;
    // Opened for a repo (from File, Home or a new repo): it goes on the band.
    if (asked !== null && ctx.repo && all.includes(ctx.repo)) { show(ctx.repo, asked); return; }
    const first = ctx.repo && band.includes(ctx.repo) ? ctx.repo : band[0];
    if (first) show(first); else topic();
  });
  return [work.element];
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);


/**
 * Run `load` once, when `el` comes near the visible part of `root` or when
 * asked. The scrolling flow must be the root: it clips what is outside it,
 * so measuring against the window would never see the margin ahead.
 */
function lazy(el: HTMLElement, root: HTMLElement, load: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | null = null;
  const run = () => (started ??= load());
  const observer = new IntersectionObserver((seen) => {
    if (!seen.some((s) => s.isIntersecting)) return;
    observer.disconnect();
    void run();
  }, {root, rootMargin: '1200px 0px'});
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
  /** File loaders and the editors they made, by path. */
  private fileLoads = new Map<string, () => Promise<void>>();
  private editors = new Map<string, HTMLTextAreaElement>();
  /** For each open editor: take a text saved elsewhere; false when the person has unsaved edits. */
  private takers = new Map<string, (text: string) => boolean>();
  private flow: HTMLElement;

  constructor(repo: string, flow: HTMLElement) { this.repo = repo; this.flow = flow; }

  /**
   * A change made through the store: an open file takes the new text; true
   * when the page must be read again (a file or directory came or went).
   */
  take(c: Change): boolean {
    if (c.what !== 'file') return true;
    const taker = this.takers.get(c.path);
    if (taker) { taker(c.text ?? ''); return false; }
    // Not open yet: shown when it comes into view, if it is already listed.
    return !this.sections.has(c.path);
  }

  /** Load the directories down to `path`, scroll it into view, and at `line` put the caret there. */
  async reveal(path: string, line = 0) {
    const parts = path ? path.split('/') : [];
    for (let i = 0; i < parts.length; i++) await this.loads.get(parts.slice(0, i).join('/'))?.();
    const target = path ? this.sections.get(path) : this.sections.get('');
    if (!target) return;
    target.scrollIntoView({block: 'start'});
    target.classList.add('revealed');
    setTimeout(() => target.classList.remove('revealed'), 1200);
    if (!line) return;
    await this.fileLoads.get(path)?.();
    const area = this.editors.get(path);
    if (!area) return;
    const lines = area.value.split('\n');
    const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    area.focus({preventScroll: true});
    area.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
    const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
    const top = area.getBoundingClientRect().top - this.flow.getBoundingClientRect().top + this.flow.scrollTop;
    this.flow.scrollTop = top + (line - 1) * height - this.flow.clientHeight / 3;
  }

  directory(path: string): HTMLElement {
    const section = h('section', {class: 'dir', 'data-path': path || '/'}, path ? null : h('p', {class: 'muted'}, '…'));
    this.sections.set(path, section);
    this.loads.set(path, lazy(section, this.flow, () => this.fill(path, section)));
    return section;
  }

  private async fill(path: string, section: HTMLElement) {
    let entries: Entry[];
    try { entries = await store.tree(this.repo, path); } catch (e) { section.replaceChildren(h('p', {class: 'muted'}, String(e))); return; }
    // An empty directory shows nothing; only an empty repo says so.
    if (!entries.length) { section.replaceChildren(path ? '' : h('div', {class: 'empty'}, 'fileはまだありません')); return; }
    section.replaceChildren(...readingOrder(entries).map((e) =>
      e.kind === 'dir' ? this.directory(join(path, e.name)) : this.file(join(path, e.name), e)));
  }

  /** A file as a plain text editor: its place in "/", line numbers, the text to edit. */
  private file(path: string, entry: Entry): HTMLElement {
    // Says something only when the file is not simply saved.
    const state = h('span', {class: 'file-state', role: 'status'});
    // The heading is the file's place in "/": the repo part quiet, the rest plain.
    const head = h('h2', {class: 'path'}, h('span', {}, h('span', {class: 'muted'}, `/root/${this.repo}/`), path), state);
    const section = h('section', {class: 'file', 'data-path': path}, head);
    this.sections.set(path, section);
    const gutter = h('pre', {class: 'gutter', 'aria-hidden': 'true'});
    const sheet = h('div', {class: 'sheet'}, gutter, h('pre', {class: 'code'}, '…'));
    section.append(sheet);
    if (entry.kind === 'link') { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, 'シンボリックリンク')); return section; }
    const number = (text: string) => {
      gutter.textContent = Array.from({length: Math.max(lineCount(text), 1)}, (_, i) => String(i + 1)).join('\n');
    };
    this.fileLoads.set(path, lazy(section, this.flow, async () => {
      let c;
      try { c = await store.read(this.repo, path); } catch (e) { state.textContent = String(e); return; }
      if (c.text === null) { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, `バイナリ · ${bytes(c.size)}`)); return; }
      number(c.text);
      if (c.truncated) {
        // Only part of it was read, so it is never written back.
        sheet.replaceChildren(gutter, h('pre', {class: 'code'}, c.text));
        state.textContent = `先頭 ${bytes(new TextEncoder().encode(c.text).length)} だけ（全体 ${bytes(c.size)}）· 読むだけ`;
        return;
      }
      const area = h('textarea', {class: 'code edit', rows: '1', wrap: 'off', spellcheck: 'false', autocapitalize: 'off',
        'aria-label': `${path} を編集`}) as HTMLTextAreaElement;
      area.value = c.text;
      sheet.replaceChildren(gutter, area);
      this.editors.set(path, area);
      const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
      // The whole box is the place to write: a press below the text puts the caret at its end.
      sheet.addEventListener('pointerdown', (event) => {
        if (event.target === area) return;
        event.preventDefault();
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      });
      requestAnimationFrame(fit);
      let saved = c.text;
      let timer = 0;
      // A text saved elsewhere (the shell, l3, Git) comes in unless this one has unsaved edits.
      this.takers.set(path, (text) => {
        if (text === area.value) { saved = text; return true; }
        if (area.value !== saved) { state.textContent = '外で変更されました。保存するとこちらで上書きします'; return false; }
        saved = text;
        area.value = text;
        fit();
        number(text);
        return true;
      });
      const save = async () => {
        clearTimeout(timer);
        if (area.value === saved) { state.textContent = ''; return; }
        const text = area.value;
        try {
          await store.write(this.repo, path, text);
          saved = text;
          state.textContent = area.value === saved ? '' : '未保存';
        } catch (e) {
          state.textContent = `保存できませんでした: ${e instanceof Error ? e.message : String(e)}`;
        }
      };
      area.addEventListener('input', () => {
        fit();
        number(area.value);
        state.textContent = '未保存';
        clearTimeout(timer);
        timer = window.setTimeout(() => void save(), 700);
      });
      area.addEventListener('blur', () => void save());
      area.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); return; }
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
          area.dispatchEvent(new Event('input'));
          return;
        }
        // Escape leaves the text, so the keyboard is never caught in it.
        if (event.key === 'Escape') area.blur();
      });
    }));
    return section;
  }
}
