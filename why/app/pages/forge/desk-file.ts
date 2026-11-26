import {h} from '../../ui/dom.ts';
import {cut as motionless, nudge} from '../../ui/glide.ts';
import {workAt as tell} from '../../ui/camera.ts';
import {caretIn, fieldCarried} from '../../ui/caret.ts';
import {errorText} from '../../../api/errors.ts';
import {t} from '../../../text/i18n.ts';
import {bytes} from '../../../text/format.ts';
import {EDIT_LIMIT, onChange, onPathsChanging, store, type Change} from '../../../repo/repos.ts';
import {shownPath} from '../../../repo/issues.ts';
import {AGENT} from '../../../repo/agent-hands.ts';
import {editorOn, holdBack, openingWith} from '../bench/play.ts';
import {Editor, fileState, lineHeight, lineStart, numbering} from './editor.ts';
import type {Laid} from './desk.ts';
import {documentMenu, type BesideOption} from './document-menu.ts';
import {Draft} from './draft.ts';
import {openDrafts} from '../kit/open-drafts.ts';
import {SPRING} from '../../ui/law.ts';

// A file as it lies on the desk (desk.ts): its text in a box of its own, written in where it is, its line numbers
// beside it, saved as Forge's editor saves (editor.ts). Its name is said over the box, its folder quiet before it.
// What is written to it elsewhere (the shell, Git, another device) comes in as it does in any editor; what the Agent
// writes comes in as it is played (bench/play.ts).

export interface DeskFile extends Laid {
  /** The line `line` (1-based) chosen in it, the caret there (none: the caret at its top). */
  at(line: number): void;
  /** The keyboard in it, the caret at its end (a file just named goes on being written). */
  toEnd(): void;
  /** Its own top, measured from the box's: where `line` is. */
  lineTop(line: number): number;
  /** The draft must be acknowledged before a user closes its sheet. */
  flush(): Promise<boolean>;
  /** A second view of the current draft, not a second owner of the file. */
  beside(grew: () => void): DeskFile | null;
  /** The repo's name changed; this paper and its draft stay in place. */
  renameRepo(to: string): void;
  /** Stop following the repo. */
  drop(): void;
}

interface PaperActions {
  beside?(): BesideOption | null;
  readOnly?(): void;
  retry?(draft: Draft): void;
}

/** Where `a` and `b` first differ (the shorter's length where one begins the other). */
export function firstDiffering(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
/** The line (1-based) `at` (an offset into `text`) is on. */
export function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

let writerId = 0;

/** Preserve a draft without touching the original. The actual repo store refuses an occupied name. */
async function saveDraftCopy(repo: string, path: string, text: string): Promise<string> {
  const cut = path.lastIndexOf('/');
  let dir = cut < 0 ? '' : path.slice(0, cut);
  const name = Array.from(path.slice(cut + 1)).slice(0, 40).join('') + '.draft';
  let list = await store.tree(repo, dir).catch(() => null);
  if (list === null) { dir = ''; list = await store.tree(repo, dir); }
  const names = new Set(list.map((e) => e.name));
  let copy = name;
  for (let n = 2; names.has(copy); n++) copy = `${name}-${n}`;
  const destination = dir ? `${dir}/${copy}` : copy;
  const data = new TextEncoder().encode(text);
  if (data.length <= EDIT_LIMIT) await store.add(repo, dir, copy, text);
  // add is exclusive. Larger drafts get the same explicit full-file save as the editor, at the reserved copy path.
  else { await store.add(repo, dir, copy, ''); await store.put(repo, destination, data); }
  return destination;
}

/** `path` of `repo` as a box on the desk; `grew` hears it change height (the desk lays its boxes again). */
export function deskFile(repo: string, path: string, grew: () => void, rename?: (name: HTMLElement) => void,
  actions: PaperActions = {}, shared?: Draft): DeskFile {
  const shown = shownPath(path);
  const cut = shown.lastIndexOf('/');
  const state = fileState();
  // Its place in "/", heard (its name is said over the box, seen), and what the file says of itself.
  const address = h('span', {class: 'sr-only'}, `/root/${repo}/${shown}`);
  const head = h('h2', {class: 'desk-file-head'}, address, state.el);
  const gutter = h('pre', {class: 'gutter', 'aria-hidden': 'true'});
  const sheet = h('div', {class: 'sheet'}, gutter, h('pre', {class: 'code'}, '…'));
  const element = h('div', {class: 'desk-file', 'data-path': path, 'data-view': shared ? 'beside' : 'primary'}, head, sheet);
  const number = numbering(gutter);
  let editor: Editor | null = null;
  const dropMenu = documentMenu(element, () => editor?.area ?? null, actions.beside);
  let dropView: (() => void) | undefined;
  let renamedView: (() => void) | undefined;
  let revision = 0;
  let writer: string | null = null;
  let dropped = false;
  let wanted: number | null = null;
  let endWanted = false;
  /** The keyboard asked for before the text was read: given once it is. */
  let focusing = false;
  /**
   * Where the keyboard was when it was asked for before the text was read. Given late, it is taken only from there
   * (or from nowhere): put elsewhere meanwhile (the rail, a field), it is not snatched back as the text comes.
   */
  let askedFrom: Element | null = null;
  const later = () => { askedFrom = document.activeElement; };
  const stillAsked = () => { const a = document.activeElement; return !a || a === document.body || a === askedFrom || element.contains(a); };

  // The line chosen (from the search, a link) washed in the marker's soft yellow under its text, the eye led to it:
  // there at once, whole (never see-through: DESIGN §1), while the caret is on that line; it goes once the caret
  // leaves the line, or a line comes or goes above it. Where the line lies in the text is kept (its start and
  // end), so following the caret costs a comparison, not a count of the lines.
  let mark: {el: HTMLElement; from: number; to: number} | null = null;
  function unmark() {
    if (!mark) return;
    const {el} = mark;
    mark = null;
    el.remove();
  }
  function markLine(area: HTMLTextAreaElement, line: number, from: number, to: number) {
    unmark();
    const el = h('div', {class: 'desk-mark', 'aria-hidden': 'true'});
    const lh = lineHeight(area);
    el.style.top = `${area.offsetTop + (line - 1) * lh}px`;
    el.style.height = `${lh}px`;
    element.prepend(el);
    mark = {el, from, to};
  }
  // Where the Agent's eye is in it (bench/play.ts): a line lit across the sheet, going from line to line as it reads;
  // gone when the eye leaves.
  let eye: HTMLElement | null = null;
  function gaze(area: HTMLTextAreaElement, line: number | null) {
    if (line === null) {
      const el = eye;
      eye = null;
      if (el) el.animate([{opacity: 1}, {opacity: 0}], {duration: motionless() ? 0 : 260, easing: SPRING}).onfinish = () => el.remove();
      return;
    }
    const lh = lineHeight(area), top = `${area.offsetTop + (line - 1) * lh}px`;
    if (!eye) {
      eye = h('div', {class: 'desk-gaze', 'aria-hidden': 'true'});
      eye.style.top = top;
      eye.style.height = `${lh}px`;
      element.prepend(eye);
      eye.animate([{opacity: 0}, {opacity: 1}], {duration: motionless() ? 0 : 200, easing: SPRING});
      return;
    }
    eye.style.top = top;
  }
  // The Agent's hand in it as it writes (bench/play.ts): its caret where it types, a stroke of ink as the OS draws the
  // person's, solid while it writes and blinking once it rests; gone with the hand. The keyboard stays the person's: the
  // file is never focused for it. (Before: its letters went and came with nothing doing it.)
  let hand: HTMLElement | null = null, handRest = 0;
  function handAt(area: HTMLTextAreaElement, at: number | null) {
    clearTimeout(handRest);
    if (at === null) {
      const el = hand;
      hand = null;
      if (el) el.animate([{opacity: 1}, {opacity: 0}], {duration: motionless() ? 0 : 160, easing: SPRING}).onfinish = () => el.remove();
      return;
    }
    const p = caretIn(area, at);
    if (!hand) {
      hand = h('div', {class: 'desk-caret', 'aria-hidden': 'true'});
      element.append(hand);
    }
    hand.classList.remove('resting');
    hand.style.transform = `translate(${area.offsetLeft + p.x}px, ${area.offsetTop + p.y}px)`;
    hand.style.height = `${p.h}px`;
    handRest = window.setTimeout(() => hand?.classList.add('resting'), 500);
  }
  const caretLeft = () => {
    if (!mark || !editor || document.activeElement !== editor.area) return;
    const c = editor.area.selectionStart;
    if (c < mark.from || c > mark.to) unmark();
  };

  function at(line: number) {
    if (!editor) { wanted = line; later(); return; }
    const {area} = editor;
    // No line asked for: the caret at its top.
    if (line < 1) { area.focus({preventScroll: true}); area.setSelectionRange(0, 0); return; }
    const from = lineStart(area.value.split('\n'), line - 1);
    let to = area.value.indexOf('\n', from);
    if (to < 0) to = area.value.length;
    // The caret where the line's text begins (past its indent), nothing chosen: the line is shown by its wash.
    const text = from + (/^[ \t]*/.exec(area.value.slice(from, to))?.[0].length ?? 0);
    area.focus({preventScroll: true});
    area.setSelectionRange(text, text);
    lead(area);
    markLine(area, line, from, to);
  }

  function bind(draft: Draft) {
    number(draft.text);
    let forget = shared ? null : openDrafts.register(repo, path, draft);
    const e = editor = new Editor(draft, {path, companion: !!shared, head, sheet, gutter, number, state, flow: element,
      seen: () => grew(), recover: () => recover(draft), retry: () => retry(draft)});

    // Where the Agent is in it, told up to the desk (desk.ts WORK_AT), whose camera keeps that line in sight: its hand
    // as it writes (the first place what it put differs from what was there), its eye as it reads.
    const workAt = (line: number | null) => {
      const lh = lineHeight(e.area);
      tell(element, line === null ? null : {top: e.area.offsetTop + (line - 1) * lh, height: lh});
    };
    const editing = {
      take: (text: string) => {
        const was = draft.text, ok = draft.take(text);
        if (ok && text !== was) workAt(lineOf(text, firstDiffering(was, text)));
        return ok;
      },
      area: e.area,
      gaze: (line: number | null) => { gaze(e.area, line); workAt(line); },
      hand: (at: number | null) => handAt(e.area, at),
    };
    let unregister = shared ? null : editorOn(repo, path, editing);
    if (!shared) renamedView = () => {
      unregister?.();
      forget?.();
      forget = openDrafts.register(repo, path, draft);
      unregister = editorOn(repo, path, editing);
    };
    // Written in on the line washed: it stays while the writing is on that line, its end following; a line broken or
    // written above it, it goes.
    e.area.addEventListener('input', () => {
      if (!mark) return;
      const c = e.area.selectionStart, v = e.area.value;
      if (c < mark.from) { unmark(); return; }
      const end = v.indexOf('\n', mark.from);
      mark.to = end < 0 ? v.length : end;
      if (c > mark.to) unmark();
    });
    e.area.addEventListener('keyup', caretLeft);
    e.area.addEventListener('pointerup', caretLeft);
    // Written on, or gone through by the keys, the line in hand keeps the room ahead of it (lead()); a press puts the
    // caret under the hand and turns nothing.
    e.area.addEventListener('input', () => lead(e.area));
    e.area.addEventListener('keydown', (k) => { if (!k.isComposing) requestAnimationFrame(() => lead(e.area)); });
    const areaSize = new ResizeObserver(() => { stand(e.area); grew(); });
    const bodySize = new ResizeObserver(() => stand(e.area));
    areaSize.observe(e.area);
    bodySize.observe(element);
    dropView = () => {
      renamedView = undefined;
      unregister?.();
      forget?.();
      areaSize.disconnect(); bodySize.disconnect();
      clearTimeout(handRest);
      e.drop();
      if (!shared) draft.stop();
    };
    if (!stillAsked()) { wanted = null; endWanted = false; focusing = false; }
    if (wanted !== null) at(wanted);
    else if (endWanted) toEnd();
    else if (focusing) e.area.focus({preventScroll: true});
    grew();
  };

  type Read = 'initial' | 'external' | 'own' | 'copy';
  async function load(reason: Read = 'initial', reading = ++revision) {
    const draft = editor?.draft;
    const current = () => !dropped && reading === revision && draft === editor?.draft;
    if (draft) {
      // Block new writes in the notice's own turn. Only work already sent to the store is allowed to finish.
      if (reason === 'external' || reason === 'copy') draft.checkOutside();
      await draft.idle();
      if (!current() || (reason === 'own' && !draft.clean)) return;
    }
    let c;
    try { c = await store.read(repo, path); }
    catch (e) {
      if (current()) {
        if (draft && reason !== 'own') draft.blockUnread();
        else if (!draft) state.el.textContent = errorText(e);
      }
      return;
    }
    if (!current() || (draft && reason === 'own' && !draft.clean)) return;
    const full = c.text !== null && !c.truncated;
    const copied = reason === 'copy' && draft?.copy != null;
    if (draft) {
      if (full && !copied) { draft.take(c.text!); return; }
      if (draft.unsaved && !copied) { draft.blockUnread(); return; }
      actions.readOnly?.();
      dropView?.(); dropView = undefined;
      editor = null;
    }
    if (c.text === null) {
      state.el.textContent = '';
      sheet.replaceChildren(h('p', {class: 'muted sheet-note'}, t('Binary · {size}', {size: bytes(c.size)})));
      grew();
      return;
    }
    if (c.truncated) {
      number(c.text);
      sheet.replaceChildren(gutter, h('pre', {class: 'code'}, c.text));
      state.el.textContent = t('First {part} only (total {size}) · Read-only', {part: bytes(new TextEncoder().encode(c.text).length), size: bytes(c.size)});
      grew();
      return;
    }
    const opening = openingWith(repo, path, c.text);
    state.el.textContent = '';
    const author = writer = `forge-draft:${++writerId}`;
    bind(new Draft(opening, EDIT_LIMIT, async (text, whole) => {
      if (whole) await store.put(repo, path, new TextEncoder().encode(text), author);
      else await store.write(repo, path, text, author);
    }));
  }

  function retry(draft: Draft) {
    if (shared) actions.retry?.(draft);
    else if (editor?.draft === draft && !draft.locked) void load(draft.copy === null ? 'external' : 'copy');
  }

  async function recover(draft: Draft) {
    if (!draft.unread) return;
    const release = draft.lock();
    if (!release) return;
    try {
      const text = draft.text;
      draft.copied(await saveDraftCopy(repo, path, text), text);
    } finally { release(); }
  }

  function changed(ch: Change) {
    if (ch.repo !== repo) return;
    if (ch.what !== 'repo' && ch.path !== path) return;
    if (ch.what === 'dir') { void load('external'); return; }
    if (ch.what === 'removed') {
      if (ch.to === undefined && editor?.draft.checking) editor.draft.blockUnread();
      return;
    }
    // Full-file writes announce a truncated/unreadable preview before the write promise resolves.
    // It isn't an external replacement and must never wedge newer text typed while the write was in flight.
    if (writer !== null && ch.by === writer) {
      if (ch.what !== 'file' && !editor?.draft.checking && !editor?.draft.unread) void load('own', revision);
      return;
    }
    if (ch.what === 'file' && ch.by === AGENT && holdBack(repo, path, ch.text)) return;
    if (!editor || ch.what !== 'file' || (ch.text.length > EDIT_LIMIT / 4 && new TextEncoder().encode(ch.text).length > EDIT_LIMIT)) {
      void load('external');
      return;
    }
    ++revision;
    editor.draft.take(ch.text);
  }
  const off = shared ? null : onChange(changed);
  const offEarly = shared ? null : onPathsChanging((changedRepo, paths) => {
    if (changedRepo !== repo || !paths.includes(path)) return;
    ++revision;
    editor?.draft.checkOutside();
  });
  if (shared) bind(shared); else void load();

  /**
   * A file whose lines pass the world's lower third stands to the window's foot, with paper under its last line up to
   * that third: the room ahead of the line written last (DESIGN §2, look room). Shorter, it is as tall as its lines.
   */
  function stand(area: HTMLTextAreaElement) {
    const foot = parseFloat(getComputedStyle(element).getPropertyValue('--ahead'));
    element.classList.toggle('long', foot > 0 && area.offsetTop + area.offsetHeight > foot);
  }
  /** How wide a letter of the file is (it is set in the mono face): measured once. */
  let letter = 0;
  /**
   * The line in hand kept out of the third of the world it goes towards (DESIGN §2, look room): its foot no lower than
   * the lower third line as it is written on, its top no higher than the upper third line going back (while there is
   * more above), by turning the sheet a whole line at a time, at once, as a typewriter's platen turns a line under the
   * hand; and along a line that runs on past the sheet, its next fifteen letters in sight ahead of the caret (as many as
   * it has) and four behind (what is read at a glance is some four letters before the eye and fifteen after it).
   */
  function lead(area: HTMLTextAreaElement) {
    if (document.activeElement !== area) return;
    const cs = getComputedStyle(element), foot = parseFloat(cs.getPropertyValue('--ahead')), top = parseFloat(cs.getPropertyValue('--ahead-top'));
    if (!(foot > 0)) return;
    const lh = lineHeight(area), at = area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd;
    const v = area.value, start = v.lastIndexOf('\n', at - 1) + 1, line = lineOf(v, at) - 1;
    const y = area.offsetTop + line * lh - element.scrollTop;
    if (y + lh > foot) element.scrollTop = area.offsetTop + (line + 1) * lh - foot;
    else if (y < top && element.scrollTop > 0) element.scrollTop = Math.max(0, area.offsetTop + line * lh - top);
    if (area.scrollWidth > area.clientWidth + 1) {
      const before = v.slice(start, at);
      let x: number;
      // (A line of letters of one width counted; one with other writings in it laid out.)
      if (/^[\x20-\x7e\t]*$/.test(before)) {
        letter ||= (() => { const c = document.createElement('canvas').getContext('2d')!; c.font = getComputedStyle(area).font; return c.measureText('0').width; })();
        let col = 0;
        for (const ch of before) col = ch === '\t' ? (Math.floor(col / 4) + 1) * 4 : col + 1;
        x = col * letter;
      } else x = caretIn(area, at).x + area.scrollLeft;
      const l = letter || parseFloat(getComputedStyle(area).fontSize) * .602, room = area.clientWidth;
      if (x - area.scrollLeft > room - 15 * l) area.scrollLeft = x - (room - 15 * l);
      else if (x - area.scrollLeft < 4 * l && area.scrollLeft > 0) area.scrollLeft = Math.max(0, x - 4 * l);
    }
    fieldCarried();
  }

  function toEnd() {
    if (!editor) { endWanted = true; later(); return; }
    const {area} = editor, end = area.value.length;
    area.focus({preventScroll: true});
    area.setSelectionRange(end, end);
    lead(area);
  }

  return {
    element,
    toEnd,
    name: cut < 0 ? shown : shown.slice(cut + 1),
    dir: cut < 0 ? '' : `${shown.slice(0, cut)}/`,
    focus: () => { if (editor) editor.area.focus({preventScroll: true}); else { focusing = true; later(); } },
    at,
    lineTop: (line) => (editor ? editor.area.offsetTop + (line - 1) * lineHeight(editor.area) : 0),
    renameRepo(to) {
      if (to === repo) return;
      repo = to;
      ++revision; // A read begun under the old name can no longer replace this paper.
      address.textContent = `/root/${repo}/${shown}`;
      renamedView?.();
      if (!editor && !shared) void load();
    },
    flush: () => editor?.draft.closeable() ?? Promise.resolve(true),
    beside: (laid) => !shared && editor && !dropped ? deskFile(repo, path, laid, undefined, {retry}, editor.draft) : null,
    drop: () => { dropped = true; dropMenu(); off?.(); offEarly?.(); dropView?.(); },
    // Its name written over: the keyboard is the name's, not the text's when it is read.
    ...(rename ? {rename: (name: HTMLElement) => { focusing = false; wanted = null; endWanted = false; rename(name); }} : {}),
  };
}

/**
 * `name` (of the file at `path`) written over in its own place: the name itself written in (its folder quiet before
 * it, as ever), a line under it, its stem chosen and its ending kept. Enter, or leaving it, gives what was written (in
 * the file's folder: a name with a / in it moves it) to `rename`; Escape, nothing written, or the same name put it
 * back. Enter or Escape ends it with the keyboard going on (`onward`: into the file) when the name stays as it was;
 * renamed, `rename` says where the keyboard goes. A name it cannot be is said beside it, the keyboard kept there (left
 * for elsewhere, it is put back).
 */
export function renameIn(name: HTMLElement, path: string, rename: (path: string, written: string) => Promise<void>, onward?: () => void) {
  if (name.isContentEditable) return;
  const was = name.textContent ?? '';
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const error = h('span', {class: 'error small path-error', role: 'alert'});
  name.setAttribute('contenteditable', 'plaintext-only');
  name.setAttribute('role', 'textbox');
  name.setAttribute('aria-label', t('New name'));
  name.spellcheck = false;
  name.focus({preventScroll: true});
  const text = name.firstChild, dot = was.lastIndexOf('.');
  if (text) {
    const r = document.createRange();
    r.setStart(text, 0);
    r.setEnd(text, dot > 0 ? dot : was.length);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(r);
  }
  let over = false, going = false;
  const still = () => { for (const a of ['contenteditable', 'role', 'aria-label']) name.removeAttribute(a); };
  const back = () => {
    if (over) return;
    over = true;
    error.remove();
    name.textContent = was;
    still();
  };
  const go = async (leaving: boolean) => {
    if (over || going) return;
    const typed = (name.textContent ?? '').trim();
    if (!typed || typed === was) { back(); if (!leaving) onward?.(); return; }
    going = true;
    try {
      await rename(path, dir + typed);
      over = true;
      error.remove();
      still();
    } catch (err) {
      going = false;
      if (leaving) { back(); nudge(name); return; }
      error.textContent = errorText(err);
      if (!error.isConnected) name.after(error);
      name.focus();
      nudge(name);
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void go(false); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); back(); onward?.(); }
  };
  name.addEventListener('keydown', key);
  name.addEventListener('blur', () => void go(true), {once: true});
  name.addEventListener('blur', () => name.removeEventListener('keydown', key), {once: true});
}
