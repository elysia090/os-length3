import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {declarations, leavesOf, readSheet, splitTop} from '../../build/styles/sheet.ts';

// What a colour may say (DESIGN §13, after Bertin's visual variables): what is ranked is said by value, the greys from
// ink to paper, lighter and lighter and with no hue of their own; a hue says a kind (the machine, one's own, done,
// refused) and ranks nothing.

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const token = (name: string): [number, number, number] => {
  const m = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i').exec(css);
  assert.ok(m, `--${name} is a colour in tokens.css`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as [number, number, number];
};
/** CIE Lab of an sRGB colour. */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const f = (v: number) => { v /= 255; return v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92; };
  const [R, G, B] = [f(r), f(g), f(b)];
  const k = (t: number) => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = k((R * .4124 + G * .3576 + B * .1805) / .95047), y = k(R * .2126 + G * .7152 + B * .0722), z = k((R * .0193 + G * .1192 + B * .9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const chroma = (c: [number, number, number]) => Math.hypot(c[1], c[2]);

test('what is ranked is said by value: the greys from ink to paper each lighter than the last, and none of them a hue', () => {
  const ranks = ['ink', 'sub', 'edge', 'quiet', 'rule', 'slot', 'ground', 'paper'].map((n) => ({n, c: lab(token(n))}));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i]!.c[0] > ranks[i - 1]!.c[0] + 3, `${ranks[i]!.n} lighter than ${ranks[i - 1]!.n} by a step that is seen`);
  }
  for (const {n, c} of ranks) assert.ok(chroma(c) < 5, `${n} is grey (chroma ${chroma(c).toFixed(1)})`);
});

test('a hue says a kind and nothing else: each clearly a hue, each kind its own', () => {
  const kinds = ['green', 'note', 'done', 'off'].map((n) => ({n, c: lab(token(n))}));
  for (const {n, c} of kinds) assert.ok(chroma(c) > 20, `${n} is a hue (chroma ${chroma(c).toFixed(1)})`);
  const angle = (c: [number, number, number]) => (Math.atan2(c[2], c[1]) * 180 / Math.PI + 360) % 360;
  // (The machine's green and done's green are one hue at two values: the terminal's words, and a step done.)
  for (const [a, b] of [['note', 'off'], ['green', 'off'], ['note', 'green'], ['done', 'off'], ['note', 'done']] as const) {
    const d = Math.abs(angle(lab(token(a))) - angle(lab(token(b)))), apart = Math.min(d, 360 - d);
    assert.ok(apart > 30, `${a} and ${b} are told apart by hue (${apart.toFixed(0)}°)`);
  }
});

// Three sizes, one, two and four times (DESIGN §3, after Vignelli): every word at one size, a name at twice it, the
// shot's one large thing at four; what says less is said quieter or in the other weight, never smaller. One bold.
const SERVER_MEASURES = ['control', 'meta', 'time', 'word', 'title'] as const;
const SERVER_SIZE = new Set<string>(SERVER_MEASURES.map((role) => `var(--t-server-${role})`));
const NOTE_WRITING = 'var(--note-writing)', REPO_NAME = 'var(--repo-name-size, calc(.7 * var(--t-head)))';
test('a place uses the common type scale or its scoped writing measure, and every weight is one of three', async () => {
  const {readdirSync} = await import('node:fs');
  const dir = new URL('../styles/', import.meta.url);
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')] as const);
  const SIZES = /^(var\(--t-(word|head|voice)\)|var\(--size\)|inherit|0)$/;
  const INBOX = /^var\(--t-inbox-(time|meta|write|words|compact-title|title)\)$/;
  const allowed = (file: string, size: string) => SIZES.test(size)
    || file === 'inbox.css' && INBOX.test(size) || file === 'home.css' && [NOTE_WRITING, REPO_NAME].includes(size)
    || file === 'server-desk.css' && SERVER_SIZE.has(size) && size !== 'var(--t-server-time)'
    || file === 'talk.css' && size === 'var(--t-server-time)';
  for (const [f, s] of sheets) {
    for (const m of s.matchAll(/font-size:\s*([^;}]+)/g)) assert.ok(allowed(f, m[1]!.trim()), `${f}: font-size ${m[1]}`);
    for (const m of s.matchAll(/(?<![-\w])font:\s*([^;}]+)/g)) {
      const v = m[1]!.trim();
      if (v === 'inherit') continue;
      const lead = /^(?:(?:italic|normal)\s+)?(?:(\d{3})\s+)?/.exec(v)!;
      const size = splitTop(v.slice(lead[0].length), ' /\t\r\n').find(({text}) => text)?.text;
      assert.ok(size && allowed(f, size), `${f}: font ${v}`);
      if (lead[1]) assert.ok(['400', '700', '900'].includes(lead[1]), `${f}: font ${v}`);
    }
    for (const m of s.matchAll(/font-weight:\s*([^;}]+)/g)) assert.ok(['400', '700', '900', 'inherit'].includes(m[1]!.trim()), `${f}: font-weight ${m[1]}`);
    // (A size of its own, kept in a property: a name's, one cell or two of capitals.)
    for (const m of s.matchAll(/--size:\s*([^;}]+)/g)) assert.match(m[1]!.trim(), /^var\(--t-(head|voice)\)$|^calc\(var\(--cap\) \* var\(--u\) \/ \.727\)$/, `${f}: --size ${m[1]}`);
  }
  // 17, 33 and 66: the words by the angle a small letter needs, the name by its capitals' cell, and twice that.
  assert.match(css, /--t-word:\s*17px/);
  assert.match(css, /--t-head:\s*calc\(var\(--u\) \/ \.727\)/);
  assert.match(css, /--t-voice:\s*calc\(2 \* var\(--u\) \/ \.727\)/);
});

test('Home keeps its note and repo-name measures on their own surfaces', () => {
  const sheet = readFileSync(new URL('../styles/home.css', import.meta.url), 'utf8');
  const measure = leavesOf(readSheet(sheet).nodes).flatMap(({node, parents}) => {
    if (node.kind !== 'rule') return [];
    const selector = node.selector.replace(/\s+/g, ' ').trim();
    const scope = parents.map(({name, prelude}) => `@${name}${prelude.replace(/\s+/g, '')}`).join(' ');
    return declarations(node.body).filter(({prop, value}) => ['--note-writing', '--repo-name-size'].includes(prop)
      || value.includes(NOTE_WRITING) || value.includes(REPO_NAME))
      .map(({prop, value}) => [scope, selector, prop, value]);
  });
  assert.deepEqual(measure, [
    ['', '.home-own > .section', '--note-writing', '20px'],
    ['@media(max-width:600px)', '.home-own > .section', '--note-writing', '18px'],
    ['', '.home-own :is(.todo-title, .todo-kind)', 'font', '700 var(--note-writing)/var(--note-row) var(--sans)'],
    ['', '.home-own .todo-detail', 'font', '400 var(--note-writing)/calc(var(--u) + var(--s1)) var(--sans)'],
    ['', '.home-repos > .gear-card > .card-open > .card-title', 'font', `900 ${REPO_NAME}/var(--u) var(--display)`],
    ['@media(max-width:600px)', '.home-repos', '--repo-name-size', 'var(--t-word)'],
  ]);
});

test('Server keeps its already chosen letter measure on its own desk', () => {
  const sheet = readFileSync(new URL('../styles/server-desk.css', import.meta.url), 'utf8');
  const measure = leavesOf(readSheet(sheet).nodes).flatMap(({node, parents}) => {
    if (node.kind !== 'rule') return [];
    return declarations(node.body).filter(({prop}) => prop.startsWith('--t-server-'))
      .map(({prop, value}) => [parents.length > 0, node.selector.trim(), prop, value]);
  });
  const work = ".page[data-place='server'] > .server-work";
  assert.deepEqual(measure, [
    [false, work, '--t-server-control', '16px'],
    [false, work, '--t-server-meta', '14px'],
    [false, work, '--t-server-time', '13px'],
    [false, work, '--t-server-word', '18px'],
    [false, work, '--t-server-title', '36px'],
    [true, work, '--t-server-word', 'var(--t-word)'],
    [true, work, '--t-server-title', 'min(34px, 9vw)'],
  ]);
});
