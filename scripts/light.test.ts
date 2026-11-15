import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {GREYS, HUES, lightOf, oklab, TINTS, under, written} from './light.ts';

// One light (DESIGN §3, colour), held on what the sheets carry, whoever wrote them.

const sheet = (name: string) => readFileSync(new URL(`../why/app/styles/${name}`, import.meta.url), 'utf8');
const tokens = sheet('tokens.css');
const ground = /--ground: (#[0-9a-f]{6})/.exec(tokens)![1]!;
const light = lightOf(ground);
const value = (css: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)?.[1];

/** Relative luminance, for contrast (WCAG 2). */
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

test('every grey, ink to paper and the dots, is the ground\'s light at its own lightness: one white, as a scene is balanced to one', () => {
  const dot = /--dots: radial-gradient\(circle, (#[0-9a-f]{6})/.exec(tokens)![1]!;
  for (const [name, hex] of [...GREYS.map((g) => [g, value(tokens, g)!] as const), ['dot', dot] as const]) {
    // (Within what a screen's 256 steps a channel can hold: a thousandth and a bit of chroma off the light's neutral.)
    assert.ok(under(light, hex).C <= 0.0015, `${name} ${hex}: ${under(light, hex).C.toFixed(4)} off the ground's light`);
  }
});

test('a mark\'s tint is the mark seen in the light\'s white: its hue under the light', () => {
  for (const [tint, {mark}] of Object.entries(TINTS)) {
    const a = under(light, value(tokens, tint)!).h, b = under(light, value(tokens, mark)!).h;
    assert.ok(Math.abs(((a - b + 540) % 360) - 180) <= 3, `${tint} at ${a.toFixed(1)}, its mark ${mark} at ${b.toFixed(1)}`);
  }
});

/** A set of sixteen as a sheet carries it, each named colour resolved (the greys by their token). */
function set(css: string, rule: RegExp) {
  const body = rule.exec(css)![0];
  return Array.from({length: 16}, (_, i) => {
    const v = new RegExp(`--ansi-${i}: ([^;]+);`).exec(body)![1]!.trim();
    const ref = /^var\(--([a-z-]+)\)$/.exec(v);
    return ref ? value(tokens, ref[1]!)! : v;
  });
}

for (const [where, css, rule, on, bright] of [
  ['on paper', sheet('terminal.css'), /:root \{\n {2}--ansi-0:[^}]*\}/, value(tokens, 'paper')!, -1],
  ['on the screen', sheet('forge-desk.css'), /\.desk-box\[data-kind\]\.held \{[^}]*\}/, value(tokens, 'ink')!, 1],
] as const) {
  test(`the terminal's sixteen ${where}: six hues round the wheel at one lightness and one chroma from the light's neutral, mixing to it; bright a step more ink; black and white the OS's greys`, () => {
    const all = set(css, rule);
    for (const [first, label] of [[1, 'normal'], [9, 'bright']] as const) {
      const six = all.slice(first, first + 6).map((h) => under(light, h));
      const Ls = six.map((c) => c.L), Cs = six.map((c) => c.C);
      // One lightness, one chroma (as far as a screen's steps let them be one): none louder than another.
      assert.ok(Math.max(...Ls) - Math.min(...Ls) <= 0.01, `${label}: lightness ${Ls.map((x) => x.toFixed(3))}`);
      assert.ok(Math.max(...Cs) - Math.min(...Cs) <= 0.01, `${label}: chroma ${Cs.map((x) => x.toFixed(3))}`);
      // At equal steps round the wheel (ANSI's order red, green, yellow, blue, magenta, cyan: the wheel's 0, 2, 1, 4, 5, 3).
      [0, 2, 1, 4, 5, 3].forEach((k, i) => {
        const d = Math.abs(((six[i]!.h - HUES[k]! + 540) % 360) - 180);
        assert.ok(d <= 3, `${label} ${i + 1}: hue ${six[i]!.h.toFixed(1)}, wanted ${HUES[k]!.toFixed(1)}`);
      });
      // Together they mix to the light's neutral (Itten, Munsell): what is left of their mean is a trace.
      const lab = all.slice(first, first + 6).map(oklab);
      const mean = [0, 1, 2].map((j) => lab.reduce((s, c) => s + c[j]!, 0) / 6);
      const left = Math.hypot(mean[1]! - light[0] * mean[0]!, mean[2]! - light[1] * mean[0]!);
      assert.ok(left <= 0.004, `${label}: they mix to ${left.toFixed(4)} off the neutral`);
      // Read where they are drawn.
      for (const h of all.slice(first, first + 6)) assert.ok(contrast(h, on) >= 4.5, `${label} ${h} on ${on}: ${contrast(h, on).toFixed(2)}`);
    }
    // Bright is a step more ink: further from what it is read on.
    const L = (i: number) => oklab(all[i]!)[0];
    for (let i = 1; i <= 6; i++) assert.ok(bright * (L(i + 8) - L(i)) > 0.05, `bright ${i + 8} a step more ink than ${i}`);
    // Black and white, bright and not, are the OS's own greys, each under the one light.
    for (const i of [0, 7, 8, 15]) assert.ok(under(light, all[i]!).C <= 0.0015, `${i}: ${all[i]} a grey of the light`);
    for (const i of [7, 15]) assert.ok(contrast(all[i]!, on) >= 4.5, `white ${i} read ${where}`);
  });
}

test('the sheets carry what scripts/light.ts writes (node scripts/light.ts)', () => {
  const now = written();
  assert.equal(tokens, now.tokens);
  assert.equal(sheet('terminal.css'), now.terminal);
  assert.equal(sheet('forge-desk.css'), now.desk);
});
