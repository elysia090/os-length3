import {differs, Held} from '../conflict.ts';
import {bytes, h} from '../dom.ts';
import {t} from '../i18n.ts';
import {lineCount, readingOrder} from '../reading.ts';
import {store, type Change, type Entry} from '../repos.ts';
import {answers} from './common.ts';
import {diffFiles} from './diff-view.ts';

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
   * at the file's start (a file chosen to work on, from File).
   */
  async reveal(path: string, line = 0, write = false) {
    const parts = path ? path.split('/') : [];
    for (let i = 0; i < parts.length; i++) await this.loads.get(parts.slice(0, i).join('/'))?.();
    const target = path ? this.sections.get(path) : this.sections.get('');
    if (!target) return;
    target.scrollIntoView({block: 'start'});
    // What comes after it may not be read yet, so the page cannot scroll that far (a file just
    // made, before the folders below it): as it grows, it is put there again, until the person moves.
    const root = this.root;
    if (root && !line) {
      const grown = new ResizeObserver(() => target.scrollIntoView({block: 'start'}));
      const stop = () => { grown.disconnect(); for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(e, stop, true); };
      for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(e, stop, true);
      grown.observe(root);
      setTimeout(stop, 1500);
    }
    target.classList.add('revealed');
    setTimeout(() => target.classList.remove('revealed'), 1200);
    if (!line && !write) return;
    await this.fileLoads.get(path)?.();
    const area = this.editors.get(path);
    if (!area) return;
    if (!line) { area.focus({preventScroll: true}); area.setSelectionRange(0, 0); return; }
    const lines = area.value.split('\n');
    const at = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    area.focus({preventScroll: true});
    area.setSelectionRange(at, at + (lines[line - 1]?.length ?? 0));
    const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
    const top = area.getBoundingClientRect().top - this.flow.getBoundingClientRect().top + this.flow.scrollTop;
    this.flow.scrollTop = top + (line - 1) * height - this.flow.clientHeight / 3;
  }

  /**
   * The file being read: the one with the caret while it is in view (the
   * last file, chosen in File, cannot reach the top), else the first whose
   * box reaches below the top of the center.
   */
  reading(): string | null {
    const view = this.flow.getBoundingClientRect();
    const top = view.top + 8;
    const caret = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('section.file') : null;
    const page = this.root ?? this.flow;
    if (caret && page.contains(caret)) {
      const r = caret.getBoundingClientRect();
      if (r.bottom > top && r.top < view.bottom) return caret.dataset.path ?? null;
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
        'aria-label': t('Edit {path}', {path})}) as HTMLTextAreaElement;
      area.value = c.text;
      sheet.replaceChildren(gutter, area);
      this.editors.set(path, area);
      const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
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
      const settle = () => { ask.remove(); difference.hidden = true; see.setAttribute('aria-expanded', 'false'); };
      const asking = () => {
        clearTimeout(timer);
        state.textContent = t('Changed elsewhere');
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
          state.textContent = area.value === held.saved ? '' : t('Unsaved');
        } catch (e) {
          state.textContent = t('Could not save: {message}', {message: e instanceof Error ? e.message : String(e)});
        }
      };
      const save = async () => {
        clearTimeout(timer);
        if (!held.canSave) return;
        if (area.value === held.saved) { state.textContent = ''; return; }
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
        state.textContent = t('Unsaved');
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
