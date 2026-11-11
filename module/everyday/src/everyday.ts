// everyday: the look and feel of a thing, changed by the one who uses it.
//
// What a look is made of is a sheet of names and their values: a stylesheet's custom properties (colours, faces,
// sizes, spaces, corners, the pace of what moves). A person's changes are a few lines, `name: value`, in a file of
// their own. everyday reads the first for what may be changed (each name's kind, its usual value, how far from it
// a change may go), holds the second to it, and gives back the rules that make the changes so.
//
// A line that is not a change, names nothing that may be changed, is not of its kind, is out of bounds, or would
// leave words unread on their ground, is left out and said: what it would have changed stays as it was. Nothing of
// a person's text is written into the rules as it came: each value is read, and written again from what was read.
// The way back is the file itself: a line taken out is that thing as it was, and no file is everything as it was.
//
// It knows no product. What may be changed is what the product's own sheet says once, plainly and of everywhere: a
// value that follows from others (var(), calc(), a mix), or that the sheet itself changes by the window, is the
// product's to keep.

/** What a value is: a colour, a length (px), a time (ms), a number, a share (of one), a face (a font's families). */
export type Kind = 'colour' | 'length' | 'time' | 'number' | 'share' | 'face';

/** One thing that may be changed. */
export interface Thing {
  name: string;
  kind: Kind;
  /** Its value as the sheet has it. */
  usual: string;
  /** How far a change may go (a length, a time, a number, a share); 0 and 0 where its kind has no bounds. */
  least: number;
  most: number;
  /** What the sheet says of it: the note written over it. */
  says: string;
}

/** Words in the colour `on` are read on the colour `under`: their contrast is `least` at least (WCAG's ratio). */
export interface Pair { on: string; under: string; least: number }

/** A line left out, and why. */
export interface Left { line: number; text: string; why: string }

export interface Changed {
  /** The rules that make the changes so: one `:root` rule, or nothing where nothing is changed. */
  css: string;
  /** Each name changed, and its value as it is written in the rules. */
  values: Record<string, string>;
  left: Left[];
}

const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const AMOUNT = /^(\d{1,7}(?:\.\d{1,4})?|\.\d{1,4})(px|ms|)$/;
/** One family of a face: a name in quotes, or words of letters and digits. */
const FAMILY = /^(?:'[A-Za-z0-9][A-Za-z0-9 _-]{0,63}'|"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}"|-?[A-Za-z][A-Za-z0-9_-]{0,63}(?: [A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,7})$/;

/** A plain value's kind and its bounds, or nothing where the value follows from others. */
function plain(value: string): Pick<Thing, 'kind' | 'least' | 'most'> | undefined {
  if (COLOUR.test(value)) return {kind: 'colour', least: 0, most: 0};
  const amount = AMOUNT.exec(value);
  if (amount) {
    const n = Number(amount[1]);
    if (!(n > 0)) return undefined; // (nothing is a half or a double of none)
    // A size between half and twice what it was; a time from none to four times; a number from a quarter to four
    // times; a share from none to all.
    if (amount[2] === 'px') return {kind: 'length', least: n / 2, most: n * 2};
    if (amount[2] === 'ms') return {kind: 'time', least: 0, most: n * 4};
    return n < 1 ? {kind: 'share', least: 0, most: 1} : {kind: 'number', least: n / 4, most: n * 4};
  }
  const families = value.split(',').map((f) => f.trim());
  if (families.length >= 2 && families.every((f) => FAMILY.test(f))) return {kind: 'face', least: 0, most: 0};
  return undefined;
}

/** A sheet's text with its notes taken out of the way: each `/* … *\/` made spaces, so places in it stay where they were. */
const unnoted = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, (note) => note.replace(/[^\n]/g, ' '));

/**
 * What may be changed, read from a sheet (a stylesheet's text, or several one after another): every custom
 * property a `:root` rule sets once, plainly, and for every window. One set again anywhere (in another `:root`
 * rule, or under an at-rule: by the window's width, the screen's sharpness) is the sheet's own to change, and one
 * whose value is made of others follows them.
 */
export function things(sheet: string): Thing[] {
  const text = unnoted(sheet);
  const found = new Map<string, {value: string; at: number; times: number}>();
  // Each rule's opening brace, with the selector before it and how deep it stands.
  let depth = 0, from = 0;
  const open: {root: boolean; nested: boolean}[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { // (a string: to its end, whatever is in it)
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '{') {
      const selector = text.slice(from, i).trim();
      open.push({root: selector === ':root', nested: depth > 0});
      depth++, from = i + 1;
    } else if (c === '}') {
      const rule = open.pop();
      if (rule?.root) declarations(text, from, i, rule.nested, found);
      depth = Math.max(0, depth - 1), from = i + 1;
    } else if (c === ';' && !open.at(-1)?.root) from = i + 1;
  }
  const all: Thing[] = [];
  for (const [name, {value, at, times}] of found) {
    const kind = times === 1 ? plain(value) : undefined;
    if (kind) all.push({name, usual: value, ...kind, says: note(sheet, at)});
  }
  return all;
}

/** The declarations of one `:root` rule (from `from` to `to` in `text`), each custom property counted. */
function declarations(text: string, from: number, to: number, nested: boolean, found: Map<string, {value: string; at: number; times: number}>): void {
  let start = from, round = 0;
  for (let i = from; i <= to; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 || end > to ? to : end;
    } else if (c === '(') round++;
    else if (c === ')') round--;
    else if ((c === ';' && round <= 0) || i === to) {
      const said = /^(\s*)--([a-z][a-z0-9-]*)\s*:([\s\S]*)$/.exec(text.slice(start, i));
      if (said) {
        const was = found.get(said[2]);
        // (set under an at-rule, it is set by the window: counted twice, so it is no one's to change)
        found.set(said[2], {value: was?.value ?? said[3].trim(), at: was?.at ?? start + said[1].length, times: (was?.times ?? 0) + (nested ? 2 : 1)});
      }
      start = i + 1, round = 0;
    }
  }
}

/** The note written over the declaration at `at`: the one that ends just before it, with nothing between. */
function note(sheet: string, at: number): string {
  const before = sheet.slice(0, at), end = before.lastIndexOf('*/');
  if (end < 0 || before.slice(end + 2).trim()) return '';
  return before.slice(before.lastIndexOf('/*', end) + 2, end).replace(/\s+/g, ' ').trim();
}

/** A colour's red, green and blue, each 0 to 255. */
function rgb(colour: string): [number, number, number] {
  const hex = colour.length === 4 ? colour.slice(1).replace(/./g, '$&$&') : colour.slice(1);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
/** How light a colour is to the eye, 0 to 1 (WCAG's relative luminance). */
function light(colour: string): number {
  const [r, g, b] = rgb(colour).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** The contrast of two colours, 1 (the same) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A number written as few digits as say it. */
const written = (n: number) => String(Math.round(n * 10000) / 10000);

/** One value read as `thing`'s kind and written again; or why it is not one. */
function read(thing: Thing, value: string): {value: string} | {why: string} {
  if (thing.kind === 'colour') {
    if (!COLOUR.test(value)) return {why: 'a colour is written #rgb or #rrggbb'};
    return {value: '#' + rgb(value.toLowerCase()).map((v) => v.toString(16).padStart(2, '0')).join('')};
  }
  if (thing.kind === 'face') {
    const families = value.split(',').map((f) => f.trim());
    if (families.length > 8 || !families.every((f) => FAMILY.test(f))) return {why: 'a face is its families\' names, with commas between (letters, digits, spaces)'};
    // Each in quotes (a name is never a keyword by accident), and the usual ones after it, for the letters it has not.
    return {value: [...families.map((f) => `"${f.replace(/^['"]|['"]$/g, '')}"`), thing.usual].join(', ')};
  }
  const unit = thing.kind === 'length' ? 'px' : thing.kind === 'time' ? 'ms' : '';
  const amount = AMOUNT.exec(value);
  if (!amount || amount[2] !== unit) return {why: `${unit ? `a ${thing.kind} is a number and ${unit}` : `a ${thing.kind} is a number`} (as ${thing.usual})`};
  const n = Number(amount[1]);
  if (n < thing.least || n > thing.most) return {why: `between ${written(thing.least)}${unit} and ${written(thing.most)}${unit} (it is ${thing.usual})`};
  return {value: written(n) + unit};
}

/** The most of a person's text that is read: more is not a look, and is not read in part. */
export const MOST = 64 << 10;

/**
 * A person's changes held to what may be changed: `text`, a change a line (`name: value`; `--name: value;` as a
 * stylesheet writes it is the same; a line that begins with # or // is a note). The last line for a name is the one
 * that counts. `pairs`: the words that must stay read on their grounds; while one would not be, the line written
 * last among those that changed it is left out.
 */
export function change(all: readonly Thing[], text: string, pairs: readonly Pair[] = []): Changed {
  const left: Left[] = [];
  if (text.length > MOST) return {css: '', values: {}, left: [{line: 0, text: '', why: `longer than is read (${MOST} characters): nothing of it is taken`}]};
  const by = new Map(all.map((thing) => [thing.name, thing]));
  const taken = new Map<string, {value: string; line: number; text: string}>();
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const said = /^(?:--)?([a-z][a-z0-9-]*)\s*:\s*(.*?)\s*;?$/.exec(line);
    const shown = line.slice(0, 120);
    if (!said) { left.push({line: i + 1, text: shown, why: 'not a change (name: value)'}); return; }
    const thing = by.get(said[1]);
    if (!thing) { left.push({line: i + 1, text: shown, why: 'nothing that may be changed has that name'}); return; }
    const value = read(thing, said[2]);
    if ('why' in value) { left.push({line: i + 1, text: shown, why: value.why}); return; }
    taken.delete(thing.name); // (said again: this one counts, where it stands)
    taken.set(thing.name, {value: value.value, line: i + 1, text: shown});
  });
  // The words that must stay read. Read of the look as a whole (a dark ground and light words are taken together,
  // whichever was written first); while a pair fails, the line written last among what was changed of the failing
  // pairs is left out, and the look read again: as with nothing changed, every pair holds in the end.
  const now = (name: string) => taken.get(name)?.value ?? by.get(name)?.usual;
  for (;;) {
    let last: {name: string; line: number; text: string; why: string} | undefined;
    for (const pair of pairs) {
      const on = now(pair.on), under = now(pair.under);
      if (!on || !under || !COLOUR.test(on) || !COLOUR.test(under)) continue;
      const ratio = contrast(on, under);
      if (ratio >= pair.least) continue;
      for (const name of [pair.on, pair.under]) {
        const lost = taken.get(name);
        if (lost && (!last || lost.line > last.line))
          last = {name, line: lost.line, text: lost.text, why: `${pair.on} would not be read on ${pair.under} (their contrast ${written(Math.round(ratio * 100) / 100)}, of ${pair.least} at least)`};
      }
    }
    if (!last) break;
    left.push({line: last.line, text: last.text, why: last.why});
    taken.delete(last.name);
  }
  left.sort((a, b) => a.line - b.line);
  const values = Object.fromEntries([...taken].map(([name, {value}]) => [name, value]));
  const css = taken.size ? `:root { ${[...taken].map(([name, {value}]) => `--${name}: ${value};`).join(' ')} }` : '';
  return {css, values, left};
}
