// A number of bytes and a time, written as a person reads them, in the language the OS speaks: why's words for
// them, whichever part or page says them.

import {currentLang, t} from './i18n.ts';

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
