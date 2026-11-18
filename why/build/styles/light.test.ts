import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ANSI_ORDER, GREYS, HUES, lc, lightOf, NOTE_QUIET, oklab, PHOSPHOR, SETS, TINTS, under, written} from './light.ts';

// One light (DESIGN §3, colour), held on what the sheets carry, whoever wrote them.

const sheet = (name: string) => readFileSync(new URL(`../../app/styles/${name}`, import.meta.url), 'utf8');
const tokens = sheet('tokens.css');
const ground = /--ground: (#[0-9a-f]{6})/.exec(tokens)![1]!;
const light = lightOf(ground);
const value = (css: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)?.[1];


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
function set_(css: string, rule: RegExp) {
  const body = rule.exec(css)![0];
  return Array.from({length: 16}, (_, i) => {
    const v = new RegExp(`--ansi-${i}: ([^;]+);`).exec(body)![1]!.trim();
    const ref = /^var\(--([a-z-]+)\)$/.exec(v);
    return ref ? value(tokens, ref[1]!)! : v;
  });
}

for (const [where, css, rule, set] of [
  ['on paper', sheet('terminal.css'), /:root \{\n {2}--ansi-0:[^}]*\}/, SETS.paper],
  ['on the screen', sheet('forge-desk.css'), /\.desk-box\[data-kind\]:is\(\.held, \.leaving\) \{[^}]*\}/, SETS.screen],
] as const) {
  test(`the terminal's sixteen ${where}: six hues round the wheel at one contrast and one chroma from the light's neutral, mixing to it; bright a step past; black and white the OS's greys`, () => {
    const all = set_(css, rule), on = value(tokens, set.on)!;
    for (const [first, label, target] of [[1, 'normal', set.lc], [9, 'bright', set.bright]] as const) {
      const six = all.slice(first, first + 6);
      // One contrast on what they are read on (APCA), one chroma: none louder than another.
      for (const h of six) assert.ok(Math.abs(lc(h, on) - target) <= 1.5, `${label} ${h}: Lc ${lc(h, on).toFixed(1)}, wanted ${target}`);
      const Cs = six.map((h) => under(light, h).C);
      assert.ok(Math.max(...Cs) - Math.min(...Cs) <= 0.01, `${label}: chroma ${Cs.map((x) => x.toFixed(3))}`);
      // At equal steps round the wheel.
      ANSI_ORDER.forEach((k, i) => {
        const d = Math.abs(((under(light, six[i]!).h - HUES[k]! + 540) % 360) - 180);
        assert.ok(d <= 3, `${label} ${i + 1}: hue ${under(light, six[i]!).h.toFixed(1)}, wanted ${HUES[k]!.toFixed(1)}`);
      });
      // Together they mix to the light's neutral (Itten, Munsell): what is left of their mean is a trace.
      const lab = six.map(oklab);
      const mean = [0, 1, 2].map((j) => lab.reduce((s, c) => s + c[j]!, 0) / 6);
      const left = Math.hypot(mean[1]! - light[0] * mean[0]!, mean[2]! - light[1] * mean[0]!);
      assert.ok(left <= 0.006, `${label}: they mix to ${left.toFixed(4)} off the neutral`);
    }
    // Bright a step past (more contrast); black and white the OS's own greys under the one light.
    assert.ok(Math.abs(set.bright) - Math.abs(set.lc) >= 6, 'bright a step past');
    for (const i of [0, 7, 8, 15]) assert.ok(under(light, all[i]!).C <= 0.0015, `${i}: ${all[i]} a grey of the light`);
    // White, bright white and bright black are read (Lc 45 and more); on the glass nothing past its ceiling, Lc 90.
    for (const i of [7, 8, 15]) assert.ok(Math.abs(lc(all[i]!, on)) >= 45, `${i} read ${where}: Lc ${lc(all[i]!, on).toFixed(1)}`);
    if (set.on === 'ink') for (const h of all) assert.ok(lc(h, on) >= -90, `${h} on the glass: Lc ${lc(h, on).toFixed(1)}, past its ceiling`);
  });
}

test('words are crisp and never tiring: read at length at Lc 75 and more, no word under Lc 45, nothing on the glass past Lc 90', () => {
  const v = (n: string) => value(tokens, n)!;
  assert.ok(lc(v('ink'), v('paper')) >= 90, 'ink on paper');
  assert.ok(lc(v('sub'), v('paper')) >= 75, 'sub on paper');
  assert.ok(lc(v('ink'), v('ground')) >= 75, 'ink on the ground');
  assert.ok(lc(v('sub'), v('ground')) >= 60, 'sub on the ground');
  for (const bg of ['ground', 'paper']) assert.ok(lc(v('quiet'), v(bg)) >= 45, `quiet on ${bg}: Lc ${lc(v('quiet'), v(bg)).toFixed(1)}`);
  assert.ok(lc(v('note-quiet'), v('note')) >= NOTE_QUIET - 1, 'the note\'s quiet words');
  const g = lc(v('green'), v('ink'));
  assert.ok(g <= PHOSPHOR + 1.5 && g >= -90, `the terminal's words on its glass: Lc ${g.toFixed(1)}`);
});

test('the sheets carry what why/build/styles/light.ts writes (node why/build/styles/light.ts)', () => {
  const now = written();
  assert.equal(tokens, now.tokens);
  assert.equal(sheet('terminal.css'), now.terminal);
  assert.equal(sheet('forge-desk.css'), now.desk);
});
