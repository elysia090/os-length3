import {h} from '../../ui/dom.ts';
import {nudge} from '../../ui/glide.ts';
import {errorText} from '../../host/errors.ts';
import {t} from '../../i18n/i18n.ts';
import {bytes} from '../../ui/dom.ts';
import {EDIT_LIMIT, onChange, store} from '../../repos/repos.ts';
import {shownPath} from '../../repos/issues.ts';
import {AGENT} from '../../repos/agent-hands.ts';
import {editorOn, holdBack, openingWith} from '../bench/play.ts';
import {Editor, fileState, lineHeight, lineStart, numbering} from './editor.ts';
import type {Laid} from './desk.ts';

// A file as it lies on the desk (desk.ts): its text in a box of its own, written in where it is, its line numbers
// beside it, saved as Forge's editor saves (editor.ts). Its name is said over the box, its folder quiet before it.
// What is written to it elsewhere (the shell, Git, another device) comes in as it does in any editor; what the Agent
// writes comes in as it is played (bench/play.ts).

export interface DeskFile extends Laid {
  /** The line `line` (1-based) chosen in it, the caret there (none: the caret at its top). */
  at(line: number): void;
  /** Its own top, measured from the box's: where `line` is. */
  lineTop(line: number): number;
  /** Stop following the repo. */
  drop(): void;
}

/** `path` of `repo` as a box on the desk; `grew` hears it change height (the desk lays its boxes again). */
export function deskFile(repo: string, path: string, grew: () => void, rename?: (name: HTMLElement) => void): DeskFile {
  const shown = shownPath(path);
  const cut = shown.lastIndexOf('/');
  const state = fileState();
  // Its place in "/", heard (its name is said over the box, seen), and what the file says of itself.
  const head = h('h2', {class: 'desk-file-head'}, h('span', {class: 'sr-only'}, `/root/${repo}/${shown}`), state.el);
  const gutter = h('pre', {class: 'gutter', 'aria-hidden': 'true'});
  const sheet = h('div', {class: 'sheet'}, gutter, h('pre', {class: 'code'}, '…'));
  const element = h('div', {class: 'desk-file', 'data-path': path}, head, sheet);
  const number = numbering(gutter);
  let editor: Editor | null = null;
  let wanted: number | null = null;
  /** The keyboard asked for before the text was read: given once it is. */
  let focusing = false;

  function at(line: number) {
    if (!editor) { wanted = line; return; }
    const {area} = editor;
    // No line asked for: the caret at its top.
    if (line < 1) { area.focus({preventScroll: true}); area.setSelectionRange(0, 0); return; }
    const from = lineStart(area.value.split('\n'), line - 1);
    const to = area.value.indexOf('\n', from);
    area.focus({preventScroll: true});
    area.setSelectionRange(from, to < 0 ? area.value.length : to);
  }

  const load = async () => {
    let c;
    try { c = await store.read(repo, path); } catch (e) { state.el.textContent = String(e); return; }
    if (c.text === null) { sheet.replaceChildren(h('p', {class: 'muted sheet-note'}, t('Binary · {size}', {size: bytes(c.size)}))); grew(); return; }
    number(c.text);
    if (c.truncated) {
      sheet.replaceChildren(gutter, h('pre', {class: 'code'}, c.text));
      state.el.textContent = t('First {part} only (total {size}) · Read-only', {part: bytes(new TextEncoder().encode(c.text).length), size: bytes(c.size)});
      grew();
      return;
    }
    const e = editor = new Editor(openingWith(repo, path, c.text), {repo, path, head, sheet, gutter, number, state, flow: element, seen: () => grew()});
    editorOn(repo, path, {take: (text) => e.take(text), area: e.area});
    new ResizeObserver(() => grew()).observe(e.area);
    if (wanted !== null) at(wanted);
    else if (focusing) e.area.focus({preventScroll: true});
    grew();
  };
  void load();

  const off = onChange((ch) => {
    if (ch.repo !== repo || !editor) return;
    // The repo changed as a whole (a shell on the root wrote it, a file put whole that is read only in part): the
    // file read again, taken in as written elsewhere, or read again in part to read only.
    if (ch.what === 'repo') {
      void store.read(repo, path).then((c) => {
        if (!editor) return;
        if (c.text !== null && !c.truncated) { editor.take(c.text); return; }
        editor = null;
        sheet.replaceChildren(gutter, h('pre', {class: 'code'}, '…'));
        void load();
      }, () => {});
      return;
    }
    if (ch.what !== 'file' || ch.path !== path) return;
    if (ch.by === AGENT && holdBack(repo, path, ch.text ?? '')) return;
    // Saved whole past what Forge edits (asked for in its box), or changed without its text handed on (only part of
    // it can be read): read again, in part to read only where it is so.
    if (ch.text === undefined || ((ch.text.length > EDIT_LIMIT / 4) && new TextEncoder().encode(ch.text).length > EDIT_LIMIT)) {
      editor = null;
      sheet.replaceChildren(gutter, h('pre', {class: 'code'}, '…'));
      void load();
      return;
    }
    editor.take(ch.text ?? '');
  });

  return {
    element,
    name: cut < 0 ? shown : shown.slice(cut + 1),
    dir: cut < 0 ? '' : `${shown.slice(0, cut)}/`,
    focus: () => { if (editor) editor.area.focus({preventScroll: true}); else focusing = true; },
    at,
    lineTop: (line) => (editor ? editor.area.offsetTop + (line - 1) * lineHeight(editor.area) : 0),
    drop: off,
    ...(rename ? {rename} : {}),
  };
}

/**
 * `name` (of the file at `path`) written over in its own place, the stem chosen and the ending kept: Enter or leaving it
 * gives what was written to `rename`; Escape, nothing written, or the same name put it back. A name it cannot be is
 * said beside it, the keyboard kept there (left for elsewhere, it is put back).
 */
export function renameIn(name: HTMLElement, path: string, rename: (path: string, written: string) => Promise<void>) {
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
