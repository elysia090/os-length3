import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {missing, setLang, t, tn} from './i18n.ts';

/** Every literal handed to t() / tn() in the app's source. */
function texts(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'i18n') texts(p, out); continue; }
    if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) out.push(m[1].replace(/\\'/g, "'"));
    for (const m of src.matchAll(/\btn\(\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g)) out.push(m[1], m[2]);
  }
  return out;
}

test('every English text has its Japanese', () => {
  const all = [...new Set(texts(new URL('.', import.meta.url).pathname))];
  assert.deepEqual(missing(all), []);
});

test('English by default; Japanese when chosen; placeholders filled in either', () => {
  assert.equal(t('{n} min ago', {n: 3}), '3 min ago');
  setLang('ja');
  assert.equal(t('{n} min ago', {n: 3}), '3分前');
  assert.equal(t('a text nobody translated'), 'a text nobody translated');
  setLang('en');
  assert.equal(tn('{n} file', '{n} files', 1), '1 file');
});

test('no Japanese is written outside the catalog', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'i18n') walk(p); continue; }
      if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('/i18n.ts')) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/['"`][^'"`]*[぀-ヿ一-鿿]/.test(code)) offenders.push(`${p.split('/src/').at(-1)}:${i + 1}`);
      });
    }
  };
  walk(new URL('.', import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});

// How Japanese is written beside Latin words and numbers (DESIGN.md §1).
const catalog = () => readdirSync(new URL('./i18n/ja/', import.meta.url).pathname).filter((f) => f !== 'index.ts')
  .flatMap((f) => [...readFileSync(new URL(`./i18n/ja/${f}`, import.meta.url), 'utf8')
    .matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"): '((?:[^'\\]|\\.)*)'/gm)]
    .map((m) => ({file: f, en: m[1] ?? m[2], ja: m[3]})));
const KANA_KANJI = '\\u3040-\\u30fa\\u30fc-\\u30ff\\u3400-\\u9fff';
const NAMES = 'name|server|board|repo|who|address|path|client|issue|date|list|query';

test('Japanese is written one way beside Latin words, numbers and names', () => {
  const rules: [string, RegExp][] = [
    ['a Latin word is a space apart', new RegExp(`[A-Za-z][${KANA_KANJI}]|[${KANA_KANJI}][A-Za-z]`)],
    ['a number and its counter are one', /(?<![A-Za-z\d])(\d+|\{(n|m|open|all)\}) (日|年|月|週|時間|分|秒|件|個|行|文字|回|人|台|版|ファイル|プロセス)/],
    ['a name is set apart by t(), not by hand', new RegExp(`\\{(${NAMES})\\} [${KANA_KANJI}]|[${KANA_KANJI}] \\{(${NAMES})\\}`)],
    ['a colon after Japanese is full width', new RegExp(`[${KANA_KANJI}]:`)],
  ];
  const broken = catalog().flatMap((e) => rules.filter(([, r]) => r.test(e.ja.replace(/\{\w+\}/g, (p) => p))).map(([why]) => `${why}: ${e.ja}`));
  assert.deepEqual(broken, []);
});

test('each English text has one Japanese', () => {
  const seen = new Map<string, string>();
  const twice = catalog().filter((e) => { const had = seen.get(e.en); seen.set(e.en, e.ja); return had !== undefined; }).map((e) => `${e.file}: ${e.en}`);
  assert.deepEqual(twice, []);
});

test('a name is a space apart from Japanese only when it is Latin', () => {
  setLang('ja');
  assert.equal(t('To the people of {server}', {server: '旅行'}), '旅行の人たちへ');
  assert.equal(t('To the people of {server}', {server: 'trip'}), 'trip の人たちへ');
  assert.equal(t('To the people of {server}', {server: 'trip42'}), 'trip42 の人たちへ');
  assert.equal(t('To the people of {server}', {server: '42'}), '42の人たちへ');
  assert.equal(t('{n} new posts', {n: 3}), '新しい投稿 3件');
  setLang('en');
  assert.equal(t('To the people of {server}', {server: 'trip'}), 'To the people of trip');
});
