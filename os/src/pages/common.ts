import {h} from '../dom.ts';
import {errorText} from '../errors.ts';
import {t} from '../i18n.ts';
import {icon} from '../icons.ts';
import {pop} from '../glide.ts';
import {purpose, RAIL, type PurposeId} from '../purposes.ts';

export function pageHead(id: PurposeId): HTMLElement {
  const p = purpose(id);
  const mark = icon(id);
  inkAtEdge(mark);
  return h('div', {class: 'page-head'}, mark, h('h1', {}, t(p.label)), h('p', {}, t(p.role)));
}

/**
 * `svg` drawn a little left, by the room its drawing leaves inside its square at the left (each icon its own, two
 * to four pixels), so that its ink, not its square, stands at the edge the page's words and boxes start at under it.
 * What it moves it gives back on its right: the title stands where every page's does, not a pixel or two apart.
 */
function inkAtEdge(svg: SVGSVGElement) {
  requestAnimationFrame(() => {
    const vb = svg.viewBox.baseVal, w = svg.getBoundingClientRect().width;
    const shape = svg.querySelector<SVGGraphicsElement>('path, circle, rect, line, polyline');
    if (!svg.isConnected || !vb?.width || !w || !shape) return;
    const inset = (svg.getBBox().x - vb.x - (parseFloat(getComputedStyle(shape).strokeWidth) || 0) / 2) * (w / vb.width);
    if (inset > 0) svg.style.margin = `0 ${inset.toFixed(1)}px 0 ${-inset.toFixed(1)}px`;
  });
}

/**
 * The answers under something being written or asked: what declines or
 * goes back at the left, what goes on at the right (the primary one last),
 * as every box ends. `no` may be absent; then the right stands alone.
 */
export function answers(no: Node | null, ...yes: (Node | null)[]): HTMLElement {
  return h('div', {class: 'answers'}, no, h('span', {class: 'grow'}), ...yes);
}

/**
 * The foot of an ask made in `box` after `from` was pressed: the deed goes on
 * on the side it was pressed (the next step under the pointer), Not now on
 * the other. Measured before the box gives way to the ask.
 */
export function askFoot(from: Element, box: Element): (no: Node, yes: Node) => HTMLElement {
  const a = from.getBoundingClientRect(), b = box.getBoundingClientRect();
  const left = a.width > 0 && a.left + a.width / 2 < b.left + b.width / 2;
  return (no, yes) => h('div', {class: 'card-foot'}, ...(left ? [yes, h('span', {class: 'grow'}), no] : [no, h('span', {class: 'grow'}), yes]));
}

/**
 * `b` does `f` when pressed, held while it runs, so a second press does
 * nothing. Failed, `b` says why in its own place and can be pressed again to
 * try again (its word back while it does). Before, several such buttons kept
 * the reason and stayed held: nothing more could be done there.
 */
export function deed(b: HTMLButtonElement, f: () => Promise<unknown>) {
  const word = b.textContent ?? '';
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = word;
    // Done, it gives a small beat where it was pressed; failed, it says why there.
    try { await f(); if (b.isConnected) pop(b, .06, 300); } catch (e) { b.textContent = errorText(e); } finally { b.disabled = false; }
  });
}

/** Copy `text` when `el` is pressed, and say so in its place for a moment (there is no Copy button). */
export function copying(el: HTMLElement, text: string) {
  el.addEventListener('click', () => {
    void navigator.clipboard?.writeText(text);
    el.dataset.copiedWord = t('Copied');
    el.dataset.copied = '';
    pop(el, .04, 260);
    window.setTimeout(() => delete el.dataset.copied, 1200);
  });
  el.title = t('Press to copy');
}

/**
 * A deed that asks first comes back under the pointer, so the second click
 * of a double click would land on it: it holds still this long after showing.
 */
export const SETTLE = 500;

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

export function parts<K extends string>(page: string, list: readonly {id: K; label: string}[],
  label = RAIL.some((p) => p.id === page) ? t(purpose(page as PurposeId).label) : ''): Parts<K> {
  const key = `length3.part.${page}`;
  const tabs = new Map<K, {tab: HTMLButtonElement; small: HTMLElement; panel: HTMLElement}>();
  const heard: ((k: K) => void)[] = [];
  // Heard by the name it is given (the page's, in the language spoken), never by the key it is kept under.
  const bar = h('div', {class: 'parts', role: 'tablist', ...(label ? {'aria-label': label} : {})});
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
      // On a narrow window the switch slides sideways: the chosen one is kept in view.
      if (on && bar.isConnected && bar.scrollWidth > bar.clientWidth) x.tab.scrollIntoView({block: 'nearest', inline: 'nearest'});
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
