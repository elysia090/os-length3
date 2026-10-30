// Splits the stylesheet into files by what each part styles, keeping every rule where the cascade has it:
//
//   node scripts/styles-split.mjs [--plan] [SHEET]
//
// SHEET (src/styles.css) is one sheet of rules, or the entry this wrote before, whose parts it reads back first (each
// part's first comment is its own, said again when it is written). It writes the parts to styles/ beside SHEET (taking
// away any .css there it did not write) and SHEET as the entry that imports them, in order. --plan only says what it
// would write: each part, its lines, and the rules in it that are about another part.
//
// A rule wins over another as heavy only by coming later, so the order is the sheet's: each part is a run of the
// sheet's rules one after another, and the entry imports the parts in the order the runs stand in. Which rules a run
// holds is chosen so that most of its rules are about one part (styles-parts.mjs says which, from their classes):
// a new part costs as much as a few rules that stand in a part not their own, so a rule or two about something else
// among many about one thing stay where they are, in the part around them. A part that comes back later in the
// sheet is written again under its name and a number (bench-2.css, after bench.css).
//
// Before anything is written, the parts read back in order must be the sheet again: the same comments and rules in
// the same order, each in the same @media, whatever the room between them.

import {mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {PARTS, classPart} from './styles-parts.mjs';
import {entryOf, leavesOf, readLeaf, readSheet} from './styles-sheet.mjs';

const OS = fileURLToPath(new URL('..', import.meta.url));
const ABOUT = new Map(PARTS.map((p) => [p.name, p.about]));
/** Parts that are about many places: their classes yield to a place's in the same selector. */
const COMMON = new Set(['base', 'shared', 'controls', 'switch', 'menus', 'page', 'parts', 'cards', 'small-cards']);

// ---- Reading the sheet, whole ----

/** A part file's text without its first comment (the one this writes over it). */
export const withoutHead = (text) => text.replace(/^\s*\/\*[\s\S]*?\*\/[ \t]*\n?/, '');

/**
 * The sheet as one text: SHEET itself, or the parts its entry imports read back one after another (each ends a line,
 * which the next starts after), then any rules after them.
 */
export function wholeSheet(sheet) {
  const text = readFileSync(sheet, 'utf8');
  const entry = entryOf(text);
  if (!entry) return text;
  const parts = entry.files.map((p) => {
    const part = withoutHead(readFileSync(resolve(dirname(sheet), p), 'utf8'));
    return part.endsWith('\n') ? part : `${part}\n`;
  });
  return [...parts, ...(entry.rest.trim() ? [entry.rest.replace(/^\n/, '')] : [])].join('');
}

// ---- Which part a rule is about ----

/** The parts one complex selector is about: its own when its classes name one, else what its :is() names, else ''. */
function partsOfComplex(c) {
  let place = null, own = null, common = null, base = null;
  // From the subject out: the first class a part names, a place's before anything, a common part's after, the
  // base's last; what a compound :has() is about is about it too, as what stands round it is.
  const scan = (complex) => {
    for (let k = complex.compounds.length - 1; k >= 0; k--) {
      const parts = complex.compounds[k].parts;
      for (const p of parts) {
        if (p.kind !== 'class') continue;
        const hit = classPart(p.name);
        if (!hit) continue;
        if (hit.place) place ??= hit.part;
        else if (hit.part === 'base') base ??= hit.part;
        else if (COMMON.has(hit.part)) common ??= hit.part;
        else own ??= hit.part;
      }
      for (const p of parts) if (p.name === 'has' && p.list) for (const a of p.list) scan(a.complex);
    }
  };
  scan(c);
  const found = place ?? own ?? common ?? base;
  if (found) return [found];
  const inner = new Set();
  for (const cp of c.compounds) for (const p of cp.parts) if (p.list && p.name !== 'not') for (const a of p.list) for (const x of partsOfComplex(a.complex)) inner.add(x);
  if (inner.size) return [...inner];
  const last = c.compounds.at(-1)?.parts ?? [];
  if (last.some((p) => p.kind === 'pseudo-element' && p.name.startsWith('view-transition'))) return ['motion'];
  if (c.compounds.some((cp) => cp.parts.some((p) => p.kind === 'class' || p.kind === 'id'))) return [''];
  return ['base'];
}

/** The part a leaf of the sheet is about: {part, why}; an at-rule (@keyframes) is about whatever stands round it. */
export function partOf(leaf) {
  const r = readLeaf(leaf);
  if (r.kind === 'at') return {part: null, why: `@${r.name}`};
  if (r.sels.length === 1 && r.sels[0].text === ':root' && r.decls.every((d) => d.prop.startsWith('--'))) return {part: 'tokens', why: ':root'};
  const all = new Set(r.sels.flatMap(partsOfComplex));
  const named = [...all].filter(Boolean);
  if (named.length === 1) return {part: named[0], why: named[0]};
  if (named.length > 1) return {part: 'shared', why: named.join(' ')};
  return {part: 'shared', why: 'no class a part names'};
}

// ---- Runs ----

/** What a new part costs, in lines of rules that stand in a part not their own. */
const NEW_PART = 8;
/** What cutting an @media in two costs besides. */
const CUT_GROUP = 4;
/** What a line of a rule about many parts costs in a part of one. */
const SHARED_COST = 0.5;

/**
 * The runs the leaves are cut into: [{part, from, to}] (to exclusive), as cheap as can be: each new run costs
 * NEW_PART, each line of a rule costs 1 in a run of another part (of a shared rule, less), nothing in its own.
 */
export function runsOf(leaves) {
  const parts = [...new Set(leaves.map((l) => l.part).filter((p) => p !== null))];
  const n = leaves.length, P = parts.length;
  const cost = (leaf, p) => (leaf.part === null || leaf.part === parts[p] ? 0 : (leaf.part === 'shared' ? SHARED_COST : 1) * leaf.node.text.split('\n').length);
  // prev[p]: the least cost of the leaves so far with the last run of part p; back[i][p]: the part of the run
  // leaf i-1 is in, on that way (p itself when leaf i goes on in the same run, -1 for the first leaf).
  let prev = parts.map((_, p) => NEW_PART + cost(leaves[0], p));
  const back = [parts.map(() => -1)];
  for (let i = 1; i < n; i++) {
    let low = 0;
    for (let p = 1; p < P; p++) if (prev[p] < prev[low]) low = p;
    const cut = leaves[i].parents.length > 0 && leaves[i - 1].parents[0] === leaves[i].parents[0];
    const start = prev[low] + NEW_PART + (cut ? CUT_GROUP : 0);
    back.push(parts.map((_, p) => (prev[p] < start ? p : low)));
    prev = parts.map((_, p) => Math.min(prev[p], start) + cost(leaves[i], p));
  }
  let p = 0;
  for (let q = 1; q < P; q++) if (prev[q] < prev[p]) p = q;
  const runs = [];
  let to = n;
  for (let i = n - 1; i >= 0; i--) {
    const was = back[i][p];
    if (was !== p) { runs.unshift({part: parts[p], from: i, to}); to = i; p = was; }
  }
  return runs;
}

// ---- Writing a run ----

/** The text of the leaves from..to, each in the @media (and so on) it stands in, opened and closed round them. */
export function runText(all, from, to, tail) {
  let out = '';
  const open = [];
  const closeTo = (depth, leaf) => {
    while (open.length > depth) {
      const g = open.pop();
      // Closed where it closes: its own end and what follows it; else a brace, the group going on in the next part.
      out += lastLeafOf(all, g) < leaf ? g.tail + g.trail : '\n}';
    }
  };
  for (let i = from; i < to; i++) {
    const leaf = all[i];
    let same = 0;
    while (same < open.length && same < leaf.parents.length && open[same] === leaf.parents[same]) same++;
    closeTo(same, i);
    for (let d = same; d < leaf.parents.length; d++) {
      const g = leaf.parents[d];
      out += (firstLeafOf(all, g) === i ? g.lead : '\n') + g.head;
      open.push(g);
    }
    out += leaf.node.lead + leaf.node.text + leaf.node.trail;
  }
  closeTo(0, to);
  if (tail !== undefined) out += tail;
  // The line break that ended the rule before it is where the part before ends; the room before it (a blank line
  // before a section) stays, so the parts read back one after another are the sheet as it was written.
  return out.replace(/^\n/, '').replace(/\s*$/, '\n');
}

function firstLeafOf(all, g) { return g.first ??= all.findIndex((l) => l.parents.includes(g)); }
function lastLeafOf(all, g) {
  if (g.last === undefined) { g.last = -1; all.forEach((l, i) => { if (l.parents.includes(g)) g.last = i; }); }
  return g.last;
}

// ---- The same sheet ----

/**
 * What a sheet says, in order, whatever the room in it and however its @media are cut: each comment and each rule
 * with the @media (and so on) it stands in, every run of space made one.
 */
export function said(text) {
  const out = [];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const comments = (s, ctx) => { for (const c of s.match(/\/\*[\s\S]*?\*\//g) ?? []) out.push(`${ctx}${norm(c)}`); };
  const walk = (nodes, tail, ctx) => {
    for (const n of nodes) {
      comments(n.lead, ctx);
      if (n.kind === 'group') {
        comments(n.head, ctx);
        walk(n.nodes, n.tail, `${ctx}${norm(n.head.replace(/\/\*[\s\S]*?\*\//g, ' '))} `);
      } else out.push(`${ctx}${norm(n.text)}`);
      comments(n.trail, ctx);
    }
    comments(tail, ctx);
  };
  const sheet = readSheet(text);
  walk(sheet.nodes, sheet.tail, '');
  return out;
}

/** Where two sheets first say something else, or -1 when they say the same. */
export function firstDifference(a, b) {
  const x = said(a), y = said(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i;
  return -1;
}

// ---- The split ----

/** The parts a sheet is split into: [{name, file, about, text, leaves, strays}] in order, and the entry's text. */
export function split(text) {
  const sheet = readSheet(text);
  const leaves = leavesOf(sheet.nodes);
  for (const l of leaves) Object.assign(l, partOf(l));
  const runs = runsOf(leaves);
  const seen = new Map();
  const parts = runs.map((r, k) => {
    const count = (seen.get(r.part) ?? 0) + 1;
    seen.set(r.part, count);
    const name = count === 1 ? r.part : `${r.part}-${count}`;
    const body = runText(leaves, r.from, r.to, k === runs.length - 1 ? sheet.tail : undefined);
    const strays = leaves.slice(r.from, r.to).filter((l) => l.part !== null && l.part !== r.part);
    return {name, part: r.part, count, file: `${name}.css`, leaves: r.to - r.from, from: leaves[r.from].node.line, strays, body};
  });
  for (const p of parts) {
    const others = parts.filter((o) => o.part === p.part && o !== p);
    const more = !others.length ? '' : others.map((o) => `${o.count > p.count ? 'later' : 'earlier'} in the cascade, ${o.file}`).join('; ');
    p.head = comment(`${ABOUT.get(p.part)}${more ? ` More of it ${more}.` : ''}`);
    p.text = p.head + p.body;
  }
  const again = parts.find((p) => p.count > 1);
  const entry = comment(`The OS's stylesheet, in parts by what each styles: scripts/styles-split.mjs wrote them from one sheet, and
    writes them again from these. The order is the cascade's: of two rules as heavy, the later wins, so where a part stands in this list
    is part of what it says${again ? `, and a part that comes back further down (${again.file}) stands where its rules do` : ''}.`)
    + parts.map((p) => `@import './styles/${p.file}';\n`).join('');
  return {parts, entry};
}

/** A comment of these words, its lines no longer than the sheet's. */
function comment(words, width = 118) {
  const lines = [''];
  for (const w of words.split(/\s+/)) {
    if (lines.at(-1) && (lines.length === 1 ? 3 : 3) + lines.at(-1).length + 1 + w.length > width) lines.push('');
    lines[lines.length - 1] += (lines.at(-1) ? ' ' : '') + w;
  }
  return `/* ${lines.join('\n   ')} */\n`;
}

/** What the parts say, read back in order, as wholeSheet reads them. */
const readBack = (parts) => parts.map((p) => p.body).join('');

function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {plan: {type: 'boolean'}}});
  const sheet = resolve(positionals[0] ?? join(OS, 'src', 'styles.css'));
  const text = wholeSheet(sheet);
  const {parts, entry} = split(text);
  const at = firstDifference(text, readBack(parts));
  if (at >= 0) throw new Error(`the parts read back are not the sheet (they part at what it says ${at}th): nothing is written`);
  const dir = join(dirname(sheet), 'styles');
  const lines = (s) => s.split('\n').length - 1;
  for (const p of parts) {
    console.log(`${p.file.padEnd(22)} ${String(lines(p.text)).padStart(5)} lines, ${String(p.leaves).padStart(4)} rules from line ${p.from}`
      + (p.strays.length ? `; about other parts: ${p.strays.length}` : ''));
    if (values.plan) for (const l of p.strays) console.log(`    ${l.node.line}: ${(l.node.selector ?? `@${l.node.name}`).replace(/\s+/g, ' ').slice(0, 90)}  (${l.why})`);
  }
  if (values.plan) return;
  mkdirSync(dir, {recursive: true});
  const keep = new Set(parts.map((p) => p.file));
  for (const f of readdirSync(dir)) if (f.endsWith('.css') && !keep.has(f)) unlinkSync(join(dir, f));
  for (const p of parts) writeFileSync(join(dir, p.file), p.text);
  writeFileSync(sheet, entry);
  // Read back from what is written, as anyone would.
  const back = wholeSheet(sheet);
  if (firstDifference(text, back) >= 0) throw new Error('the parts written do not read back as the sheet');
  console.log(`${sheet.startsWith(OS) ? relative(OS, sheet) : sheet}: ${parts.length} parts in styles/, the same ${said(text).length} comments and rules`
    + ` in the same order${back === text ? ' (read back, the same text byte for byte)' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
