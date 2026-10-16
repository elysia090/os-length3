// Element construction. Text is always set as text, never parsed as HTML.

import {t} from './i18n.ts';

export type Child = Node | string | null | undefined | false;

export function h(tag: string, props: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v; else el.setAttribute(k, v);
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
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
