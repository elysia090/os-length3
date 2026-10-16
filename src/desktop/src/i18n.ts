// The OS's words, in English by default and wholly in Japanese when chosen.
// Code is written in English: t('Commit') is the English text itself, and
// the Japanese is looked up by it (i18n/ja/). Placeholders are {name}.
// The choice is Home's `lang` setting, the same file l3 reads, so the app
// and the command line speak the same language.

import ja from './i18n/ja/index.ts';

export type Lang = 'en' | 'ja';
export const LANGS: readonly {id: Lang; name: string}[] = [{id: 'en', name: 'English'}, {id: 'ja', name: '日本語'}];

const MIRROR = 'length3.os.lang';
let lang: Lang = (() => {
  try { return localStorage.getItem(MIRROR) === 'ja' ? 'ja' : 'en'; } catch { return 'en'; }
})();

export const currentLang = (): Lang => lang;

const listeners = new Set<() => void>();
export function onLang(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/** Take the language from Home's setting (JSON "en" or "ja"); anything else is English. */
export function useLang(stored: string | null) {
  let next: Lang = 'en';
  try { next = JSON.parse(stored ?? '"en"') === 'ja' ? 'ja' : 'en'; } catch { /* English */ }
  setLang(next);
}

export function setLang(next: Lang) {
  try { localStorage.setItem(MIRROR, next); } catch { /* the first paint only */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === lang) return;
  lang = next;
  for (const fn of [...listeners]) fn();
}

function fill(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/** The text in the current language. */
export function t(en: string, vars?: Record<string, string | number>): string {
  return fill(lang === 'ja' ? ja[en] ?? en : en, vars);
}

/** One or many: English tells them apart, Japanese does not. */
export function tn(one: string, many: string, n: number, vars: Record<string, string | number> = {}): string {
  return t(n === 1 ? one : many, {n, ...vars});
}

/** Every English text the catalog lacks, for the test that keeps it complete. */
export function missing(texts: string[]): string[] {
  return texts.filter((s) => !(s in ja));
}
