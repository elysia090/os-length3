import {differs, Held} from '../conflict.ts';
import {bytes, h} from '../dom.ts';
import {t} from '../i18n.ts';
import {lineCount, readingOrder} from '../reading.ts';
import {store, type Change, type Entry} from '../repos.ts';
import {answers} from './common.ts';
import {mark} from '../icons.ts';
import {keepOut, putAway, still} from '../glide.ts';
import {diffFiles} from './diff-view.ts';
import {shownPath} from '../issues.ts';

// The center of Forge: one repo read top to bottom as an endless page. Each
// file is a plain text editor in its own box, loaded as it comes near; in
// each directory README comes first, then the files, then the directories.
// Typing saves on its own, on leaving the file, or with Ctrl+S. A text saved
// elsewhere while this one has unsaved edits is asked in the file's box:
// take the other, or save yours over it, with what differs to be seen.

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

/** Where a text and its selection were, before and after the last indent in an editor. */
interface Spot { text: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' }
const indents = new WeakMap<HTMLTextAreaElement, {before: Spot; after: Spot}>();

/**
 * Write `text` over `from`…`to` as typing does, so Undo takes it back: the
 * browser's own command, or (where it has none) the range replaced by hand.
 */
function typeOver(area: HTMLTextAreaElement, from: number, to: number, text: string) {
  area.setSelectionRange(from, to);
  if (document.execCommand('insertText', false, text)) return;
  area.setRangeText(text, from, to, 'end');
  area.dispatchEvent(new Event('input'));
}

/**
 * Tab in a file. With nothing selected it types a tab. With a selection, each
 * line it touches is moved in by one tab (an empty line stays empty; a
 * selection ending at a line's start leaves that line), the same text stays
 * selected, and one Undo takes it all back, the selection too.
 */
export function indent(area: HTMLTextAreaElement) {
  const {value, selectionStart: a, selectionEnd: b} = area;
  const direction = area.selectionDirection;
  if (a === b) { typeOver(area, a, b, '\t'); return; }
  const from = value.lastIndexOf('\n', a - 1) + 1;
  const last = value[b - 1] === '\n' ? b - 1 : b;
  const end = value.indexOf('\n', last);
  const to = end < 0 ? value.length : end;
  const lines = value.slice(from, to).split('\n');
  if (lines.every((l) => !l)) return;
  // Where each tab goes, to move the selection with the text.
  const at: number[] = [];
  let k = from;
  for (const l of lines) { if (l) at.push(k); k += l.length + 1; }
  const start = a + at.filter((p) => p < a).length;
  const stop = b + at.filter((p) => p < b).length;
  const before = {text: value, start: a, end: b, direction};
  typeOver(area, from, to, lines.map((l) => (l ? `\t${l}` : l)).join('\n'));
  area.setSelectionRange(start, stop, direction);
  indents.set(area, {before, after: {text: area.value, start, end: stop, direction}});
}

/** One repo read top to bottom: only files, directories are just where they come from. */
/**
 * Where the caret goes in a file opened to write in: its start (true), its end, back at `at` (an offset kept when it
 * was left), or not in it (false).
 */
export type Writing = boolean | 'end' | {at: number};

export class Reader {
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
  /** The repo's own page in the flow (the flow holds every repo's, the others hidden). */
  private root: HTMLElement | null = null;
  /** The one file read, in a box beside the repo's page (only()); null for the whole page. */
  private single: string | null = null;
  /** Each file's head opens it beside, in a box of its own, when this is given. */
  private beside: ((path: string) => void) | null;
  /** The files open beside, each in a box of its own: in the page, only their heads. */
  private elsewhere = new Set<string>();
  /** Each editor's height fitted to its text again (after it was out of sight, when it could not be measured). */
  private fitters = new Map<string, () => void>();
  /** Editors whose text changed while they were out of sight, so not measured yet. */
  private stale = new Set<string>();

  /** Each file's head, pressed, shows it in File with what can be done to it (rename, move, delete). */
  private act: ((path: string) => void) | null;

  constructor(repo: string, flow: HTMLElement, opts: {beside?(path: string): void; act?(path: string): void} = {}) {
    this.repo = repo; this.flow = flow; this.beside = opts.beside ?? null; this.act = opts.act ?? null;
    // Pressed below the last file, on nothing: the caret to its end, as a page of text takes a press under its words.
    flow.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target !== flow) return;
      // The last file there with its words (a folder, a file beside, a binary has none to write in).
      const last = [...flow.querySelectorAll<HTMLElement>('section.file:not(.elsewhere)')].filter((el) => el.querySelector('textarea.code')).at(-1);
      const code = last?.querySelector<HTMLTextAreaElement>('textarea.code');
      if (!last || !code || event.clientY < last.getBoundingClientRect().bottom) return;
      event.preventDefault();
      code.focus({preventScroll: true});
      code.setSelectionRange(code.value.length, code.value.length);
      last.scrollIntoView({behavior: still() ? 'auto' : 'smooth', block: 'end'});
    });
  }

  /**
   * The files open beside (`paths`): in the page each is folded to its head, so the page reads on past it and the
   * same text never stands twice in the row; closed there, it unfolds.
   */
  fold(paths: string[]) {
    this.elsewhere = new Set(paths);
    for (const [path, section] of this.sections) {
      if (!section.classList.contains('file')) continue;
      section.classList.toggle('elsewhere', this.elsewhere.has(path));
    }
    this.refit();
  }

  /** Written on while out of sight (folded, its box hidden), an editor is fitted to its text once it shows. */
  refit() {
    for (const path of [...this.stale]) this.fitters.get(path)?.();
  }

  /**
   * A change made through the store: an open file takes the new text; true
   * when the page must be read again (a file or directory came or went).
   */
  take(c: Change): boolean {
    // One file alone is not read again for another's change.
    if (this.single !== null && c.what === 'file' && c.path !== this.single) return false;
    if (c.what !== 'file') return true;
    const taker = this.takers.get(c.path);
    if (taker) { taker(c.text ?? ''); return false; }
    // Not open yet: shown when it comes into view, if it is already listed.
    return !this.sections.has(c.path);
  }

  /**
   * Give `path`'s editor the keyboard again, its selection as it was, without moving the page: the page was
   * read again under the person's caret. Nothing is taken from what has the keyboard meanwhile.
   */
  async refocus(path: string, start: number, end: number) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) await this.loads.get(parts.slice(0, i).join('/'))?.();
    await this.fileLoads.get(path)?.();
    const area = this.editors.get(path);
    if (!area?.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
    area.focus({preventScroll: true});
    area.setSelectionRange(start, end);
  }

  /**
   * Load the directories down to `path` and scroll it into view; at `line`,
   * that line is selected with the caret in it; with `write`, the caret is put
   * at the file's start (a file chosen to work on, from File), with 'end' at its end (what was just written there,
   * as a repo's README once made, to go on writing), or back where it was left ({at}); a place in it other than its
   * start is put in view.
   */
  async reveal(path: string, line = 0, write: Writing = false) {
    const parts = path ? path.split('/') : [];
    for (let i = 0; i < parts.length; i++) await this.loads.get(parts.slice(0, i).join('/'))?.();
    const target = path ? this.sections.get(path) : this.sections.get('');
    if (!target) return;
    let put = () => target.scrollIntoView({block: 'start'});
    put();
    // What comes after it may not be read yet, so the page cannot scroll that far (a file just
    // made, before the folders below it): as it grows, it is put there again, until the person moves.
    const root = this.root;
    if (root && !line) {
      const grown = new ResizeObserver(() => put());
      const stop = () => { grown.disconnect(); for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(e, stop, true); };
      for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(e, stop, true);
      grown.observe(root);
      setTimeout(stop, 1500);
    }
    target.classList.add('revealed');
    // Off once its light has gone (not at a guess of when, which can fall a frame before its end and cut it).
    const off = () => target.classList.remove('revealed');
    target.querySelector(':scope > .path')?.addEventListener('animationend', off, {once: true});
    setTimeout(off, 1600);
    if (!line && !write) return;
    await this.fileLoads.get(path)?.();
    const area = this.editors.get(path);
    if (!area) return;
    if (!line) {
      const at = typeof write === 'object' ? Math.min(write.at, area.value.length) : write === 'end' ? area.value.length : 0;
      area.focus({preventScroll: true});
      area.setSelectionRange(at, at);
      if (at) { put = () => this.toLine(target, area, area.value.slice(0, at).split('\n').length); put(); }
      return;
    }
    const lines = area.value.split('\n');
    const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    area.focus({preventScroll: true});
    const end = at + (lines[line - 1]?.length ?? 0);
    area.setSelectionRange(at, end);
    // The line is lit for the landing (styles.css .revealed); after it, the caret waits at its start, so the next
    // key typed goes in beside it rather than over it. A selection the person has made since stays theirs.
    setTimeout(() => { if (area.selectionStart === at && area.selectionEnd === end) area.setSelectionRange(at, at); }, 1200);
    this.toLine(target, area, line);
  }

  /**
   * `line` of the file in `target` a third of the way down the center, or, near its file's top, the file's head at
   * the top: not the empty foot of the file before it over a line that would show anyway.
   */
  private toLine(target: HTMLElement, area: HTMLTextAreaElement, line: number) {
    const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
    const box = this.flow.getBoundingClientRect().top - this.flow.scrollTop;
    const top = area.getBoundingClientRect().top - box;
    // The head where it stops, inside the page's top padding (styles.css scroll-padding-top), not over its edge.
    const head = target.getBoundingClientRect().top - box - (parseFloat(getComputedStyle(this.flow).scrollPaddingTop) || 0);
    this.flow.scrollTop = Math.max(head, top + (line - 1) * height - this.flow.clientHeight / 3);
  }

  /**
   * Where `path` is read, as an offset in it to come back to: the caret's while the file has it, else the start of
   * the line a third of the way down the center (the line reveal() puts there).
   */
  place(path: string): number {
    const area = this.editors.get(path);
    if (!area) return 0;
    if (document.activeElement === area) return area.selectionStart;
    const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
    const third = this.flow.getBoundingClientRect().top + this.flow.clientHeight / 3;
    const lines = area.value.split('\n');
    const line = Math.min(lines.length - 1, Math.max(0, Math.floor((third - area.getBoundingClientRect().top) / height)));
    return lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  }

  /**
   * The file being read: the one with the caret while it is in view (the
   * last file, chosen in File, cannot reach the top), else `landed` (the one
   * last gone to, from File, the search or Git) while it is in view, else the
   * first whose box reaches below the top of the center. So the file gone to
   * stays the one read when the keyboard goes elsewhere (File pressed again).
   */
  reading(landed: string | null = null): string | null {
    const view = this.flow.getBoundingClientRect();
    const top = view.top + 8;
    const caret = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('section.file') : null;
    const page = this.root ?? this.flow;
    if (caret && page.contains(caret)) {
      const r = caret.getBoundingClientRect();
      if (r.bottom > top && r.top < view.bottom) return caret.dataset.path ?? null;
    }
    const went = landed ? [...page.querySelectorAll<HTMLElement>('section.file')].find((s) => s.dataset.path === landed) : undefined;
    if (went) {
      const r = went.getBoundingClientRect();
      if (r.bottom > top && r.top < view.bottom) return landed;
    }
    for (const section of page.querySelectorAll<HTMLElement>('section.file')) {
      if (section.getBoundingClientRect().bottom > top) return section.dataset.path ?? null;
    }
    return null;
  }

  directory(path: string): HTMLElement {
    const section = h('section', {class: 'dir', 'data-path': path || '/'}, path ? null : h('p', {class: 'muted'}, '…'));
    if (!path) this.root = section;
    this.sections.set(path, section);
    this.loads.set(path, lazy(section, this.flow, () => this.fill(path, section)));
    return section;
  }

  /** One file alone, for a box beside the repo's page: its box as the page draws it, or that it is gone. */
  only(path: string): HTMLElement {
    const section = h('section', {class: 'dir only', 'data-path': path}, h('p', {class: 'muted'}, '…'));
    this.root = section;
    this.single = path;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    void store.tree(this.repo, dir).then((entries) => {
      const e = entries.find((x) => x.kind !== 'dir' && join(dir, x.name) === path);
      section.replaceChildren(e ? this.file(path, e) : h('div', {class: 'empty'}, t('{path} is not there any more', {path})));
    }, (err: unknown) => section.replaceChildren(h('p', {class: 'muted'}, String(err))));
    return section;
  }

  private async fill(path: string, section: HTMLElement) {
    let entries: Entry[];
    try { entries = await store.tree(this.repo, path); } catch (e) { section.replaceChildren(h('p', {class: 'muted'}, String(e))); return; }
    // An empty directory shows nothing; only an empty repo says so.
    if (!entries.length) { section.replaceChildren(path ? '' : h('div', {class: 'empty'}, t('No files yet'))); return; }
    section.replaceChildren(...readingOrder(entries).map((e) =>
      e.kind === 'dir' ? this.directory(join(path, e.name)) : this.file(join(path, e.name), e)));
  }

  /** A file as a plain text editor: its place in "/", line numbers, the text to edit. */
  private file(path: string, entry: Entry): HTMLElement {
    // Says something only when the file is not simply saved.
    const state = h('span', {class: 'file-state', role: 'status'});
    /** Written and not saved yet: a quiet dot where the word would be (said, not shown); saved, it goes. */
    const unsaved = () => {
      const dot = state.querySelector<HTMLElement>('.unsaved-dot');
      // Written on again while it was going: it stays.
      if (dot) { keepOut(dot); return; }
      state.replaceChildren(h('span', {class: 'unsaved-dot', 'aria-hidden': 'true'}), h('span', {class: 'sr-only'}, t('Unsaved')));
    };
    /** Saved: the dot goes as it came, not at once. */
    const saved = () => {
      const dot = state.querySelector<HTMLElement>('.unsaved-dot');
      if (dot) putAway(dot, () => { if (dot.isConnected) state.textContent = ''; }); else state.textContent = '';
    };
    // The heading is the file's place in "/": the repo part quiet, the rest plain; an issue's file is the issue (#3).
    const shown = shownPath(path);
    const head = h('h2', {class: 'path'}, h('span', {}, h('span', {class: 'muted'}, `/root/${this.repo}/`), h('span', {class: 'path-name'}, shown)), state);
    // Beside, in a box of its own: from its head's button, or Ctrl+click (⌘) on the head, as a link opens a tab.
    const beside = this.beside;
    if (beside && this.single === null) {
      const open = h('button', {type: 'button', class: 'file-beside', 'aria-label': t('Open {path} beside', {path: shown}), title: t('Open beside')}, mark('beside'));
      open.addEventListener('click', () => beside(path));
      head.append(open);
      head.addEventListener('click', (event) => { if ((event.ctrlKey || event.metaKey) && !(event.target as Element).closest('button')) beside(path); });
    }
    // Pressed (not to choose its words, nor on its buttons), the head is the file's own place in File.
    const act = this.act;
    if (act) {
      head.classList.add('acts');
      head.title = t('{path} in File', {path: shown});
      head.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || (event.target as Element).closest('button') || !getSelection()?.isCollapsed) return;
        act(path);
      });
    }
    const section = h('section', {class: this.elsewhere.has(path) ? 'file elsewhere' : 'file', 'data-path': path}, head);
    this.sections.set(path, section);
    const gutter = h('pre', {class: 'gutter', 'aria-hidden': 'true'});
    const sheet = h('div', {class: 'sheet'}, gutter, h('pre', {class: 'code'}, '…'));
    section.append(sheet);
    if (entry.kind === 'link') { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, t('Symbolic link'))); return section; }
    // The numbers are written again only when the count of lines changed, not at every keystroke.
    let numbered = 0;
    const number = (text: string) => {
      const n = Math.max(lineCount(text), 1);
      if (n === numbered) return;
      numbered = n;
      gutter.textContent = Array.from({length: n}, (_, i) => String(i + 1)).join('\n');
    };
    this.fileLoads.set(path, lazy(section, this.flow, async () => {
      let c;
      try { c = await store.read(this.repo, path); } catch (e) { state.textContent = String(e); return; }
      if (c.text === null) { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, t('Binary · {size}', {size: bytes(c.size)}))); return; }
      number(c.text);
      if (c.truncated) {
        // Only part of it was read, so it is never written back.
        sheet.replaceChildren(gutter, h('pre', {class: 'code'}, c.text));
        state.textContent = t('Only the first {part} (of {size}) · read only', {part: bytes(new TextEncoder().encode(c.text).length), size: bytes(c.size)});
        return;
      }
      const area = h('textarea', {class: 'code code-edit', rows: '1', wrap: 'off', spellcheck: 'false', autocapitalize: 'off',
        'aria-label': t('Edit {path}', {path: shownPath(path)})}) as HTMLTextAreaElement;
      area.value = c.text;
      sheet.replaceChildren(gutter, area);
      this.editors.set(path, area);
      // Out of sight (folded, or its page hidden) it cannot be measured: it is fitted again when it shows.
      const fit = () => {
        if (!area.offsetParent) { this.stale.add(path); return; }
        this.stale.delete(path);
        area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`;
      };
      this.fitters.set(path, fit);
      // The whole box is the place to write. A press beside the text (its numbers, or the room around
      // them) is that line, selected as a line found is; a press below the text puts the caret at its end.
      sheet.addEventListener('pointerdown', (event) => {
        if (event.target === area) return;
        event.preventDefault();
        area.focus({preventScroll: true});
        const at = area.getBoundingClientRect();
        if (event.clientX < at.left && event.clientY < at.bottom) {
          const lines = area.value.split('\n');
          const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
          const n = Math.min(Math.max(Math.floor((event.clientY - at.top) / height), 0), lines.length - 1);
          const from = lines.slice(0, n).reduce((k, l) => k + l.length + 1, 0);
          area.setSelectionRange(from, from + lines[n].length);
          return;
        }
        area.setSelectionRange(area.value.length, area.value.length);
      });
      requestAnimationFrame(fit);
      const held = new Held(c.text);
      let timer = 0;
      const show = (text: string) => { area.value = text; fit(); number(text); };
      // Saved elsewhere while this one has unsaved edits: asked in the box, over the text, which
      // stays to be read and written on. Nothing is saved on its own until it is answered. What
      // differs opens under the answers, so nothing moves under the pointer that asked for it.
      const ask = h('div', {class: 'file-ask', role: 'group', 'aria-label': t('Changed elsewhere')});
      const see = h('button', {type: 'button', class: 'button small-button', 'aria-expanded': 'false'}, t('See what differs')) as HTMLButtonElement;
      const take = h('button', {type: 'button', class: 'button small-button'}, t('Use the other')) as HTMLButtonElement;
      const keep = h('button', {type: 'button', class: 'button small-button primary'}, t('Save yours over it')) as HTMLButtonElement;
      const difference = h('div', {class: 'file-ask-diff', hidden: ''});
      const paintDiff = () => {
        if (difference.hidden || held.theirs === null) return;
        const d = differs(held.theirs, area.value);
        difference.replaceChildren(...diffFiles([{path: t('Yours against the other'), status: 'modified', binary: false, lines: d.lines, more: d.more}]));
      };
      // Answered, the ask folds away over the text, not at once.
      const settle = () => { putAway(ask, () => ask.remove(), {fold: true}); difference.hidden = true; see.setAttribute('aria-expanded', 'false'); };
      const asking = () => {
        clearTimeout(timer);
        state.textContent = t('Changed elsewhere');
        keepOut(ask);
        if (!ask.isConnected) {
          ask.replaceChildren(
            h('p', {class: 'muted small'}, t('It was saved elsewhere while you wrote here.')),
            h('p', {class: 'muted small'}, t('Yours is kept here until you choose.')),
            answers(take, see, keep), difference);
          head.after(ask);
        }
        paintDiff();
      };
      see.addEventListener('click', () => {
        difference.hidden = !difference.hidden;
        see.setAttribute('aria-expanded', String(!difference.hidden));
        paintDiff();
      });
      take.addEventListener('click', () => {
        show(held.useTheirs());
        settle();
        state.textContent = '';
        area.focus();
      });
      keep.addEventListener('click', async () => {
        const text = held.keepMine(area.value);
        settle();
        await write(text);
        area.focus();
      });
      // A text saved elsewhere (another device, the shell, l3, Git) comes in unless this one has unsaved edits.
      this.takers.set(path, (text) => {
        const came = held.came(text, area.value);
        if (came === 'ask') { asking(); return false; }
        if (came === 'take') show(text);
        settle();
        if (came === 'same' || state.textContent === t('Changed elsewhere')) state.textContent = '';
        return true;
      });
      const write = async (text: string) => {
        try {
          await store.write(this.repo, path, text);
          held.wrote(text);
          if (area.value === held.saved) saved(); else unsaved();
        } catch (e) {
          state.textContent = t('Could not save: {message}', {message: e instanceof Error ? e.message : String(e)});
        }
      };
      const save = async () => {
        clearTimeout(timer);
        if (!held.canSave) return;
        if (area.value === held.saved) { saved(); return; }
        await write(area.value);
      };
      area.addEventListener('input', () => {
        fit();
        number(area.value);
        if (held.asking) {
          // Written on until it is theirs: nothing is left to ask.
          if (held.typed(area.value)) { settle(); state.textContent = ''; } else paintDiff();
          return;
        }
        unsaved();
        clearTimeout(timer);
        timer = window.setTimeout(() => void save(), 700);
      });
      area.addEventListener('blur', () => void save());
      // The tab closing (or put away) saves what is written, before the store keeps what it has (repos.ts).
      const leaving = () => { if (!area.isConnected) { removeEventListener('beforeunload', leaving); document.removeEventListener('visibilitychange', leaving); return; } if (area.value !== held.saved) void save(); };
      addEventListener('beforeunload', leaving);
      document.addEventListener('visibilitychange', leaving);
      area.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); return; }
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
          event.preventDefault();
          indent(area);
          return;
        }
        // Escape leaves the text, so the keyboard is never caught in it: it is on the page, and
        // Shift+Tab goes back up to the search from there.
        if (event.key === 'Escape') this.flow.focus({preventScroll: true});
      });
      // Undo and Redo of an indent take back the selection it had, not only the text.
      area.addEventListener('input', (event) => {
        const how = (event as InputEvent).inputType;
        const was = indents.get(area);
        if (!was || (how !== 'historyUndo' && how !== 'historyRedo')) return;
        const to = how === 'historyUndo' ? was.before : was.after;
        if (area.value === to.text) area.setSelectionRange(to.start, to.end, to.direction);
      });
    }));
    return section;
  }
}
