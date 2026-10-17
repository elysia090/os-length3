import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {icon} from '../icons.ts';
import {purpose, type PurposeId} from '../purposes.ts';

export function pageHead(id: PurposeId): HTMLElement {
  const p = purpose(id);
  return h('div', {class: 'page-head'}, icon(id), h('h1', {}, t(p.label)), h('p', {}, t(p.role)));
}

/** A page whose surface is not built yet: what it will hold, plainly. */
export function placeholder(id: PurposeId): Node[] {
  return [pageHead(id), h('div', {class: 'empty'}, t(purpose(id).detail))];
}

/**
 * A page in parts: the section headings are the switch, and only the part
 * chosen is shown, so a page never becomes one long scroll. The choice is
 * kept per page (a convenience: it may be forgotten). Arrow keys move along.
 */
export interface Parts<K extends string> {
  /** The headings, in a row. */
  switch: HTMLElement;
  panel(k: K): HTMLElement;
  show(k: K): void;
  current(): K;
  /** A bare number after the heading; '' or 0 shows none. */
  count(k: K, n: number | string): void;
  /** A part with nothing to offer here is not offered. */
  offer(k: K, on: boolean): void;
  /** Hear when the part shown changes. */
  onShow(f: (k: K) => void): void;
}

/**
 * Bring the element `id` to the top of the view, and keep it there while what
 * is above it fills in (a page draws at once and its numbers come later),
 * until the person scrolls themselves or the page has settled.
 */
export function reveal(id: string) {
  const at = document.getElementById(id);
  if (!at) return;
  const put = () => at.scrollIntoView({block: 'start'});
  const grown = new ResizeObserver(put);
  const stop = () => { grown.disconnect(); for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(e, stop, true); };
  for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(e, stop, true);
  for (const part of at.closest('main')?.children ?? []) grown.observe(part);
  put();
  setTimeout(stop, 2000);
}

/** Show `part` of `page` the next time that page is drawn (as if it had been chosen there last). */
export function choosePart(page: string, part: string) {
  try { localStorage.setItem(`length3.part.${page}`, part); } catch { /* convenience only */ }
}

export function parts<K extends string>(page: string, list: readonly {id: K; label: string}[]): Parts<K> {
  const key = `length3.part.${page}`;
  const tabs = new Map<K, {tab: HTMLButtonElement; small: HTMLElement; panel: HTMLElement}>();
  const heard: ((k: K) => void)[] = [];
  const bar = h('div', {class: 'parts', role: 'tablist', 'aria-label': page});
  for (const p of list) {
    const small = h('small', {});
    const tab = h('button', {type: 'button', class: 'part', role: 'tab', id: `part-${page}-${p.id}`, 'aria-controls': `panel-${page}-${p.id}`, 'aria-selected': 'false', tabindex: '-1'},
      p.label, small) as HTMLButtonElement;
    const panel = h('div', {class: 'part-panel', role: 'tabpanel', id: `panel-${page}-${p.id}`, 'aria-labelledby': tab.id, hidden: ''});
    tab.addEventListener('click', () => show(p.id));
    tab.addEventListener('keydown', (e) => {
      const offered = list.filter((x) => !tabs.get(x.id)!.tab.hidden);
      const at = offered.findIndex((x) => x.id === p.id);
      const to = e.key === 'ArrowRight' ? offered[(at + 1) % offered.length] : e.key === 'ArrowLeft' ? offered[(at - 1 + offered.length) % offered.length] : null;
      if (!to) return;
      e.preventDefault();
      show(to.id);
      tabs.get(to.id)!.tab.focus();
    });
    bar.append(tab);
    tabs.set(p.id, {tab, small, panel});
  }
  let now: K = list[0].id;
  const show = (k: K) => {
    now = k;
    for (const [id, x] of tabs) {
      const on = id === k;
      x.tab.setAttribute('aria-selected', String(on));
      x.tab.tabIndex = on ? 0 : -1;
      x.panel.hidden = !on;
    }
    try { localStorage.setItem(key, k); } catch { /* convenience only */ }
    for (const f of heard) f(k);
  };
  let kept: string | null = null;
  try { kept = localStorage.getItem(key); } catch { /* none */ }
  show(list.some((p) => p.id === kept) ? kept as K : list[0].id);
  return {
    switch: bar,
    panel: (k) => tabs.get(k)!.panel,
    show,
    current: () => now,
    count: (k, n) => { tabs.get(k)!.small.textContent = n ? `${n}` : ''; },
    offer: (k, on) => {
      tabs.get(k)!.tab.hidden = !on;
      if (!on && now === k) show(list.find((p) => !tabs.get(p.id)!.tab.hidden)?.id ?? list[0].id);
    },
    onShow: (f) => { heard.push(f); },
  };
}
