// One light (DESIGN §3, colour): every colour of the OS is seen under the light the ground is lit by, as a film's
// every neutral is the one the scene is balanced to.
//
// The ground's colour says what the light is: in OKLab, a grey under a tinted light is the neutral grey with each of
// the eye's three responses scaled by the light (von Kries), and that scales L, a and b alike, so every neutral under
// one light has the same a/L and b/L: the ground's. So each grey (ink to paper) is the ground's light at its own
// lightness, and white is the light itself, not a white of another light beside it.
//
// The terminal's sixteen colours, as programs name them, are seen under it too, and balanced on it: the six hues at
// equal steps round the wheel, turned to stand nearest the terminal's own (red, yellow, green, cyan, blue, magenta),
// each at one lightness and one chroma from the light's neutral at that lightness, so that together they mix to it
// (Itten: colours are in harmony when their mixture is a neutral grey; Munsell: a design balances on the middle
// grey), and none is louder than another. Their bright ones are a step more ink: further from the ground they are
// read on, the same hue and chroma. Black and white are the OS's own greys.
//
// Crisp, and not tiring (APCA, the contrast WCAG 3 drafts with, which weighs a word's lightness against its ground's
// as the eye does, polarity and all): what is read at length on paper or the ground at Lc 75 and more, Lc 90 where it
// can be; a program's colours, spans within it, a step under the words they are among and over Lc 60; nothing on the
// screen's dark glass past Lc 90, where wider pupils make a brighter word bloom (halation) and tire; no word anywhere
// under Lc 45. Each set's six at one contrast (not one lightness: a blue and a yellow of one L are not one contrast),
// the bright ones a step past it.
//
//   node scripts/light.ts           write the greys and the sixteen into the sheets
//   node scripts/light.ts --check   say whether the sheets carry them (and end 1 if they do not)
//
// light.test.ts holds the laws on what the sheets carry, whoever wrote them.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const OS = fileURLToPath(new URL('..', import.meta.url));
const STYLES = join(OS, 'why', 'app', 'styles');

export type Lab = [L: number, a: number, b: number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** A colour written `#rrggbb`, in OKLab (Ottosson 2020). */
export function oklab(hex: string): Lab {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** An OKLab colour in linear sRGB (outside 0 to 1 where it is out of the screen's gamut). */
function linear([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** Whether a screen can show it. */
export const shown = (lab: Lab) => linear(lab).every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** An OKLab colour as `#rrggbb`. */
export function hex(lab: Lab): string {
  return `#${linear(lab).map((c) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, c))))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** APCA's lightness contrast (0.0.98G, its W3 constants) of `text` on `bg`: positive dark on light, negative light on
 * dark; 90 is a column of words read at length, 75 the least for it, 60 content text, 45 the least for any word. */
export function lc(text: string, bg: string): number {
  const Y = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.4);
    const y = 0.2126729 * r! + 0.7151522 * g! + 0.072175 * b!;
    return y > 0.022 ? y : y + (0.022 - y) ** 1.414;
  };
  const t = Y(text), b = Y(bg);
  if (b > t) { const c = (b ** 0.56 - t ** 0.57) * 1.14; return c < 0.1 ? 0 : (c - 0.027) * 100; }
  const c = (b ** 0.65 - t ** 0.62) * 1.14;
  return c > -0.1 ? 0 : (c + 0.027) * 100;
}

/** The lightness at which a colour of chroma `C` and hue `h` under `light` reads at contrast `target` on `bg`. */
export function lightFor(light: [number, number], C: number, h: number, target: number, bg: string): number {
  let best = 0, off = Infinity;
  for (let L = 0.05; L <= 0.999; L += 0.0005) {
    const d = Math.abs(lc(hex(at(light, L, C, h)), bg) - target);
    if (d < off) { off = d; best = L; }
  }
  return best;
}

/** The light a colour is lit by: its a/L and b/L. */
export const lightOf = (hex: string): [number, number] => { const [L, a, b] = oklab(hex); return [a / L, b / L]; };

/** The neutral of lightness `L` under `light`. */
export const neutral = (light: [number, number], L: number): Lab => [L, light[0] * L, light[1] * L];

/** How far a colour is from the light's neutral at its lightness: its chroma and hue (degrees) under that light. */
export function under(light: [number, number], hexOrLab: string | Lab): {L: number; C: number; h: number} {
  const [L, a, b] = typeof hexOrLab === 'string' ? oklab(hexOrLab) : hexOrLab;
  const da = a - light[0] * L, db = b - light[1] * L;
  return {L, C: Math.hypot(da, db), h: ((Math.atan2(db, da) * 180) / Math.PI + 360) % 360};
}

/** The terminal's six hues as programs mean them (xterm's red, yellow, green, cyan, blue, magenta), in OKLab's hue. */
export const NAMED = [29.2, 109.8, 142.5, 194.8, 264.1, 328.4] as const;
/** Six at equal steps round the wheel, turned to stand nearest the named six: the turn is their mean departure. */
export const HUES = (() => {
  const turn = NAMED.reduce((s, h, i) => s + (h - 60 * i), 0) / 6;
  return NAMED.map((_, i) => turn + 60 * i);
})();

/** The six under `light` at lightness `L` and chroma `C` from its neutral, in ANSI's order: red, green, yellow, blue,
 * magenta, cyan (1 to 6). */
export function six(light: [number, number], L: number, C: number): Lab[] {
  const [red, yellow, green, cyan, blue, magenta] = HUES.map((h): Lab => at(light, L, C, h));
  return [red!, green!, yellow!, blue!, magenta!, cyan!];
}
/** ANSI's order (red, green, yellow, blue, magenta, cyan) of the wheel's six (red, yellow, green, cyan, blue, magenta). */
export const ANSI_ORDER = [0, 2, 1, 4, 5, 3] as const;

/** The six at one contrast `target` on `bg`, chroma `C`, each at its own lightness for it, in ANSI's order. */
export const sixAt = (light: [number, number], C: number, target: number, bg: string): Lab[] =>
  ANSI_ORDER.map((k) => at(light, lightFor(light, C, HUES[k]!, target, bg), C, HUES[k]!));

/** The most chroma all six hold at `L` under `light` and the screen can show, in steps of .005. */
export function most(light: [number, number], L: number): number {
  let C = 0;
  while (six(light, L, C + 0.005).every(shown)) C += 0.005;
  return Math.round(C * 1000) / 1000;
}

/** The greys of the OS (tokens.css) by their lightness (OKLab L), each made the ground's light at it: from the ink (the
 * terminal's glass too) up to the paper. Their steps are the design's (§3, colour); only their light is made one here. */
export const GREY_L = {ink: 0.201, sub: 0.44, edge: 0.535, quiet: 0.598, dot: 0.664, rule: 0.684, slot: 0.831,
  raised: 0.917, paper: 0.985} as const;
/** (The quiet grey is the least a word is read at on the ground, Lc 45: lighter, a count or a line's number on the ground
 * was a word to make out.) */
export const GREYS = ['ink', 'sub', 'edge', 'quiet', 'rule', 'slot', 'raised', 'paper'] as const;

/** A mark's tint (the ground of a line it marks, a highlighter's stroke) is the mark seen in the light's white: its
 * hue under the light, at the tint's own lightness and chroma. Made against another white, a tint drifts from its
 * mark (a red's ground going pink, a green's going cyan) once the light is the ground's. */
export const TINTS = {'add-tint': {mark: 'add', L: 0.919, C: 0.026}, 'del-tint': {mark: 'del', L: 0.896, C: 0.025},
  'marker-soft': {mark: 'marker', L: 0.923, C: 0.049}, 'sky-tint': {mark: 'agent', L: 0.891, C: 0.0255}} as const;

/** A colour at lightness `L` and chroma `C` from `light`'s neutral, of hue `h` (degrees) under it. */
export const at = (light: [number, number], L: number, C: number, h: number): Lab => {
  const r = (h * Math.PI) / 180;
  return [L, light[0] * L + C * Math.cos(r), light[1] * L + C * Math.sin(r)];
};
/** The dots' colour, written in --dots. */
const DOT = /(--dots: radial-gradient\(circle, )(#[0-9a-f]{6})/;

/** The two sets of sixteen, by their contrast on what they are read on: on paper (and the ground), and on the screen's
 * glass (the terminal in hand). A program's colours are spans among words, a step under them; bright a step past. */
export const SETS = {
  paper: {on: 'paper', lc: 80, bright: 90},
  screen: {on: 'ink', lc: -72, bright: -80},
} as const;
/** The terminal's own words on its glass (the green), read at length: crisp, under the glass's ceiling of Lc 90. */
export const PHOSPHOR = -84;
/** The note's quiet words (the line to write the next in) on its yellow: the least a word is read at. */
export const NOTE_QUIET = 47;

/** What the sheets are to carry: each grey, and each set's sixteen (names of the page's own greys for black and white). */
export function wanted(tokens: string) {
  const ground = /--ground: (#[0-9a-f]{6})/.exec(tokens)![1]!;
  const light = lightOf(ground);
  const greys = Object.fromEntries(Object.entries(GREY_L).map(([g, L]) => [g, hex(neutral(light, L))])) as Record<keyof typeof GREY_L, string>;
  const value = (name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(tokens)![1]!;
  const tints = Object.fromEntries(Object.entries(TINTS).map(([t, o]) => [t, hex(at(light, o.L, o.C, under(light, value(o.mark)).h))])) as Record<keyof typeof TINTS, string>;
  const set = (s: {on: string; lc: number; bright: number}) => {
    const bg = greys[s.on as keyof typeof greys];
    // At each contrast, the most chroma all six hold there, in steps of .005: as colourful as the six can be at once
    // (on the glass the bright ones are paler for it: a red or a blue that light holds little colour).
    const most6 = (t: number) => { let C = 0.25; while (C > 0 && !sixAt(light, C, t, bg).every(shown)) C = Math.round((C - 0.005) * 1000) / 1000; return C; };
    const C = most6(s.lc), Cb = most6(s.bright);
    return {C, Cb, normal: sixAt(light, C, s.lc, bg).map(hex), bright: sixAt(light, Cb, s.bright, bg).map(hex)};
  };
  // The green and the note's quiet words, each its own hue and chroma, at the lightness of its contrast.
  const own = (name: string, target: number, bg: string) => { const u = under(light, value(name)); return hex(at(light, lightFor(light, u.C, u.h, target, bg), u.C, u.h)); };
  const marks = {green: own('green', PHOSPHOR, greys.ink), 'note-quiet': own('note-quiet', NOTE_QUIET, value('note'))};
  return {ground, light, greys, tints, marks, paper: set(SETS.paper), screen: set(SETS.screen)};
}

/** The sixteen as a sheet sets them: `--ansi-0` to `--ansi-15`, black and white given: the OS's own greys. White is
 * read as the colours are (on paper the edge's grey, so it is seen; on the glass the slot's), bright white a step more
 * ink (on paper the sub's; on the glass the raised grey, Lc 89, under the glass's ceiling: the paper's white bloomed
 * there), bright black the dim words programs mean by it, at Lc 45 and more (on the glass the rule's). */
export function sixteen(s: {normal: string[]; bright: string[]}, black: string, white: string, brightBlack: string, brightWhite: string): string {
  const all = [black, ...s.normal, white, brightBlack, ...s.bright, brightWhite];
  return all.map((v, i) => `--ansi-${i}: ${v};`).join(' ');
}

const FILES = {tokens: join(STYLES, 'tokens.css'), terminal: join(STYLES, 'terminal.css'), desk: join(STYLES, 'forge-desk.css')};
/** The sixteen's rule in each sheet: on paper (terminal.css :root), on the screen (forge-desk.css, the terminal in hand). */
const PAPER_SET = /(:root \{\n {2})--ansi-0:[^}]*?(\n\})/;
const SCREEN_SET = /(\.desk-box\[data-kind\]:is\(\.held, \.leaving\) \{[^\n]*\n {2})--ansi-0:[^}]*?( \})/;

/** The sheets as they are to be. */
export function written() {
  const tokens = readFileSync(FILES.tokens, 'utf8');
  const w = wanted(tokens);
  let t = tokens;
  for (const g of GREYS) t = t.replace(new RegExp(`(--${g}: )#[0-9a-f]{6}`), `$1${w.greys[g]}`);
  t = t.replace(DOT, `$1${w.greys.dot}`);
  for (const [k, v] of Object.entries({...w.tints, ...w.marks})) t = t.replace(new RegExp(`(--${k}: )#[0-9a-f]{6}`), `$1${v}`);
  const wrap = (line: string) => line.replace(/((?:--ansi-\d+: [^;]+; ){6})/g, '$1\n  ').replace(/ \n/g, '\n').trimEnd();
  const terminal = readFileSync(FILES.terminal, 'utf8').replace(PAPER_SET,
    (_, a: string, b: string) => `${a}${wrap(sixteen(w.paper, 'var(--ink)', 'var(--edge)', 'var(--quiet)', 'var(--sub)'))}${b}`);
  const desk = readFileSync(FILES.desk, 'utf8').replace(SCREEN_SET,
    (_, a: string, b: string) => `${a}${wrap(sixteen(w.screen, 'var(--edge)', 'var(--slot)', 'var(--rule)', 'var(--raised)'))}${b}`);
  return {tokens: t, terminal, desk, wanted: w};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const now = written();
  if (process.argv.includes('--check')) {
    const off = (['tokens', 'terminal', 'desk'] as const).filter((k) => readFileSync(FILES[k], 'utf8') !== now[k]);
    if (off.length) { console.error(`not under one light: ${off.join(', ')} (node scripts/light.ts)`); process.exit(1); }
  } else if (process.argv.includes('--show')) {
    console.log(JSON.stringify(now.wanted, null, 1));
  } else for (const k of ['tokens', 'terminal', 'desk'] as const) writeFileSync(FILES[k], now[k]);
}
