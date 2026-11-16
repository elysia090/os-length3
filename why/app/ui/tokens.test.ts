import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

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
test('every size of type is one of three, and every weight one of three', async () => {
  const {readdirSync} = await import('node:fs');
  const dir = new URL('../styles/', import.meta.url);
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')] as const);
  const SIZES = /^(var\(--t-(word|head|voice)\)|var\(--size\)|inherit|0)$/;
  for (const [f, s] of sheets) {
    for (const m of s.matchAll(/font-size:\s*([^;}]+)/g)) assert.match(m[1]!.trim(), SIZES, `${f}: font-size ${m[1]}`);
    for (const m of s.matchAll(/(?<![-\w])font:\s*([^;}]+)/g)) {
      const v = m[1]!.trim();
      if (v === 'inherit') continue;
      const t = /^(?:(?:italic|normal)\s+)?(?:(\d{3})\s+)?(\S+?)(?:\/\S+)?\s/.exec(`${v} `);
      assert.ok(t, `${f}: font ${v}`);
      assert.match(t[2]!, SIZES, `${f}: font ${v}`);
      if (t[1]) assert.ok(['400', '700', '900'].includes(t[1]), `${f}: font ${v}`);
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
