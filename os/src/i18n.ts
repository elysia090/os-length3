// The OS's words, in English by default and wholly in Japanese when chosen.
// Code is written in English: t('Commit') is the English text itself, and
// the Japanese is looked up by it (i18n/ja/). Placeholders are {name}.
// The choice is Home's `lang` setting, the same file l3 reads, so the app
// and the command line speak the same language. The Japanese words are read only once Japanese is chosen (a chunk of
// their own, an eighth of the app): an OS in English never loads them.

type Lang = 'en' | 'ja';
export const LANGS: readonly {id: Lang; name: string}[] = [{id: 'en', name: 'English'}, {id: 'ja', name: '日本語'}];

const MIRROR = 'length3.os.lang';
let lang: Lang = (() => {
  try { return localStorage.getItem(MIRROR) === 'ja' ? 'ja' : 'en'; } catch { return 'en'; }
})();

export const currentLang = (): Lang => lang;

/** The Japanese words, by the English they stand for: once read. */
let ja: Record<string, string> | null = null;
let reading: Promise<void> | null = null;
const readJa = () => (reading ??= import('./i18n/ja/index.ts').then((m) => { ja = m.default; }));
// Japanese last time: its words are on their way from the first moment, beside what else the first page waits for.
if (lang === 'ja') void readJa();

const listeners = new Set<() => void>();
export function onLang(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

/** Take the language from Home's setting (JSON "en" or "ja"); anything else is English. Settled once its words are
 * here (what is drawn first waits for it, so it is never drawn in English and then again in Japanese). */
export function useLang(stored: string | null): Promise<void> {
  let next: Lang = 'en';
  try { next = JSON.parse(stored ?? '"en"') === 'ja' ? 'ja' : 'en'; } catch { /* English */ }
  return setLang(next);
}

/** The language chosen: spoken (and those listening told) once its words are read, never half in one and half in the
 * other meanwhile. */
export function setLang(next: Lang): Promise<void> {
  try { localStorage.setItem(MIRROR, next); } catch { /* the first paint only */ }
  return (next === 'ja' ? readJa() : Promise.resolve()).then(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = next;
    if (next === lang) return;
    lang = next;
    for (const fn of [...listeners]) fn();
  });
}

/** Kana and kanji (not their punctuation): what a Latin word is set a space apart from (DESIGN.md §1). */
export const KANA_KANJI = /[぀-ヺー-ヿ㐀-鿿]/;
const LATIN = /[A-Za-z]/;
const apart = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && ((LATIN.test(a) && KANA_KANJI.test(b)) || (KANA_KANJI.test(a) && LATIN.test(b)));
/** A name with Latin in it is a Latin word to its last digit (`perf42 で`); a bare number keeps its counter (`3件`). */
const edge = (v: string, c: string | undefined) => (c && /\d/.test(c) && LATIN.test(v) ? 'a' : c);

/** Placeholders filled in; a name is set apart from the Japanese beside it only when it is Latin (`notes を`, `旅行の`). */
function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string, at: number) => {
    if (!(k in vars)) return m;
    const v = String(vars[k]);
    const before = apart(text[at - 1], edge(v, v[0])) ? ' ' : '';
    const after = apart(edge(v, v.at(-1)), text[at + m.length]) ? ' ' : '';
    return before + v + after;
  });
}

/** The text in the current language. */
export function t(en: string, vars?: Record<string, string | number>): string {
  return fill(lang === 'ja' ? ja?.[en] ?? en : en, vars);
}

/** One or many: English tells them apart, Japanese does not. */
export function tn(one: string, many: string, n: number, vars: Record<string, string | number> = {}): string {
  return t(n === 1 ? one : many, {n, ...vars});
}

/** Every English text the catalog lacks, for the test that keeps it complete. */
export async function missing(texts: string[]): Promise<string[]> {
  await readJa();
  return texts.filter((s) => !(s in ja!));
}
