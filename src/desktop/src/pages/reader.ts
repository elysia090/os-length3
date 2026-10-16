import {bytes, h} from '../dom.ts';
import {t} from '../i18n.ts';
import {lineCount, readingOrder} from '../reading.ts';
import {store, type Change, type Entry} from '../repos.ts';

// The center of Forge: one repo read top to bottom as an endless page. Each
// file is a plain text editor in its own box, loaded as it comes near; in
// each directory README comes first, then the files, then the directories.
// Typing saves on its own, on leaving the file, or with Ctrl+S.

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
    if (!entries.length) { section.replaceChildren(path ? '' : h('div', {class: 'empty'}, t('No files yet'))); return; }
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
    if (entry.kind === 'link') { sheet.replaceWith(h('p', {class: 'muted sheet-note'}, t('Symbolic link'))); return section; }
    const number = (text: string) => {
      gutter.textContent = Array.from({length: Math.max(lineCount(text), 1)}, (_, i) => String(i + 1)).join('\n');
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
      const area = h('textarea', {class: 'code edit', rows: '1', wrap: 'off', spellcheck: 'false', autocapitalize: 'off',
        'aria-label': t('Edit {path}', {path})}) as HTMLTextAreaElement;
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
        if (area.value !== saved) { state.textContent = t('Changed elsewhere. Saving here will overwrite it'); return false; }
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
          state.textContent = area.value === saved ? '' : t('Unsaved');
        } catch (e) {
          state.textContent = t('Could not save: {message}', {message: e instanceof Error ? e.message : String(e)});
        }
      };
      area.addEventListener('input', () => {
        fit();
        number(area.value);
        state.textContent = t('Unsaved');
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
