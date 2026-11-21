// What DESIGN.md says the OS never has, read off its sheets and its code, so that a rule broken is named where it is
// broken: nothing see-through but depth (§1), a shadow hard (§3), no filter but depth's blur, two weights and the
// display's, the four corners, no colour written outside the light's own sheets (why/build/styles/light.ts), and nothing that
// waits on a pointer (§7). What can only be seen rendered (heights, rings, colours as computed) is the browser's to
// check, in every place (why/test/app/design.spec.ts).
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {test} from 'node:test';
import {declarations, entryOf, leavesOf, readSheet} from './sheet.ts';

const ROOT = join(import.meta.dirname, '../../..');
const APP = join(ROOT, 'why', 'app');
const STYLES = join(APP, 'styles');

type Said = {at: string; selector: string; prop: string; value: string};
/** Every declaration of every sheet, with the rule it is in. */
function said(): Said[] {
  const out: Said[] = [];
  for (const f of readdirSync(STYLES).filter((n) => n.endsWith('.css')).sort()) {
    // (The sheet that only gathers the others, its imports first: what follows them.)
    const text = readFileSync(join(STYLES, f), 'utf8');
    for (const leaf of leavesOf(readSheet(entryOf(text)?.rest ?? text).nodes)) {
      if (leaf.node.kind !== 'rule') continue;
      const {selector, body} = leaf.node;
      for (const d of declarations(body)) out.push({at: f, selector: selector.replace(/\s+/g, ' ').trim(), prop: d.prop, value: d.value.replace(/\s+/g, ' ').trim()});
    }
  }
  return out;
}
const ALL = said();
const named = (s: Said) => `${s.at} ${s.selector} { ${s.prop}: ${s.value} }`;
/** The values of `prop` (and of the longhands it names: `-webkit-` ones too). */
const of = (...props: string[]) => ALL.filter((s) => props.includes(s.prop.replace(/^-webkit-/, '')));
/** A value split at its top-level commas. */
const layers = (v: string) => {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '(') depth++;
    else if (v[i] === ')') depth--;
    else if (v[i] === ',' && !depth) { out.push(v.slice(from, i).trim()); from = i + 1; }
  }
  return [...out, v.slice(from).trim()];
};
/** A value's words at its top level (what is in brackets kept whole). */
const words = (v: string) => {
  const out: string[] = [];
  let depth = 0, w = '';
  for (const c of v) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (/\s/.test(c) && !depth) { if (w) out.push(w); w = ''; } else w += c;
  }
  return w ? [...out, w] : out;
};

/** Depth, the one thing allowed to be seen through (§1): the world going out of focus under what is called up. */
const DEPTH = /\.page-veil/;

test('nothing is see-through: what says less is said by value (§1, §3)', () => {
  const wrong = [
    ...of('opacity').filter((s) => !/^(0|1|var\(.*\))$/.test(s.value)),
    ...of('fill-opacity', 'stroke-opacity'),
    ...ALL.filter((s) => /color-mix\([^;]*\btransparent\b/.test(s.value) && !DEPTH.test(s.selector)),
    ...ALL.filter((s) => /\b(rgba|hsla)\(|\brgb\([^)]*\//.test(s.value)),
  ];
  assert.deepEqual(wrong.map(named), []);
});

test('a shadow is hard: no blur in it, and no shadow on words (§3)', () => {
  const length = /^(-?[\d.]+(px|em|rem)?|var\(--(shade|s\d|u|line[\w-]*)\)|calc\(.*\))$/;
  const soft = of('box-shadow').filter((s) => s.value !== 'none' && layers(s.value).some((l) => {
    const n = words(l).filter((w) => w !== 'inset' && length.test(w));
    return n.length >= 3 && !/^0(px)?$/.test(n[2]!);
  }));
  assert.deepEqual([...soft, ...of('text-shadow').filter((s) => s.value !== 'none')].map(named), []);
});

test('no filter but depth\'s blur (§1)', () => {
  const wrong = [...of('filter'), ...of('backdrop-filter')].filter((s) => s.value !== 'none' && !/^blur\([^)]*\)$/.test(s.value));
  assert.deepEqual(wrong.map(named), []);
});

test('two weights, 400 and 700, and the display face\'s 900 (§3)', () => {
  const weight = /^(400|700|900|normal|bold|inherit)$/;
  const wrong = [
    ...of('font-weight').filter((s) => !weight.test(s.value)),
    ...of('font').filter((s) => /^\d{3}\b/.test(s.value) && !weight.test(words(s.value)[0]!)),
  ];
  assert.deepEqual(wrong.map(named), []);
});

test('a corner is a key\'s, a field\'s or a sheet\'s, or round (§3)', () => {
  const corner = (w: string) => /^(0|50%|inherit|var\(--r-[\w-]+\)|calc\(.*\))$/.test(w);
  const wrong = of('border-radius').filter((s) => !words(s.value).filter((w) => w !== '/').every(corner));
  assert.deepEqual(wrong.map(named), []);
});

test('no colour is written outside the light\'s own sheets (why/build/styles/light.ts)', () => {
  // The light's: the tokens, and the terminal's sixteen as light.ts writes them. A mask's black is no colour (it says
  // only what is kept), and a picture's (a cursor's) is its own.
  const own = (s: Said) => s.at === 'tokens.css' || (s.at === 'terminal.css' && s.selector === ':root')
    || (s.at === 'forge-desk.css' && s.selector === '.desk-box[data-kind]:is(.held, .leaving)');
  const wrong = ALL.filter((s) => !own(s) && !/^(-webkit-)?mask/.test(s.prop) && !/url\(/.test(s.value)
    && /#[0-9a-fA-F]{3,8}\b|\b(rgb|hsl|hwb|lab|lch|oklab|oklch)\(/.test(s.value));
  assert.deepEqual(wrong.map(named), []);
});

/** The app's own code (its tests aside). */
function code(dir: string): {at: string; text: string}[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === 'dist' ? [] : code(p);
    return n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts') ? [{at: relative(ROOT, p), text: readFileSync(p, 'utf8')}] : [];
  });
}

test('nothing waits on a pointer: no tooltip, no title (§7)', () => {
  const wrong: string[] = [];
  for (const {at, text} of ['pages', 'ui', 'main', 'host'].flatMap((d) => code(join(APP, d)))) {
    text.split('\n').forEach((line, i) => {
      if (/\b(?!document\b)\w+\.title\s*=(?!=)|setAttribute\(\s*['"]title['"]/.test(line)) wrong.push(`${at}:${i + 1}: ${line.trim()}`);
    });
    for (const m of text.matchAll(/\bh\(\s*'[\w-]+'\s*,\s*\{[^{}]*?\btitle\s*:/g)) wrong.push(`${at}:${text.slice(0, m.index).split('\n').length}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  assert.deepEqual(wrong, []);
});
