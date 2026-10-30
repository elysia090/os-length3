// The stylesheet's scripts on small sheets and a small app of their own: a sheet is read as it is written, a rule's
// weight is the cascade's, the classes an app can put on a page are followed to the strings they are made of, what
// can match nothing goes (and nothing else), and a sheet split into parts reads back as the same sheet.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {madeBy, pageWords} from './styles-classes.mjs';
import {pruneText} from './styles-prune.mjs';
import {said, split} from './styles-split.mjs';
import {entryOf, leavesOf, parseComplex, readSheet, specificity, textOf} from './styles-sheet.mjs';

const SHEET = `/* The tokens. */
:root { --ink: #222; --mark: url("data:image/svg+xml,%3Csvg%3E{}%3C/svg%3E"); }
.a { color: var(--ink); } /* about .a */
/* Over the media. */
@media (max-width: 760px) {
  /* Inside. */
  .a, .b > .c { padding: 0; }
  @supports (display: grid) { .d { display: grid; } }
}
@keyframes spin { to { rotate: 1turn; } }
/* At the end. */
`;

test('a sheet is read as it is written: every comment, string and group where it stands', () => {
  const sheet = readSheet(SHEET);
  assert.equal(textOf(sheet.nodes, sheet.tail), SHEET);
  const leaves = leavesOf(sheet.nodes);
  assert.deepEqual(leaves.map((l) => l.node.kind === 'rule' ? l.node.selector : `@${l.node.name}`), [':root', '.a', '.a, .b > .c', '.d', '@keyframes']);
  assert.deepEqual(leaves.map((l) => l.parents.map((g) => g.prelude)), [[], [], ['(max-width: 760px)'], ['(max-width: 760px)', '(display: grid)'], []]);
  assert.equal(leaves[1].node.trail, ' /* about .a */');
  assert.match(leaves[2].node.lead, /Inside/);
  const entry = entryOf(`/* The parts. */\n@import './styles/a.css';\n@import "./styles/b.css";\n.added { color: red; }\n`);
  assert.deepEqual(entry.files, ['./styles/a.css', './styles/b.css']);
  assert.equal(entry.rest, '\n.added { color: red; }\n');
  assert.equal(entryOf(SHEET), null);
});

test('a selector weighs what the cascade says', () => {
  const w = (s) => specificity(parseComplex(s));
  assert.deepEqual(w('.a .b'), [0, 2, 0]);
  assert.deepEqual(w('#x:is(.a, #y) > p::before'), [2, 0, 2]);
  assert.deepEqual(w(':where(.a, #b) .c'), [0, 1, 0]);
  assert.deepEqual(w('.a:not(.b, .c.d)'), [0, 3, 0]);
  assert.deepEqual(w('li:nth-child(2n of .x, #y)'), [1, 1, 1]);
  assert.deepEqual(w('::view-transition-old(page)'), [0, 0, 1]);
  assert.deepEqual(w('.a:has(> .b + .c)'), [0, 3, 0]);
  assert.deepEqual(w('input[type="checkbox"]:checked::after'), [0, 2, 2]);
});

/** An app of its own: src/ with these files, and index.html. */
function app(files, html = '<html class="opening"><body><main class="page" id="page"></main></body></html>') {
  const dir = mkdtempSync(join(tmpdir(), 'styles-test-'));
  mkdirSync(join(dir, 'src'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'src', name), text);
  writeFileSync(join(dir, 'index.html'), html);
  try { return pageWords(dir); } finally { rmSync(dir, {recursive: true, force: true}); }
}

const DOM = `export function h(tag: string, props: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') el.className = v; else el.setAttribute(k, v); }
  return el;
}
`;

test('a class is followed to the strings it is made of: a template, a parameter, an option, a toggle', () => {
  const words = app({'dom.ts': DOM, 'page.ts': `import {h} from './dom.ts';
import {t} from './i18n.ts';
const button = (text: string, kind = '') => h('button', {class: \`button \${kind}\`.trim()}, text);
export const go = () => button(t('Take note'), 'primary');
function row(extra: Partial<{kind: string}> = {}) { return h('li', {class: extra.kind ?? 'plain'}); }
export const rows = (bad: boolean) => [row(), row({kind: \`tree-new\${bad ? ' tree-bad' : ''}\`})];
export const tier = (x: 'pro' | 'free') => h('div', {class: \`card tier-\${x}\`});
export const mark = (m: {kind: 'add' | 'del'}) => h('i', {class: \`line \${m.kind}\`});
export function open(el: HTMLElement) { el.classList.toggle('open', true); }
`, 'i18n.ts': 'export const t = (s: string) => s;\n', 'chip.ts': `import {h} from './dom.ts';
export const chip = (text: string, kind = '') => h('span', {class: \`chip \${kind}\`}, text);
`, 'board.ts': `import * as parts from './chip.ts';
export const on = () => parts.chip('x', 'lit');
export const later = () => import('./chip.ts').then((m) => m.chip('y', 'late'));
`});
  assert.deepEqual(words.unread, []);
  for (const c of ['button', 'primary', 'plain', 'tree-new', 'tree-bad', 'card', 'line', 'add', 'del', 'open', 'opening', 'page', 'chip', 'lit', 'late']) {
    assert.equal(madeBy(words.classes, c), 'word', c);
  }
  assert.equal(madeBy(words.classes, 'tier-pro'), 'word');
  // Words said, and words written but never given as a class, are not classes.
  for (const c of ['take', 'note', 'tier', 'kind']) assert.equal(madeBy(words.classes, c), '', c);
  assert.equal(madeBy(words.ids, 'page'), 'word');
});

test('a class given from what cannot be followed may be any word a string holds', () => {
  const words = app({'dom.ts': DOM, 'page.ts': `import {h} from './dom.ts';
export const note = (el: HTMLElement) => h('p', {class: \`kind-\${el.dataset.kind}\`}, 'a note');
`});
  assert.equal(words.unread.length, 1);
  assert.match(words.unread[0].at, /page\.ts:2/);
  assert.equal(madeBy(words.classes, 'kind-fix'), 'kind-…');
  assert.equal(madeBy(words.classes, 'note'), 'word');
  assert.equal(madeBy(words.classes, 'nowhere'), '');
});

/** What an app with these classes and elements can put on a page. */
const given = (classes, tags = ['p', 'div'], prefixes = []) => {
  const w = (words, pre = []) => ({words: new Set(words), prefixes: new Set(pre), suffixes: new Set(), infixes: new Set()});
  return {classes: w(classes, prefixes), ids: w([]), tags: w(tags)};
};

test('what can match nothing goes, and nothing else, with the comment over it when it is over nothing else', () => {
  const page = given(['a', 'b', 'c'], ['p'], ['tier-']);
  const {text, out} = pruneText(page, `/* A and a gone one. */
.a, .gone { color: red; }
/* Only gone ones. */
.gone { color: red; }
.gone p { color: red; }

/* B, after a blank line. */
.b:is(.c, .gone) { color: red; }
.b:is(.c, #gone) { color: red; }
:where(.c, .gone) p, kbd { color: red; }
.tier-pro, .tier-free, html { color: red; }
@media (max-width: 1px) { .gone { color: red; } }
/* Over a gone one and a kept one. */
.gone { color: red; }
.c { color: blue; }
`);
  assert.equal(text, `/* A and a gone one. */
.a { color: red; }

/* B, after a blank line. */
.b:is(.c) { color: red; }
.b:is(.c, #gone) { color: red; }
:where(.c) p { color: red; }
.tier-pro, .tier-free, html { color: red; }
/* Over a gone one and a kept one. */
.c { color: blue; }
`);
  assert.equal(out.filter((o) => o.whole).length, 4);
  // #gone stays in :is(): without it the rule would weigh less.
  assert.ok(!out.some((o) => /#gone/.test(o.what)));
});

test('a sheet split into parts reads back as the same sheet, an @media cut where the parts are', () => {
  const rules = (cls, n, indent = '') => Array.from({length: n}, (_, i) => `${indent}.${cls}.n${i} { margin: ${i}px; }`).join('\n');
  const text = `/* The rail. */\n${rules('rail-item', 12)}\n@media (max-width: 760px) {\n${rules('rail', 6, '  ')}\n${rules('git-band', 12, '  ')}\n}\n/* Git. */\n${rules('git-flow', 12)}\n`;
  const {parts, entry} = split(text);
  assert.deepEqual(parts.map((p) => p.file), ['rail.css', 'git.css']);
  assert.match(entry, /@import '\.\/styles\/rail\.css';\n@import '\.\/styles\/git\.css';\n$/);
  assert.match(parts[0].text, /^\/\* The rail: [^]*\*\/\n\/\* The rail\. \*\/\n\.rail-item\.n0/);
  assert.match(parts[0].text, /@media \(max-width: 760px\) \{\n  \.rail\.n0 [^]*\.rail\.n5 \{ margin: 5px; \}\n\}\n$/);
  assert.match(parts[1].text, /^\/\* Git: [^]*\*\/\n@media \(max-width: 760px\) \{\n  \.git-band\.n0 /);
  const back = parts.map((p) => p.body).join('');
  assert.deepEqual(said(back), said(text));
  // Where no @media is cut, the parts one after another are the sheet as it was written, its room and all.
  const whole = `/* The rail. */\n${rules('rail-item', 12)}\n\n/* Git. */\n${rules('git-flow', 12)}\n`;
  assert.equal(split(whole).parts.map((p) => p.body).join(''), whole);
  // Split again from the parts, they are the same parts.
  assert.deepEqual(split(back).parts.map((p) => p.text), parts.map((p) => p.text));
});
