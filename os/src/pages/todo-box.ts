import {h, shortDay} from '../dom.ts';
import {t} from '../i18n.ts';
import {getState, setState} from '../state.ts';
import * as todo from '../todo.ts';

// The TODO box, Home's and each server board's: the same list, kept in
// different places (Home's state; the Remote, for a board's people). Each
// item is written like a short note: the first line names it the way issues
// are named here ("Fix：再起動すると保存内容が消える"), Enter breaks to the
// detail lines, and Enter on an empty detail line starts the next item.
// Typing "Kind：" at the start of the first line turns it into the item's
// kind. A done item's first line is struck through and faded; its detail
// stays readable. The box keeps its own DOM, so typing never re-renders the
// page.

const KIND_AT_START = /^\s*([A-Za-z][A-Za-z0-9-]{0,15})\s*[：:]\s*/;

function load(): todo.Todo[] {
  try { return todo.parse(getState('todo')); } catch { return []; }
}

const date = shortDay;

const CIRCLE = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z';
const CHECK = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM8 12.2l2.7 2.7L16.2 9.3';

function mark(done: boolean): SVGSVGElement {
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
}

/** A TODO list on screen: its box, and taking in the list as it now is elsewhere. */
export interface TodoList {
  element: HTMLElement;
  /** Take in `list` as kept elsewhere: at once, or as soon as nothing in the box is being written. */
  update(list: todo.Todo[]): void;
}

export interface TodoOptions {
  /** Shown, not written: no field takes text, no mark is pressed. */
  readOnly?: boolean;
  /** What is left, in words ('2 of 3 left'), each time it changes. */
  counted?: (text: string) => void;
  /** Why it could not be kept, or '' once it is. */
  failed?: (why: string) => void;
  /** The first item's placeholder, while the list is empty. */
  first?: string;
}

/** A TODO list kept by `keep` (given what is worth keeping, each time it changes). */
export function todoList(start: todo.Todo[], keep: (kept: todo.Todo[]) => Promise<void>, o: TodoOptions = {}): TodoList {
  let items = [...start];
  const list = h('div', {class: 'todo-items', role: 'list'});
  const rows = new Map<string, Row>();

  const save = () => {
    const kept = todo.persisted(items);
    keep(kept).then(() => o.failed?.(''),
      (e: unknown) => o.failed?.(t('Could not save: {message}', {message: e instanceof Error ? e.message : String(e)})));
    count(kept);
  };
  const count = (kept: readonly todo.Todo[]) => {
    const open = kept.filter((td) => !td.done).length;
    o.counted?.(kept.length ? t('{open} of {all} left', {open, all: kept.length}) : '');
  };

  const caret = (field: HTMLInputElement | HTMLTextAreaElement, at: 'start' | 'end') => {
    field.focus();
    const p = at === 'start' ? 0 : field.value.length;
    field.setSelectionRange(p, p);
  };
  const neighbour = (id: string, step: number) => items[items.findIndex((td) => td.id === id) + step]?.id;
  const showDetail = (r: Row, show: boolean) => { r.detail.hidden = !show; if (show) fit(r.detail); };

  const paint = (td: todo.Todo) => {
    const r = rows.get(td.id)!;
    // Shown as it is written, "Fix：", so the format reads off the screen.
    r.kind.textContent = td.kind ? `${td.kind}：` : '';
    r.kind.hidden = !td.kind;
    r.item.classList.toggle('done', td.done);
    r.button.replaceChildren(mark(td.done));
    r.button.setAttribute('aria-pressed', String(td.done));
    r.button.setAttribute('aria-label', td.done ? t('Mark as not done') : t('Mark as done'));
    r.meta.textContent = todo.filled(td) ? date(td.created) : '';
  };

  /** Start a new item after `id` and put the caret on its first line. */
  const next = (id: string) => {
    const r = todo.insertAfter(items, id);
    items = r.list;
    render();
    caret(rows.get(r.id)!.title, 'end');
  };

  const build = (td: todo.Todo): HTMLElement => {
    if (o.readOnly) {
      // Read, not written: the same lines, as text.
      const kind = h('span', {class: 'todo-kind', ...(td.kind ? {} : {hidden: ''})}, td.kind ? `${td.kind}：` : '');
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
      spellcheck: 'false'}) as HTMLTextAreaElement;
    const meta = h('span', {class: 'todo-meta'});
    title.value = td.title;
    detail.value = td.detail;
    const head = h('div', {class: 'todo-head'}, button, kind, title, meta);
    const item = h('div', {class: 'todo-item', role: 'listitem'}, head, detail);
    const row: Row = {item, title, detail, kind, button, meta};
    rows.set(td.id, row);

    const current = () => items.find((x) => x.id === td.id)!;
    const set = (change: {kind?: string | null; title?: string; detail?: string}) => {
      items = todo.edit(items, td.id, change);
      save();
      paint(current());
      ensureBlankEnd();
    };
    // A kind is taken only when the colon is typed, so text given back from
    // the chip ("Fix：…") stays text.
    let previous = title.value;

    button.addEventListener('click', () => { items = todo.toggle(items, td.id); save(); paint(current()); });

    title.addEventListener('input', () => {
      const m = !current().kind && !KIND_AT_START.test(previous) && KIND_AT_START.exec(title.value);
      if (m) {
        title.value = title.value.slice(m[0].length);
        set({kind: m[1], title: title.value});
        title.setSelectionRange(0, 0);
      } else {
        set({title: title.value});
      }
      previous = title.value;
    });
    title.addEventListener('keydown', (e) => {
      const it = current();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); button.click(); return; }
      if (e.key === 'Enter') {
        // A line break after the first line is where the detail begins.
        e.preventDefault();
        if (!todo.filled(it)) return;
        showDetail(row, true);
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
          const before = neighbour(td.id, -1);
          const after = neighbour(td.id, 1);
          items = todo.remove(items, td.id);
          save();
          render();
          const r = rows.get(before ?? after ?? '');
          if (r) caret(r.detail.hidden ? r.title : r.detail, 'end');
        }
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
      const atEnd = detail.selectionStart === detail.value.length && detail.selectionEnd === detail.value.length;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); button.click(); return; }
      if (e.key === 'Enter' && atEnd && (detail.value === '' || detail.value.endsWith('\n'))) {
        // Enter on an empty last line ends this item and starts the next.
        e.preventDefault();
        detail.value = detail.value.replace(/\n+$/, '');
        set({detail: detail.value});
        showDetail(row, detail.value !== '');
        next(td.id);
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
  const ensureBlankEnd = () => {
    if (o.readOnly) return;
    const last = items.at(-1);
    if (last && !todo.filled(last)) return;
    items = todo.insertAfter(items, null).list;
    list.append(build(items.at(-1)!));
    placeholder();
  };

  const placeholder = () => {
    if (o.readOnly) return;
    for (const r of rows.values()) r.title.placeholder = '';
    const last = items.at(-1);
    if (last) rows.get(last.id)!.title.placeholder = items.length === 1 ? o.first ?? t('Fix: The title wraps on a phone') : t('Next TODO');
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
  const hint = o.readOnly ? null : h('p', {class: 'todo-hint'},
    h('span', {}, t('First line as Kind: title')), h('span', {}, t('Enter for the detail')), h('span', {}, t('Enter on an empty line for the next TODO')),
    h('span', {}, t('○ or Ctrl+Enter when done')));
  const element = h('div', {class: 'todo-box'}, list, hint);
  // What came from elsewhere waits while something here is being written.
  let waiting: todo.Todo[] | null = null;
  const writing = () => element.contains(document.activeElement);
  element.addEventListener('focusout', () => setTimeout(() => {
    if (waiting && !writing()) { items = waiting; waiting = null; render(); count(todo.persisted(items)); }
  }, 0));
  return {
    element,
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
    {counted: (text) => { remaining.textContent = text; }, failed: (why) => { status.textContent = why; }});
  return h('section', {class: 'section', 'aria-labelledby': 'todo-title'},
    h('h2', {id: 'todo-title'}, 'TODO', remaining), box.element, status);
}
