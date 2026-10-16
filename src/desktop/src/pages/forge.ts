import {addToBand, offBand, parseBand, removeFromBand} from '../band.ts';
import {bytes, h} from '../dom.ts';
import {mark} from '../icons.ts';
import {store, type Entry} from '../repos.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {lineCount, readingOrder} from '../reading.ts';
import {Reference} from './reference.ts';
import {sessionFor, terminalFor} from './terminal.ts';

/**
 * Forge, the place you work. The repos out to work on run as pills in a band
 * set low at the top; ⊕ brings more out and each pill comes off with its ×. The large center is the open repo's files one after another, an
 * endless page you scroll through and edit in place, opened at the file chosen
 * in File; there are no tabs. A prompt box sits at the bottom of the center. The narrow
 * right pane holds a reference switched freely on top and the terminal
 * below; using the prompt box sends the terminal up over the center, just
 * above the box, and the reference grows down into the room it leaves.
 */

/** Set when Forge is opened for a repo: the path to scroll to ('' for the top). */
let pending: string | null = null;
const BAND_KEY = 'length3.os.band';

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
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

const MOVE = 280;

/** Move `el` into `to`, animating from where it was (FLIP). */
function fly(el: HTMLElement, to: HTMLElement) {
  const from = el.getBoundingClientRect();
  to.append(el);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const at = el.getBoundingClientRect();
  if (!at.width || !from.width) return;
  el.animate([
    {transformOrigin: 'top left', transform: `translate(${from.left - at.left}px, ${from.top - at.top}px) scale(${from.width / at.width}, ${from.height / at.height})`},
    {transformOrigin: 'top left', transform: 'none'},
  ], {duration: MOVE, easing: 'cubic-bezier(.2, .9, .25, 1.06)'});
}

export function forge(ctx: Context): Node[] {
  let reader: Reader | null = null;
  let repo: string | null = null;
  const strip = h('nav', {class: 'repo-strip', 'aria-label': 'repo'});
  const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'repoの中身'});

  // The terminal: a box that lives at the bottom of the right pane and flies
  // up above the prompt box while the prompt is in use.
  const termBox = h('section', {class: 'term-box', 'aria-label': 'Terminal'}, h('h2', {}, 'Terminal'));
  const termHome = h('div', {class: 'term-home'}, termBox);
  const termSlot = h('div', {class: 'term-slot'});
  const prompt = h('textarea', {class: 'prompt-in', rows: '1', 'aria-label': 'プロンプト',
    placeholder: 'コマンドを入力して Enter（このrepoの sh に送られます）', spellcheck: 'false', autocapitalize: 'off'}) as HTMLTextAreaElement;
  const note = h('p', {class: 'prompt-note muted small', role: 'status'});
  const dock = h('div', {class: 'dock'}, termSlot, h('form', {class: 'prompt'}, prompt), note);
  const center = h('div', {class: 'center'}, flow, dock);

  const reference = new Reference({reveal: (path, line) => void reader?.reveal(path, line)});
  const side = h('aside', {class: 'side', 'aria-label': '参照とターミナル'}, reference.element, termHome);
  const work = h('div', {class: 'work'}, strip, center, side);

  let prompting = false;
  const setPrompting = (on: boolean) => {
    if (on === prompting) return;
    prompting = on;
    work.classList.toggle('prompting', on);
    fly(termBox, on ? termSlot : termHome);
  };
  const fit = () => { prompt.style.height = 'auto'; prompt.style.height = `${prompt.scrollHeight}px`; };
  prompt.addEventListener('focus', () => setPrompting(true));
  prompt.addEventListener('input', fit);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setPrompting(false); prompt.blur(); return; }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!repo) return;
    if (!sessionFor(repo).send(prompt.value)) { note.textContent = 'shellはまだ起動していません'; return; }
    note.textContent = '';
    prompt.value = '';
    fit();
  });
  // Leaving the prompt and the terminal sends the terminal home; losing the
  // window's focus does not.
  dock.addEventListener('focusout', (event) => {
    const to = event.relatedTarget as Node | null;
    if (to && !dock.contains(to)) setPrompting(false);
  });
  termBox.addEventListener('pointerdown', (event) => {
    if (prompting || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    prompt.focus();
  });


  // The band: ⊕ at its left, then the repos out to work on, each a pill that
  // comes off with its ×. One press of ⊕ brings every repo not on the band
  // out at once, on the right; this is not adding tabs one by one. With no
  // pill left the center shows Topic.
  let band: string[] = [];
  let all: string[] = [];
  const pills = h('div', {class: 'pills'});
  const add = h('button', {type: 'button', class: 'band-add', 'aria-label': 'repoを全部帯に出す'}, mark('plus')) as HTMLButtonElement;
  strip.append(add, pills);
  const saveBand = () => { try { localStorage.setItem(BAND_KEY, JSON.stringify(band)); } catch { /* convenience only */ } };
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
    reference.setRepo(null);
    flow.replaceChildren(h('div', {class: 'topic'}, pageHead('topic'),
      h('div', {class: 'empty'}, 'まだ投稿はありません。帯の ⊕ からrepoを出すと、ここはそのrepoのfileになります。')));
    flow.scrollTop = 0;
    termBox.replaceChildren(termBox.firstChild!, h('div', {class: 'empty'}, 'repoを帯に出すと、そのrepoでshellが動きます。'));
    prompt.disabled = true;
    prompt.placeholder = '帯にrepoを出すと、そのrepoの sh に送れます';
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
      reference.setRepo(name);
      flow.replaceChildren(reader.directory(''));
      flow.scrollTop = 0;
      termBox.replaceChildren(termBox.firstChild!, terminalFor(name));
      prompt.disabled = false;
      prompt.placeholder = 'コマンドを入力して Enter（このrepoの sh に送られます）';
    }
    paintBand();
    if (path) void reader!.reveal(path);
  };
  live = {element: work, show};

  prompt.disabled = true;
  void store.list().then((repos) => {
    all = repos.map((r) => r.name);
    band = parseBand(load(BAND_KEY), all, ctx.repo);
    const asked = pending;
    pending = null;
    // Opened for a repo (from File, Home or a new repo): it goes on the band.
    if (asked !== null && ctx.repo && all.includes(ctx.repo)) { show(ctx.repo, asked); return; }
    const first = ctx.repo && band.includes(ctx.repo) ? ctx.repo : band[0];
    if (first) show(first); else topic();
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
  /** File loaders and the editors they made, by path. */
  private fileLoads = new Map<string, () => Promise<void>>();
  private editors = new Map<string, HTMLTextAreaElement>();
  private flow: HTMLElement;

  constructor(repo: string, flow: HTMLElement) { this.repo = repo; this.flow = flow; }

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
    this.fileLoads.set(path, lazy(section, async () => {
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
      requestAnimationFrame(fit);
      let saved = c.text;
      let timer = 0;
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
