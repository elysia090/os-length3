import {h, shortDay} from '../ui/dom.ts';
import {t} from '../i18n.ts';
import {getState, setState} from '../home/state.ts';
import * as todo from '../home/todo.ts';
import {errorText} from '../app/errors.ts';
import {arrive, closeUp, pop} from '../ui/glide.ts';
import {mark as glyph} from '../ui/icons.ts';
import {KIND_WORD, named} from '../repos/text.ts';
import {SETTLE} from './common.ts';

// The TODO box, Home's and each server board's: the same list, kept in
// different places (Home's state; the Remote, for a board's people). Each
// item is written like a short note: the first line names it the way issues
// are named here ("Fix：再起動すると保存内容が消える"), Enter breaks to the
// detail lines, and Enter on an empty detail line starts the next item.
// Typing "Kind：" at the start of the first line (a Latin word or a Japanese
// one, 買う：) turns it into the item's kind. A done item's first line is
// struck through and faded; its detail stays readable. An item goes by its ×
// (or Delete or Backspace on its empty line), the done ones together by Clear
// done. The box keeps its own DOM, so typing never re-renders the page.

const KIND_AT_START = new RegExp(`^\\s*(${KIND_WORD})\\s*[：:]\\s*`);

function load(): todo.Todo[] {
  try { return todo.parse(getState('todo')); } catch { return []; }
}

const date = shortDay;

const CIRCLE = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z';
const CHECK = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM8 12.2l2.7 2.7L16.2 9.3';

/** A TODO's mark: its circle, ticked once done. */
export function mark(done: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', done ? CHECK : CIRCLE);
  svg.append(path);
  return svg;
}

/** Grow a textarea to its content so the page, not the field, scrolls. */
function fit(area: HTMLTextAreaElement) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

interface Row {
  item: HTMLElement;
  title: HTMLInputElement;
  detail: HTMLTextAreaElement;
  kind: HTMLElement;
  button: HTMLButtonElement;
  meta: HTMLElement;
  strike: HTMLElement;
  /** Its ×, which takes it out of the list. */
  away: HTMLButtonElement;
}

/** A TODO list on screen: its box, and taking in the list as it now is elsewhere. */
/**
 * A kind's colon as it is written (the full-width "："), drawn as a colon is beside a Latin word, against it with a
 * space's room after (styles.css): the written one is kept in the text (copied, heard), the one seen is the face's own,
 * since where a full-width colon stands in its box is each font's (centred in one, at the left in another).
 */
export const kindColon = (): HTMLElement => h('span', {class: 'kind-colon'}, h('span', {class: 'kind-colon-said'}, '：'));
/**
 * A kind as it is written (Fix：), its colon tucked against a Latin word (kindColon); after a Japanese one (買う：) the
 * full-width colon is what Japanese sets there, and is shown as it is written.
 */
export const kindWords = (kind: string): Node[] =>
  /[A-Za-z0-9-]$/.test(kind) ? [document.createTextNode(kind), kindColon()] : [document.createTextNode(`${kind}：`)];
/**
 * A line of a file as written, whose first word is a Latin kind (an issue's Fix：…, its Closed：…): its colon tucked
 * as kindWords tucks it, in the code face as in any other; any other line, and any other full-width colon, as it is.
 */
export function kindLine(text: string): Node[] {
  const m = /^(\s*[A-Za-z][A-Za-z0-9-]{0,15})：/.exec(text);
  return m ? [document.createTextNode(m[1]), kindColon(), document.createTextNode(text.slice(m[0].length))] : [document.createTextNode(text)];
}

interface TodoList {
  element: HTMLElement;
  /** Clear done, for the box's head beside what is left: there while an item is done, and never when shown, not written. */
  clear: HTMLButtonElement;
  /** Take in `list` as kept elsewhere: at once, or as soon as nothing in the box is being written. */
  update(list: todo.Todo[]): void;
}

interface TodoOptions {
  /** Shown, not written: no field takes text, no mark is pressed. */
  readOnly?: boolean;
  /** How many are left of how many, each time it changes. */
  counted?: (open: number, all: number) => void;
  /** Why it could not be kept, or '' once it is. */
  failed?: (why: string) => void;
  /** The first item's placeholder, while the list is empty. */
  first?: string;
}

/** What is left said at the box's head ('2 of 3 left'): a change seen there gives a beat, as Git's count of issues does. */
function sayLeft(el: HTMLElement, open: number, all: number) {
  const text = all ? t('{open} of {all} left', {open, all}) : '';
  if (el.textContent === text) return;
  const seen = el.isConnected && el.textContent !== '';
  el.textContent = text;
  if (seen && text) pop(el, .12, 300);
}

/** A TODO list kept by `keep` (given what is worth keeping, each time it changes). */
export function todoList(start: todo.Todo[], keep: (kept: todo.Todo[]) => Promise<void>, o: TodoOptions = {}): TodoList {
  let items = [...start];
  const list = h('div', {class: 'todo-items', role: 'list'});
  const rows = new Map<string, Row>();

  const save = () => {
    const kept = todo.persisted(items);
    keep(kept).then(() => o.failed?.(''),
      (e: unknown) => o.failed?.(t('Could not save: {message}', {message: errorText(e)})));
    count(kept);
  };
  const clear = h('button', {class: 'todo-clear', type: 'button', hidden: ''}, t('Clear done')) as HTMLButtonElement;
  const count = (kept: readonly todo.Todo[]) => {
    const open = kept.filter((td) => !td.done).length;
    o.counted?.(open, kept.length);
    clear.hidden = !!o.readOnly || open === kept.length;
  };

  const caret = (field: HTMLInputElement | HTMLTextAreaElement, at: 'start' | 'end') => {
    field.focus();
    const p = at === 'start' ? 0 : field.value.length;
    field.setSelectionRange(p, p);
  };
  const neighbour = (id: string, step: number) => items[items.findIndex((td) => td.id === id) + step]?.id;
  /** Its detail shown or put away: the lines under it make room for it, or close up after it, rather than jump. */
  const showDetail = (r: Row, show: boolean) => {
    if (r.detail.hidden !== show) { if (show) fit(r.detail); return; }
    const below: Element[] = [];
    for (let e = r.item.nextElementSibling; e && r.item.isConnected; e = e.nextElementSibling) below.push(e);
    const was = below[0]?.getBoundingClientRect().top;
    r.detail.hidden = !show;
    if (show) fit(r.detail);
    if (was !== undefined) closeUp(below, was - below[0].getBoundingClientRect().top, 200);
  };
  /** The line through a done item's words (styles.css draws it across them as it is done): as long as they are, from
   * its kind's start. Measured once the row is in the page. */
  let pen: CanvasRenderingContext2D | null = null;
  const strike = (r: Row) => {
    if (!r.item.isConnected) { requestAnimationFrame(() => { if (r.item.isConnected) strike(r); }); return; }
    const cs = getComputedStyle(r.title);
    pen ??= document.createElement('canvas').getContext('2d');
    if (!pen) return;
    pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const words = Math.min(pen.measureText(r.title.value).width, r.title.clientWidth);
    const kind = r.kind.hidden ? 0 : r.title.getBoundingClientRect().left - r.kind.getBoundingClientRect().left;
    r.strike.style.width = `${Math.ceil(kind + words)}px`;
  };

  const paint = (td: todo.Todo) => {
    const r = rows.get(td.id)!;
    // Shown as it is written, "Fix：", so the format reads off the screen.
    // Its kind read off the line as it is typed ("Fix:"): the word takes its form with a pop, understood.
    const understood = !!td.kind && r.kind.hidden && r.item.isConnected;
    r.kind.replaceChildren(...(td.kind ? kindWords(td.kind) : []));
    r.kind.hidden = !td.kind;
    if (understood) pop(r.kind, .1, 300);
    // Done just now: its mark pops and settles, the reward for it, once. Taken back, it gives a smaller beat.
    const now = td.done && !r.item.classList.contains('done') && r.item.isConnected;
    const back = !td.done && r.item.classList.contains('done') && r.item.isConnected;
    if (td.done) strike(r);
    r.item.classList.toggle('done', td.done);
    r.button.replaceChildren(mark(td.done));
    if (now) pop(r.button);
    else if (back) pop(r.button, .06, 260);
    r.button.setAttribute('aria-pressed', String(td.done));
    r.button.setAttribute('aria-label', td.done ? t('Mark as not done') : t('Mark as done'));
    // A line with nothing in it yet is room for an item, not one: its mark is dashed, neither pressed nor stopped at
    // on the way along, and there is nothing to take out. Written in, it is an item, its mark whole and its × there.
    r.button.disabled = !todo.filled(td);
    r.away.hidden = !todo.filled(td);
    r.away.setAttribute('aria-label', t('Remove {item}', {item: named(td.kind, td.title) || t('this item')}));
    // Its day comes in at the line's end as the line becomes an item (filled), stamped there, not simply there.
    const day = todo.filled(td) ? date(td.created) : '';
    const dated = !r.meta.textContent && !!day && r.item.isConnected;
    r.meta.textContent = day;
    if (dated) arrive(r.meta, 1, 'x', 6, 260);
  };

  /** Where each line stands now, to have it go from there to where it stands once drawn again (the lines under a
   * line made making way for it, never there at once). */
  const standing = () => {
    const was = new Map([...rows].map(([id, r]) => [id, r.item.getBoundingClientRect().top]));
    return () => {
      for (const [id, top] of was) {
        const el = rows.get(id)?.item;
        const by = el?.isConnected ? top - el.getBoundingClientRect().top : 0;
        if (el && Math.abs(by) > .5) closeUp([el], by, 220);
      }
    };
  };

  /** Start a new item after `id` and put the caret on its first line. `stood`: where the lines stood before. */
  const next = (id: string, stood = standing()) => {
    const r = todo.insertAfter(items, id);
    items = r.list;
    render();
    caret(rows.get(r.id)!.title, 'end');
    // It unfolds from the line it was started from; those under it make way.
    arrive(rows.get(r.id)!.item, -1, 'y', 10, 220);
    stood();
  };

  /** When an item last went by its ×: the next one's × closes up under the pointer, and a double press takes one. */
  let dropped = -Infinity;
  /** `id` taken out of the list, the lines under it closing up over where it was; its neighbours, as drawn now. */
  const drop = (id: string): {before?: Row; after?: Row} => {
    const at = items.findIndex((x) => x.id === id);
    const before = items[at - 1]?.id ?? '', after = items[at + 1]?.id ?? '';
    const gap = rows.get(id)?.item.getBoundingClientRect().height ?? 0;
    const below = items.slice(at + 1).map((x) => x.id);
    items = todo.remove(items, id);
    save();
    render();
    // The lines under it close up over where it was, rather than being there at once.
    closeUp(below.map((x) => rows.get(x)?.item).filter((el): el is HTMLElement => !!el), gap);
    return {before: rows.get(before), after: rows.get(after)};
  };

  const build = (td: todo.Todo): HTMLElement => {
    if (o.readOnly) {
      // Read, not written: the same lines, as text.
      const kind = h('span', {class: 'todo-kind', ...(td.kind ? {} : {hidden: ''})}, ...(td.kind ? kindWords(td.kind) : []));
      return h('div', {class: `todo-item${td.done ? ' done' : ''}`, role: 'listitem'},
        h('div', {class: 'todo-head'}, h('span', {class: 'todo-mark', 'aria-label': td.done ? t('Done') : t('Not done')}, mark(td.done)), kind,
          h('span', {class: 'todo-title'}, td.title), h('span', {class: 'todo-meta'}, date(td.created))),
        td.detail ? h('div', {class: 'todo-detail todo-read'}, td.detail) : null);
    }
    const button = h('button', {class: 'todo-mark', type: 'button'}) as HTMLButtonElement;
    const kind = h('span', {class: 'todo-kind'});
    const title = h('input', {class: 'todo-title', maxlength: String(todo.TEXT_LIMIT), 'aria-label': t('What to do'),
      autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const detail = h('textarea', {class: 'todo-detail', rows: '1', maxlength: String(todo.DETAIL_LIMIT), 'aria-label': t('Detail'),
      placeholder: t('Detail'), spellcheck: 'false'}) as HTMLTextAreaElement;
    const meta = h('span', {class: 'todo-meta'});
    const strikeEl = h('span', {class: 'todo-strike', 'aria-hidden': 'true'});
    const away = h('button', {class: 'todo-away', type: 'button'}, glyph('close')) as HTMLButtonElement;
    title.value = td.title;
    detail.value = td.detail;
    const head = h('div', {class: 'todo-head'}, button, kind, title, meta, away, strikeEl);
    const item = h('div', {class: 'todo-item', role: 'listitem'}, head, detail);
    const row: Row = {item, title, detail, kind, button, meta, strike: strikeEl, away};
    rows.set(td.id, row);
    // Pressed on its line beside the words (or on the dashed mark of a line not yet an item), the caret goes to it.
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target !== head) return;
      e.preventDefault();
      caret(title, 'end');
    });
    // Its × takes it out; the keyboard goes on to what came up into its place (its ×, or the line to write in).
    away.addEventListener('click', () => {
      if (performance.now() - dropped < SETTLE) return;
      dropped = performance.now();
      const {before, after} = drop(td.id);
      const r = after ?? before;
      if (r) (r.away.hidden ? r.title : r.away).focus({preventScroll: true});
    });

    const current = () => items.find((x) => x.id === td.id)!;
    const set = (change: {kind?: string | null; title?: string; detail?: string}) => {
      items = todo.edit(items, td.id, change);
      save();
      paint(current());
      ensureBlankEnd(true);
    };
    // A kind is taken only when the colon is typed, so text given back from
    // the chip ("Fix：…") stays text.
    let previous = title.value;

    button.addEventListener('click', () => { items = todo.toggle(items, td.id); save(); paint(current()); });

    const typed = () => {
      const m = !current().kind && !KIND_AT_START.test(previous) && KIND_AT_START.exec(title.value);
      if (m) {
        title.value = title.value.slice(m[0].length);
        set({kind: m[1], title: title.value});
        title.setSelectionRange(0, 0);
      } else {
        // The space after the colon goes with the colon: the title starts at its first word.
        const lead = current().kind ? title.value.length - title.value.trimStart().length : 0;
        if (lead) {
          const at = Math.max(0, (title.selectionStart ?? 0) - lead);
          title.value = title.value.slice(lead);
          title.setSelectionRange(at, at);
        }
        set({title: title.value});
      }
      previous = title.value;
    };
    // A word being made in an input method is the method's until it is taken (買う：, then its Enter): the line is read
    // then, never written over under it.
    title.addEventListener('input', (e) => { if (!(e as InputEvent).isComposing) typed(); });
    title.addEventListener('compositionend', typed);
    title.addEventListener('keydown', (e) => {
      // A word being made in an input method (Japanese) is the method's: its Enter takes the word, nothing here.
      if (e.isComposing || e.keyCode === 229) return;
      const it = current();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); button.click(); return; }
      if (e.key === 'Enter') {
        // A line break after the first line is where the detail begins.
        e.preventDefault();
        if (!todo.filled(it)) return;
        // Its detail line unfolds from the first line, as the next item does.
        const opening = detail.hidden;
        showDetail(row, true);
        if (opening) arrive(detail, -1, 'y', 6, 200);
        caret(detail, 'start');
      } else if (e.key === 'Backspace' && title.selectionStart === 0 && title.selectionEnd === 0) {
        if (it.kind) {
          e.preventDefault();
          title.value = `${it.kind}：${title.value}`;
          previous = title.value;
          set({kind: null, title: title.value});
          title.setSelectionRange(it.kind.length + 1, it.kind.length + 1);
        } else if (!title.value && !it.detail && items.length > 1) {
          e.preventDefault();
          const {before, after} = drop(td.id);
          const r = before ?? after;
          if (r) caret(r.detail.hidden ? r.title : r.detail, 'end');
        }
      } else if (e.key === 'Delete' && !title.value && !it.detail && items.length > 1) {
        // Delete on its empty line takes it out too (a kind with it), the caret going on to the line come up in its place.
        e.preventDefault();
        const {before, after} = drop(td.id);
        if (after) caret(after.title, 'start'); else if (before) caret(before.detail.hidden ? before.title : before.detail, 'end');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!detail.hidden) caret(detail, 'start');
        else { const n = rows.get(neighbour(td.id, 1) ?? ''); if (n) caret(n.title, 'end'); }
      } else if (e.key === 'ArrowUp') {
        const p = rows.get(neighbour(td.id, -1) ?? '');
        if (p) { e.preventDefault(); caret(p.detail.hidden ? p.title : p.detail, 'end'); }
      }
    });

    detail.addEventListener('input', () => { fit(detail); set({detail: detail.value}); });
    detail.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const atEnd = detail.selectionStart === detail.value.length && detail.selectionEnd === detail.value.length;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); button.click(); return; }
      if (e.key === 'Enter' && atEnd && (detail.value === '' || detail.value.endsWith('\n'))) {
        // Enter on an empty last line ends this item and starts the next.
        e.preventDefault();
        const stood = standing();
        detail.value = detail.value.replace(/\n+$/, '');
        set({detail: detail.value});
        showDetail(row, detail.value !== '');
        next(td.id, stood);
      } else if (e.key === 'Backspace' && detail.selectionStart === 0 && detail.selectionEnd === 0 && !detail.value) {
        e.preventDefault();
        showDetail(row, false);
        caret(title, 'end');
      } else if (e.key === 'ArrowUp' && detail.selectionStart === 0) {
        e.preventDefault();
        caret(title, 'end');
      } else if (e.key === 'ArrowDown' && atEnd) {
        const n = rows.get(neighbour(td.id, 1) ?? '');
        if (n) { e.preventDefault(); caret(n.title, 'end'); }
      }
    });
    detail.addEventListener('blur', () => showDetail(row, detail.value !== ''));

    showDetail(row, td.detail !== '');
    paint(td);
    return item;
  };

  /** There is always one empty item at the end to write into. */
  /** There is always an empty line at the foot to write the next in; one made as the last is written unfolds there. */
  const ensureBlankEnd = (unfold = false) => {
    if (o.readOnly) return;
    const last = items.at(-1);
    if (last && !todo.filled(last)) return;
    items = todo.insertAfter(items, null).list;
    const el = build(items.at(-1)!);
    list.append(el);
    placeholder();
    if (unfold) arrive(el, -1, 'y', 10, 220);
  };

  const placeholder = () => {
    if (o.readOnly) return;
    for (const r of rows.values()) r.title.placeholder = '';
    const last = items.at(-1);
    // Short enough for a phone's line, and plainly a slot for words: the form (a kind, then what to do), not an item.
    if (last) rows.get(last.id)!.title.placeholder = items.length === 1 ? o.first ?? t('Fix: what to do') : t('Next TODO');
  };

  // Heights can only be measured once the fields are in the page.
  const fitAll = () => { for (const r of rows.values()) if (!r.detail.hidden) fit(r.detail); };
  new ResizeObserver(fitAll).observe(list);

  const render = () => {
    rows.clear();
    list.replaceChildren(...items.map(build));
    ensureBlankEnd();
    placeholder();
    fitAll();
  };

  render();
  // Drawn, not changed: nothing is kept until something is written (Home's TODO
  // was written back, and agreed with the Remote, each time Home was drawn).
  count(todo.persisted(items));
  // The keys, as keys, while the box is written in (and only then): a word beside each, not a sentence. The first
  // line's form (Kind: title) is the placeholder's to show.
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const keys = (caps: string[], word: string) => h('span', {class: 'key-hint'}, ...caps.map((c) => h('kbd', {}, c)), h('span', {}, word));
  const hint = o.readOnly ? null : h('p', {class: 'todo-hint', 'aria-hidden': 'true'},
    keys(['Enter'], t('detail')), keys(['Enter'], t('on an empty line, the next')), keys([mod, 'Enter'], t('done')));
  const element = h('div', {class: 'todo-box'}, list, hint);
  // Pressed on its paper below the items, the line at its foot takes the caret, as a page written on does: the
  // empty sheet is where the next is written, not a thing to aim at.
  if (!o.readOnly) element.addEventListener('pointerdown', (event) => {
    // (Its key hints' line, there unseen until the box is written in, is the sheet too.)
    if (event.button !== 0 || !(event.target === element || event.target === list || (hint && hint.contains(event.target as Node)))) return;
    const last = items.at(-1), row = last && rows.get(last.id);
    if (!row || event.clientY < row.title.getBoundingClientRect().top) return;
    event.preventDefault();
    row.title.focus();
    row.title.setSelectionRange(row.title.value.length, row.title.value.length);
  });
  // An item begun and left empty (Enter, then away) is not one: it goes as the keyboard leaves it, the lines under it
  // closing up, and only the empty line at the foot stays to write the next in.
  list.addEventListener('focusout', () => setTimeout(() => {
    const gone = items.find((x, i) => i < items.length - 1 && !todo.filled(x) && !rows.get(x.id)?.item.contains(document.activeElement));
    if (!gone || !rows.has(gone.id) || o.readOnly) return;
    drop(gone.id);
  }, 0));
  // Clear done: the done items go together, those under each closing up over where it was; the keyboard, which had
  // it, goes to the line at the foot, where the next is written.
  clear.addEventListener('click', () => {
    const was = new Map([...rows].map(([id, r]) => [id, r.item.getBoundingClientRect().top]));
    const had = document.activeElement === clear;
    items = items.filter((x) => !x.done);
    save();
    render();
    for (const [id, r] of rows) closeUp([r.item], (was.get(id) ?? 0) - r.item.getBoundingClientRect().top);
    const foot = rows.get(items.at(-1)?.id ?? '');
    if (had && foot) caret(foot.title, 'end');
  });

  // What came from elsewhere waits while something here is being written.
  let waiting: todo.Todo[] | null = null;
  const writing = () => element.contains(document.activeElement);
  element.addEventListener('focusout', () => setTimeout(() => {
    if (waiting && !writing()) { items = waiting; waiting = null; render(); count(todo.persisted(items)); }
  }, 0));
  return {
    element,
    clear,
    update(next) {
      if (writing()) { waiting = next; return; }
      items = [...next];
      render();
      count(todo.persisted(items));
    },
  };
}

/** Home's TODO: one list for the person, kept in Home's state (the same file l3 todo reads). */
export function todoBox(): HTMLElement {
  const status = h('p', {class: 'error', role: 'alert'});
  const remaining = h('small', {});
  const box = todoList(load(), (kept) => setState('todo', JSON.stringify(kept)),
    {counted: (open, all) => sayLeft(remaining, open, all), failed: (why) => { status.textContent = why; }});
  // Named TODO alone: what is left and Clear done stand on its line, at its right.
  return h('section', {class: 'section', 'aria-labelledby': 'todo-title'},
    h('h2', {}, h('span', {id: 'todo-title'}, 'TODO'), h('span', {class: 'todo-left'}, remaining, box.clear)), box.element, status);
}
