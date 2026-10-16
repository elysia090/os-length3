import {h} from '../dom.ts';
import * as todo from '../todo.ts';

// The TODO box on Home. Each item is written like a short note: the first
// line names it the way issues are named here ("Fix：再起動すると保存内容が消える"),
// Enter breaks to the detail lines, and Enter on an empty detail line starts
// the next item. Typing "Kind：" at the start of the first line turns it into
// the item's kind. A done item's first line is struck through and faded;
// its detail stays readable. The box keeps its own DOM, so typing never
// re-renders the page.

const KEY = 'length3.os.todo';
const KIND_AT_START = /^\s*([A-Za-z][A-Za-z0-9-]{0,15})\s*[：:]\s*/;

function load(): todo.Todo[] {
  try { return todo.parse(localStorage.getItem(KEY)); } catch { return []; }
}

const date = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

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

export function todoBox(): HTMLElement {
  let items = load();
  const status = h('p', {class: 'error', role: 'alert'});
  const remaining = h('small', {});
  const list = h('div', {class: 'todo-items', role: 'list'});
  const rows = new Map<string, Row>();

  const save = () => {
    const kept = todo.persisted(items);
    try { localStorage.setItem(KEY, JSON.stringify(kept)); status.textContent = ''; }
    catch { status.textContent = 'この端末に保存できませんでした'; }
    const open = kept.filter((t) => !t.done).length;
    remaining.textContent = kept.length ? `残り ${open} / ${kept.length}` : '';
  };

  const caret = (field: HTMLInputElement | HTMLTextAreaElement, at: 'start' | 'end') => {
    field.focus();
    const p = at === 'start' ? 0 : field.value.length;
    field.setSelectionRange(p, p);
  };
  const neighbour = (id: string, step: number) => items[items.findIndex((t) => t.id === id) + step]?.id;
  const showDetail = (r: Row, show: boolean) => { r.detail.hidden = !show; if (show) fit(r.detail); };

  const paint = (t: todo.Todo) => {
    const r = rows.get(t.id)!;
    // Shown as it is written, "Fix：", so the format reads off the screen.
    r.kind.textContent = t.kind ? `${t.kind}：` : '';
    r.kind.hidden = !t.kind;
    r.item.classList.toggle('done', t.done);
    r.button.replaceChildren(mark(t.done));
    r.button.setAttribute('aria-pressed', String(t.done));
    r.button.setAttribute('aria-label', t.done ? '未完了に戻す' : '完了にする');
    r.meta.textContent = todo.filled(t) ? date(t.created) : '';
  };

  /** Start a new item after `id` and put the caret on its first line. */
  const next = (id: string) => {
    const r = todo.insertAfter(items, id);
    items = r.list;
    render();
    caret(rows.get(r.id)!.title, 'end');
  };

  const build = (t: todo.Todo): HTMLElement => {
    const button = h('button', {class: 'todo-mark', type: 'button'}) as HTMLButtonElement;
    const kind = h('span', {class: 'todo-kind'});
    const title = h('input', {class: 'todo-title', maxlength: String(todo.TEXT_LIMIT), 'aria-label': 'やること',
      autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const detail = h('textarea', {class: 'todo-detail', rows: '1', maxlength: String(todo.DETAIL_LIMIT), 'aria-label': '詳細',
      spellcheck: 'false'}) as HTMLTextAreaElement;
    const meta = h('span', {class: 'todo-meta'});
    title.value = t.title;
    detail.value = t.detail;
    const head = h('div', {class: 'todo-head'}, button, kind, title, meta);
    const item = h('div', {class: 'todo-item', role: 'listitem'}, head, detail);
    const row: Row = {item, title, detail, kind, button, meta};
    rows.set(t.id, row);

    const current = () => items.find((x) => x.id === t.id)!;
    const set = (change: {kind?: string | null; title?: string; detail?: string}) => {
      items = todo.edit(items, t.id, change);
      save();
      paint(current());
      ensureBlankEnd();
    };
    // A kind is taken only when the colon is typed, so text given back from
    // the chip ("Fix：…") stays text.
    let previous = title.value;

    button.addEventListener('click', () => { items = todo.toggle(items, t.id); save(); paint(current()); });

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
          const before = neighbour(t.id, -1);
          const after = neighbour(t.id, 1);
          items = todo.remove(items, t.id);
          save();
          render();
          const r = rows.get(before ?? after ?? '');
          if (r) caret(r.detail.hidden ? r.title : r.detail, 'end');
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!detail.hidden) caret(detail, 'start');
        else { const n = rows.get(neighbour(t.id, 1) ?? ''); if (n) caret(n.title, 'end'); }
      } else if (e.key === 'ArrowUp') {
        const p = rows.get(neighbour(t.id, -1) ?? '');
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
        next(t.id);
      } else if (e.key === 'Backspace' && detail.selectionStart === 0 && detail.selectionEnd === 0 && !detail.value) {
        e.preventDefault();
        showDetail(row, false);
        caret(title, 'end');
      } else if (e.key === 'ArrowUp' && detail.selectionStart === 0) {
        e.preventDefault();
        caret(title, 'end');
      } else if (e.key === 'ArrowDown' && atEnd) {
        const n = rows.get(neighbour(t.id, 1) ?? '');
        if (n) { e.preventDefault(); caret(n.title, 'end'); }
      }
    });
    detail.addEventListener('blur', () => showDetail(row, detail.value !== ''));

    showDetail(row, t.detail !== '');
    paint(t);
    return item;
  };

  /** There is always one empty item at the end to write into. */
  const ensureBlankEnd = () => {
    const last = items.at(-1);
    if (last && !todo.filled(last)) return;
    items = todo.insertAfter(items, null).list;
    list.append(build(items.at(-1)!));
    placeholder();
  };

  const placeholder = () => {
    for (const r of rows.values()) r.title.placeholder = '';
    const last = items.at(-1);
    if (last) rows.get(last.id)!.title.placeholder = items.length === 1 ? 'Fix：保存内容が消える' : '次のTODO';
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
  save();
  const hint = h('p', {class: 'todo-hint'},
    h('span', {}, '1行目に 種別：件名'), h('span', {}, 'Enter で詳細'), h('span', {}, '空の行で Enter すると次のTODO'),
    h('span', {}, '○ か Ctrl+Enter で完了'));
  return h('section', {class: 'section', 'aria-labelledby': 'todo-title'},
    h('h2', {id: 'todo-title'}, 'TODO', remaining),
    h('div', {class: 'todo-box'}, list, hint), status);
}
