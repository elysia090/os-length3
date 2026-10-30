// Element construction. Text is always set as text, never parsed as HTML.

import {currentLang, t} from '../i18n.ts';

type Child = Node | string | null | undefined | false;

export function h(tag: string, props: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // A style goes through the style object, never as an attribute: the desktop app's policy (style-src 'self')
    // drops a style attribute written into the page, and with it a row's depth or a slide's place.
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(n: number): string {
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${UNITS[i]}`;
}

/** "3 min ago", "yesterday" style, falling back to a date. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', {n: Math.floor(s / 60)});
  if (s < 86400) return t('{n} h ago', {n: Math.floor(s / 3600)});
  if (s < 172800) return t('yesterday');
  return day(ms);
}

/** A day, written as the language the OS speaks writes one: Oct 17, 2031 / 2031年10月17日. */
export function day(ms: number): string {
  return dateFormat(DAY).format(ms);
}

/** A day without its year, as on a TODO, written as the language writes one: Oct 17 / 10月17日, never 10/17. */
export function shortDay(ms: number): string {
  return dateFormat(SHORT_DAY).format(ms);
}

/**
 * The language's way of writing a time as `how` says, made once a language and a way: making one is most of what
 * writing a date costs (a TODO of many lines, or a talk of many posts, drawn again wrote hundreds), its use little.
 * `how` is a way kept as it is (a constant), which is what it is known by.
 */
const ways = new WeakMap<Intl.DateTimeFormatOptions, Map<string, Intl.DateTimeFormat>>();
export function dateFormat(how: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const lang = currentLang();
  let byLang = ways.get(how);
  if (!byLang) { byLang = new Map(); ways.set(how, byLang); }
  let f = byLang.get(lang);
  if (!f) { f = new Intl.DateTimeFormat(lang, how); byLang.set(lang, f); }
  return f;
}
const DAY: Intl.DateTimeFormatOptions = {year: 'numeric', month: 'short', day: 'numeric'};
const SHORT_DAY: Intl.DateTimeFormatOptions = {month: 'short', day: 'numeric'};

/**
 * The arrow keys go along a list of things pressed (`items` in `list`), as they go along the rail: from the one with
 * the keyboard to the nearest one that way on the screen (a column of rows, a row of pills, a grid of cards alike).
 * Tab still goes through them all; nothing else changes.
 */
export function arrowKeys(list: HTMLElement, items: string) {
  list.addEventListener('keydown', (event) => {
    const way = ({ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0]} as Record<string, [number, number]>)[event.key];
    if (!way || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = (event.target as Element).closest<HTMLElement>(items);
    if (!at || !list.contains(at) || (event.target as Element).matches('input, textarea, select, [contenteditable]')) return;
    const from = at.getBoundingClientRect(), cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best: HTMLElement | null = null, bestCost = Infinity;
    for (const el of list.querySelectorAll<HTMLElement>(items)) {
      if (el === at || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      // Only what lies that way, the one most in line with it first, then the nearest.
      const ahead = way[0] ? dx * way[0] : dy * way[1];
      if (ahead <= 1) continue;
      const aside = Math.abs(way[0] ? dy : dx);
      const cost = ahead + aside * 3;
      if (cost < bestCost) { bestCost = cost; best = el; }
    }
    if (!best) return;
    event.preventDefault();
    best.focus();
  });
}
