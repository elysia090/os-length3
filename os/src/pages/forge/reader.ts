import {bytes, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {readingOrder} from '../../repos/reading.ts';
import {store, type Change, type Entry} from '../../repos/repos.ts';
import {mark} from '../../ui/icons.ts';
import {nudge, still} from '../../ui/glide.ts';
import {errorText} from '../../app/errors.ts';
import {shownPath} from '../../repos/issues.ts';
import {Editor, fileState, lineHeight, lineStart, numbering, type FileState} from './editor.ts';

// The center of Forge: one repo read top to bottom as an endless page. Each
// file is a plain text editor in its own box (editor.ts), loaded as it comes near; in
// each directory README comes first, then the files, then the directories.

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

/** `target` lit for the landing (styles.css .revealed), and off once its light has gone. */
function light(target: HTMLElement) {
  target.classList.add('revealed');
  // Off once its light has gone (not at a guess of when, which can fall a frame before its end and cut it).
  const off = () => target.classList.remove('revealed');
  target.querySelector(':scope > .path')?.addEventListener('animationend', off, {once: true});
  setTimeout(off, 1600);
}

/**
 * Where the caret goes in a file opened to write in: its start (true), its end, back at `at` (an offset kept when it
 * was left), or not in it (false).
 */
export type Writing = boolean | 'end' | {at: number};

/** One repo read top to bottom: only files, directories are just where they come from. */
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

  /** Each file's name, pressed in its head, is written over there: what is written is the caller's to move it to. */
  private rename: ((path: string, written: string) => Promise<void>) | null;

  constructor(repo: string, flow: HTMLElement, opts: {beside?(path: string): void; rename?(path: string, written: string): Promise<void>} = {}) {
    this.repo = repo; this.flow = flow; this.beside = opts.beside ?? null; this.rename = opts.rename ?? null;
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

  /** The directories down to `path` read (each once), so that its section is in the page. */
  private async down(path: string) {
    const parts = path ? path.split('/') : [];
    for (let i = 0; i < parts.length; i++) await this.loads.get(parts.slice(0, i).join('/'))?.();
  }

  /**
   * Give `path`'s editor the keyboard again, its selection as it was, without moving the page: the page was
   * read again under the person's caret. Nothing is taken from what has the keyboard meanwhile.
   */
  async refocus(path: string, start: number, end: number) {
    await this.down(path);
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
    await this.down(path);
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
    light(target);
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
    const at = lineStart(lines, line - 1);
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
    const height = lineHeight(area);
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
    const third = this.flow.getBoundingClientRect().top + this.flow.clientHeight / 3;
    const lines = area.value.split('\n');
    const line = Math.min(lines.length - 1, Math.max(0, Math.floor((third - area.getBoundingClientRect().top) / lineHeight(area))));
    return lineStart(lines, line);
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
      section.replaceChildren(e ? this.file(path, e) : h('div', {class: 'empty'}, t('{path} no longer exists', {path})));
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
    const state = fileState();
    const head = this.head(path, state);
    const section = h('section', {class: this.elsewhere.has(path) ? 'file elsewhere' : 'file', 'data-path': path}, head);
    this.sections.set(path, section);
    const gutter = h('pre', {class: 'gutter', 'aria-hidden': 'true'});
    const sheet = h('div', {class: 'sheet'}, gutter, h('pre', {class: 'code'}, '…'));
    section.append(sheet);
    if (entry.kind === 'link') { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, t('Symbolic link'))); return section; }
    const number = numbering(gutter);
    this.fileLoads.set(path, lazy(section, this.flow, () => this.load(path, {head, sheet, gutter, number, state})));
    return section;
  }

  /**
   * A file's head: its place in "/", the repo part quiet, the rest plain (an issue's file is the issue, #3), and what
   * the file says of itself (`state`). Its name pressed is written over in place; its button, or Ctrl+click, opens it
   * beside.
   */
  private head(path: string, state: FileState): HTMLElement {
    const shown = shownPath(path);
    const name = h('span', {class: 'path-name'}, shown);
    const head = h('h2', {class: 'path'}, h('span', {}, h('span', {class: 'muted'}, `/root/${this.repo}/`), name), state.el);
    // Beside, in a box of its own: from its head's button, or Ctrl+click (⌘) on the head, as a link opens a tab.
    const beside = this.beside;
    if (beside && this.single === null) {
      const open = h('button', {type: 'button', class: 'file-beside', 'aria-label': t('Open {path} to the side', {path: shown}), title: t('Open to the side')}, mark('beside'));
      open.addEventListener('click', () => beside(path));
      head.append(open);
      head.addEventListener('click', (event) => { if ((event.ctrlKey || event.metaKey) && !(event.target as Element).closest('button')) beside(path); });
    }
    // Its name pressed (not to choose its words): written over where it stands. An issue's file is its number, no name.
    const rename = this.rename;
    if (rename && shown === path) {
      name.classList.add('renames');
      name.title = t('Rename');
      name.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || !getSelection()?.isCollapsed) return;
        renameIn(name, path, rename);
      });
    }
    return head;
  }

  /**
   * `path` read into its box as it comes near: a binary says so, a file read only in part is shown and never
   * written back, and any other text is an editor.
   */
  private async load(path: string, box: {head: HTMLElement; sheet: HTMLElement; gutter: HTMLElement; number(text: string): void; state: FileState}) {
    const {sheet, gutter, state} = box;
    let c;
    try { c = await store.read(this.repo, path); } catch (e) { state.el.textContent = String(e); return; }
    if (c.text === null) { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, t('Binary · {size}', {size: bytes(c.size)}))); return; }
    box.number(c.text);
    if (c.truncated) {
      // Only part of it was read, so it is never written back.
      sheet.replaceChildren(gutter, h('pre', {class: 'code'}, c.text));
      state.el.textContent = t('First {part} only (total {size}) · Read-only', {part: bytes(new TextEncoder().encode(c.text).length), size: bytes(c.size)});
      return;
    }
    const editor = new Editor(c.text, {...box, repo: this.repo, path, flow: this.flow,
      // Out of sight (folded, or its page hidden) it cannot be measured: it is fitted again when it shows.
      seen: (measured) => { if (measured) this.stale.delete(path); else this.stale.add(path); }});
    this.editors.set(path, editor.area);
    this.fitters.set(path, () => editor.fit());
    this.takers.set(path, (text) => editor.take(text));
  }
}

/**
 * `name` (of the file at `path`) written over in its own place, the stem chosen and the ending kept: Enter or leaving it
 * gives what was written to `rename`; Escape, nothing written, or the same name put it back. A name it cannot be is
 * said beside it, the keyboard kept there (left for elsewhere, it is put back).
 */
function renameIn(name: HTMLElement, path: string, rename: (path: string, written: string) => Promise<void>) {
  const input = h('input', {class: 'path-rename', 'aria-label': t('New name'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
  const error = h('span', {class: 'error small path-error', role: 'alert'});
  input.value = path;
  const fit = () => { input.size = Math.max(4, input.value.length + 1); };
  fit();
  input.addEventListener('input', fit);
  name.replaceWith(input, error);
  input.focus();
  const from = path.lastIndexOf('/') + 1, dot = path.lastIndexOf('.');
  input.setSelectionRange(from, dot > from ? dot : path.length);
  let over = false;
  const back = () => {
    if (over) return;
    over = true;
    error.remove();
    input.replaceWith(name);
  };
  const go = async (leaving: boolean) => {
    if (over || input.disabled) return;
    const written = input.value.trim();
    if (!written || written === path) { back(); return; }
    input.disabled = true;
    try {
      await rename(path, written);
      over = true;
    } catch (err) {
      input.disabled = false;
      if (leaving) { back(); nudge(name); return; }
      error.textContent = errorText(err);
      input.focus();
      nudge(input);
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); void go(false); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); }
  });
  input.addEventListener('blur', () => void go(true));
}
