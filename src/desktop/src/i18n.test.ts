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
